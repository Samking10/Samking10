// Everything a customer can do: reply by email, tap a response button, opt out, or bounce.
import { addEvent, getEstimate, setStatus, suppress } from './estimates.js';
import { notifyContractor } from './notify.js';
import { formatMoney } from '../config.js';

const OPEN_STATUSES = ['active', 'no_response', 'paused'];

export const RESPONSE_CHOICES = {
  schedule: { label: "Yes, I'd like to get on the schedule", status: 'interested' },
  question: { label: 'I have a question. Please contact me', status: 'interested' },
  later: { label: 'Not right now, maybe later', status: 'lost', reason: 'Not right now (maybe later)' },
  no: { label: 'No thanks, I went another direction', status: 'lost', reason: 'Went another direction' },
};

function load(db, token) {
  const estimate = db.prepare('SELECT * FROM estimates WHERE public_token = ?').get(String(token || ''));
  if (!estimate) return null;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(estimate.account_id);
  return { estimate, account };
}

export function findByToken(db, token) {
  return load(db, token);
}

export async function recordResponse(ctx, token, choiceKey, message = '', now = Date.now()) {
  const { db, cfg } = ctx;
  const found = load(db, token);
  const choice = RESPONSE_CHOICES[choiceKey];
  if (!found || !choice) return null;
  const { estimate, account } = found;
  const note = String(message || '').trim().slice(0, 2000);
  addEvent(db, { accountId: account.id, estimateId: estimate.id, type: 'customer_response', data: { choice: choiceKey, message: note }, now });
  if (estimate.status !== 'booked' && estimate.status !== 'unsubscribed') {
    setStatus(db, cfg, account, estimate, choice.status, { now, by: 'customer', reason: choice.reason || '' });
  }
  const lines = [
    `${estimate.customer_name} responded to your estimate${estimate.job_description ? ` for ${estimate.job_description}` : ''}:`,
    '',
    `  "${choice.label}"`,
  ];
  if (note) lines.push('', 'Their message:', note);
  lines.push('', `Email: ${estimate.customer_email}`);
  if (estimate.customer_phone) lines.push(`Phone: ${estimate.customer_phone}`);
  lines.push('', `Follow-ups for this estimate have stopped. Open it: ${cfg.baseUrl}/app/estimates/${estimate.id}`);
  await notifyContractor(ctx, account, {
    subject: `${choice.status === 'interested' ? 'Hot lead' : 'Update'}: ${estimate.customer_name} responded`,
    text: lines.join('\n'),
    replyTo: estimate.customer_email,
  });
  return getEstimate(db, account.id, estimate.id);
}

export async function unsubscribe(ctx, token, now = Date.now()) {
  const { db, cfg } = ctx;
  const found = load(db, token);
  if (!found) return null;
  const { estimate, account } = found;
  suppress(db, account.id, estimate.customer_email, 'unsubscribed', now);
  addEvent(db, { accountId: account.id, estimateId: estimate.id, type: 'unsubscribed', data: {}, now });
  if (estimate.status !== 'booked' && estimate.status !== 'unsubscribed') {
    setStatus(db, cfg, account, estimate, 'unsubscribed', { now, by: 'customer' });
  }
  return found;
}

function header(headers, name) {
  const h = (headers || []).find((x) => String(x.Name).toLowerCase() === name.toLowerCase());
  return h ? String(h.Value) : '';
}

export function isAutoReply(payload) {
  const auto = header(payload.Headers, 'Auto-Submitted');
  if (auto && auto.toLowerCase() !== 'no') return true;
  if (header(payload.Headers, 'X-Autoreply') || header(payload.Headers, 'X-Autorespond')) return true;
  if (/^(auto_reply|bulk|junk)$/i.test(header(payload.Headers, 'Precedence').trim())) return true;
  return /^\s*(auto(matic)?[\s-]?reply|out of (the )?office|away from (the )?office|on vacation)/i.test(payload.Subject || '');
}

export function extractToken(payload) {
  if (payload.MailboxHash) return payload.MailboxHash;
  const candidates = [payload.OriginalRecipient, payload.To, ...(payload.ToFull || []).map((t) => t.Email), ...(payload.CcFull || []).map((t) => t.Email)];
  for (const c of candidates) {
    const m = /reply\+([A-Za-z0-9_-]+)@/.exec(String(c || ''));
    if (m) return m[1];
  }
  return null;
}

// Postmark inbound webhook payload: https://postmarkapp.com/developer/webhooks/inbound-webhook
export async function handleInboundEmail(ctx, payload, now = Date.now()) {
  const { db, cfg } = ctx;
  const token = extractToken(payload);
  const found = token && load(db, token);
  if (!found) return { matched: false };
  const { estimate, account } = found;
  const auto = isAutoReply(payload);
  const fromEmail = payload.FromFull?.Email || payload.From || '';
  const text = String(payload.StrippedTextReply || payload.TextBody || '').trim().slice(0, 10000);
  addEvent(db, { accountId: account.id, estimateId: estimate.id, type: auto ? 'auto_reply' : 'reply_received', data: { from: fromEmail, subject: payload.Subject || '', text }, now });
  if (auto) return { matched: true, auto: true };

  if (OPEN_STATUSES.includes(estimate.status) || estimate.status === 'lost') {
    setStatus(db, cfg, account, estimate, 'replied', { now, by: 'customer' });
  }
  const amount = estimate.amount_cents ? ` (${formatMoney(estimate.amount_cents)})` : '';
  await notifyContractor(ctx, account, {
    subject: `${estimate.customer_name} replied: ${payload.Subject || 'your estimate'}`,
    replyTo: fromEmail || estimate.customer_email,
    text: [
      `${estimate.customer_name} replied about their estimate${amount}. Hit reply to answer them directly.`,
      '',
      '----',
      text || '(no text)',
      '----',
      '',
      `Follow-ups for this estimate have stopped. Open it: ${cfg.baseUrl}/app/estimates/${estimate.id}`,
    ].join('\n'),
  });
  return { matched: true, auto: false };
}

// Postmark bounce/spam-complaint webhook.
export async function handleBounce(ctx, payload, now = Date.now()) {
  const { db, cfg } = ctx;
  const messageId = payload.MessageID;
  const f = messageId && db.prepare('SELECT * FROM followups WHERE provider_message_id = ?').get(String(messageId));
  if (!f) return { matched: false };
  const estimate = db.prepare('SELECT * FROM estimates WHERE id = ?').get(f.estimate_id);
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(f.account_id);
  const isComplaint = payload.RecordType === 'SpamComplaint';
  const hard = isComplaint || ['HardBounce', 'BadEmailAddress', 'ManuallyDeactivated', 'Blocked'].includes(payload.Type);
  addEvent(db, { accountId: account.id, estimateId: estimate.id, type: 'bounce', data: { type: payload.Type || payload.RecordType, hard, description: payload.Description || '' }, now });
  if (!hard || estimate.status === 'booked') return { matched: true, hard };
  if (isComplaint) {
    suppress(db, account.id, estimate.customer_email, 'spam_complaint', now);
    setStatus(db, cfg, account, estimate, 'unsubscribed', { now, by: 'customer', reason: 'spam complaint' });
  } else {
    setStatus(db, cfg, account, estimate, 'bounced', { now, by: 'system' });
    await notifyContractor(ctx, account, {
      subject: `Email to ${estimate.customer_name} bounced`,
      text: `A follow-up to ${estimate.customer_name} at ${estimate.customer_email} could not be delivered.\n\nFix the address and follow-ups will restart:\n${cfg.baseUrl}/app/estimates/${estimate.id}`,
    });
  }
  return { matched: true, hard };
}
