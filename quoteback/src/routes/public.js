import express from 'express';
import { html, flash } from '../views/html.js';
import { page } from '../views/layout.js';
import { formatMoney } from '../config.js';
import { createSession, destroySession, verifyPassword, rateLimiter, verifyCsrf } from '../auth.js';
import { createAccount, createPasswordReset, usePasswordReset } from '../services/accounts.js';
import { UserError } from '../services/estimates.js';
import { RESPONSE_CHOICES, findByToken, recordResponse, unsubscribe } from '../services/customer.js';
import { composeNotice } from '../email/compose.js';

const safeNext = (n) => (typeof n === 'string' && /^\/app(\/|$|\?)/.test(n) ? n : '/app');

export function publicRoutes(ctx) {
  const { db, cfg } = ctx;
  const r = express.Router();
  const loginLimit = rateLimiter({ max: 10 });
  const resetLimit = rateLimiter({ max: 5 });
  const signupLimit = rateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });
  const p = cfg.pricing;

  r.get('/', (req, res) => {
    if (req.user) return res.redirect('/app');
    res.send(page({ req, title: 'Estimate follow-up for painting contractors', body: html`
      <section class="hero">
        <h1>Follow up on every estimate. Keep interested customers from slipping away.</h1>
        <p>QuoteBack sends polite, personal follow-up emails on the estimates you've sent, stops the moment a customer responds,
        and shows you which conversations turned into booked jobs.</p>
        <div class="actions"><a class="btn" href="/signup">Set up your account</a><a class="btn secondary" href="#how">How it works</a></div>
      </section>
      <section id="how" class="grid two">
        <div class="card"><h2>1. Add your open estimates</h2><p>Type them in or paste a spreadsheet export. Takes about two minutes per batch.</p></div>
        <div class="card"><h2>2. QuoteBack follows up for you</h2><p>A short series of emails written for residential painting, sent from your business name during your business hours. Edit any of them.</p></div>
        <div class="card"><h2>3. Customers reply to you</h2><p>Replies land in your inbox. Follow-ups stop automatically when a customer replies, taps "I'd like to schedule", or opts out.</p></div>
        <div class="card"><h2>4. See what it's worth</h2><p>Track which estimates got a response and which turned into booked jobs, and how much they were worth.</p></div>
      </section>
      <section class="card">
        <h2>Pricing</h2>
        <div class="price">${formatMoney(p.monthlyPriceCents, p.currency)}<span class="muted small"> / month</span></div>
        <ul>
          <li>${p.maxLocations === 1 ? 'One business location' : `Up to ${p.maxLocations} locations`}</li>
          <li>Up to ${p.maxActiveEstimates} estimates being followed up at a time</li>
          <li>Email follow-ups with automatic stop on reply</li>
          ${p.trialDays > 0 ? html`<li>${p.trialDays}-day free trial</li>` : ''}
          ${p.onboardingFeeEnabled && p.onboardingFeeCents > 0 ? html`<li>Optional done-for-you setup: ${formatMoney(p.onboardingFeeCents, p.currency)} one time. We import your estimates and tune your emails with you.</li>` : ''}
        </ul>
        <p class="muted small">Cancel any time from your billing page.</p>
        <a class="btn" href="/signup">Get started</a>
      </section>`,
    }));
  });

  // ---- Signup / login ----
  const signupForm = (req, error, v = {}) => page({ req, narrow: true, title: 'Create your account', body: html`
    <div class="card">
      <h1>Create your account</h1>
      <p class="muted">You can set everything up and send yourself test emails before any customer gets a follow-up.</p>
      ${error ? html`<div class="flash err">${error}</div>` : ''}
      <form method="post" action="/signup">
        <div class="field"><label>Business name</label><input type="text" name="business_name" value="${v.business_name || ''}" required placeholder="Brightline Painting"></div>
        <div class="field"><label>Your name <span class="hint">(signs the emails)</span></label><input type="text" name="owner_name" value="${v.owner_name || ''}" placeholder="Sam Rivera"></div>
        <div class="field"><label>Email</label><input type="email" name="email" value="${v.email || ''}" required autocomplete="email"></div>
        <div class="field"><label>Password <span class="hint">(8+ characters)</span></label><input type="password" name="password" required minlength="8" autocomplete="new-password"></div>
        <input type="hidden" name="timezone" data-detect-tz value="${v.timezone || ''}">
        <button class="btn block">Create account</button>
      </form>
    </div>
    <p class="muted small">Already have an account? <a href="/login">Log in</a></p>` });

  r.get('/signup', (req, res) => (req.user ? res.redirect('/app') : res.send(signupForm(req))));
  r.post('/signup', (req, res) => {
    if (!signupLimit(req.ip)) return res.status(429).send(signupForm(req, 'Too many signups from this network. Try again later.', req.body));
    try {
      const { userId } = createAccount(db, cfg, req.body);
      createSession(db, cfg, res, userId);
      res.redirect('/app');
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      res.status(400).send(signupForm(req, err.message, req.body));
    }
  });

  const loginForm = (req, error) => page({ req, narrow: true, title: 'Log in', body: html`
    <div class="card">
      <h1>Log in</h1>
      ${flash(req)}
      ${error ? html`<div class="flash err">${error}</div>` : ''}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${safeNext(req.query.next || req.body?.next)}">
        <div class="field"><label>Email</label><input type="email" name="email" required autocomplete="email" value="${req.body?.email || ''}"></div>
        <div class="field"><label>Password</label><input type="password" name="password" required autocomplete="current-password"></div>
        <button class="btn block">Log in</button>
      </form>
    </div>
    <p class="muted small"><a href="/forgot">Forgot your password?</a> · <a href="/signup">Create an account</a></p>` });

  r.get('/login', (req, res) => (req.user ? res.redirect('/app') : res.send(loginForm(req))));
  r.post('/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!loginLimit(`${req.ip}|${email}`)) return res.status(429).send(loginForm(req, 'Too many attempts. Wait 15 minutes and try again.'));
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
      return res.status(401).send(loginForm(req, 'That email and password don\'t match.'));
    }
    createSession(db, cfg, res, user.id);
    res.redirect(safeNext(req.body.next));
  });

  r.post('/logout', verifyCsrf, (req, res) => {
    destroySession(db, req, res);
    res.redirect('/');
  });

  // ---- Password reset ----
  r.get('/forgot', (req, res) => res.send(page({ req, narrow: true, title: 'Reset password', body: html`
    <div class="card"><h1>Reset your password</h1>
    <form method="post" action="/forgot"><div class="field"><label>Email</label><input type="email" name="email" required></div>
    <button class="btn block">Email me a reset link</button></form></div>` })));

  r.post('/forgot', async (req, res) => {
    if (resetLimit(req.ip)) {
      const reset = createPasswordReset(db, req.body.email);
      if (reset) {
        await ctx.transport.send(composeNotice(cfg, {
          to: reset.user.email,
          subject: 'Reset your QuoteBack password',
          text: `Someone asked to reset your QuoteBack password. If it was you, open this link within 2 hours:\n\n${cfg.baseUrl}/reset/${reset.token}\n\nIf it wasn't you, ignore this email.`,
        })).catch((err) => console.error('[reset]', err.message));
      }
    }
    res.redirect('/login?notice=' + encodeURIComponent('If that email has an account, a reset link is on its way.'));
  });

  const resetForm = (req, error) => page({ req, narrow: true, title: 'Choose a new password', body: html`
    <div class="card"><h1>Choose a new password</h1>
    ${error ? html`<div class="flash err">${error}</div>` : ''}
    <form method="post"><div class="field"><label>New password</label><input type="password" name="password" minlength="8" required autocomplete="new-password"></div>
    <button class="btn block">Save password</button></form></div>` });

  r.get('/reset/:token', (req, res) => res.send(resetForm(req)));
  r.post('/reset/:token', (req, res) => {
    try {
      usePasswordReset(db, req.params.token, req.body.password);
      res.redirect('/login?notice=' + encodeURIComponent('Password updated. Log in with your new password.'));
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      res.status(400).send(resetForm(req, err.message));
    }
  });

  // ---- Customer-facing pages (linked from follow-up emails) ----
  // GET never changes anything: email security scanners open links automatically.
  const customerPage = (title, body) => page({ title, nav: false, header: false, body: html`<div class="public-box">${body}</div>` });
  const notFound = (res) => res.status(404).send(customerPage('Link not found', html`<div class="card"><h1>This link isn't valid</h1><p>It may have been copied incompletely.</p></div>`));

  r.get('/r/:token', (req, res) => {
    const found = findByToken(db, req.params.token);
    if (!found) return notFound(res);
    const { estimate, account } = found;
    res.send(customerPage(account.business_name, html`
      <div class="card">
        <h1>${account.business_name}</h1>
        <p class="muted">Estimate for ${estimate.job_description || 'your painting project'}${estimate.amount_cents ? ` · ${formatMoney(estimate.amount_cents)}` : ''}</p>
        <form method="post">
          ${Object.entries(RESPONSE_CHOICES).map(([key, c], i) => html`<label class="choice"><input type="radio" name="choice" value="${key}" ${i === 0 ? 'checked' : ''}>${c.label}</label>`)}
          <div class="field"><label>Anything you'd like to add? <span class="hint">(optional)</span></label>
          <textarea name="message" placeholder="Best time to reach you, questions about colors, timing..."></textarea></div>
          <button class="btn block">Send to ${account.owner_name || account.business_name}</button>
        </form>
      </div>
      <p class="muted small">You can also just reply to the email${account.phone ? html` or call ${account.phone}` : ''}.</p>`));
  });

  r.post('/r/:token', async (req, res) => {
    const found = findByToken(db, req.params.token);
    if (!found) return notFound(res);
    const choice = RESPONSE_CHOICES[req.body.choice] ? req.body.choice : 'question';
    await recordResponse(ctx, req.params.token, choice, req.body.message);
    const { account } = found;
    const interested = RESPONSE_CHOICES[choice].status === 'interested';
    res.send(customerPage('Thanks', html`<div class="card"><h1>Thanks, we got it.</h1>
      <p>${interested ? `${account.owner_name || account.business_name} will be in touch soon.` : `Thanks for letting us know. ${account.business_name} won't send more follow-ups about this estimate.`}</p>
      ${account.phone ? html`<p class="muted">Need us sooner? Call ${account.phone}.</p>` : ''}</div>`));
  });

  r.get('/u/:token', (req, res) => {
    const found = findByToken(db, req.params.token);
    if (!found) return notFound(res);
    res.send(customerPage('Stop emails', html`<div class="card"><h1>Stop follow-up emails?</h1>
      <p>${found.account.business_name} won't email you about this estimate again.</p>
      <form method="post"><button class="btn block">Yes, stop the emails</button></form></div>`));
  });

  // Also handles one-click unsubscribe from mail apps (RFC 8058).
  r.post('/u/:token', async (req, res) => {
    const found = await unsubscribe(ctx, req.params.token);
    if (!found) return notFound(res);
    res.send(customerPage('Unsubscribed', html`<div class="card"><h1>Done</h1><p>You won't get more follow-ups from ${found.account.business_name} about this estimate.</p></div>`));
  });

  return r;
}
