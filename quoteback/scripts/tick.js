// Runs the follow-up scheduler once and exits. Use this if your host runs cron jobs
// instead of a long-running process (set SCHEDULER_ENABLED=false on the web server then).
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createTransport } from '../src/email/transport.js';
import { runTick } from '../src/scheduler.js';

const cfg = loadConfig();
const db = openDb(cfg.databasePath);
const result = await runTick({ cfg, db, transport: createTransport(cfg, db) });
console.log(JSON.stringify(result));
db.close();
