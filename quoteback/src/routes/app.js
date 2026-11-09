import express from 'express';
import { html, raw, money, date, statusBadge, csrf, flash, pct } from '../views/html.js';
import { page } from '../views/layout.js';
import { DAY, dateInputToTs, tsToDateInput } from '../time.js';
import {
  STATUSES, UserError, createEstimate, getEstimate, setStatus, updateEstimate, deleteEstimate,
  sendingAllowed, parseMoneyToCents, getSteps, countLimited, addEvent,
} from '../services/estimates.js';
import { periodStats, needsAttention, upcoming, failedFollowups } from '../services/stats.js';
import { retryFollowup } from '../scheduler.js';
import { readEstimatesCsv } from '../csv.js';
import { composeFollowup } from '../email/compose.js';
import { RESPONSE_CHOICES } from '../services/customer.js';

export const go = (res, url, { notice, error } = {}) => {
  const q = notice ? `notice=${encodeURIComponent(notice)}` : error ? `error=${encodeURIComponent(error)}` : '';
  res.redirect(q ? `${url}${url.includes('?') ? '&' : '?'}${q}` : url);
};

export function accountBanners(ctx, req) {
  const { cfg } = ctx;
  const a = req.account;
  const gate = sendingAllowed(a);
  const out = [];
  if (!gate.ok) {
    out.push(html`<div class="flash warn"><strong>Follow-ups are on hold.</strong> ${gate.reason}
      ${a.sending_paused ? html`<a href="/app/settings">Open settings</a>` : html`<a href="/app/billing">Activate your plan</a>`}.
      Everything you set up now will start sending once that's done.</div>`);
  } else if (a.plan_status === 'trialing' && a.trial_ends_at) {
    const days = Math.max(0, Math.ceil((a.trial_ends_at - Date.now()) / DAY));
    out.push(html`<div class="flash warn">Free trial: ${days} day${days === 1 ? '' : 's'} left. <a href="/app/billing">Subscribe</a> to keep follow-ups running.</div>`);
  } else if (a.plan_status === 'past_due') {
    out.push(html`<div class="flash warn">Your last payment didn't go through. <a href="/app/billing">Update your card</a> to avoid follow-ups stopping.</div>`);
  }
  if (!cfg.email.inboundDomain) {
    out.push(html`<div class="flash warn">Automatic reply detection is off on this server, so customer replies go straight to your inbox and
      QuoteBack can't see them. When a customer replies, mark the estimate "Customer replied" so follow-ups stop.</div>`);
  }
  return out;
}

function nextFollowupText(ctx, account, estimateId) {
  const f = ctx.db.prepare(`SELECT scheduled_at FROM followups WHERE estimate_id = ? AND status = 'scheduled' ORDER BY step_position LIMIT 1`).get(estimateId);
  return f ? `First follow-up is scheduled for ${date(f.scheduled_at, account, true)}.` : '';
}

const EVENT_TEXT = {
  created: (d) => (d.suppressed ? 'Added. This customer opted out before, so no emails will be sent.' : `Added${d.source === 'csv' ? ' from import' : ''}.`),
  followup_sent: (d) => `Follow-up #${d.step} sent: "${d.subject}"`,
  reply_received: (d) => `Customer replied by email${d.subject ? `: "${d.subject}"` : ''}`,
  auto_reply: () => 'Automatic reply received (out of office). Follow-ups continue.',
  customer_response: (d) => `Customer tapped: "${RESPONSE_CHOICES[d.choice]?.label || d.choice}"`,
  status_changed: (d) => `Status: ${STATUSES[d.from]?.label || d.from} → ${STATUSES[d.to]?.label || d.to}${d.by === 'customer' ? ' (by customer)' : d.by === 'system' ? ' (automatic)' : ''}${d.reason ? ` · ${d.reason}` : ''}${d.to === 'booked' && d.booked_amount_cents ? ` · ${money(d.booked_amount_cents)}` : ''}`,
  sequence_finished: () => 'All follow-ups sent. No response yet.',
  unsubscribed: () => 'Customer opted out of emails.',
  bounce: (d) => `Email bounced (${d.type}).`,
  send_failed: (d) => `A follow-up failed to send: ${d.error}`,
  note: (d) => 'Note',
  edited: () => 'Details edited.',
};
const EVENT_CLASS = { reply_received: 'hl', customer_response: 'hl', followup_sent: 'sent', status_changed: '' };

