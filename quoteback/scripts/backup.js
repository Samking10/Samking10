// Makes a consistent copy of the database (safe while the app is running) and keeps the newest 14.
// Usage: npm run backup            -> data/backups/quoteback-YYYY-MM-DD-HHMM.db
//        BACKUP_DIR=/mnt/x npm run backup
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';

const cfg = loadConfig();
const dir = process.env.BACKUP_DIR || path.join(path.dirname(cfg.databasePath), 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
const file = path.join(dir, `quoteback-${stamp}.db`);
const db = openDb(cfg.databasePath);
await db.backup(file);
db.close();

const keep = Number(process.env.BACKUP_KEEP || 14);
const old = fs.readdirSync(dir).filter((f) => /^quoteback-.*\.db$/.test(f)).sort().reverse().slice(keep);
for (const f of old) fs.unlinkSync(path.join(dir, f));
console.log(`Backup written to ${file}`);
