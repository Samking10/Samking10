import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionMiddleware, requireUser, requireAdmin, verifyCsrf } from './auth.js';
import { publicRoutes } from './routes/public.js';
import { appRoutes } from './routes/app.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes } from './routes/admin.js';
import { webhookRoutes } from './routes/webhooks.js';
import { getMeta } from './db.js';
import { html } from './views/html.js';
import { page } from './views/layout.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(ctx) {
  const { db, cfg } = ctx;
  const app = express();
  app.disable('x-powered-by');
  if (cfg.isProd) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com; frame-ancestors 'none'");
    next();
  });

  // Webhooks first: they need the raw body and no session/CSRF.
  app.use('/webhooks', webhookRoutes(ctx));

  app.use('/static', express.static(path.join(here, '..', 'public'), { maxAge: cfg.isProd ? '1h' : 0 }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));

  app.get('/healthz', (req, res) => {
    const last = Number(getMeta(db, 'last_tick_at') || 0);
    const staleMs = Math.max(10 * 60, cfg.scheduler.intervalSeconds * 5) * 1000;
    const schedulerOk = !cfg.scheduler.enabled || (last && Date.now() - last < staleMs);
    db.prepare('SELECT 1').get();
    res.status(schedulerOk ? 200 : 503).json({ ok: !!schedulerOk, lastSchedulerRun: last ? new Date(last).toISOString() : null });
  });

  app.use(sessionMiddleware(db, cfg));
  app.use('/', publicRoutes(ctx));
  app.use('/app', requireUser, verifyCsrf, appRoutes(ctx), accountRoutes(ctx));
  app.use('/admin', requireUser, requireAdmin, verifyCsrf, adminRoutes(ctx));

  // Lets you read emails when EMAIL_TRANSPORT=log (local testing, or before email is set up).
  app.get('/dev/outbox', requireUser, (req, res) => {
    if (cfg.email.transport !== 'log' || (cfg.isProd && !req.user.isAdmin)) return res.status(404).send('Not found');
    const rows = req.user.isAdmin
      ? db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 100').all()
      : db.prepare(`SELECT o.* FROM outbox o WHERE o.to_email = ? OR o.to_email IN (SELECT customer_email FROM estimates WHERE account_id = ?) ORDER BY id DESC LIMIT 100`).all(req.account.notify_email, req.account.id);
    res.send(page({ req, title: 'Outbox', body: html`<h1>Outbox (test mode)</h1>
      <p class="muted">EMAIL_TRANSPORT=log: emails are stored here instead of being delivered.</p>
      ${rows.map((m) => html`<div class="card"><p class="small"><strong>To:</strong> ${m.to_email}<br><strong>From:</strong> ${m.from_header}<br><strong>Reply-To:</strong> ${m.reply_to || ''}<br><strong>Subject:</strong> ${m.subject}</p><div class="preview">${m.text_body}</div></div>`)}` }));
  });

  app.use((req, res) => res.status(404).send(page({ req, title: 'Not found', body: html`<div class="card"><h1>Page not found</h1><a href="/">Go home</a></div>` })));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', req.method, req.originalUrl, err);
    res.status(500).send(page({ req, title: 'Something went wrong', body: html`<div class="card"><h1>Something went wrong</h1><p>Please go back and try again. If it keeps happening, contact support${cfg.supportEmail ? ` at ${cfg.supportEmail}` : ''}.</p></div>` }));
  });

  return app;
}
