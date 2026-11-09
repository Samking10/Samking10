import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, makeAccount, followups, estimateById, getAccount, MONDAY_10AM, customer } from './helpers.js';
import { createEstimate, setStatus, countLimited } from '../src/services/estimates.js';
import { runTick, retryFollowup } from '../src/scheduler.js';
import { handleInboundEmail, recordResponse, unsubscribe, handleBounce } from '../src/services/customer.js';
import { SendError } from '../src/email/transport.js';
import { DAY, HOUR, isInSendWindow, localParts } from '../src/time.js';

const add = (ctx, account, overrides = {}, now = MONDAY_10AM, sentAt = now) =>
  createEstimate(ctx.db, ctx.cfg, account, customer(overrides), { now, sentAt });

// Runs the scheduler every 15 minutes between two times, like the real server.
async function runUntil(ctx, from, to) {
  for (let t = from; t <= to; t += 15 * 60 * 1000) await runTick(ctx, t);
}

test('new estimate schedules each step at the right delay, inside the sending window', () => {
  const ctx = makeCtx();
  const account = makeAccount(ctx);
  const est = add(ctx, account);
  const rows = followups(ctx, est.id);
  assert.deepEqual(rows.map((f) => f.delay_days), [2, 5, 10, 21]);
  for (const f of rows) {
    assert.ok(isInSendWindow(f.scheduled_at, account), 'inside window');
    assert.ok(f.scheduled_at >= est.sent_at + f.delay_days * DAY);
    assert.ok(f.scheduled_at < est.sent_at + (f.delay_days + 2) * DAY);
  }
  // Day 5 after Monday 10am is Saturday 10am, allowed by the default Mon-Sat window.
  assert.equal(rows[1].scheduled_at, MONDAY_10AM + 5 * DAY);
  // Day 21 lands on a Monday too.
  assert.equal(localParts(rows[3].scheduled_at, account.timezone).weekday, 1);
});

test('a step that would land on a non-sending day moves to the next allowed morning', () => {
  const ctx = makeCtx();
  const account = makeAccount(ctx, { send_days: '1,2,3,4,5' });
  const est = add(ctx, account);
  const step2 = followups(ctx, est.id)[1]; // day 5 = Saturday
  const p = localParts(step2.scheduled_at, account.timezone);
  assert.equal(p.weekday, 1);
  assert.equal(p.hour, 8);
});

test('sends each step exactly once, with merge fields, footer and reply tracking address', async () => {
  const ctx = makeCtx();
  const account = makeAccount(ctx);
  const est = add(ctx, account);
  await runTick(ctx, MONDAY_10AM + DAY);
  assert.equal(ctx.transport.sent.length, 0, 'nothing before day 2');
  await runTick(ctx, MONDAY_10AM + 2 * DAY);
  await runTick(ctx, MONDAY_10AM + 2 * DAY + 60000);
  assert.equal(ctx.transport.sent.length, 1);
  const msg = ctx.transport.sent[0];
  assert.equal(msg.to, 'dana@example.com');
  assert.equal(msg.subject, 'Your painting estimate from Brightline Painting');
  assert.match(msg.text, /^Hi Dana,/);
  assert.match(msg.text, /interior repaint, 3 bedrooms/);
  assert.match(msg.text, new RegExp(`https://app.test/r/${est.public_token}`));
  assert.match(msg.text, /12 Main St/);
  assert.equal(msg.replyTo, `reply+${est.public_token}@in.test`);
  assert.equal(msg.from, '"Brightline Painting" <followups@app.test>');
  assert.ok(msg.headers['List-Unsubscribe']);
  assert.equal(followups(ctx, est.id)[0].status, 'sent');
});

test('the whole sequence runs, then the estimate is marked no response', async () => {
  const ctx = makeCtx();
  const account = makeAccount(ctx);
  const est = add(ctx, account);
  await runUntil(ctx, MONDAY_10AM, MONDAY_10AM + 23 * DAY);
  assert.equal(ctx.transport.sent.length, 4);
  assert.equal(estimateById(ctx, est.id).status, 'no_response');
});

