// Creates a demo account with realistic history for sales demos and local testing.
// Login: demo@quoteback.test / demo-password
// Refuses to run when NODE_ENV=production.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createAccount } from '../src/services/accounts.js';
import { createEstimate, setStatus, getEstimate, realignSchedule } from '../src/services/estimates.js';
import { runTick } from '../src/scheduler.js';
import { recordResponse, handleInboundEmail } from '../src/services/customer.js';
import { DAY, HOUR } from '../src/time.js';

const cfg = loadConfig();
if (cfg.isProd) throw new Error('Not in production.');
const db = openDb(cfg.databasePath);
const transport = { name: 'demo', send: async () => ({ messageId: `demo-${Math.random()}` }) };
const ctx = { cfg, db, transport };

if (db.prepare("SELECT 1 FROM users WHERE email = 'demo@quoteback.test'").get()) {
  console.log('Demo account already exists. Log in with demo@quoteback.test / demo-password');
  process.exit(0);
}

const start = Date.now() - 40 * DAY;
const { accountId } = createAccount(db, cfg, {
  business_name: 'Brightline Painting', owner_name: 'Sam Rivera', email: 'demo@quoteback.test',
  password: 'demo-password', timezone: 'America/New_York',
}, start);
db.prepare(`UPDATE accounts SET plan_status = 'active', phone = '(518) 555-0142', business_address = '12 Main St, Albany, NY 12207',
  test_email_sent_at = ?, send_days = '0,1,2,3,4,5,6', send_window_start = 0, send_window_end = 24 WHERE id = ?`).run(start, accountId);
const account = () => db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);

const people = [
  ['Dana Whitfield', 'interior repaint, 3 bedrooms', 4200], ['Marcus Lee', 'exterior, two-story colonial', 9800],
  ['Priya Shah', 'kitchen cabinets', 3600], ['Tom Becker', 'deck stain and railings', 1850], ['Alicia Gomez', 'whole-house interior', 11200],
  ['Ken Okafor', 'garage and trim', 2400], ['Rachel Stein', 'living room and hallway', 2900], ['Luis Ortega', 'exterior trim and shutters', 3300],
  ['Hannah Cole', 'basement walls and ceiling', 2100], ['Greg Novak', 'fence, 180 ft', 1600], ['Mei Tanaka', 'nursery and bathroom', 1400],
  ['Owen Price', 'exterior, ranch house', 6700], ['Fatima Noor', 'stairwell and foyer', 2600], ['Ben Harris', 'office suite (home)', 3900],
];

const ests = people.map(([name, job, amount], i) => {
  const sentAt = start + i * 2.5 * DAY;
  return createEstimate(db, cfg, account(), {
    customer_name: name, customer_email: `${name.split(' ')[0].toLowerCase()}@example.com`, job_description: job, amount: String(amount),
  }, { now: sentAt, sentAt });
});

// Replay time hour by hour so follow-ups, replies and bookings happen in a realistic order.
const outcomes = {
  1: { at: 7, act: 'reply', text: 'Hi Sam, sorry for the delay. Can you do the first week of May?' },
  2: { at: 6, act: 'tap', choice: 'schedule', text: 'Weekday mornings work best' },
  4: { at: 12, act: 'book', amount: 10800 },
  5: { at: 3, act: 'lost', reason: 'Went with a cheaper quote' },
  7: { at: 9, act: 'book', amount: 3300 },
  9: { at: 8, act: 'tap', choice: 'question', text: 'Is the paint low-VOC? We have a baby on the way.' },
  10: { at: 4, act: 'book', amount: 1400 },
};
const done = new Set();
for (let t = start; t < Date.now(); t += HOUR) {
  await runTick(ctx, t);
  for (const [i, o] of Object.entries(outcomes)) {
    const e = ests[i];
    if (done.has(i) || t < e.sent_at + o.at * DAY) continue;
    done.add(i);
    if (o.act === 'reply') await handleInboundEmail(ctx, { MailboxHash: e.public_token, FromFull: { Email: e.customer_email }, Subject: 'Re: Your estimate', StrippedTextReply: o.text }, t);
    if (o.act === 'tap') await recordResponse(ctx, e.public_token, o.choice, o.text, t);
    if (o.act === 'book') setStatus(db, cfg, account(), getEstimate(db, accountId, e.id), 'booked', { now: t, bookedAmountCents: o.amount * 100 });
    if (o.act === 'lost') setStatus(db, cfg, account(), getEstimate(db, accountId, e.id), 'lost', { now: t, reason: o.reason });
  }
}
db.prepare(`UPDATE accounts SET send_days = '1,2,3,4,5,6', send_window_start = 8, send_window_end = 18 WHERE id = ?`).run(accountId);
realignSchedule(db, account());
console.log('Demo account created. Log in with demo@quoteback.test / demo-password');
db.close();
