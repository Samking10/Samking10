import crypto from 'node:crypto';
import { DAY, nextSendTime } from '../time.js';

export const STATUSES = {
  active: { label: 'Following up', tone: 'blue', help: 'Follow-up emails are scheduled.' },
  replied: { label: 'Customer replied', tone: 'orange', help: 'The customer emailed back. Follow-ups stopped.' },
  interested: { label: 'Wants to talk', tone: 'orange', help: 'The customer tapped the reply link. Follow-ups stopped.' },
  booked: { label: 'Booked', tone: 'green', help: 'Job won.' },
  lost: { label: 'Lost', tone: 'gray', help: 'Customer declined or went elsewhere.' },
  paused: { label: 'Paused', tone: 'gray', help: 'You paused follow-ups.' },
  no_response: { label: 'No response', tone: 'gray', help: 'All follow-ups sent; no response yet.' },
  unsubscribed: { label: 'Opted out', tone: 'gray', help: 'Customer asked not to be emailed.' },
  bounced: { label: 'Bad email', tone: 'red', help: 'Email could not be delivered. Fix the address to restart.' },
};

// Statuses that count toward the plan's active-estimate limit.
export const LIMITED_STATUSES = ['active', 'paused'];
export const NEEDS_ATTENTION = ['replied', 'interested'];

export class UserError extends Error {}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
export function isEmail(s) {
  return EMAIL_RE.test(String(s || '').trim());
}

