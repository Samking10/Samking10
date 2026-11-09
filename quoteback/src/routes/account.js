import express from 'express';
import { html, money, date, csrf, flash, pct } from '../views/html.js';
import { page } from '../views/layout.js';
import { DAY, DAY_NAMES, parseSendDays, startOfLocalMonth } from '../time.js';
import { UserError, getSteps, sendingAllowed } from '../services/estimates.js';
import { updateSettings, saveSequence } from '../services/accounts.js';
import { periodStats, pipeline, stepPerformance } from '../services/stats.js';
import { MERGE_FIELDS, mergeValues, renderTemplate } from '../templates.js';
import { MAX_STEPS } from '../defaults.js';
import { composeFollowup } from '../email/compose.js';
import { createCheckout, createPortal } from '../services/billing.js';
import { hashPassword, verifyPassword } from '../auth.js';
import { formatMoney } from '../config.js';
import { go, accountBanners } from './app.js';

const COMMON_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];
const allZones = () => {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return COMMON_ZONES; }
};
const hourLabel = (h) => (h === 0 || h === 24 ? '12 AM' : h === 12 ? '12 PM' : h < 12 ? `${h} AM` : `${h - 12} PM`);

const SAMPLE = {
  id: 0, customer_name: 'Dana Whitfield', customer_email: 'dana@example.com', job_description: 'interior repaint, 3 bedrooms',
  amount_cents: 420000, sent_at: Date.now(), public_token: 'sample', job_address: '48 Elm St',
};

