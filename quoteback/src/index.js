import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createTransport } from './email/transport.js';
import { createApp } from './server.js';
import { startScheduler } from './scheduler.js';

const cfg = loadConfig();
const db = openDb(cfg.databasePath);
const transport = createTransport(cfg, db);
const ctx = { cfg, db, transport };

const app = createApp(ctx);
const server = app.listen(cfg.port, () => {
  console.log(`QuoteBack running at ${cfg.baseUrl} (email: ${transport.name}, billing: ${cfg.billing.mode}, reply detection: ${cfg.email.inboundDomain ? 'on' : 'off'})`);
});

const stopScheduler = cfg.scheduler.enabled ? startScheduler(ctx) : () => {};

function shutdown() {
  stopScheduler();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
