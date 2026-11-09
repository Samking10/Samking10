import { mergeValues, renderTemplate } from '../templates.js';
import { formatDate } from '../time.js';

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function displayName(name) {
  return String(name || 'QuoteBack').replace(/["\\\r\n<>]/g, '').slice(0, 70);
}

export function fromHeader(cfg, name) {
  return `"${displayName(name)}" <${cfg.email.fromEmail}>`;
}

export function replyToFor(cfg, account, estimate) {
  if (cfg.email.inboundDomain) return `reply+${estimate.public_token}@${cfg.email.inboundDomain}`;
  return account.notify_email;
}

export function textToHtml(text) {
  const paragraphs = String(text).split(/\n{2,}/).map((p) => {
    const linked = escapeHtml(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>');
    return `<p style="margin:0 0 14px">${linked}</p>`;
  });
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222">${paragraphs.join('')}</div>`;
}

export function responseUrl(cfg, estimate) {
  return `${cfg.baseUrl}/r/${estimate.public_token}`;
}

export function unsubscribeUrl(cfg, estimate) {
  return `${cfg.baseUrl}/u/${estimate.public_token}`;
}

// Builds a customer follow-up email from a sequence step.
export function composeFollowup(cfg, account, estimate, step) {
  const values = mergeValues({ account, estimate, formatDate: (ts) => formatDate(ts, account.timezone) });
  const subject = renderTemplate(step.subject, values).replace(/[\r\n]+/g, ' ').trim();
  let body = renderTemplate(step.body, values).trim();
  if (account.email_signature?.trim()) body += `\n\n${account.email_signature.trim()}`;

  const footer = [];
  if (account.include_response_link) {
    footer.push(`Ready to schedule, or have a question? Let us know with one tap:\n${responseUrl(cfg, estimate)}`);
  }
  const address = [account.business_name, account.business_address].filter(Boolean).join(', ');
  footer.push(`${address}\nNo more follow-ups about this estimate: ${unsubscribeUrl(cfg, estimate)}`);
  const text = `${body}\n\n--\n${footer.join('\n\n')}`;

  return {
    to: estimate.customer_email,
    from: fromHeader(cfg, account.business_name),
    replyTo: replyToFor(cfg, account, estimate),
    bcc: account.bcc_owner ? account.notify_email : undefined,
    subject,
    text,
    html: textToHtml(text),
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl(cfg, estimate)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    tag: 'followup',
  };
}

// Plain emails from QuoteBack to the contractor (alerts, password resets).
export function composeNotice(cfg, { to, subject, text, replyTo }) {
  return {
    to,
    from: fromHeader(cfg, 'QuoteBack'),
    replyTo,
    subject,
    text: `${text}\n\n--\nQuoteBack · ${cfg.baseUrl}/app`,
    html: textToHtml(`${text}\n\n--\nQuoteBack · ${cfg.baseUrl}/app`),
    tag: 'notice',
  };
}