export function parseMoneyToCents(value) {
  const cleaned = String(value ?? '').replace(/[$,\s]/g, '');
  if (cleaned === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

export function newToken() {
  return crypto.randomBytes(16).toString('base64url');
}

export function addEvent(db, { accountId, estimateId = null, type, data = {}, now = Date.now() }) {
  db.prepare('INSERT INTO events(account_id, estimate_id, type, data, created_at) VALUES(?, ?, ?, ?, ?)')
    .run(accountId, estimateId, type, JSON.stringify(data), now);
}

export function getSteps(db, accountId) {
  return db.prepare('SELECT * FROM sequence_steps WHERE account_id = ? ORDER BY position').all(accountId);
}

export function countLimited(db, accountId) {
  return db.prepare(`SELECT COUNT(*) n FROM estimates WHERE account_id = ? AND status IN (${LIMITED_STATUSES.map(() => '?').join(',')})`)
    .get(accountId, ...LIMITED_STATUSES).n;
}

export function isSuppressed(db, accountId, email) {
  return !!db.prepare('SELECT 1 FROM suppressions WHERE account_id = ? AND email = ?').get(accountId, email);
}

// Validates and normalises estimate fields from a form or CSV row.
export function cleanEstimateInput(input) {
  const out = {
    customer_name: String(input.customer_name || '').trim().slice(0, 120),
    customer_email: String(input.customer_email || '').trim().toLowerCase().slice(0, 200),
    customer_phone: String(input.customer_phone || '').trim().slice(0, 40),
    job_address: String(input.job_address || '').trim().slice(0, 200),
    job_description: String(input.job_description || '').trim().slice(0, 200),
  };
  const errors = [];
  if (!out.customer_name) errors.push('Customer name is required.');
  if (!isEmail(out.customer_email)) errors.push('A valid customer email is required.');
  const cents = parseMoneyToCents(input.amount);
  if (cents === null) errors.push('Estimate amount should be a number like 4200 or 4,200.50.');
  out.amount_cents = cents ?? 0;
  return { values: out, errors };
}

// Creates follow-up rows for every step. If the estimate is old enough that the first
// step is already overdue, the whole sequence slides forward so it starts now with its
// original spacing (rather than sending several overdue emails at once).
export function scheduleFollowups(db, account, estimate, now) {
  const steps = getSteps(db, account.id);
  if (steps.length === 0) return 0;
  const firstDue = estimate.sent_at + steps[0].delay_days * DAY;
  const shift = Math.max(0, now - firstDue);
  const insert = db.prepare(`INSERT INTO followups(account_id, estimate_id, step_position, delay_days, scheduled_at)
    VALUES(?, ?, ?, ?, ?)`);
  for (const step of steps) {
    const due = estimate.sent_at + step.delay_days * DAY + shift;
    insert.run(account.id, estimate.id, step.position, step.delay_days, nextSendTime(due, account));
  }
  return steps.length;
}

export function createEstimate(db, cfg, account, input, { now = Date.now(), source = 'manual', sentAt } = {}) {
  const { values, errors } = cleanEstimateInput(input);
  if (errors.length) throw new UserError(errors.join(' '));
  if (!sentAt || sentAt > now + DAY) throw new UserError('The estimate date must be today or earlier.');
  if (getSteps(db, account.id).length === 0) throw new UserError('Your follow-up sequence has no emails. Add one on the Follow-ups page first.');

  return db.transaction(() => {
    if (countLimited(db, account.id) >= cfg.pricing.maxActiveEstimates) {
      throw new UserError(`Your plan includes up to ${cfg.pricing.maxActiveEstimates} estimates being followed up at once. Mark some as booked or lost first.`);
    }
    const suppressed = isSuppressed(db, account.id, values.customer_email);
    const status = suppressed ? 'unsubscribed' : 'active';
    const r = db.prepare(`INSERT INTO estimates(account_id, customer_name, customer_email, customer_phone, job_address,
        job_description, amount_cents, sent_at, status, status_changed_at, public_token, source, created_at)
      VALUES(@account_id, @customer_name, @customer_email, @customer_phone, @job_address, @job_description,
        @amount_cents, @sent_at, @status, @now, @token, @source, @now)`)
      .run({ ...values, account_id: account.id, sent_at: Math.min(sentAt, now), status, now, token: newToken(), source });
    const estimate = getEstimate(db, account.id, r.lastInsertRowid);
    if (!suppressed) scheduleFollowups(db, account, estimate, now);
    addEvent(db, { accountId: account.id, estimateId: estimate.id, type: 'created', data: { source, suppressed }, now });
    return estimate;
  })();
}

export function getEstimate(db, accountId, id) {
  return db.prepare('SELECT * FROM estimates WHERE id = ? AND account_id = ?').get(id, accountId);
}

export function cancelPending(db, estimateId) {
  return db.prepare(`UPDATE followups SET status = 'canceled' WHERE estimate_id = ? AND status = 'scheduled'`).run(estimateId).changes;
}

// The single place estimate status changes. Anything other than "active" stops follow-ups.
export function setStatus(db, cfg, account, estimate, to, { now = Date.now(), by = 'contractor', reason = '', bookedAmountCents, bookedAt } = {}) {
  if (!STATUSES[to]) throw new UserError('Unknown status.');
  return db.transaction(() => {
    const current = getEstimate(db, account.id, estimate.id);
    const from = current.status;
    if (to === 'active') resumeFollowups(db, cfg, account, current, now);
    else cancelPending(db, current.id);

    const updates = { status: to, status_changed_at: now, lost_reason: to === 'lost' ? reason : '' };
    if (to === 'booked') {
      updates.booked_amount_cents = bookedAmountCents ?? current.booked_amount_cents ?? current.amount_cents;
      updates.booked_at = bookedAt ?? now;
    } else if (from === 'booked') {
      updates.booked_amount_cents = null;
      updates.booked_at = null;
    }
    const sets = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE estimates SET ${sets} WHERE id = @id`).run({ ...updates, id: current.id });
    if (from !== to || to === 'booked') {
      addEvent(db, { accountId: account.id, estimateId: current.id, type: 'status_changed', data: { from, to, by, reason, booked_amount_cents: updates.booked_amount_cents }, now });
    }
    return getEstimate(db, account.id, current.id);
  })();
}

function resumeFollowups(db, cfg, account, estimate, now) {
  if (estimate.status === 'active') return;
  if (isSuppressed(db, account.id, estimate.customer_email)) throw new UserError('This customer opted out of emails, so follow-ups cannot restart.');
  if (estimate.status === 'bounced') throw new UserError('Fix the customer email address first; that restarts follow-ups.');
  if (LIMITED_STATUSES.indexOf(estimate.status) === -1 && countLimited(db, account.id) >= cfg.pricing.maxActiveEstimates) {
    throw new UserError(`You already have ${cfg.pricing.maxActiveEstimates} estimates being followed up, the most your plan includes.`);
  }
  const remaining = db.prepare(`SELECT * FROM followups WHERE estimate_id = ? AND status IN ('canceled', 'scheduled') ORDER BY step_position`).all(estimate.id);
  if (remaining.length === 0) throw new UserError('Every follow-up for this estimate has already been sent.');
  // Keep the original spacing, starting no sooner than one day from now so a resume never surprises a customer.
  const lastSent = db.prepare(`SELECT MAX(sent_at) t FROM followups WHERE estimate_id = ? AND status = 'sent'`).get(estimate.id).t;
  const earliest = Math.max(now + DAY, lastSent ? lastSent + DAY : 0);
  const shift = Math.max(0, earliest - remaining[0].scheduled_at);
  const upd = db.prepare(`UPDATE followups SET status = 'scheduled', scheduled_at = ?, error = NULL WHERE id = ?`);
  for (const f of remaining) upd.run(nextSendTime(f.scheduled_at + shift, account), f.id);
}

// Edits customer details. Changing a bounced email address restarts follow-ups.
export function updateEstimate(db, cfg, account, estimate, input, { now = Date.now(), sentAt } = {}) {
  const { values, errors } = cleanEstimateInput(input);
  if (errors.length) throw new UserError(errors.join(' '));
  return db.transaction(() => {
    db.prepare(`UPDATE estimates SET customer_name=@customer_name, customer_email=@customer_email, customer_phone=@customer_phone,
      job_address=@job_address, job_description=@job_description, amount_cents=@amount_cents, sent_at=@sent_at WHERE id=@id`)
      .run({ ...values, sent_at: sentAt ?? estimate.sent_at, id: estimate.id });
    addEvent(db, { accountId: account.id, estimateId: estimate.id, type: 'edited', data: {}, now });
    const emailChanged = values.customer_email !== estimate.customer_email.toLowerCase();
    if (emailChanged && estimate.status === 'bounced') {
      db.prepare(`UPDATE estimates SET status = 'paused' WHERE id = ?`).run(estimate.id);
      db.prepare(`UPDATE followups SET status = 'canceled' WHERE estimate_id = ? AND status = 'failed'`).run(estimate.id);
      return setStatus(db, cfg, account, { ...estimate, status: 'paused' }, 'active', { now, by: 'contractor', reason: 'email corrected' });
    }
    return getEstimate(db, account.id, estimate.id);
  })();
}

export function deleteEstimate(db, account, estimate) {
  db.transaction(() => {
    db.prepare('DELETE FROM followups WHERE estimate_id = ?').run(estimate.id);
    db.prepare('DELETE FROM events WHERE estimate_id = ?').run(estimate.id);
    db.prepare('DELETE FROM estimates WHERE id = ? AND account_id = ?').run(estimate.id, account.id);
  })();
}

export function suppress(db, accountId, email, reason, now = Date.now()) {
  db.prepare(`INSERT INTO suppressions(account_id, email, reason, created_at) VALUES(?, ?, ?, ?)
    ON CONFLICT(account_id, email) DO NOTHING`).run(accountId, email.toLowerCase(), reason, now);
}

// After the sending window changes, move already-scheduled emails into the new window
// so the dates shown in the app match when they'll actually go out.
export function realignSchedule(db, account) {
  const rows = db.prepare(`SELECT id, scheduled_at FROM followups WHERE account_id = ? AND status = 'scheduled'`).all(account.id);
  const upd = db.prepare('UPDATE followups SET scheduled_at = ? WHERE id = ?');
  db.transaction(() => {
    for (const f of rows) {
      const t = nextSendTime(f.scheduled_at, account);
      if (t !== f.scheduled_at) upd.run(t, f.id);
    }
  })();
}

// Plan/billing gate for sending to customers.
export function sendingAllowed(account, now = Date.now()) {
  if (account.sending_paused) return { ok: false, reason: 'You paused all sending in Settings.' };
  if (['active', 'past_due'].includes(account.plan_status)) return { ok: true };
  if (account.plan_status === 'trialing' && account.trial_ends_at && account.trial_ends_at > now) return { ok: true };
  return { ok: false, reason: 'Your subscription is not active yet, so follow-ups are on hold.' };
}
