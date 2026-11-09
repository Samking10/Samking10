import crypto from 'node:crypto';
import { DAY, MINUTE } from './time.js';

const COOKIE = 'qb_session';
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return ['scrypt', salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password, stored) {
  const [kind, saltB64, hashB64] = String(stored).split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ }
    }
  }
  return out;
}

export function createSession(db, cfg, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * DAY;
  db.prepare('INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at) VALUES(?, ?, ?, ?)')
    .run(sha256(token), userId, crypto.randomBytes(24).toString('base64url'), expires);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  const secure = cfg.isProd ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

export function destroySession(db, req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function sessionMiddleware(db, cfg) {
  const lookup = db.prepare(`SELECT s.csrf_token, s.expires_at, u.id user_id, u.email, u.account_id FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`);
  const accountById = db.prepare('SELECT * FROM accounts WHERE id = ?');
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      const row = lookup.get(sha256(token));
      if (row && row.expires_at > Date.now()) {
        req.user = { id: row.user_id, email: row.email, isAdmin: cfg.adminEmails.includes(row.email.toLowerCase()) };
        req.account = accountById.get(row.account_id);
        req.csrfToken = row.csrf_token;
      }
    }
    next();
  };
}

export function requireUser(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(404).send('Not found');
  next();
}

export function verifyCsrf(req, res, next) {
  if (req.method !== 'POST') return next();
  const sent = String(req.body?._csrf || '');
  const ok = req.csrfToken && sent.length === req.csrfToken.length
    && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.csrfToken));
  if (!ok) return res.status(403).send('This form expired. Go back, refresh the page, and try again.');
  next();
}

// Simple in-memory limiter for login and password-reset forms.
export function rateLimiter({ max, windowMs = 15 * MINUTE }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 10000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return true;
    }
    entry.count++;
    return entry.count <= max;
  };
}
