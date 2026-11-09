// Tiny HTML templating: html`...` escapes every interpolated value unless it is
// itself html`...` (or raw()). Arrays are joined. null/undefined/false render nothing.
import { escapeHtml } from '../email/compose.js';
import { formatMoney } from '../config.js';
import { formatDate } from '../time.js';
import { STATUSES } from '../services/estimates.js';

class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

export const raw = (s) => new Safe(String(s));

function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeHtml(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return new Safe(out);
}

export const money = (cents) => formatMoney(cents);
export const date = (ts, account, withTime = false) => formatDate(ts, account?.timezone || 'America/New_York', withTime);

export function statusBadge(status) {
  const s = STATUSES[status] || { label: status, tone: 'gray' };
  return html`<span class="badge ${s.tone}" title="${s.help || ''}">${s.label}</span>`;
}

export const csrf = (req) => html`<input type="hidden" name="_csrf" value="${req.csrfToken || ''}">`;

export function flash(req) {
  const notice = req.query?.notice;
  const error = req.query?.error;
  return html`${notice ? html`<div class="flash ok">${notice}</div>` : ''}${error ? html`<div class="flash err">${error}</div>` : ''}`;
}

export function pct(n) {
  return n === null || n === undefined ? '–' : `${Math.round(n * 100)}%`;
}
