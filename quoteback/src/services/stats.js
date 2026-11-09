// Numbers that show a contractor what QuoteBack did for them.
// "After a follow-up" means the response or booking happened after at least one QuoteBack email was sent.
// That's a fair, checkable claim; we don't claim QuoteBack *caused* the booking.

const RESPONSE_TYPES = `('reply_received', 'customer_response')`;

export function periodStats(db, accountId, from, to) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const estimatesAdded = one('SELECT COUNT(*) n FROM estimates WHERE account_id = ? AND created_at >= ? AND created_at < ?', accountId, from, to).n;
  const followupsSent = one(`SELECT COUNT(*) n FROM followups WHERE account_id = ? AND status = 'sent' AND sent_at >= ? AND sent_at < ?`, accountId, from, to).n;

  // Customers who responded in this period after getting at least one follow-up.
  const respondedAfterFollowup = one(`SELECT COUNT(DISTINCT ev.estimate_id) n FROM events ev
    WHERE ev.account_id = ? AND ev.type IN ${RESPONSE_TYPES} AND ev.created_at >= ? AND ev.created_at < ?
      AND EXISTS (SELECT 1 FROM followups f WHERE f.estimate_id = ev.estimate_id AND f.status = 'sent' AND f.sent_at <= ev.created_at)`,
  accountId, from, to).n;

  const booked = one(`SELECT COUNT(*) n, COALESCE(SUM(booked_amount_cents), 0) cents FROM estimates
    WHERE account_id = ? AND status = 'booked' AND booked_at >= ? AND booked_at < ?`, accountId, from, to);
  const bookedAfter = one(`SELECT COUNT(*) n, COALESCE(SUM(e.booked_amount_cents), 0) cents FROM estimates e
    WHERE e.account_id = ? AND e.status = 'booked' AND e.booked_at >= ? AND e.booked_at < ?
      AND EXISTS (SELECT 1 FROM followups f WHERE f.estimate_id = e.id AND f.status = 'sent' AND f.sent_at <= e.booked_at)`,
  accountId, from, to);

  // Of estimates that got a follow-up in this period, how many responded at any point after one.
  const reached = one(`SELECT COUNT(DISTINCT estimate_id) n FROM followups WHERE account_id = ? AND status = 'sent' AND sent_at >= ? AND sent_at < ?`, accountId, from, to).n;
  const reachedResponded = one(`SELECT COUNT(DISTINCT f.estimate_id) n FROM followups f
    WHERE f.account_id = ? AND f.status = 'sent' AND f.sent_at >= ? AND f.sent_at < ?
      AND EXISTS (SELECT 1 FROM events ev WHERE ev.estimate_id = f.estimate_id AND ev.type IN ${RESPONSE_TYPES} AND ev.created_at >= f.sent_at)`,
  accountId, from, to).n;

  return {
    estimatesAdded,
    followupsSent,
    respondedAfterFollowup,
    bookedJobs: booked.n,
    bookedCents: booked.cents,
    bookedAfterFollowupJobs: bookedAfter.n,
    bookedAfterFollowupCents: bookedAfter.cents,
    estimatesReached: reached,
    responseRate: reached ? reachedResponded / reached : null,
  };
}

export function pipeline(db, accountId) {
  const rows = db.prepare(`SELECT status, COUNT(*) n, COALESCE(SUM(amount_cents), 0) cents FROM estimates WHERE account_id = ? GROUP BY status`).all(accountId);
  const by = Object.fromEntries(rows.map((r) => [r.status, r]));
  const open = ['active', 'replied', 'interested', 'paused', 'no_response'];
  return {
    byStatus: by,
    openCount: open.reduce((s, k) => s + (by[k]?.n || 0), 0),
    openCents: open.reduce((s, k) => s + (by[k]?.cents || 0), 0),
  };
}

// Which email in the sequence prompted responses: a response is credited to the latest
// follow-up sent before it.
export function stepPerformance(db, accountId) {
  const sent = db.prepare(`SELECT step_position, COUNT(*) n FROM followups WHERE account_id = ? AND status = 'sent' GROUP BY step_position`).all(accountId);
  const responses = db.prepare(`SELECT ev.estimate_id, MIN(ev.created_at) t FROM events ev
    WHERE ev.account_id = ? AND ev.type IN ${RESPONSE_TYPES} GROUP BY ev.estimate_id`).all(accountId);
  const credit = {};
  const latest = db.prepare(`SELECT step_position FROM followups WHERE estimate_id = ? AND status = 'sent' AND sent_at <= ? ORDER BY sent_at DESC LIMIT 1`);
  for (const r of responses) {
    const f = latest.get(r.estimate_id, r.t);
    if (f) credit[f.step_position] = (credit[f.step_position] || 0) + 1;
  }
  return sent.map((s) => ({ position: s.step_position, sent: s.n, responses: credit[s.step_position] || 0 }));
}

export function needsAttention(db, accountId) {
  return db.prepare(`SELECT * FROM estimates WHERE account_id = ? AND status IN ('replied', 'interested', 'bounced') ORDER BY status_changed_at DESC LIMIT 50`).all(accountId);
}

export function upcoming(db, accountId, limit = 8) {
  return db.prepare(`SELECT f.*, e.customer_name FROM followups f JOIN estimates e ON e.id = f.estimate_id
    WHERE f.account_id = ? AND f.status = 'scheduled' ORDER BY f.scheduled_at LIMIT ?`).all(accountId, limit);
}

export function failedFollowups(db, accountId) {
  return db.prepare(`SELECT f.*, e.customer_name FROM followups f JOIN estimates e ON e.id = f.estimate_id
    WHERE f.account_id = ? AND f.status = 'failed' AND e.status IN ('active', 'no_response') ORDER BY f.scheduled_at DESC LIMIT 20`).all(accountId);
}
