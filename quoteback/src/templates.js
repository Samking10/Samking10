import { formatMoney } from './config.js';

export const MERGE_FIELDS = {
  customer_first_name: 'Customer first name (e.g. "Dana")',
  customer_name: 'Customer full name',
  job_description: 'What the estimate is for (e.g. "interior repaint, 3 bedrooms")',
  job_address: 'Job address',
  estimate_amount: 'Estimate total (e.g. "$4,200")',
  estimate_date: 'Date the estimate was sent',
  business_name: 'Your business name',
  owner_name: 'Your name',
  business_phone: 'Your phone number',
};

export function firstName(fullName) {
  const name = String(fullName || '').trim();
  if (!name) return 'there';
  return name.split(/\s+/)[0];
}

export function mergeValues({ account, estimate, formatDate }) {
  return {
    customer_first_name: firstName(estimate.customer_name),
    customer_name: estimate.customer_name,
    job_description: estimate.job_description || 'your painting project',
    job_address: estimate.job_address || '',
    estimate_amount: estimate.amount_cents ? formatMoney(estimate.amount_cents) : 'the estimate',
    estimate_date: formatDate ? formatDate(estimate.sent_at) : '',
    business_name: account.business_name,
    owner_name: account.owner_name || account.business_name,
    business_phone: account.phone || '',
  };
}

// Replaces {{field}} with values. Unknown fields are left visible so mistakes are noticed in previews.
export function renderTemplate(text, values) {
  return String(text).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, key) => (key in values ? String(values[key] ?? '') : match));
}

export function unknownFields(text) {
  const found = new Set();
  for (const m of String(text).matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) {
    if (!(m[1] in MERGE_FIELDS)) found.add(m[1]);
  }
  return [...found];
}
