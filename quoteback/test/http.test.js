import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/server.js';
import { makeCtx, makeAccount, estimateById, customer } from './helpers.js';
import { createEstimate } from '../src/services/estimates.js';
import { verifyStripeSignature } from '../src/services/billing.js';

async function start(overrides) {
  const ctx = makeCtx({ BILLING_MODE: 'stripe', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', ...overrides });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ctx, base, close: () => server.close() };
}

function stripeSign(body, secret = 'whsec_test', t = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

test('stripe signature check rejects tampering and old timestamps', () => {
  const body = '{"a":1}';
  assert.ok(verifyStripeSignature(body, stripeSign(body), 'whsec_test'));
  assert.ok(!verifyStripeSignature('{"a":2}', stripeSign(body), 'whsec_test'));
  assert.ok(!verifyStripeSignature(body, stripeSign(body, 'whsec_test', Math.floor(Date.now() / 1000) - 3600), 'whsec_test'));
});

test('stripe webhooks activate and cancel an account, ignoring duplicates', async (t) => {
  const { ctx, base, close } = await start();
  t.after(close);
  const account = makeAccount(ctx, { active: false });
  const send = (event) => {
    const body = JSON.stringify(event);
    return fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': stripeSign(body), 'content-type': 'application/json' }, body });
  };
  const bad = await fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=00' }, body: '{}' });
  assert.equal(bad.status, 400);

  const completed = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { client_reference_id: String(account.id), customer: 'cus_1', subscription: 'sub_1', metadata: { onboarding: '1' } } } };
  assert.equal((await (await send(completed)).json()).result, 'ok');
  let a = ctx.db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id);
  assert.equal(a.plan_status, 'active');
  assert.equal(a.onboarding_paid, 1);
  assert.equal((await (await send(completed)).json()).result, 'duplicate');

  await send({ id: 'evt_2', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: {} } } });
  a = ctx.db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id);
  assert.equal(a.plan_status, 'canceled');
});

test('inbound email webhook requires the secret and stops follow-ups', async (t) => {
  const { ctx, base, close } = await start();
  t.after(close);
  const account = makeAccount(ctx);
  const est = createEstimate(ctx.db, ctx.cfg, account, customer(), { sentAt: Date.now() });
  const payload = JSON.stringify({ MailboxHash: est.public_token, FromFull: { Email: 'dana@example.com' }, Subject: 'Re: estimate', TextBody: 'Yes please' });
  const denied = await fetch(`${base}/webhooks/postmark/inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
  assert.equal(denied.status, 401);
  const auth = `Basic ${Buffer.from('postmark:inbound-secret').toString('base64')}`;
  const ok = await fetch(`${base}/webhooks/postmark/inbound`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: payload });
  assert.deepEqual(await ok.json(), { matched: true, auto: false });
  assert.equal(estimateById(ctx, est.id).status, 'replied');
});

test('customer links: opening them changes nothing; submitting does', async (t) => {
  const { ctx, base, close } = await start();
  t.after(close);
  const account = makeAccount(ctx);
  const est = createEstimate(ctx.db, ctx.cfg, account, customer(), { sentAt: Date.now() });
  const page = await fetch(`${base}/r/${est.public_token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Brightline Painting/);
  await fetch(`${base}/u/${est.public_token}`);
  assert.equal(estimateById(ctx, est.id).status, 'active', 'GET must not act (link scanners)');
  await fetch(`${base}/u/${est.public_token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(estimateById(ctx, est.id).status, 'unsubscribed');
  assert.equal((await fetch(`${base}/r/not-a-real-token`)).status, 404);
});

test('signup, login, CSRF protection and account isolation', async (t) => {
  const { ctx, base, close } = await start();
  t.after(close);
  const form = (o) => new URLSearchParams(o).toString();
  const post = (path, body, cookie) => fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: form(body) });

  const signup = await post('/signup', { business_name: 'Coat & Co', owner_name: 'Ana', email: 'ana@coat.test', password: 'longpassword', timezone: 'America/Denver' });
  assert.equal(signup.status, 302);
  const cookie = signup.headers.get('set-cookie').split(';')[0];
  const dash = await (await fetch(`${base}/app`, { headers: { cookie } })).text();
  assert.match(dash, /Coat &amp; Co/);
  assert.match(dash, /Get set up/);

  // No CSRF token: rejected.
  const noCsrf = await post('/app/estimates', { customer_name: 'X', customer_email: 'x@y.com' }, cookie);
  assert.equal(noCsrf.status, 403);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(dash)[1];
  const created = await post('/app/estimates', { _csrf: csrf, customer_name: 'Lee', customer_email: 'lee@y.com', amount: '1200', sent_date: '' }, cookie);
  assert.equal(created.status, 302);
  assert.match(created.headers.get('location'), /\/app\/estimates\/\d+/);

  // Another account can't see it.
  const other = makeAccount(ctx);
  const otherEst = createEstimate(ctx.db, ctx.cfg, other, customer(), { sentAt: Date.now() });
  assert.equal((await fetch(`${base}/app/estimates/${otherEst.id}`, { headers: { cookie } })).status, 404);

  // Wrong password.
  assert.equal((await post('/login', { email: 'ana@coat.test', password: 'nope' })).status, 401);
  assert.equal((await post('/login', { email: 'ana@coat.test', password: 'longpassword' })).status, 302);
  // Admin is hidden from non-admins.
  assert.equal((await fetch(`${base}/admin`, { headers: { cookie } })).status, 404);
});

test('landing page shows pricing from config', async (t) => {
  const { base, close } = await start({ PLAN_PRICE_CENTS: '34900', MAX_ACTIVE_ESTIMATES: '300' });
  t.after(close);
  const html = await (await fetch(base)).text();
  assert.match(html, /\$349/);
  assert.match(html, /Up to 300 estimates/);
});
