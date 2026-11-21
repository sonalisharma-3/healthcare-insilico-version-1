// Several stateless workers in front of one PostgreSQL (plan-master task
// 19.2). Each worker is the normal server; the operating system spreads
// connections (and so episodes) across them. SQLite allows one worker only.
//   WORKERS=4 node platform/server/cluster.mjs
import cluster from 'node:cluster';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dbConfig } from './db/index.mjs';

const wanted = Number(process.env.WORKERS) || Math.max(1, Math.min(8, os.availableParallelism() - 1));
const backend = (() => { try { return dbConfig().backend; } catch { return (process.env.DATABASE_URL || '').startsWith('postgres') ? 'postgres' : 'sqlite'; } })();
const workers = backend === 'postgres' ? wanted : 1;
if (cluster.isPrimary) {
  if (workers === 1 && wanted > 1) console.log('  SQLite in use: running one worker. Several workers need PostgreSQL (DATABASE_URL=postgres://...).');
  console.log(`  Starting ${workers} worker${workers === 1 ? '' : 's'} on port ${process.env.PORT || 3000}`);
  cluster.setupPrimary({ exec: fileURLToPath(new URL('./index.mjs', import.meta.url)) });
  const forkWorker = (idx) => { const w = cluster.fork({ WORKER_INDEX: String(idx), HL7_MLLP_PORT: '' }); w.workerIndex = idx; return w; };
  for (let i = 0; i < workers; i += 1) forkWorker(i);
  cluster.on('exit', (w, code) => { if (code !== 0 && !w.exitedAfterDisconnect) { console.log(`  worker ${w.id} exited (${code}); restarting`); forkWorker(w.workerIndex ?? 0); } });
  const stop = () => { for (const w of Object.values(cluster.workers)) w?.disconnect(); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