test('an email reply stops follow-ups and forwards the reply to the contractor', async () => {
  const ctx = makeCtx();
  const account = makeAccount(ctx);
  const est = add(ctx, account);
  await runTick(ctx, MONDAY_10AM + 2 * DAY);
  const r = await handleInboundEmail(ctx, {
    MailboxHash: est.public_token, FromFull: { Email: 'dana@example.com' }, Subject: 'Re: Your painting estimate',
    StrippedTextReply: 'Can you start in two weeks?', Headers: [],
  }, MONDAY_10AM + 3 * DAY);
  assert.deepEqual(r, { matched: true, auto: false });
  assert.equal(estimateById(ctx, est.id).status, 'replied');
  const notice = ctx.transport.sent.at(-1);
  assert.equal(notice.to, account.notify_email);
  assert.equal(notice.replyTo, 'dana@example.com');
  assert.match(notice.text, /Can you start in two weeks/);
  const before = ctx.transport.sent.length;
  await runUntil(ctx, MONDAY_10AM + 3 * DAY, MONDAY_10AM + 25 * DAY);
  assert.equal(ctx.transport.sent.length, before, 'no more follow-ups after reply');
  assert.ok(followups(ctx, est.id).slice(1).every((f) => f.status === 'canceled'));
});

test('an out-of-office auto-reply is logged but does not stop follow-ups', async () => {
  const ctx = makeCtx();
  const account = makeAccount(ctx);
  const est = add(ctx, account);
  const r = await handleInboundEmail(ctx, {
    To: `"Brightline" <reply+${est.public_token}@in.test>`, FromFull: { Email: 'dana@example.com' },
    Subject: 'Out of Office: Your painting estimate', TextBody: 'I am away until Monday', Headers: [{ Name: 'Auto-Submitted', Value: 'auto-replied' }],
  });
  assert.deepEqual(r, { matched: true, auto: true });
  assert.equal(estimateById(ctx, est.id).status, 'active');
});

test('tapping a response button stops follow-ups and alerts the contractor', async () => {
  const ctx = makeCtx();
  const account = makeAccount(ctx);
  const est = add(ctx, account);
  await recordResponse(ctx, est.public_token, 'schedule', 'Mornings are best', MONDAY_10AM + DAY);
  assert.equal(estimateById(ctx, est.id).status, 'interested');
  assert.match(ctx.transport.sent[0].subject, /Hot lead/);
  assert.match(ctx.transport.sent[0].text, /Mornings are best/);
  assert.ok(followups(ctx, est.id).every((f) => f.status === 'canceled'));
});

test('unsubscribe stops this estimate and blocks future estimates to that address', async () => {
  const ctx = makeCtx();
  const account = makeAccount(ctx);
  const est = add(ctx, account);
  await unsubscribe(ctx, est.public_token);
  assert.equal(estimateById(ctx, est.id).status, 'unsubscribed');
  const again = add(ctx, account, { customer_email: 'DANA@example.com' });
  assert.equal(again.status, 'unsubscribed');
  assert.equal(followups(ctx, again.id).length, 0);
});

test('an old estimate starts its sequence now and keeps the spacing between emails', async () => {
  const ctx = makeCtx();
  const account = makeAccount(ctx);
  const est = add(ctx, account, {}, MONDAY_10AM, MONDAY_10AM - 30 * DAY);
  const rows = followups(ctx, est.id);
  assert.equal(rows[0].scheduled_at, MONDAY_10AM);
  assert.equal(rows[1].scheduled_at - rows[0].scheduled_at, 3 * DAY);
  await runTick(ctx, MONDAY_10AM);
  assert.equal(ctx.transport.sent.length, 1, 'only one email, not a burst of overdue ones');
});

test('emails wait while the subscription is inactive, then go out one at a time with spacing kept', async () => {
  const ctx = makeCtx();
  const account = makeAccount(ctx, { active: false });
  const est = add(ctx, account);
  await runUntil(ctx, MONDAY_10AM, MONDAY_10AM + 12 * DAY);
  assert.equal(ctx.transport.sent.length, 0);
  ctx.db.prepare(`UPDATE accounts SET plan_status = 'active' WHERE id = ?`).run(account.id);
  const activatedAt = MONDAY_10AM + 12 * DAY;
  await runUntil(ctx, activatedAt, activatedAt + 2 * HOUR);
  assert.equal(ctx.transport.sent.length, 1);
  const rows = followups(ctx, est.id);
  assert.ok(rows[1].scheduled_at >= rows[0].sent_at + 3 * DAY, 'step 2 kept 3 days after step 1');
});

test('the same address is never emailed twice within the minimum gap', async () => {
  const ctx = makeCtx();
  const account = makeAccount(ctx);
  add(ctx, account, { job_description: 'interior' });
  add(ctx, account, { job_description: 'exterior' });
  await runUntil(ctx, MONDAY_10AM + 2 * DAY, MONDAY_10AM + 2 * DAY + 10 * HOUR);
  assert.equal(ctx.transport.sent.length, 1);
  await runUntil(ctx, MONDAY_10AM + 2 * DAY + 10 * HOUR, MONDAY_10AM + 4 * DAY);
  assert.equal(ctx.transport.sent.length, 2);
  const gap = ctx.db.prepare(`SELECT MAX(sent_at) - MIN(sent_at) g FROM followups WHERE status = 'sent'`).get().g;
  assert.ok(gap >= 20 * HOUR);
});

