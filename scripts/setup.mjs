// npm run setup (plan-master task 19.1): asks which database and storage to
// use, tests the connection, and writes .env. Never creates or loads data.
// Non-interactive when answers are given as flags:
//   node scripts/setup.mjs --db postgres --database-url postgres://... --storage local --env-api yes
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'yes'] : null)).filter(Boolean));
const rl = process.stdin.isTTY && !args.db ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
const ask = async (question, fallback) => { if (!rl) return fallback; const a = (await rl.question(`${question} [${fallback}] `)).trim(); return a || fallback; };

console.log('Healthcare InSilico setup. This writes .env and tests connections. It never creates or loads data.\n');
const db = (args.db || await ask('Database: sqlite or postgres?', 'sqlite')).toLowerCase();
let databaseUrl = '';
if (db === 'postgres') {
  databaseUrl = args['database-url'] || await ask('PostgreSQL connection URL', 'postgres://localhost:5432/hospital');
  try { const { default: pg } = await import('pg'); const c = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 }); await c.connect(); await c.query('select 1'); await c.end(); console.log('  PostgreSQL connection works.'); } catch (err) { console.log(`  PostgreSQL connection failed: ${err.message}. The URL is written anyway; fix it in .env and run npm run install-check.`); }
} else { databaseUrl = ''; console.log('  SQLite under data/ (the default).'); }
const storage = (args.storage || await ask('Storage: local, gcs, s3 or azure?', 'local')).toLowerCase();
const lines = ['# Written by npm run setup. Keys live here or in files named by *_FILE; they are never logged or shown.'];
if (databaseUrl) lines.push(`DATABASE_URL=${databaseUrl}`);
else lines.push('DB_BACKEND=sqlite', 'SQLITE_FILE=data/app.sqlite');
lines.push(`OBJECT_STORE=${['local', 'gcs', 's3', 'azure'].includes(storage) ? storage : 'local'}`);
if (storage === 'gcs') lines.push(`GCS_BUCKET=${args.bucket || await ask('GCS bucket', 'hospital-desktop')}`, '# GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json');
if (storage === 's3') lines.push(`S3_BUCKET=${args.bucket || await ask('S3 bucket', 'hospital-desktop')}`, `S3_ENDPOINT=${args.endpoint || await ask('S3 endpoint (blank for AWS)', '')}`, 'S3_ACCESS_KEY_ID=', 'S3_SECRET_ACCESS_KEY=');
if (storage === 'azure') lines.push(`AZURE_CONTAINER=${args.bucket || await ask('Azure container', 'hospital-desktop')}`, 'AZURE_CONNECTION_STRING=');
const envApi = (args['env-api'] || await ask('Switch the environment API on (for trainers)? yes or no', 'no')).toLowerCase().startsWith('y');
lines.push(`ENV_API_ENABLED=${envApi ? 'true' : 'false'}`);
const port = args.port || await ask('Port', '3000');
lines.push(`PORT=${port}`);
const file = path.join(REPO_ROOT, '.env');
if (fs.existsSync(file) && !args.force) { const keep = path.join(REPO_ROOT, `.env.backup-${Date.now()}`); fs.copyFileSync(file, keep); console.log(`  Existing .env kept as ${path.basename(keep)}.`); }
fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
console.log(`\nWrote ${file}. Next: npm run install-check, then npm run dev (hospital screens) or npm run env:serve (environment API on).`);
if (rl) rl.close();
