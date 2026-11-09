// CSV import for existing open estimates. Accepts the column names most estimating tools
// and spreadsheets use, so contractors rarely need to rename anything.
import { cleanEstimateInput } from './services/estimates.js';
import { dateInputToTs } from './time.js';

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const COLUMNS = {
  customer_name: ['name', 'customer', 'customer name', 'client', 'client name', 'full name', 'contact', 'contact name'],
  first_name: ['first name', 'first', 'firstname'],
  last_name: ['last name', 'last', 'lastname', 'surname'],
  customer_email: ['email', 'e-mail', 'email address', 'customer email', 'client email'],
  customer_phone: ['phone', 'phone number', 'mobile', 'cell', 'customer phone'],
  job_address: ['address', 'job address', 'street', 'property address', 'service address', 'location'],
  job_description: ['job', 'description', 'job description', 'project', 'scope', 'title', 'estimate name', 'service'],
  amount: ['amount', 'total', 'estimate', 'estimate amount', 'estimate total', 'price', 'quote', 'value', 'quote total'],
  sent_at: ['date', 'sent', 'sent date', 'date sent', 'estimate date', 'created', 'created date', 'issued', 'quote date'],
};

export function mapHeader(header) {
  const map = {};
  header.forEach((h, i) => {
    const key = h.trim().toLowerCase().replace(/[_*]+/g, ' ').replace(/\s+/g, ' ');
    for (const [field, names] of Object.entries(COLUMNS)) {
      if (names.includes(key) && map[field] === undefined) map[field] = i;
    }
  });
  return map;
}

export function parseDate(value, tz) {
  const v = String(value || '').trim();
  if (!v) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(v);
  if (m) return dateInputToTs(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, tz);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/.exec(v);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return dateInputToTs(`${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`, tz);
  }
  return undefined; // present but unreadable
}

// Returns { rows: [{ line, input, sentAt, errors }], missing: [required columns not found] }
export function readEstimatesCsv(text, tz, now = Date.now()) {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], missing: [], empty: true };
  const map = mapHeader(table[0]);
  const missing = [];
  if (map.customer_name === undefined && map.first_name === undefined) missing.push('customer name');
  if (map.customer_email === undefined) missing.push('email');
  if (missing.length) return { rows: [], missing };

  const get = (r, f) => (map[f] === undefined ? '' : String(r[map[f]] ?? '').trim());
  const rows = table.slice(1).map((r, i) => {
    const name = get(r, 'customer_name') || [get(r, 'first_name'), get(r, 'last_name')].filter(Boolean).join(' ');
    const input = {
      customer_name: name, customer_email: get(r, 'customer_email'), customer_phone: get(r, 'customer_phone'),
      job_address: get(r, 'job_address'), job_description: get(r, 'job_description'), amount: get(r, 'amount'),
    };
    const { errors } = cleanEstimateInput(input);
    let sentAt = parseDate(get(r, 'sent_at'), tz);
    if (sentAt === undefined) errors.push(`Can't read the date "${get(r, 'sent_at')}". Use 2026-03-14 or 3/14/2026.`);
    if (sentAt === null || sentAt === undefined) sentAt = now;
    if (sentAt > now + 86400000) errors.push('The date is in the future.');
    return { line: i + 2, input, sentAt: Math.min(sentAt, now), errors };
  });
  return { rows, missing };
}
