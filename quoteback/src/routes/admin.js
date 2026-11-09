// Operator page for you (the QuoteBack owner): see every account's health at a glance
// and switch accounts on/off when billing manually.
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { html, money, date, csrf, flash } from '../views/html.js';
import { page } from '../views/layout.js';
import { DAY, HOUR } from '../time.js';
import { getMeta } from '../db.js';
import { go } from './app.js';

const PLAN_STATUSES = ['inactive', 'trialing', 'active', 'past_due', 'canceled'];

export function adminRoutes(ctx) {
  const { db, cfg } = ctx;
  const r = express.Router();

  r.get('/', (req, res) => {
    const now = Date.now();
    const lastTick = Number(getMeta(db, 'last_tick_at') || 0);
    const overdue = db.prepare(`SELECT COUNT(*) n FROM followups f JOIN accounts a ON a.id = f.account_id
      WHERE f.status = 'scheduled' AND f.scheduled_at < ? AND a.plan_status IN ('active', 'past_due', 'trialing') AND a.sending_paused = 0`).get(now - 2 * HOUR).n;
    const failed7 = db.prepare(`SELECT COUNT(*) n FROM events WHERE type = 'send_failed' AND created_at > ?`).get(now - 7 * DAY).n;
    const accounts = db.prepare(`SELECT a.*,
        (SELECT email FROM users u WHERE u.account_id = a.id ORDER BY id LIMIT 1) login,
        (SELECT COUNT(*) FROM estimates e WHERE e.account_id = a.id AND e.status IN ('active', 'paused')) active_estimates,
        (SELECT COUNT(*) FROM followups f WHERE f.account_id = a.id AND f.status = 'sent' AND f.sent_at > @week) sent7,
        (SELECT COUNT(*) FROM followups f WHERE f.account_id = a.id AND f.status = 'failed') failed,
        (SELECT COUNT(*) FROM estimates e WHERE e.account_id = a.id AND e.status = 'booked') booked,
        (SELECT MAX(created_at) FROM estimates e WHERE e.account_id = a.id) last_estimate
      FROM accounts a ORDER BY a.created_at DESC`).all({ week: now - 7 * DAY });
    const paying = accounts.filter((a) => a.plan_status === 'active' || a.plan_status === 'past_due').length;

    res.send(page({ req, title: 'Admin', body: html`
      ${flash(req)}
      <h1>Admin</h1>
      <div class="stats">
        <div class="stat"><div class="n">${paying}</div><div class="l">Paying accounts</div></div>
        <div class="stat"><div class="n">${money(paying * cfg.pricing.monthlyPriceCents)}</div><div class="l">Monthly recurring revenue</div></div>
        <div class="stat"><div class="n">${lastTick ? `${Math.round((now - lastTick) / 1000)}s` : 'never'}</div><div class="l">Since last scheduler run</div></div>
        <div class="stat"><div class="n" style="color:${overdue ? 'var(--red)' : 'inherit'}">${overdue}</div><div class="l">Emails overdue by 2h+ (should be 0)</div></div>
        <div class="stat"><div class="n">${failed7}</div><div class="l">Send failures, last 7 days</div></div>
      </div>
      <p class="muted small"><a href="/admin/backup.db">Download database backup</a> · Email: ${cfg.email.transport}${cfg.email.transport === 'log' ? html` (<a href="/dev/outbox">view outbox</a>)` : ''} · Reply detection: ${cfg.email.inboundDomain ? 'on' : 'OFF'} · Billing: ${cfg.billing.mode}</p>
      <div class="card"><div class="table-wrap"><table>
        <tr><th>Business</th><th>Plan</th><th class="num">Active</th><th class="num">Sent 7d</th><th class="num">Failed</th><th class="num">Booked</th><th>Last estimate added</th><th></th></tr>
        ${accounts.map((a) => html`<tr>
          <td><strong>${a.business_name}</strong><div class="muted small">${a.login} · joined ${date(a.created_at, a)}</div></td>
          <td>${a.plan_status}${a.onboarding_paid ? html`<div class="muted small">onboarding paid</div>` : ''}${a.sending_paused ? html`<div class="muted small">paused by user</div>` : ''}</td>
          <td class="num">${a.active_estimates}</td><td class="num">${a.sent7}</td>
          <td class="num" style="color:${a.failed ? 'var(--red)' : 'inherit'}">${a.failed}</td><td class="num">${a.booked}</td>
          <td class="small">${a.last_estimate ? date(a.last_estimate, a) : html`<span class="muted">none</span>`}</td>
          <td><form method="post" action="/admin/accounts/${a.id}/plan" class="actions">${csrf(req)}
            <select name="plan_status">${PLAN_STATUSES.map((s) => html`<option ${s === a.plan_status ? 'selected' : ''}>${s}</option>`)}</select>
            <button class="btn small secondary">Set</button></form></td>
        </tr>`)}
      </table></div></div>
      <p class="muted small">Tip: an account with no new estimates for 2+ weeks is at risk of canceling. Check in with them.</p>` }));
  });

  // Download a consistent copy of the whole database (keep one somewhere safe each week).
  r.get('/backup.db', async (req, res, next) => {
    const file = path.join(os.tmpdir(), `quoteback-backup-${Date.now()}.db`);
    try {
      await db.backup(file);
      res.download(file, `quoteback-${new Date().toISOString().slice(0, 10)}.db`, () => fs.unlink(file, () => {}));
    } catch (err) {
      next(err);
    }
  });

  r.post('/accounts/:id/plan', (req, res) => {
    const status = String(req.body.plan_status);
    if (!PLAN_STATUSES.includes(status)) return go(res, '/admin', { error: 'Unknown status' });
    const trialEnds = status === 'trialing' ? Date.now() + Math.max(cfg.pricing.trialDays, 14) * DAY : null;
    db.prepare('UPDATE accounts SET plan_status = ?, trial_ends_at = COALESCE(?, trial_ends_at) WHERE id = ?').run(status, trialEnds, Number(req.params.id));
    go(res, '/admin', { notice: 'Plan updated.' });
  });

  return r;
}
