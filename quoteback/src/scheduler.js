import { composeFollowup } from './email/compose.js';
import { DAY, HOUR, MINUTE, nextSendTime } from './time.js';
import { addEvent, getSteps, isSuppressed, sendingAllowed } from './services/estimates.js';
import { setMeta } from './db.js';
import { notifyContractor } from './services/notify.js';

const STALE_CLAIM_MS = 10 * MINUTE;

// Decides, inside a transaction, what to do with one due follow-up.
// Returns { msg } when an email should go out now; otherwise reschedules or cancels it.
function prepare(db, cfg, followupId, now) {
  return db.transaction(() => {
    const f = db.prepare('SELECT * FROM followups WHERE id = ?').get(followupId);
    if (!f || f.status !== 'scheduled' || f.scheduled_at > now) return null;
    const estimate = db.prepare('SELECT * FROM estimates WHERE id = ?').get(f.estimate_id);
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(f.account_id);
    const reschedule = (at) => db.prepare('UPDATE followups SET scheduled_at = ? WHERE id = ?').run(at, f.id);

    if (estimate.status !== 'active') {
      db.prepare(`UPDATE followups SET status = 'canceled' WHERE id = ?`).run(f.id);
      return null;
    }
    if (isSuppressed(db, account.id, estimate.customer_email)) {
      db.prepare(`UPDATE followups SET status = 'canceled' WHERE estimate_id = ? AND status = 'scheduled'`).run(estimate.id);
      db.prepare(`UPDATE estimates SET status = 'unsubscribed', status_changed_at = ? WHERE id = ?`).run(now, estimate.id);
      return null;
    }
    if (!sendingAllowed(account, now).ok) {
      reschedule(now + HOUR); // check again later; spacing between steps is restored when it sends
      return null;
    }
    const earlier = db.prepare(`SELECT * FROM followups WHERE estimate_id = ? AND step_position < ? AND status IN ('scheduled', 'sending')
      ORDER BY step_position LIMIT 1`).get(estimate.id, f.step_position);
    if (earlier) {
      reschedule(nextSendTime(Math.max(earlier.scheduled_at, now) + Math.max(1, f.delay_days - earlier.delay_days) * DAY, account));
      return null;
    }
    const windowTime = nextSendTime(now, account);
    if (windowTime > now) {
      reschedule(windowTime);
      return null;
    }
    const gapMs = cfg.scheduler.minHoursBetweenEmailsToSameAddress * HOUR;
    const last = db.prepare(`SELECT MAX(sent_at) t FROM followups WHERE account_id = ? AND to_email = ? AND status = 'sent'`)
      .get(account.id, estimate.customer_email).t;
    if (last && now - last < gapMs) {
      reschedule(nextSendTime(last + gapMs, account));
      return null;
    }
    const step = getSteps(db, account.id).find((s) => s.position === f.step_position);
    if (!step) {
      db.prepare(`UPDATE followups SET status = 'skipped', error = 'This email was removed from the sequence.' WHERE id = ?`).run(f.id);
      finishIfDone(db, estimate, now);
      return null;
    }
    const msg = composeFollowup(cfg, account, estimate, step);
    const claimed = db.prepare(`UPDATE followups SET status = 'sending', claimed_at = ?, attempts = attempts + 1,
        to_email = ?, subject = ?, body = ? WHERE id = ? AND status = 'scheduled'`)
      .run(now, msg.to, msg.subject, msg.text, f.id).changes;
    if (!claimed) return null;
    msg.idempotencyKey = `followup-${f.id}-${f.attempts + 1}`;
    return { msg, followup: f, estimate, account };
  })();
}

function finishIfDone(db, estimate, now) {
  const pending = db.prepare(`SELECT COUNT(*) n FROM followups WHERE estimate_id = ? AND status IN ('scheduled', 'sending')`).get(estimate.id).n;
  if (pending > 0) return;
  const current = db.prepare('SELECT status FROM estimates WHERE id = ?').get(estimate.id);
  if (current.status !== 'active') return;
  db.prepare(`UPDATE estimates SET status = 'no_response', status_changed_at = ? WHERE id = ?`).run(now, estimate.id);
  addEvent(db, { accountId: estimate.account_id, estimateId: estimate.id, type: 'sequence_finished', data: {}, now });
}

function markSent(db, job, messageId, now) {
  db.transaction(() => {
    const { followup: f, estimate } = job;
    db.prepare(`UPDATE followups SET status = 'sent', sent_at = ?, provider_message_id = ?, error = NULL WHERE id = ?`).run(now, String(messageId), f.id);
    addEvent(db, { accountId: estimate.account_id, estimateId: estimate.id, type: 'followup_sent', data: { followup_id: f.id, step: f.step_position, subject: job.msg.subject }, now });
    // Keep later steps at least their intended distance after this one (matters when this one ran late).
    const later = db.prepare(`SELECT * FROM followups WHERE estimate_id = ? AND step_position > ? AND status = 'scheduled'`).all(estimate.id, f.step_position);
    for (const l of later) {
      const minAt = now + (l.delay_days - f.delay_days) * DAY;
      if (l.scheduled_at < minAt) db.prepare('UPDATE followups SET scheduled_at = ? WHERE id = ?').run(nextSendTime(minAt, job.account), l.id);
    }
    finishIfDone(db, estimate, now);
  })();
}