export function accountRoutes(ctx) {
  const { db, cfg } = ctx;
  const r = express.Router();

  // ---- Settings ----
  r.get('/settings', (req, res) => {
    const a = req.account;
    const days = parseSendDays(a.send_days);
    const zones = [...COMMON_ZONES, ...allZones().filter((z) => !COMMON_ZONES.includes(z))];
    if (!zones.includes(a.timezone)) zones.unshift(a.timezone);
    res.send(page({ req, title: 'Settings', body: html`
      ${flash(req)}
      <h1>Settings</h1>
      <form method="post" action="/app/settings">
        ${csrf(req)}
        <div class="card">
          <h2>Your business</h2>
          <div class="row">
            <div class="field"><label>Business name</label><input type="text" name="business_name" value="${a.business_name}" required></div>
            <div class="field"><label>Your name <span class="hint">(signs emails)</span></label><input type="text" name="owner_name" value="${a.owner_name}"></div>
          </div>
          <div class="row">
            <div class="field"><label>Phone <span class="hint">(shown to customers)</span></label><input type="tel" name="phone" value="${a.phone}"></div>
            <div class="field"><label>Send alerts to</label><input type="email" name="notify_email" value="${a.notify_email}" required></div>
          </div>
          <div class="field"><label>Business mailing address <span class="hint">(required in marketing emails by the CAN-SPAM Act; shown in the email footer)</span></label>
            <input type="text" name="business_address" value="${a.business_address}" placeholder="123 Main St, Springfield, IL 62701"></div>
          <div class="field"><label>Extra signature <span class="hint">(optional; added under every email)</span></label>
            <textarea name="email_signature" rows="3" placeholder="Licensed &amp; insured · brightlinepainting.com">${a.email_signature}</textarea></div>
        </div>

        <div class="card">
          <h2>When emails go out</h2>
          <div class="row">
            <div class="field"><label>Time zone</label><select name="timezone">${zones.map((z) => html`<option ${z === a.timezone ? 'selected' : ''}>${z}</option>`)}</select></div>
            <div class="field"><label>From</label><select name="send_window_start">${Array.from({ length: 24 }, (_, h) => html`<option value="${h}" ${h === a.send_window_start ? 'selected' : ''}>${hourLabel(h)}</option>`)}</select></div>
            <div class="field"><label>Until</label><select name="send_window_end">${Array.from({ length: 24 }, (_, i) => i + 1).map((h) => html`<option value="${h}" ${h === a.send_window_end ? 'selected' : ''}>${hourLabel(h)}</option>`)}</select></div>
          </div>
          <div class="field"><label>Days</label><div class="days">
            ${DAY_NAMES.map((n, i) => html`<label><input type="checkbox" name="send_days" value="${i}" ${days.includes(i) ? 'checked' : ''}>${n}</label>`)}
          </div></div>
          <label class="check"><input type="checkbox" name="include_response_link" value="1" ${a.include_response_link ? 'checked' : ''}>
            <span>Add a one-tap "ready to schedule / have a question" link to each email <span class="hint">(lets customers respond without typing)</span></span></label>
          <label class="check"><input type="checkbox" name="bcc_owner" value="1" ${a.bcc_owner ? 'checked' : ''}>
            <span>Send me a copy (BCC) of every follow-up</span></label>
          <label class="check"><input type="checkbox" name="sending_paused" value="1" ${a.sending_paused ? 'checked' : ''}>
            <span><strong>Pause all follow-ups</strong> <span class="hint">(e.g. while you're on vacation; they wait and resume when you uncheck this)</span></span></label>
        </div>
        <button class="btn">Save settings</button>
      </form>

      <div class="card" style="margin-top:20px">
        <h2>Change password</h2>
        <form method="post" action="/app/settings/password">
          ${csrf(req)}
          <div class="row">
            <div class="field"><label>Current password</label><input type="password" name="current" required autocomplete="current-password"></div>
            <div class="field"><label>New password</label><input type="password" name="password" minlength="8" required autocomplete="new-password"></div>
          </div>
          <button class="btn secondary">Update password</button>
        </form>
      </div>
      <p class="muted small">Logged in as ${req.user.email}. ${cfg.supportEmail ? html`Questions? <a href="mailto:${cfg.supportEmail}">${cfg.supportEmail}</a>` : ''}</p>` }));
  });

  r.post('/settings', (req, res) => {
    try {
      updateSettings(db, req.account, req.body);
      go(res, '/app/settings', { notice: 'Settings saved.' });
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      go(res, '/app/settings', { error: err.message });
    }
  });

  r.post('/settings/password', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(req.body.current || ''), user.password_hash)) return go(res, '/app/settings', { error: 'Current password is wrong.' });
    if (String(req.body.password || '').length < 8) return go(res, '/app/settings', { error: 'New password must be at least 8 characters.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), user.id);
    go(res, '/app/settings', { notice: 'Password updated.' });
  });

  // ---- Follow-up sequence ----
  r.get('/sequence', (req, res) => {
    const a = req.account;
    const steps = getSteps(db, a.id);
    const rows = [...steps];
    while (rows.length < Math.min(MAX_STEPS, steps.length + 1)) rows.push({ position: rows.length + 1, delay_days: '', subject: '', body: '' });
    res.send(page({ req, title: 'Follow-up emails', body: html`
      ${flash(req)}
      <div class="headline"><div><h1>Follow-up emails</h1>
        <p class="muted">Sent in order after you add an estimate. They stop as soon as the customer replies, responds, or you change the status.</p></div>
        <form method="post" action="/app/sequence/test">${csrf(req)}<button class="btn secondary">Send me a test of all ${steps.length}</button></form></div>
      <div class="grid two">
        <form method="post" action="/app/sequence">
          ${csrf(req)}
          ${rows.map((s, i) => html`<div class="step">
            <div class="step-head"><strong>Email ${i + 1}</strong>
              <label class="hint" style="display:flex;gap:6px;align-items:center;margin:0">
                <input type="number" min="1" max="90" name="delay_days_${i}" value="${s.delay_days}" ${i < steps.length ? 'required' : ''}> days after the estimate</label>
              ${i >= steps.length ? html`<span class="hint">(optional: fill in to add)</span>` : ''}
            </div>
            <div class="field"><label>Subject</label><input type="text" name="subject_${i}" value="${s.subject}"></div>
            <div class="field"><label>Message</label><textarea name="body_${i}" rows="8">${s.body}</textarea></div>
            ${i < steps.length && steps.length > 1 ? html`<label class="check small"><input type="checkbox" name="remove_${i}" value="1"> Remove this email</label>` : ''}
          </div>`)}
          <p class="muted small">Wording changes apply to every email that hasn't gone out yet. Timing changes apply to estimates you add from now on.</p>
          <button class="btn">Save emails</button>
        </form>
        <div>
          <div class="card"><h2>Fields you can use</h2>
            <table>${Object.entries(MERGE_FIELDS).map(([k, d]) => html`<tr><td><code>{{${k}}}</code></td><td class="small muted">${d}</td></tr>`)}</table></div>
          <div class="card"><h2>Preview</h2><p class="muted small">How email 1 looks for a sample customer, including the footer QuoteBack adds.</p>
            ${steps[0] ? html`<p class="small"><strong>Subject:</strong> ${composeFollowup(cfg, a, SAMPLE, steps[0]).subject}</p><div class="preview">${composeFollowup(cfg, a, SAMPLE, steps[0]).text}</div>` : ''}
          </div>
          <div class="card"><h2>Tips</h2><ul class="small">
            <li>Short and personal beats polished. These should read like you typed them on your phone.</li>
            <li>The last email ("should I close out your estimate?") usually gets the most replies.</li>
            <li>Don't promise discounts or deadlines you won't honor.</li></ul></div>
        </div>
      </div>` }));
  });

  r.post('/sequence', (req, res) => {
    const steps = [];
    for (let i = 0; i < MAX_STEPS; i++) {
      if (req.body[`remove_${i}`]) continue;
      if (req.body[`subject_${i}`] === undefined) continue;
      steps.push({ delay_days: req.body[`delay_days_${i}`], subject: req.body[`subject_${i}`], body: req.body[`body_${i}`] });
    }
    try {
      saveSequence(db, req.account.id, steps);
      go(res, '/app/sequence', { notice: 'Follow-up emails saved.' });
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      go(res, '/app/sequence', { error: err.message });
    }
  });

  r.post('/sequence/test', async (req, res) => {
    const a = req.account;
    const steps = getSteps(db, a.id);
    const sample = { ...SAMPLE, customer_name: a.owner_name || 'Test Customer', customer_email: a.notify_email };
    try {
      for (const step of steps) {
        const msg = composeFollowup(cfg, a, sample, step);
        msg.subject = `[Test ${step.position}/${steps.length}, day ${step.delay_days}] ${msg.subject}`;
        msg.replyTo = a.notify_email;
        msg.bcc = undefined;
        await ctx.transport.send(msg);
      }
      db.prepare('UPDATE accounts SET test_email_sent_at = ? WHERE id = ?').run(Date.now(), a.id);
      go(res, '/app/sequence', { notice: `Sent ${steps.length} test emails to ${a.notify_email}. Check your inbox (and spam folder).` });
    } catch (err) {
      go(res, '/app/sequence', { error: `Couldn't send the test: ${err.message}` });
    }
  });

  // ---- Billing ----
  r.get('/billing', (req, res) => {
    const a = req.account;
    const p = cfg.pricing;
    const gate = sendingAllowed(a);
    const statusText = {
      active: 'Active', trialing: 'Free trial', past_due: 'Payment failed, retrying', canceled: 'Canceled', inactive: 'Not active yet',
    }[a.plan_status] || a.plan_status;
    const onboardingOffer = p.onboardingFeeEnabled && p.onboardingFeeCents > 0 && !a.onboarding_paid;
    res.send(page({ req, title: 'Billing', narrow: true, body: html`
      ${flash(req)}
      ${req.query.done ? html`<div class="flash ok">Thanks! Your subscription is being activated. This page updates within a minute.</div>` : ''}
      <div class="card">
        <h1>Your plan</h1>
        <p><strong>${p.planName}</strong>: ${formatMoney(p.monthlyPriceCents, p.currency)}/month · up to ${p.maxActiveEstimates} active estimates · ${p.maxLocations === 1 ? '1 location' : `${p.maxLocations} locations`}</p>
        <p>Status: <strong>${statusText}</strong>${a.plan_status === 'trialing' && a.trial_ends_at ? ` (ends ${date(a.trial_ends_at, a)})` : ''}
          ${gate.ok ? html` · <span class="badge green">Follow-ups sending</span>` : html` · <span class="badge orange">Follow-ups on hold</span>`}</p>
        ${cfg.billing.mode === 'stripe' ? html`
          ${['active', 'past_due'].includes(a.plan_status) && a.stripe_customer_id
            ? html`<form method="post" action="/app/billing/portal">${csrf(req)}<button class="btn">Manage card, invoices or cancel</button></form>`
            : html`<form method="post" action="/app/billing/checkout">${csrf(req)}
              ${onboardingOffer ? html`<label class="check"><input type="checkbox" name="onboarding" value="1">
                <span>Add done-for-you setup (${formatMoney(p.onboardingFeeCents, p.currency)} one time). We import your open estimates and tune your emails with you on a call.</span></label>` : ''}
              <button class="btn" style="margin-top:10px">Subscribe with card</button></form>`}`
        : html`<p class="muted">${gate.ok ? 'Your account is active. ' : 'Your account is activated by the QuoteBack team once your first invoice is set up. '}
          ${cfg.supportEmail ? html`Billing questions: <a href="mailto:${cfg.supportEmail}">${cfg.supportEmail}</a>.` : ''}</p>`}
      </div>` }));
  });

  r.post('/billing/checkout', async (req, res) => {
    if (cfg.billing.mode !== 'stripe') return go(res, '/app/billing');
    try {
      res.redirect(303, await createCheckout(cfg, req.account, req.user.email, { includeOnboarding: !!req.body.onboarding }));
    } catch (err) {
      console.error('[billing]', err.message);
      go(res, '/app/billing', { error: "Couldn't open checkout. Please try again in a minute." });
    }
  });

  r.post('/billing/portal', async (req, res) => {
    if (cfg.billing.mode !== 'stripe' || !req.account.stripe_customer_id) return go(res, '/app/billing');
    try {
      res.redirect(303, await createPortal(cfg, req.account));
    } catch (err) {
      console.error('[billing]', err.message);
      go(res, '/app/billing', { error: "Couldn't open the billing portal. Please try again in a minute." });
    }
  });

  // ---- Results report ----
  r.get('/report', (req, res) => {
    const a = req.account;
    const now = Date.now();
    const monthStart = startOfLocalMonth(now, a.timezone);
    const lastMonthStart = startOfLocalMonth(monthStart - DAY, a.timezone);
    const periods = {
      '30d': { label: 'Last 30 days', from: now - 30 * DAY, to: now + 1, months: 1 },
      month: { label: 'This month', from: monthStart, to: now + 1, months: 1 },
      lastmonth: { label: 'Last month', from: lastMonthStart, to: monthStart, months: 1 },
      all: { label: 'Since you started', from: 0, to: now + 1, months: Math.max(1, Math.ceil((now - a.created_at) / (30 * DAY))) },
    };
    const key = periods[req.query.period] ? req.query.period : '30d';
    const per = periods[key];
    const s = periodStats(db, a.id, per.from, per.to);
    const pipe = pipeline(db, a.id);
    const steps = getSteps(db, a.id);
    const perf = stepPerformance(db, a.id);
    const booked = db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM followups f WHERE f.estimate_id = e.id AND f.status = 'sent' AND f.sent_at <= e.booked_at) fu
      FROM estimates e WHERE e.account_id = ? AND e.status = 'booked' AND e.booked_at >= ? AND e.booked_at < ? ORDER BY e.booked_at DESC`).all(a.id, per.from, per.to);
    const cost = cfg.pricing.monthlyPriceCents * per.months;
    const paying = ['active', 'past_due'].includes(a.plan_status);

    res.send(page({ req, title: 'Results', body: html`
      <div class="headline"><div><h1>Results</h1><p class="muted">${a.business_name} · ${per.label}</p></div>
        <button class="btn secondary no-print" data-print>Print / save PDF</button></div>
      <div class="tabs no-print">${Object.entries(periods).map(([k, v]) => html`<a class="${k === key ? 'on' : ''}" href="/app/report?period=${k}">${v.label}</a>`)}</div>

      <div class="stats">
        <div class="stat"><div class="n">${s.estimatesAdded}</div><div class="l">Estimates added</div></div>
        <div class="stat"><div class="n">${s.followupsSent}</div><div class="l">Follow-ups sent for you</div></div>
        <div class="stat"><div class="n">${s.respondedAfterFollowup}</div><div class="l">Customers who responded after a follow-up</div></div>
        <div class="stat"><div class="n">${pct(s.responseRate)}</div><div class="l">Response rate of followed-up estimates</div></div>
        <div class="stat"><div class="n">${s.bookedAfterFollowupJobs}</div><div class="l">Jobs booked after a follow-up</div></div>
        <div class="stat"><div class="n">${money(s.bookedAfterFollowupCents)}</div><div class="l">Booked after a follow-up</div></div>
      </div>

      ${paying && s.bookedAfterFollowupCents > 0 ? html`<div class="card"><p style="margin:0">Jobs booked after a QuoteBack follow-up are worth <strong>${money(s.bookedAfterFollowupCents)}</strong>
        in this period, compared with <strong>${money(cost)}</strong> for QuoteBack${per.months > 1 ? ` (${per.months} months)` : ''}.</p>
        <p class="muted small" style="margin:6px 0 0">"After a follow-up" means at least one QuoteBack email went out before the job was marked booked. Some of these customers might have booked anyway.</p></div>` : ''}

      <div class="grid two">
        <div class="card"><h2>Open pipeline</h2>
          <p><strong>${pipe.openCount}</strong> open estimates worth <strong>${money(pipe.openCents)}</strong></p>
          <p class="muted small">Total booked so far: ${pipe.byStatus.booked?.n || 0} jobs. Lost: ${pipe.byStatus.lost?.n || 0}. No response after all follow-ups: ${pipe.byStatus.no_response?.n || 0}.</p></div>
        <div class="card"><h2>Which emails get responses</h2>
          ${perf.length === 0 ? html`<p class="muted">Shows up after your first follow-ups go out.</p>` : html`<table><tr><th>Email</th><th class="num">Sent</th><th class="num">Responses</th></tr>
          ${perf.map((x) => html`<tr><td>#${x.position} <span class="muted small">${renderTemplate(steps.find((s2) => s2.position === x.position)?.subject || '(removed)', mergeValues({ account: a, estimate: SAMPLE }))}</span></td><td class="num">${x.sent}</td><td class="num">${x.responses} <span class="muted small">${pct(x.sent ? x.responses / x.sent : null)}</span></td></tr>`)}
          </table><p class="muted small">All time. A response is credited to the most recent email before it.</p>`}</div>
      </div>

      <div class="card"><h2>Booked jobs</h2>
        ${booked.length === 0 ? html`<p class="muted">None in this period yet. When you win a job, open the estimate and mark it Booked so it counts here.</p>` : html`<div class="table-wrap"><table>
          <tr><th>Customer</th><th>Booked</th><th class="num">Amount</th><th>Follow-ups before booking</th></tr>
          ${booked.map((e) => html`<tr><td><a href="/app/estimates/${e.id}">${e.customer_name}</a><div class="muted small">${e.job_description}</div></td>
            <td class="small">${date(e.booked_at, a)}</td><td class="num">${money(e.booked_amount_cents)}</td><td>${e.fu}</td></tr>`)}
        </table></div>`}
      </div>` }));
  });

  return r;
}

export { accountBanners };
