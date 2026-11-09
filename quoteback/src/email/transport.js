// Email delivery. One small function per provider, using plain HTTPS calls (no SDKs to keep updated).

export class SendError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.permanent = permanent; // true = retrying will not help (bad address, suppressed, etc.)
  }
}

export function createTransport(cfg, db) {
  const kind = cfg.email.transport;
  if (kind === 'log') return logTransport(db);
  if (kind === 'postmark') return postmarkTransport(cfg.email);
  if (kind === 'resend') return resendTransport(cfg.email);
  throw new Error(`Unknown transport ${kind}`);
}

function logTransport(db) {
  return {
    name: 'log',
    async send(msg) {
      const r = db.prepare(`INSERT INTO outbox(to_email, from_header, reply_to, subject, text_body, created_at)
        VALUES(?, ?, ?, ?, ?, ?)`).run(msg.to, msg.from, msg.replyTo || null, msg.subject, msg.text, Date.now());
      return { messageId: `log-${r.lastInsertRowid}` };
    },
  };
}

async function postJson(url, headers, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new SendError(`Network error: ${err.message}`);
  }
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* keep raw text */ }
  return { res, json, text };
}

function postmarkTransport(e) {
  return {
    name: 'postmark',
    async send(msg) {
      const headers = Object.entries(msg.headers || {}).map(([Name, Value]) => ({ Name, Value }));
      const { res, json, text } = await postJson('https://api.postmarkapp.com/email', { 'X-Postmark-Server-Token': e.postmarkToken }, {
        From: msg.from, To: msg.to, ReplyTo: msg.replyTo, Bcc: msg.bcc || undefined,
        Subject: msg.subject, TextBody: msg.text, HtmlBody: msg.html,
        Headers: headers, MessageStream: e.postmarkStream, TrackOpens: false, TrackLinks: 'None',
        Tag: msg.tag,
      });
      if (res.ok && json.ErrorCode === 0) return { messageId: json.MessageID };
      // 300 invalid email, 406 inactive recipient (bounced/unsubscribed before): retrying won't help.
      const permanent = res.status === 422 && [300, 406].includes(json.ErrorCode);
      throw new SendError(`Postmark ${res.status}: ${json.Message || text}`.slice(0, 500), { permanent });
    },
  };
}

function resendTransport(e) {
  return {
    name: 'resend',
    async send(msg) {
      const headers = { Authorization: `Bearer ${e.resendApiKey}` };
      if (msg.idempotencyKey) headers['Idempotency-Key'] = msg.idempotencyKey;
      const { res, json, text } = await postJson('https://api.resend.com/emails', headers, {
        from: msg.from, to: [msg.to], reply_to: msg.replyTo, bcc: msg.bcc ? [msg.bcc] : undefined,
        subject: msg.subject, text: msg.text, html: msg.html, headers: msg.headers,
      });
      if (res.ok && json.id) return { messageId: json.id };
      const permanent = res.status === 422 || res.status === 400;
      throw new SendError(`Resend ${res.status}: ${json.message || text}`.slice(0, 500), { permanent });
    },
  };
}