function quickAddForm(req, account, v = {}) {
  return html`<form method="post" action="/app/estimates">
    ${csrf(req)}
    <div class="row">
      <div class="field"><label>Customer name</label><input type="text" name="customer_name" required value="${v.customer_name || ''}"></div>
      <div class="field"><label>Customer email</label><input type="email" name="customer_email" required value="${v.customer_email || ''}"></div>
    </div>
    <div class="row">
      <div class="field"><label>What's the job? <span class="hint">(used in emails)</span></label><input type="text" name="job_description" placeholder="exterior repaint" value="${v.job_description || ''}"></div>
      <div class="field"><label>Estimate total</label><input type="text" name="amount" inputmode="decimal" placeholder="4,200" value="${v.amount || ''}"></div>
      <div class="field"><label>Date sent</label><input type="date" name="sent_date" value="${v.sent_date || tsToDateInput(Date.now(), account.timezone)}" max="${tsToDateInput(Date.now(), account.timezone)}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Phone <span class="hint">(optional)</span></label><input type="tel" name="customer_phone" value="${v.customer_phone || ''}"></div>
      <div class="field"><label>Job address <span class="hint">(optional)</span></label><input type="text" name="job_address" value="${v.job_address || ''}"></div>
    </div>
    <button class="btn">Add estimate &amp; start follow-ups</button>
  </form>`;
}

