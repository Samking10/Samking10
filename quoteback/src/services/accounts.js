import crypto from 'node:crypto';
import { hashPassword, sha256 } from '../auth.js';
import { DEFAULT_STEPS, MAX_STEPS } from '../defaults.js';
import { DAY, HOUR, isValidTimezone, parseSendDays } from '../time.js';
import { isEmail, UserError, realignSchedule } from './estimates.js';
import { unknownFields } from '../templates.js';

export function createAccount(db, cfg, input, now = Date.now()) {
  const businessName = String(input.business_name || '').trim().slice(0, 100);
  const ownerName = String(input.owner_name || '').trim().slice(0, 100);
  const email = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');
  const timezone = isValidTimezone(input.timezone) ? input.timezone : 'America/New_York';
  if (!businessName) throw new UserError('Business name is required.');
  if (!isEmail(email)) throw new UserError('Enter a valid email address.');
  if (password.length < 8) throw new UserError('Password must be at least 8 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new UserError('An account with that email already exists. Try logging in.');

  return db.transaction(() => {
    const trial = cfg.pricing.trialDays > 0;
    const acc = db.prepare(`INSERT INTO accounts(business_name, owner_name, notify_email, timezone, plan_status, trial_ends_at, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run(businessName, ownerName, email, timezone, trial ? 'trialing' : 'inactive', trial ? now + cfg.pricing.trialDays * DAY : null, now);
    const accountId = acc.lastInsertRowid;
    const user = db.prepare('INSERT INTO users(account_id, email, password_hash, created_at) VALUES(?, ?, ?, ?)')
      .run(accountId, email, hashPassword(password), now);
    const insert = db.prepare('INSERT INTO sequence_steps(account_id, position, delay_days, subject, body) VALUES(?, ?, ?, ?, ?)');
    DEFAULT_STEPS.forEach((s, i) => insert.run(accountId, i + 1, s.delay_days, s.subject, s.body));
    return { accountId: Number(accountId), userId: Number(user.lastInsertRowid) };
  })();
}

export function updateSettings(db, account, input) {
  const v = {
    business_name: String(input.business_name || '').trim().slice(0, 100),
    owner_name: String(input.owner_name || '').trim().slice(0, 100),
    notify_email: String(input.notify_email || '').trim().toLowerCase(),
    phone: String(input.phone || '').trim().slice(0, 40),
    business_address: String(input.business_address || '').trim().slice(0, 200),
    timezone: String(input.timezone || ''),
    send_window_start: Number(input.send_window_start),
    send_window_end: Number(input.send_window_end),
    send_days: [].concat(input.send_days || []).map(Number).filter((n) => n >= 0 && n <= 6).sort().join(','),
    email_signature: String(input.email_signature || '').slice(0, 1000),
    include_response_link: input.include_response_link ? 1 : 0,
    bcc_owner: input.bcc_owner ? 1 : 0,
    sending_paused: input.sending_paused ? 1 : 0,
  };
  const errors = [];
  if (!v.business_name) errors.push('Business name is required.');
  if (!isEmail(v.notify_email)) errors.push('Enter a valid email for notifications.');
  if (!isValidTimezone(v.timezone)) errors.push('Choose a valid time zone.');
  if (!(v.send_window_start >= 0 && v.send_window_end <= 24 && v.send_window_end - v.send_window_start >= 2)) errors.push('Sending hours must be at least 2 hours long.');
  if (parseSendDays(v.send_days).length === 0) errors.push('Pick at least one day for sending.');
  if (errors.length) throw new UserError(errors.join(' '));
  db.prepare(`UPDATE accounts SET business_name=@business_name, owner_name=@owner_name, notify_email=@notify_email, phone=@phone,
    business_address=@business_address, timezone=@timezone, send_window_start=@send_window_start, send_window_end=@send_window_end,
    send_days=@send_days, email_signature=@email_signature, include_response_link=@include_response_link, bcc_owner=@bcc_owner,
    sending_paused=@sending_paused WHERE id=@id`).run({ ...v, id: account.id });
  realignSchedule(db, db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id));
}

// Replaces the sequence. Wording changes apply to every email not yet sent. Timing changes
// apply to estimates added afterwards (already-scheduled emails keep their dates).
export function saveSequence(db, accountId, steps) {
  const clean = steps
    .map((s) => ({ delay_days: Number(s.delay_days), subject: String(s.subject || '').trim(), body: String(s.body || '').trim() }))
    .filter((s) => s.subject || s.body);
  const errors = [];
  if (clean.length === 0) errors.push('Keep at least one follow-up email.');
  if (clean.length > MAX_STEPS) errors.push(`At most ${MAX_STEPS} follow-up emails.`);
  clean.forEach((s, i) => {
    if (!Number.isInteger(s.delay_days) || s.delay_days < 1 || s.delay_days > 90) errors.push(`Email ${i + 1}: days must be between 1 and 90.`);
    if (!s.subject) errors.push(`Email ${i + 1}: subject is required.`);
    if (!s.body) errors.push(`Email ${i + 1}: message is required.`);
    if (i > 0 && s.delay_days <= clean[i - 1].delay_days) errors.push(`Email ${i + 1} must go out later than email ${i}.`);
    const bad = unknownFields(`${s.subject} ${s.body}`);
    if (bad.length) errors.push(`Email ${i + 1}: unknown field ${bad.map((b) => `{{${b}}}`).join(', ')}.`);
  });
  if (errors.length) throw new UserError(errors.join(' '));
  db.transaction(() => {
    const existing = db.prepare('SELECT position FROM sequence_steps WHERE account_id = ?').all(accountId).map((r) => r.position);
    const upsert = db.prepare(`INSERT INTO sequence_steps(account_id, position, delay_days, subject, body) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(account_id, position) DO UPDATE SET delay_days = excluded.delay_days, subject = excluded.subject, body = excluded.body`);
    clean.forEach((s, i) => upsert.run(accountId, i + 1, s.delay_days, s.subject, s.body));
    for (const pos of existing) if (pos > clean.length) db.prepare('DELETE FROM sequence_steps WHERE account_id = ? AND position = ?').run(accountId, pos);
  })();
}

export function createPasswordReset(db, email, now = Date.now()) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  if (!user) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO password_resets(token_hash, user_id, expires_at) VALUES(?, ?, ?)').run(sha256(token), user.id, now + 2 * HOUR);
  return { user, token };
}

export function usePasswordReset(db, token, password, now = Date.now()) {
  if (String(password || '').length < 8) throw new UserError('Password must be at least 8 characters.');
  const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha256(String(token || '')));
  if (!row || row.used_at || row.expires_at < now) throw new UserError('This reset link has expired. Request a new one.');
  db.transaction(() => {
    db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(now, row.token_hash);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), row.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
  })();
  return row.user_id;
}