function markFailed(db, cfg, job, err, now) {
  const { followup: f, estimate } = job;
  const attempts = f.attempts + 1;
  const error = String(err.message || err).slice(0, 500);
  if (!err.permanent && attempts < cfg.scheduler.maxSendAttempts) {
    const retryAt = now + 10 * MINUTE * 4 ** (attempts - 1); // 10m, 40m, 2h40m
    db.prepare(`UPDATE followups SET status = 'scheduled', scheduled_at = ?, error = ? WHERE id = ?`).run(retryAt, error, f.id);
    return 'retry';
  }
  db.transaction(() => {
    db.prepare(`UPDATE followups SET status = 'failed', error = ? WHERE id = ?`).run(error, f.id);
    addEvent(db, { accountId: estimate.account_id, estimateId: estimate.id, type: 'send_failed', data: { followup_id: f.id, error, permanent: !!err.permanent }, now });
    if (err.permanent) {
      db.prepare(`UPDATE followups SET status = 'canceled' WHERE estimate_id = ? AND status = 'scheduled'`).run(estimate.id);
      db.prepare(`UPDATE estimates SET status = 'bounced', status_changed_at = ? WHERE id = ?`).run(now, estimate.id);
    } else {
      finishIfDone(db, estimate, now);
    }
  })();
  return 'failed';
}

// Contractor pressed "Retry" on a failed email.
export function retryFollowup(db, account, followupId, now = Date.now()) {
  return db.transaction(() => {
    const f = db.prepare(`SELECT * FROM followups WHERE id = ? AND account_id = ? AND status = 'failed'`).get(followupId, account.id);
    if (!f) return false;
    const estimate = db.prepare('SELECT * FROM estimates WHERE id = ?').get(f.estimate_id);
    if (!['active', 'no_response'].includes(estimate.status)) return false;
    db.prepare(`UPDATE followups SET status = 'scheduled', scheduled_at = ?, attempts = 0, error = NULL WHERE id = ?`).run(nextSendTime(now, account), f.id);
    if (estimate.status === 'no_response') db.prepare(`UPDATE estimates SET status = 'active', status_changed_at = ? WHERE id = ?`).run(now, estimate.id);
    return true;
  })();
}

// A crash between "claimed" and "sent" leaves a row in 'sending'. We can't know if the
// provider accepted it, so we mark it failed instead of risking a duplicate email.
function recoverStale(db, now) {
  const stale = db.prepare(`SELECT * FROM followups WHERE status = 'sending' AND claimed_at < ?`).all(now - STALE_CLAIM_MS);
  for (const f of stale) {
    db.prepare(`UPDATE followups SET status = 'failed', error = 'Sending was interrupted. Not retried automatically to avoid a duplicate email; check your sent mail and use Retry if it did not go out.' WHERE id = ?`).run(f.id);
    addEvent(db, { accountId: f.account_id, estimateId: f.estimate_id, type: 'send_failed', data: { followup_id: f.id, error: 'interrupted' }, now });
  }
  return stale.length;
}

export async function runTick(ctx, now = Date.now()) {
  const { db, cfg, transport } = ctx;
  const result = { sent: 0, retried: 0, failed: 0, recovered: recoverStale(db, now) };
  const due = db.prepare(`SELECT id FROM followups WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT ?`)
    .all(now, cfg.scheduler.batchSize);
  for (const { id } of due) {
    const job = prepare(db, cfg, id, now);
    if (!job) continue;
    try {
      const { messageId } = await transport.send(job.msg);
      markSent(db, job, messageId, now);
      result.sent++;
    } catch (err) {
      const outcome = markFailed(db, cfg, job, err, now);
      if (outcome === 'retry') result.retried++;
      else {
        result.failed++;
        if (err.permanent) {
          notifyContractor(ctx, job.account, {
            subject: `Email to ${job.estimate.customer_name} bounced`,
            text: `QuoteBack couldn't deliver a follow-up to ${job.estimate.customer_name} at ${job.estimate.customer_email}.\n\nThe address may be mistyped. Fix it here and follow-ups will restart:\n${cfg.baseUrl}/app/estimates/${job.estimate.id}\n\nDetails: ${err.message}`,
          });
        }
      }
    }
  }
  setMeta(db, 'last_tick_at', now);
  return result;
}

export function startScheduler(ctx) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runTick(ctx);
      if (r.sent || r.failed || r.retried || r.recovered) console.log('[scheduler]', JSON.stringify(r));
    } catch (err) {
      console.error('[scheduler] tick failed', err);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, ctx.cfg.scheduler.intervalSeconds * 1000);
  setTimeout(tick, 2000);
  return () => clearInterval(handle);
}
