import express from 'express';
import crypto from 'node:crypto';
import { verifyStripeSignature, applyStripeEvent } from '../services/billing.js';
import { handleInboundEmail, handleBounce } from '../services/customer.js';

function secretMatches(sent, secret) {
  const a = Buffer.from(String(sent || ''));
  const b = Buffer.from(String(secret || ''));
  return secret && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Postmark webhooks are authenticated with HTTP basic auth (https://user:SECRET@host/...)
// or a ?token=SECRET query parameter.
function postmarkAuth(cfg) {
  return (req, res, next) => {
    const secret = cfg.email.inboundWebhookSecret;
    const basic = /^Basic (.+)$/.exec(req.headers.authorization || '');
    const password = basic ? Buffer.from(basic[1], 'base64').toString().split(':').slice(1).join(':') : '';
    if (secretMatches(req.query.token, secret) || secretMatches(password, secret)) return next();
    res.status(401).json({ error: 'unauthorized' });
  };
}

export function webhookRoutes(ctx) {
  const { db, cfg } = ctx;
  const r = express.Router();

  r.post('/stripe', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const raw = req.body.toString('utf8');
    if (!cfg.billing.stripeWebhookSecret || !verifyStripeSignature(raw, req.headers['stripe-signature'], cfg.billing.stripeWebhookSecret)) {
      return res.status(400).json({ error: 'bad signature' });
    }
    const result = applyStripeEvent(db, JSON.parse(raw));
    res.json({ received: true, result });
  });

  r.post('/postmark/inbound', express.json({ limit: '10mb' }), postmarkAuth(cfg), async (req, res) => {
    const result = await handleInboundEmail(ctx, req.body || {});
    // Always 200 so Postmark doesn't retry mail we intentionally ignore.
    res.json(result);
  });

  r.post('/postmark/bounce', express.json({ limit: '1mb' }), postmarkAuth(cfg), async (req, res) => {
    res.json(await handleBounce(ctx, req.body || {}));
  });

  return r;
}
