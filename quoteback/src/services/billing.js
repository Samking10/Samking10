// Stripe billing using its REST API directly. Prices come from config, so changing
// PLAN_PRICE_CENTS changes checkout without touching the Stripe dashboard.
import crypto from 'node:crypto';

export function encodeForm(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encodeForm(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

async function stripe(cfg, path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.billing.stripeSecretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm(params),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe: ${json.error?.message || res.status}`);
  return json;
}

export async function createCheckout(cfg, account, userEmail, { includeOnboarding }) {
  const p = cfg.pricing;
  const lineItems = [{
    price_data: {
      currency: p.currency,
      unit_amount: p.monthlyPriceCents,
      recurring: { interval: 'month' },
      product_data: { name: `${p.planName} monthly plan` },
    },
    quantity: 1,
  }];
  const onboarding = includeOnboarding && p.onboardingFeeEnabled && p.onboardingFeeCents > 0 && !account.onboarding_paid;
  if (onboarding) {
    lineItems.push({
      price_data: { currency: p.currency, unit_amount: p.onboardingFeeCents, product_data: { name: 'Done-for-you setup and onboarding (one time)' } },
      quantity: 1,
    });
  }
  const session = await stripe(cfg, 'checkout/sessions', {
    mode: 'subscription',
    client_reference_id: String(account.id),
    customer: account.stripe_customer_id || undefined,
    customer_email: account.stripe_customer_id ? undefined : userEmail,
    line_items: lineItems,
    metadata: { account_id: String(account.id), onboarding: onboarding ? '1' : '0' },
    subscription_data: { metadata: { account_id: String(account.id) } },
    success_url: `${cfg.baseUrl}/app/billing?done=1`,
    cancel_url: `${cfg.baseUrl}/app/billing`,
    allow_promotion_codes: 'true',
  });
  return session.url;
}

export async function createPortal(cfg, account) {
  const session = await stripe(cfg, 'billing_portal/sessions', { customer: account.stripe_customer_id, return_url: `${cfg.baseUrl}/app/billing` });
  return session.url;
}

export function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  const items = String(header || '').split(',').map((kv) => kv.trim());
  const t = Number((items.find((kv) => kv.startsWith('t=')) || '').slice(2));
  const sigs = items.filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
  if (!t || !sigs.length || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

const STATUS_MAP = {
  active: 'active', trialing: 'trialing', past_due: 'past_due', unpaid: 'inactive',
  canceled: 'canceled', incomplete: 'inactive', incomplete_expired: 'canceled', paused: 'inactive',
};

export function applyStripeEvent(db, event) {
  const seen = db.prepare('INSERT OR IGNORE INTO stripe_events(id, type, received_at) VALUES(?, ?, ?)').run(event.id, event.type, Date.now());
  if (!seen.changes) return 'duplicate';
  const obj = event.data?.object || {};
  const findAccount = (accountId, subId, customerId) =>
    (accountId && db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(accountId)))
    || (subId && db.prepare('SELECT * FROM accounts WHERE stripe_subscription_id = ?').get(subId))
    || (customerId && db.prepare('SELECT * FROM accounts WHERE stripe_customer_id = ?').get(customerId));

  if (event.type === 'checkout.session.completed') {
    const account = findAccount(obj.client_reference_id || obj.metadata?.account_id);
    if (!account) return 'no_account';
    db.prepare(`UPDATE accounts SET stripe_customer_id = ?, stripe_subscription_id = ?, plan_status = 'active',
      onboarding_paid = MAX(onboarding_paid, ?) WHERE id = ?`)
      .run(obj.customer, obj.subscription, obj.metadata?.onboarding === '1' ? 1 : 0, account.id);
    return 'ok';
  }
  if (event.type.startsWith('customer.subscription.')) {
    const account = findAccount(obj.metadata?.account_id, obj.id, obj.customer);
    if (!account) return 'no_account';
    // Ignore updates about an older subscription once the account has moved to a new one.
    if (account.stripe_subscription_id && account.stripe_subscription_id !== obj.id) return 'stale';
    const status = event.type === 'customer.subscription.deleted' ? 'canceled' : (STATUS_MAP[obj.status] || 'inactive');
    db.prepare('UPDATE accounts SET plan_status = ?, stripe_subscription_id = ?, stripe_customer_id = ?, trial_ends_at = ? WHERE id = ?')
      .run(status, obj.id, obj.customer, obj.trial_end ? obj.trial_end * 1000 : account.trial_ends_at, account.id);
    return 'ok';
  }
  return 'ignored';
}
