import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createAccount } from '../src/services/accounts.js';

export function makeConfig(overrides = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: 'test', BASE_URL: 'https://app.test', EMAIL_TRANSPORT: 'log', BILLING_MODE: 'manual',
    INBOUND_DOMAIN: 'in.test', INBOUND_WEBHOOK_SECRET: 'inbound-secret', FROM_EMAIL: 'followups@app.test', TRIAL_DAYS: '0',
    ...overrides,
  });
  try {
    return loadConfig();
  } finally {
    process.env = saved;
  }
}

// Records every message; set .failNext = [error, ...] to simulate provider errors.
export function fakeTransport() {
  const t = {
    sent: [],
    failNext: [],
    async send(msg) {
      if (t.failNext.length) throw t.failNext.shift();
      t.sent.push(msg);
      return { messageId: `msg-${t.sent.length}` };
    },
  };
  return t;
}

export function makeCtx(cfgOverrides) {
  const cfg = makeConfig(cfgOverrides);
  const db = openDb(':memory:');
  const transport = fakeTransport();
  return { cfg, db, transport };
}

export function makeAccount(ctx, { active = true, ...fields } = {}) {
  const { accountId } = createAccount(ctx.db, ctx.cfg, {
    business_name: 'Brightline Painting', owner_name: 'Sam Rivera', email: `owner${Math.random()}@paint.test`,
    password: 'password123', timezone: 'America/New_York',
  });
  ctx.db.prepare(`UPDATE accounts SET plan_status = ?, business_address = '12 Main St, Albany NY' WHERE id = ?`).run(active ? 'active' : 'inactive', accountId);
  for (const [k, v] of Object.entries(fields)) ctx.db.prepare(`UPDATE accounts SET ${k} = ? WHERE id = ?`).run(v, accountId);
  return getAccount(ctx, accountId);
}

export const getAccount = (ctx, id) => ctx.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
export const followups = (ctx, estimateId) => ctx.db.prepare('SELECT * FROM followups WHERE estimate_id = ? ORDER BY step_position').all(estimateId);
export const estimateById = (ctx, id) => ctx.db.prepare('SELECT * FROM estimates WHERE id = ?').get(id);

// Monday 2026-11-02 10:00 New York time (15:00 UTC).
export const MONDAY_10AM = Date.UTC(2026, 10, 2, 15, 0);

export const customer = (overrides = {}) => ({
  customer_name: 'Dana Whitfield', customer_email: 'dana@example.com', amount: '4,200',
  job_description: 'interior repaint, 3 bedrooms', ...overrides,
});