export function appRoutes(ctx) {
  const { db, cfg } = ctx;
  const r = express.Router();

  // ---- Dashboard ----
  r.get('/', (req, res) => {
    const a = req.account;
    const now = Date.now();
    const s = periodStats(db, a.id, now - 30 * DAY, now + 1);
    const attention = needsAttention(db, a.id);
    const next = upcoming(db, a.id);
    const failed = failedFollowups(db, a.id);
    const estimateCount = db.prepare('SELECT COUNT(*) n FROM estimates WHERE account_id = ?').get(a.id).n;
    const checklist = [
      { done: !!(a.business_address && a.owner_name), label: 'Add your business address and name (required in every email by law)', href: '/app/settings' },
      { done: !!a.test_email_sent_at, label: 'Review your follow-up emails and send yourself a test', href: '/app/sequence' },
      { done: estimateCount > 0, label: 'Add your open estimates (one by one or paste a spreadsheet)', href: '/app/estimates/import' },
      { done: sendingAllowed(a).ok, label: cfg.billing.mode === 'stripe' ? 'Activate your plan' : 'Get your account activated', href: '/app/billing' },
    ];
    const setupDone = checklist.every((c) => c.done);
    const lastResponse = db.prepare(`SELECT data FROM events WHERE estimate_id = ? AND type IN ('reply_received', 'customer_response') ORDER BY created_at DESC LIMIT 1`);

    res.send(page({ req, title: 'Home', body: html`
      ${flash(req)}
      ${accountBanners(ctx, req)}
      <div class="headline"><div><h1>${a.business_name}</h1><p class="muted">Last 30 days</p></div>
        <div class="actions"><a class="btn" href="/app/estimates/new">+ Add estimate</a><a class="btn secondary" href="/app/estimates/import">Import</a></div></div>

      ${setupDone ? '' : html`<div class="card"><h2>Get set up</h2><ul class="checklist">
        ${checklist.map((c) => html`<li><span class="dot ${c.done ? 'done' : ''}">${c.done ? '✓' : ''}</span>
          <a href="${c.href}">${c.label}</a></li>`)}</ul></div>`}

      <div class="stats">
        <div class="stat"><div class="n">${s.followupsSent}</div><div class="l">Follow-ups sent</div></div>
        <div class="stat"><div class="n">${s.respondedAfterFollowup}</div><div class="l">Customers responded after a follow-up</div></div>
        <div class="stat"><div class="n">${s.bookedAfterFollowupJobs}</div><div class="l">Jobs booked after a follow-up</div></div>
        <div class="stat"><div class="n">${money(s.bookedAfterFollowupCents)}</div><div class="l">Value of those jobs</div></div>
      </div>

      <div class="card">
        <h2>Needs your attention ${attention.length ? html`<span class="badge orange">${attention.length}</span>` : ''}</h2>
        ${attention.length === 0 ? html`<p class="muted">Nothing right now. When a customer replies or taps a response, they'll show up here and you'll get an email.</p>` : html`
        <div class="table-wrap"><table><tr><th>Customer</th><th class="hide-sm">What they said</th><th>Status</th><th></th></tr>
        ${attention.map((e) => {
          const ev = lastResponse.get(e.id);
          const d = ev ? JSON.parse(ev.data) : {};
          const said = d.choice ? RESPONSE_CHOICES[d.choice]?.label + (d.message ? ` — ${d.message}` : '') : d.text || (e.status === 'bounced' ? 'Email bounced; check the address.' : '');
          return html`<tr><td><a href="/app/estimates/${e.id}">${e.customer_name}</a><div class="muted small">${e.job_description} ${e.amount_cents ? `· ${money(e.amount_cents)}` : ''}</div></td>
            <td class="hide-sm small">${String(said || '').slice(0, 140)}</td><td>${statusBadge(e.status)}</td>
            <td class="num"><a class="btn small secondary" href="/app/estimates/${e.id}">Open</a></td></tr>`;
        })}</table></div>`}
      </div>

      ${failed.length ? html`<div class="card"><h2>Emails that didn't send</h2><table>
        ${failed.map((f) => html`<tr><td><a href="/app/estimates/${f.estimate_id}">${f.customer_name}</a><div class="muted small">${f.error}</div></td>
        <td class="num"><form method="post" action="/app/followups/${f.id}/retry" class="inline">${csrf(req)}<button class="btn small secondary">Retry</button></form></td></tr>`)}
        </table></div>` : ''}

      <div class="grid two">
        <div class="card"><h2>Quick add</h2>${quickAddForm(req, a)}</div>
        <div class="card"><h2>Coming up</h2>
          ${next.length === 0 ? html`<p class="muted">No follow-ups scheduled.</p>` : html`<table>
          ${next.map((f) => html`<tr><td><a href="/app/estimates/${f.estimate_id}">${f.customer_name}</a><div class="muted small">Follow-up #${f.step_position}</div></td>
            <td class="num small">${date(f.scheduled_at, a, true)}</td></tr>`)}</table>`}
        </div>
      </div>` }));
  });

  // ---- Estimates list ----
  r.get('/estimates', (req, res) => {
    const a = req.account;
    const status = STATUSES[req.query.status] ? req.query.status : req.query.status === 'open' || !req.query.status ? 'open' : 'all';
    const q = String(req.query.q || '').trim();
    const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM estimates WHERE account_id = ? GROUP BY status').all(a.id).map((x) => [x.status, x.n]));
    const openStatuses = ['active', 'replied', 'interested', 'paused', 'bounced'];
    const where = ['e.account_id = @account'];
    if (status === 'open') where.push(`e.status IN (${openStatuses.map((s) => `'${s}'`).join(',')})`);
    else if (status !== 'all') where.push('e.status = @status');
    if (q) where.push('(e.customer_name LIKE @q OR e.customer_email LIKE @q OR e.job_description LIKE @q OR e.job_address LIKE @q)');
    const rows = db.prepare(`SELECT e.*,
        (SELECT MIN(scheduled_at) FROM followups f WHERE f.estimate_id = e.id AND f.status = 'scheduled') next_at,
        (SELECT COUNT(*) FROM followups f WHERE f.estimate_id = e.id AND f.status = 'sent') sent_count
      FROM estimates e WHERE ${where.join(' AND ')} ORDER BY e.sent_at DESC LIMIT 300`)
      .all({ account: a.id, status, q: `%${q}%` });
    const tab = (key, label, n) => html`<a class="${status === key ? 'on' : ''}" href="/app/estimates?status=${key}">${label}${n !== undefined ? ` (${n})` : ''}</a>`;
    const openCount = openStatuses.reduce((s, k) => s + (counts[k] || 0), 0);
    res.send(page({ req, title: 'Estimates', body: html`
      ${flash(req)}
      <div class="headline"><div><h1>Estimates</h1><p class="muted">${countLimited(db, a.id)} of ${cfg.pricing.maxActiveEstimates} being followed up</p></div>
        <div class="actions"><a class="btn" href="/app/estimates/new">+ Add estimate</a><a class="btn secondary" href="/app/estimates/import">Import</a><a class="btn secondary" href="/app/estimates/export.csv">Export</a></div></div>
      <div class="tabs">
        ${tab('open', 'Open', openCount)}
        ${['active', 'replied', 'interested', 'booked', 'no_response', 'lost', 'paused', 'unsubscribed', 'bounced'].filter((k) => counts[k] || k === 'active' || k === 'booked').map((k) => tab(k, STATUSES[k].label, counts[k] || 0))}
        ${tab('all', 'All')}
      </div>
      <form method="get" class="field" style="max-width:360px"><input type="hidden" name="status" value="${status}"><input type="text" name="q" value="${q}" placeholder="Search name, email, job…"></form>
      <div class="card"><div class="table-wrap">
      ${rows.length === 0 ? html`<p class="muted">No estimates here yet.</p>` : html`<table>
        <tr><th>Customer</th><th class="num">Amount</th><th class="hide-sm">Sent</th><th>Status</th><th class="hide-sm">Follow-ups</th></tr>
        ${rows.map((e) => html`<tr>
          <td><a href="/app/estimates/${e.id}">${e.customer_name}</a><div class="muted small">${e.job_description}</div></td>
          <td class="num">${e.status === 'booked' ? money(e.booked_amount_cents) : money(e.amount_cents)}</td>
          <td class="hide-sm small">${date(e.sent_at, a)}</td>
          <td>${statusBadge(e.status)}</td>
          <td class="hide-sm small">${e.sent_count} sent${e.next_at ? html`<div class="muted">next ${date(e.next_at, a)}</div>` : ''}</td>
        </tr>`)}
      </table>${rows.length === 300 ? html`<p class="muted small">Showing the 300 most recent. Search to find older ones.</p>` : ''}`}
      </div></div>` }));
  });

  r.get('/estimates/new', (req, res) => {
    res.send(page({ req, title: 'Add estimate', body: html`${accountBanners(ctx, req)}<div class="card" style="max-width:760px"><h1>Add an estimate</h1>
      <p class="muted">Add an estimate you've already sent the customer. QuoteBack takes over the follow-up from here.</p>
      ${flash(req)}${quickAddForm(req, req.account, req.query)}</div>` }));
  });

  r.post('/estimates', (req, res) => {
    const a = req.account;
    try {
      const sentAt = dateInputToTs(req.body.sent_date, a.timezone) ?? Date.now();
      const est = createEstimate(db, cfg, a, req.body, { sentAt });
      go(res, `/app/estimates/${est.id}`, { notice: `Added ${est.customer_name}. ${nextFollowupText(ctx, a, est.id)}` });
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      const keep = ['customer_name', 'customer_email', 'job_description', 'amount', 'sent_date', 'customer_phone', 'job_address'];
      const qs = keep.map((k) => `${k}=${encodeURIComponent(req.body[k] || '')}`).join('&');
      go(res, `/app/estimates/new?${qs}`, { error: err.message });
    }
  });

  // ---- Import ----
  r.get('/estimates/import', (req, res) => {
    res.send(page({ req, title: 'Import estimates', body: html`
      <div class="card" style="max-width:820px">
        <h1>Import open estimates</h1>
        ${flash(req)}
        <p>Export your open estimates from your estimating software or spreadsheet as a CSV file, then choose it below or paste it in.</p>
        <p class="muted small">Needs columns for <strong>name</strong> and <strong>email</strong>. Also reads amount/total, job/description, date, phone and address if present.
        Dates like 2026-03-14 or 3/14/2026. Estimates older than the first follow-up delay start their sequence right away (one email at a time, normal spacing).</p>
        <form method="post" action="/app/estimates/import/preview">
          ${csrf(req)}
          <div class="field"><input type="file" id="csv-file" accept=".csv,text/csv"></div>
          <div class="field"><textarea id="csv-text" name="csv" rows="10" placeholder="name,email,amount,job,date&#10;Dana Whitfield,dana@example.com,4200,interior repaint,2026-03-14"></textarea></div>
          <button class="btn">Preview import</button>
        </form>
      </div>` }));
  });

  function analyse(a, text) {
    const parsed = readEstimatesCsv(text, a.timezone);
    const existing = db.prepare('SELECT 1 FROM estimates WHERE account_id = ? AND customer_email = ? AND amount_cents = ?');
    const seen = new Set();
    for (const row of parsed.rows) {
      const key = `${row.input.customer_email.toLowerCase()}|${parseMoneyToCents(row.input.amount)}`;
      row.duplicate = !row.errors.length && (seen.has(key) || !!existing.get(a.id, row.input.customer_email.toLowerCase(), parseMoneyToCents(row.input.amount) ?? 0));
      seen.add(key);
    }
    return parsed;
  }

  r.post('/estimates/import/preview', (req, res) => {
    const a = req.account;
    const parsed = analyse(a, req.body.csv);
    if (parsed.empty) return go(res, '/app/estimates/import', { error: 'That file looks empty. Include a header row and at least one estimate.' });
    if (parsed.missing.length) return go(res, '/app/estimates/import', { error: `Couldn't find a column for: ${parsed.missing.join(', ')}. Check the header row.` });
    const ok = parsed.rows.filter((x) => !x.errors.length && !x.duplicate);
    const room = cfg.pricing.maxActiveEstimates - countLimited(db, a.id);
    res.send(page({ req, title: 'Preview import', body: html`
      <div class="card">
        <h1>Preview: ${ok.length} estimate${ok.length === 1 ? '' : 's'} ready to import</h1>
        ${ok.length > room ? html`<div class="flash err">Your plan allows ${room} more active estimates. Only the first ${room} will be imported.</div>` : ''}
        <div class="table-wrap"><table><tr><th>Row</th><th>Customer</th><th>Job</th><th class="num">Amount</th><th>Date</th><th></th></tr>
        ${parsed.rows.map((x) => html`<tr>
          <td>${x.line}</td><td>${x.input.customer_name}<div class="muted small">${x.input.customer_email}</div></td>
          <td class="small">${x.input.job_description}</td><td class="num">${x.input.amount}</td><td class="small">${date(x.sentAt, a)}</td>
          <td>${x.errors.length ? html`<span class="badge red">Skip</span><div class="small">${x.errors.join(' ')}</div>` : x.duplicate ? html`<span class="badge gray">Already added</span>` : html`<span class="badge green">OK</span>`}</td>
        </tr>`)}</table></div>
        <form method="post" action="/app/estimates/import" class="actions" style="margin-top:16px">
          ${csrf(req)}<textarea name="csv" hidden>${req.body.csv}</textarea>
          <button class="btn" ${ok.length ? '' : 'disabled'}>Import ${Math.min(ok.length, Math.max(room, 0))} and start follow-ups</button>
          <a class="btn secondary" href="/app/estimates/import">Start over</a>
        </form>
      </div>` }));
  });

  r.post('/estimates/import', (req, res) => {
    const a = req.account;
    const parsed = analyse(a, req.body.csv);
    let imported = 0;
    let stoppedAtLimit = false;
    for (const row of parsed.rows) {
      if (row.errors.length || row.duplicate) continue;
      try {
        createEstimate(db, cfg, a, row.input, { sentAt: row.sentAt, source: 'csv' });
        imported++;
      } catch (err) {
        if (!(err instanceof UserError)) throw err;
        stoppedAtLimit = true;
        break;
      }
    }
    go(res, '/app/estimates', { notice: `Imported ${imported} estimate${imported === 1 ? '' : 's'}.${stoppedAtLimit ? ' Stopped at your plan limit.' : ''} Follow-ups are scheduled.` });
  });

  r.get('/estimates/export.csv', (req, res) => {
    const a = req.account;
    const rows = db.prepare('SELECT * FROM estimates WHERE account_id = ? ORDER BY sent_at DESC').all(a.id);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['name', 'email', 'phone', 'address', 'job', 'amount', 'date', 'status', 'booked_amount', 'booked_date'].join(',')];
    for (const e of rows) {
      lines.push([e.customer_name, e.customer_email, e.customer_phone, e.job_address, e.job_description, (e.amount_cents / 100).toFixed(2),
        tsToDateInput(e.sent_at, a.timezone), STATUSES[e.status]?.label || e.status,
        e.booked_amount_cents != null ? (e.booked_amount_cents / 100).toFixed(2) : '', e.booked_at ? tsToDateInput(e.booked_at, a.timezone) : ''].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="quoteback-estimates.csv"');
    res.send(lines.join('\n'));
  });

  // ---- Estimate detail ----
  const loadEstimate = (req, res, next) => {
    const e = getEstimate(db, req.account.id, Number(req.params.id));
    if (!e) return res.status(404).send(page({ req, title: 'Not found', body: html`<div class="card"><h1>Estimate not found</h1><a href="/app/estimates">Back to estimates</a></div>` }));
    req.estimate = e;
    next();
  };

  r.get('/estimates/:id', loadEstimate, (req, res) => {
    const a = req.account;
    const e = req.estimate;
    const fus = db.prepare('SELECT * FROM followups WHERE estimate_id = ? ORDER BY step_position').all(e.id);
    const events = db.prepare('SELECT * FROM events WHERE estimate_id = ? ORDER BY created_at DESC, id DESC').all(e.id);
    const steps = getSteps(db, a.id);
    const nextF = fus.find((f) => f.status === 'scheduled');
    const nextStep = nextF && steps.find((s) => s.position === nextF.step_position);
    const preview = nextStep ? composeFollowup(cfg, a, e, nextStep) : null;
    const fuLabel = { scheduled: 'Scheduled', sent: 'Sent', canceled: 'Stopped', skipped: 'Skipped', failed: 'Failed', sending: 'Sending…' };

    res.send(page({ req, title: e.customer_name, body: html`
      ${flash(req)}
      <p><a href="/app/estimates">← Estimates</a></p>
      <div class="headline">
        <div><h1>${e.customer_name} ${statusBadge(e.status)}</h1>
          <p class="muted">${e.job_description || 'No job description'} · ${money(e.amount_cents)} · sent ${date(e.sent_at, a)}</p>
          <p class="small"><a href="mailto:${e.customer_email}">${e.customer_email}</a>${e.customer_phone ? html` · <a href="tel:${e.customer_phone}">${e.customer_phone}</a>` : ''}${e.job_address ? ` · ${e.job_address}` : ''}</p>
        </div>
      </div>

      <div class="grid two">
        <div class="card">
          <h2>Update status</h2>
          <p class="muted small">${STATUSES[e.status]?.help} Anything other than "Following up" stops the emails.</p>
          <form method="post" action="/app/estimates/${e.id}/status">
            ${csrf(req)}
            <div class="field"><select name="status" data-status-select="booked-extra">
              ${['booked', 'replied', 'interested', 'lost', 'paused', 'active'].map((s) => html`<option value="${s}" ${s === (e.status === 'active' ? 'booked' : e.status) ? 'selected' : ''}>${s === 'active' ? 'Following up (resume emails)' : s === 'replied' ? 'Customer replied / called me' : STATUSES[s].label}</option>`)}
            </select></div>
            <div class="field" id="booked-extra"><label>Booked amount</label><input type="text" name="booked_amount" inputmode="decimal" value="${((e.booked_amount_cents ?? e.amount_cents) / 100).toFixed(2).replace(/\.00$/, '')}"></div>
            <div class="field"><label>Note <span class="hint">(optional, e.g. why it was lost)</span></label><input type="text" name="reason" maxlength="200"></div>
            <button class="btn">Save</button>
          </form>
        </div>

        <div class="card">
          <h2>Follow-up emails</h2>
          ${fus.length === 0 ? html`<p class="muted">None scheduled.</p>` : html`<table>
          ${fus.map((f) => html`<tr><td>#${f.step_position}<div class="muted small">day ${f.delay_days}</div></td>
            <td class="small">${f.subject || steps.find((s) => s.position === f.step_position)?.subject || ''}${f.error ? html`<div class="muted">${f.error}</div>` : ''}</td>
            <td class="num small"><span class="badge ${f.status === 'sent' ? 'green' : f.status === 'scheduled' ? 'blue' : f.status === 'failed' ? 'red' : 'gray'}">${fuLabel[f.status] || f.status}</span>
            <div class="muted">${date(f.sent_at || f.scheduled_at, a, true)}</div>
            ${f.status === 'failed' ? html`<form method="post" action="/app/followups/${f.id}/retry">${csrf(req)}<button class="linklike">Retry</button></form>` : ''}</td></tr>`)}
          </table>`}
          ${preview ? html`<details style="margin-top:12px"><summary>Preview next email</summary>
            <p class="small muted">Subject: ${preview.subject}</p><div class="preview">${preview.text}</div></details>` : ''}
        </div>
      </div>

      <div class="card">
        <h2>Conversation</h2>
        <form method="post" action="/app/estimates/${e.id}/note" class="actions" style="margin-bottom:12px">
          ${csrf(req)}<input type="text" name="text" placeholder="Add a note (e.g. 'Called, wants a start date in May')" style="flex:1;min-width:200px" required maxlength="1000">
          <button class="btn secondary small">Add note</button>
        </form>
        <ul class="timeline">
        ${events.map((ev) => {
          const d = JSON.parse(ev.data);
          const text = EVENT_TEXT[ev.type] ? EVENT_TEXT[ev.type](d) : ev.type;
          const cls = ev.type === 'status_changed' && d.to === 'booked' ? 'good' : EVENT_CLASS[ev.type] || '';
          const body = ev.type === 'reply_received' ? d.text : ev.type === 'customer_response' ? d.message : ev.type === 'note' ? d.text : '';
          return html`<li class="${cls}"><div>${text}</div><div class="muted small">${date(ev.created_at, a, true)}</div>${body ? html`<div class="quote">${body}</div>` : ''}</li>`;
        })}
        </ul>
      </div>

      <details class="card"><summary><strong>Edit details</strong></summary>
        <form method="post" action="/app/estimates/${e.id}/edit" style="margin-top:14px">
          ${csrf(req)}
          <div class="row">
            <div class="field"><label>Customer name</label><input type="text" name="customer_name" value="${e.customer_name}" required></div>
            <div class="field"><label>Email</label><input type="email" name="customer_email" value="${e.customer_email}" required></div>
            <div class="field"><label>Phone</label><input type="tel" name="customer_phone" value="${e.customer_phone}"></div>
          </div>
          <div class="row">
            <div class="field"><label>Job</label><input type="text" name="job_description" value="${e.job_description}"></div>
            <div class="field"><label>Address</label><input type="text" name="job_address" value="${e.job_address}"></div>
            <div class="field"><label>Amount</label><input type="text" name="amount" value="${(e.amount_cents / 100).toFixed(2).replace(/\.00$/, '')}"></div>
          </div>
          <button class="btn">Save changes</button>
        </form>
        <form method="post" action="/app/estimates/${e.id}/delete" data-confirm="Delete this estimate and its history? This can't be undone." style="margin-top:16px">
          ${csrf(req)}<button class="btn danger small">Delete estimate</button></form>
      </details>` }));
  });

  r.post('/estimates/:id/status', loadEstimate, (req, res) => {
    const e = req.estimate;
    const to = String(req.body.status || '');
    try {
      let bookedAmountCents;
      if (to === 'booked') {
        bookedAmountCents = parseMoneyToCents(req.body.booked_amount);
        if (bookedAmountCents === null) throw new UserError('Booked amount should be a number like 4200.');
      }
      setStatus(db, cfg, req.account, e, to, { by: 'contractor', reason: String(req.body.reason || '').trim().slice(0, 200), bookedAmountCents });
      const msg = to === 'booked' ? 'Marked booked. Nice work!' : to === 'active' ? `Follow-ups resumed. ${nextFollowupText(ctx, req.account, e.id).replace('First', 'Next')}` : 'Saved. Follow-ups for this estimate are stopped.';
      go(res, `/app/estimates/${e.id}`, { notice: msg });
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      go(res, `/app/estimates/${e.id}`, { error: err.message });
    }
  });

  r.post('/estimates/:id/note', loadEstimate, (req, res) => {
    const text = String(req.body.text || '').trim().slice(0, 1000);
    if (text) addEvent(db, { accountId: req.account.id, estimateId: req.estimate.id, type: 'note', data: { text } });
    go(res, `/app/estimates/${req.estimate.id}`);
  });

  r.post('/estimates/:id/edit', loadEstimate, (req, res) => {
    try {
      updateEstimate(db, cfg, req.account, req.estimate, req.body);
      go(res, `/app/estimates/${req.estimate.id}`, { notice: 'Saved.' });
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      go(res, `/app/estimates/${req.estimate.id}`, { error: err.message });
    }
  });

  r.post('/estimates/:id/delete', loadEstimate, (req, res) => {
    deleteEstimate(db, req.account, req.estimate);
    go(res, '/app/estimates', { notice: 'Estimate deleted.' });
  });

  r.post('/followups/:id/retry', (req, res) => {
    const ok = retryFollowup(db, req.account, Number(req.params.id));
    go(res, req.get('referer')?.includes('/app/estimates/') ? new URL(req.get('referer')).pathname : '/app', ok ? { notice: 'Queued to send again.' } : { error: 'That email can no longer be retried.' });
  });

  return r;
}

export { raw, pct };
