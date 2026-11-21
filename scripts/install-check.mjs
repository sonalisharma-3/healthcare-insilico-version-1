// Verifies Node, the database and storage before the server starts
// (plan-master task 19.1). Never creates or loads data. Exit code 0 when
// everything is in place, 1 otherwise, with plain-English lines.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lines = []; let ok = true;
const pass = (m) => lines.push(`ok    ${m}`);
const fail = (m) => { ok = false; lines.push(`FAIL  ${m}`); };
const warn = (m) => lines.push(`note  ${m}`);

// Node 22 or later.
const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) pass(`Node ${process.versions.node}`); else fail(`Node ${process.versions.node}: Node 22 or later is required`);

// .env (optional) and the database setting.
const envFile = path.join(REPO_ROOT, '.env');
const env = { ...process.env };
if (fs.existsSync(envFile)) { for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } pass('.env found'); } else warn('.env not found: defaults apply (SQLite under data/, environment API off). Run npm run setup to write one');

const dbUrl = env.DATABASE_URL || '';
const backend = (env.DB_BACKEND || '').toLowerCase();
if (!backend && !dbUrl) fail('No database configured: set DB_BACKEND=sqlite or DATABASE_URL=postgres://... in .env');
else if (backend === 'sqlite' || dbUrl.startsWith('sqlite') || dbUrl.startsWith('file:')) {
  const file = env.SQLITE_FILE || dbUrl.replace(/^(sqlite:|file:)/, '') || path.join(REPO_ROOT, 'data', 'app.sqlite');
  const dir = path.dirname(path.resolve(REPO_ROOT, file));
  try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); pass(`SQLite database folder is writable: ${dir}`); } catch { fail(`SQLite database folder is not writable: ${dir}`); }
  if (env.ENV_API_ENABLED === 'true') warn('The environment API on SQLite is fine for one worker; for several stateless workers use PostgreSQL');
} else if (dbUrl.startsWith('postgres')) {
  try {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: dbUrl, connectionTimeoutMillis: 5000 });
    await client.connect(); const r = await client.query('select version()'); await client.end();
    pass(`PostgreSQL reachable: ${String(r.rows[0].version).split(',')[0]}`);
  } catch (err) { fail(`PostgreSQL not reachable at DATABASE_URL: ${err.message}`); }
} else fail(`DATABASE_URL "${dbUrl}" is not a sqlite or postgres URL`);

// Storage: local folders, or a cloud object store named in OBJECT_STORE.
const store = env.OBJECT_STORE || 'local';
if (store === 'local') {
  for (const d of ['data', env.DICOM_DIR || 'data/dicom', env.SLIDES_DIR || 'data/slides', 'data/exports', 'data/recordings', 'data/backups']) {
    const dir = path.resolve(REPO_ROOT, d);
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); } catch { fail(`Storage folder is not writable: ${dir}`); }
  }
  pass('Local storage folders under data/ are writable');
} else if (['gcs', 's3', 'azure'].includes(store)) {
  const need = { gcs: ['GCS_BUCKET'], s3: ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'], azure: ['AZURE_CONTAINER', 'AZURE_CONNECTION_STRING'] }[store];
  const missing = need.filter((k) => !env[k] && !env[`${k}_FILE`]);
  if (missing.length) fail(`OBJECT_STORE=${store} needs ${missing.join(', ')} in .env (or *_FILE paths)`); else pass(`Object store ${store} configured (keys are never printed)`);
} else fail(`OBJECT_STORE "${store}" must be local, gcs, s3 or azure`);

// Vendored browser bundles and the web root.
if (fs.existsSync(path.join(REPO_ROOT, 'desktop-login', 'web', 'index.html'))) pass('Web root present'); else fail('desktop-login/web/index.html is missing');
if (env.ENV_API_ENABLED === 'true') pass('Environment API will be on'); else warn('Environment API is off (ENV_API_ENABLED is not true)');

console.log(lines.join('\n'));
console.log(ok ? '\nInstall check passed.' : '\nInstall check failed. Fix the lines marked FAIL and run it again.');
process.exit(ok ? 0 : 1);