test('temporary provider errors are retried; a permanent error marks the email bad and alerts the contractor', async () => {
  const ctx = makeCtx();
  const account = makeAccount(ctx);
  const est = add(ctx, account);
  ctx.transport.failNext.push(new SendError('timeout'));
  const due = MONDAY_10AM + 2 * DAY;
  await runTick(ctx, due);
  assert.equal(followups(ctx, est.id)[0].status, 'scheduled');
  await runTick(ctx, due + 11 * 60 * 1000);
  assert.equal(followups(ctx, est.id)[0].status, 'sent');

  const est2 = add(ctx, account, { customer_email: 'typo@exampel.com' });
  ctx.transport.failNext.push(new SendError('Invalid email', { permanent: true }));
  await runTick(ctx, due + 3 * HOUR);
  assert.equal(estimateById(ctx, est2.id).status, 'bounced');
  assert.match(ctx.transport.sent.at(-1).subject, /bounced/);
});

test('an interrupted send is marked failed (never silently re-sent), and Retry sends it', async () => {
  const ctx = makeCtx();
  const account = makeAccount(ctx);
  const est = add(ctx, account);
  const f = followups(ctx, est.id)[0];
  ctx.db.prepare(`UPDATE followups SET status = 'sending', claimed_at = ? WHERE id = ?`).run(f.scheduled_at, f.id);
  await runTick(ctx, f.scheduled_at + HOUR);
  assert.equal(followups(ctx, est.id)[0].status, 'failed');
  assert.equal(ctx.transport.sent.length, 0);
  assert.ok(retryFollowup(ctx.db, getAccount(ctx, account.id), f.id, f.scheduled_at + HOUR));
  await runTick(ctx, f.scheduled_at + 2 * HOUR);
  assert.equal(ctx.transport.sent.length, 1);
});

test('pausing stops emails; resuming restarts no sooner than a day later', async () => {
  const ctx = makeCtx();
  const account = makeAccount(ctx);
  const est = add(ctx, account);
  setStatus(ctx.db, ctx.cfg, account, est, 'paused', { now: MONDAY_10AM + HOUR });
  await runUntil(ctx, MONDAY_10AM, MONDAY_10AM + 6 * DAY);
  assert.equal(ctx.transport.sent.length, 0);
  const resumeAt = MONDAY_10AM + 6 * DAY;
  setStatus(ctx.db, ctx.cfg, account, estimateById(ctx, est.id), 'active', { now: resumeAt });
  const rows = followups(ctx, est.id);
  assert.ok(rows.every((r) => r.status === 'scheduled'));
  assert.ok(rows[0].scheduled_at >= resumeAt + DAY);
  assert.equal(rows[1].scheduled_at - rows[0].scheduled_at >= 3 * DAY - HOUR, true);
});

test('a hard bounce webhook marks the estimate bad email', async () => {
  const ctx = makeCtx();
  const account = makeAccount(ctx);
  const est = add(ctx, account);
  await runTick(ctx, MONDAY_10AM + 2 * DAY);
  const r = await handleBounce(ctx, { RecordType: 'Bounce', Type: 'HardBounce', MessageID: 'msg-1' });
  assert.equal(r.hard, true);
  assert.equal(estimateById(ctx, est.id).status, 'bounced');
});

test('the active estimate limit is enforced', () => {
  const ctx = makeCtx({ MAX_ACTIVE_ESTIMATES: '2' });
  const account = makeAccount(ctx);
  add(ctx, account, { customer_email: 'a@x.com' });
  const b = add(ctx, account, { customer_email: 'b@x.com' });
  assert.throws(() => add(ctx, account, { customer_email: 'c@x.com' }), /up to 2 estimates/);
  setStatus(ctx.db, ctx.cfg, account, b, 'booked');
  assert.equal(countLimited(ctx.db, account.id), 1);
  add(ctx, account, { customer_email: 'c@x.com' });
});

test('changing the sending window moves already-scheduled emails into it', async () => {
  const { updateSettings } = await import('../src/services/accounts.js');
  const ctx = makeCtx();
  const account = makeAccount(ctx);
  const est = add(ctx, account);
  updateSettings(ctx.db, account, { ...account, send_window_start: 13, send_window_end: 15, send_days: ['1', '2', '3', '4', '5'] });
  const updated = getAccount(ctx, account.id);
  for (const f of followups(ctx, est.id)) {
    assert.ok(isInSendWindow(f.scheduled_at, updated));
    const p = localParts(f.scheduled_at, updated.timezone);
    assert.ok(p.hour >= 13 && p.hour < 15);
  }
});
