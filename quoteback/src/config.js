// All settings come from environment variables so nothing is hardcoded.
// Pricing lives here and only here; every page and Stripe checkout reads from it.

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be a whole number, got "${v}"`);
  return n;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function list(name) {
  return (process.env[name] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function loadConfig() {
  const env = process.env;
  const isProd = env.NODE_ENV === 'production';
  const cfg = {
    isProd,
    port: int('PORT', 3000),
    baseUrl: (env.BASE_URL || `http://localhost:${int('PORT', 3000)}`).replace(/\/$/, ''),
    databasePath: env.DATABASE_PATH || 'data/quoteback.db',
    adminEmails: list('ADMIN_EMAILS'),
    // Shown to contractors for help and (in manual billing) to activate their account.
    supportEmail: env.SUPPORT_EMAIL || '',

    pricing: {
      planName: env.PLAN_NAME || 'QuoteBack',
      monthlyPriceCents: int('PLAN_PRICE_CENTS', 29900),
      onboardingFeeCents: int('ONBOARDING_FEE_CENTS', 29900),
      // "optional": the contractor can choose done-for-you setup at checkout.
      onboardingFeeEnabled: bool('ONBOARDING_FEE_ENABLED', true),
      maxActiveEstimates: int('MAX_ACTIVE_ESTIMATES', 250),
      maxLocations: int('MAX_LOCATIONS', 1),
      trialDays: int('TRIAL_DAYS', 0),
      currency: (env.CURRENCY || 'usd').toLowerCase(),
    },

    billing: {
      // "stripe": contractors pay by card through Stripe Checkout.
      // "manual": you invoice them yourself and switch accounts on in /admin.
      mode: env.BILLING_MODE || 'manual',
      stripeSecretKey: env.STRIPE_SECRET_KEY || '',
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    },

    email: {
      // "log": nothing leaves the server; emails are viewable at /dev/outbox.
      // "postmark" or "resend": real delivery.
      transport: env.EMAIL_TRANSPORT || 'log',
      fromEmail: env.FROM_EMAIL || 'followups@example.com',
      postmarkToken: env.POSTMARK_SERVER_TOKEN || '',
      postmarkStream: env.POSTMARK_MESSAGE_STREAM || 'outbound',
      resendApiKey: env.RESEND_API_KEY || '',
      // Replies go to reply+<token>@INBOUND_DOMAIN so QuoteBack can see them and stop follow-ups.
      inboundDomain: env.INBOUND_DOMAIN || '',
      inboundWebhookSecret: env.INBOUND_WEBHOOK_SECRET || '',
    },

    scheduler: {
      enabled: bool('SCHEDULER_ENABLED', true),
      intervalSeconds: int('SCHEDULER_INTERVAL_SECONDS', 60),
      batchSize: int('SCHEDULER_BATCH_SIZE', 50),
      // Never email the same address twice within this many hours (covers duplicate estimates).
      minHoursBetweenEmailsToSameAddress: int('MIN_HOURS_BETWEEN_EMAILS', 20),
      maxSendAttempts: int('MAX_SEND_ATTEMPTS', 4),
    },
  };

  if (!['stripe', 'manual'].includes(cfg.billing.mode)) throw new Error('BILLING_MODE must be "stripe" or "manual"');
  if (!['log', 'postmark', 'resend'].includes(cfg.email.transport)) throw new Error('EMAIL_TRANSPORT must be log, postmark or resend');
  if (cfg.billing.mode === 'stripe' && (!cfg.billing.stripeSecretKey || !cfg.billing.stripeWebhookSecret)) {
    throw new Error('BILLING_MODE=stripe needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET');
  }
  if (cfg.email.transport === 'postmark' && !cfg.email.postmarkToken) throw new Error('EMAIL_TRANSPORT=postmark needs POSTMARK_SERVER_TOKEN');
  if (cfg.email.transport === 'resend' && !cfg.email.resendApiKey) throw new Error('EMAIL_TRANSPORT=resend needs RESEND_API_KEY');
  if (cfg.email.inboundDomain && !cfg.email.inboundWebhookSecret) throw new Error('INBOUND_DOMAIN needs INBOUND_WEBHOOK_SECRET');
  if (isProd && cfg.email.transport === 'log') console.warn('[config] EMAIL_TRANSPORT=log in production: no emails will be delivered.');
  return cfg;
}

export function formatMoney(cents, currency = 'usd') {
  const n = (cents || 0) / 100;
  return n.toLocaleString('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: n % 1 === 0 ? 0 : 2 });
}
