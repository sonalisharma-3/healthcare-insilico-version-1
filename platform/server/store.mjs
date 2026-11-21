// The single repository interface used by every app.
//
// Versions, not overwrites: save() only appends. Reads take { asOf, branch }.
// A branch sees its own versions plus each ancestor's versions recorded at or
// before the fork point (copy-on-write). Timestamps are UTC ISO strings with
// millisecond precision, so string comparison is chronological.
import { randomUUID } from 'node:crypto';
import { validateResource, INTERNAL_TYPES, FHIR_TYPES } from './validate.mjs';

export { INTERNAL_TYPES, FHIR_TYPES };

// A TraceStep or AuditEvent is written once and never gets a second version.
export const APPEND_ONLY_TYPES = new Set(['TraceStep', 'AuditEvent']);

// Server-owned fields. Stripped from FHIR responses and ignored on API input.
export const INTERNAL_FIELDS = [
  '_patient', '_released', '_updatedBy', '_org', '_recordedAt', '_validAt', '_branch', '_sandbox',
  '_shadow', '_import', '_seq', '_ack', '_lock',
];

const BRANCH_KINDS = new Set(['shadow', 'sandbox', 'rollout', 'redteam']);

export class StoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
  }
}

export function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new StoreError('invalid', `Invalid timestamp "${value}"`, 400);
  return date.toISOString();
}

const minIso = (a, b) => (a == null ? b : b == null ? a : a < b ? a : b);

function derivePatient(doc) {
  if (doc.resourceType === 'Patient') return `Patient/${doc.id}`;
  for (const key of ['subject', 'patient', 'beneficiary', 'for']) {
    const ref = doc[key]?.reference;
    if (typeof ref === 'string' && ref.startsWith('Patient/')) return ref;
  }
  for (const p of Array.isArray(doc.participant) ? doc.participant : []) {
    const ref = p?.actor?.reference;
    if (typeof ref === 'string' && ref.startsWith('Patient/')) return ref;
  }
  return typeof doc._patient === 'string' ? doc._patient : null;
}

function deriveValidAt(doc) {
  // Prefer result availability time (issued) over specimen draw time (effectiveDateTime) so lab results appear when resulted.
  const candidate = doc.issued ?? doc.effectiveDateTime ?? doc.effectivePeriod?.start ?? doc.authoredOn
    ?? doc.performedDateTime ?? doc.performedPeriod?.start ?? doc.occurrenceDateTime
    ?? doc.whenHandedOver ?? doc.whenPrepared ?? doc.receivedTime ?? doc.collection?.collectedDateTime
    ?? doc.identifiedDateTime ?? doc.onsetDateTime ?? doc.recordedDate ?? doc.date ?? doc.period?.start
    ?? doc.started ?? doc.start ?? doc.sent ?? doc.created ?? doc.recorded;
  if (typeof candidate !== 'string') return null;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
const TIMELESS_TYPES_SQL = "('Patient','Practitioner','Organization','Location','Device','RelatedPerson','Coverage','Consent')";

/**
 * No patient names anywhere (docs/PAYER.md, rules): a patient is known by number. Whatever name a record holds,
 * every read gives "Patient <medical record number>" in its place. A name that came with imported data stays in the
 * stored record for one purpose only: so that it can be found and masked in free text (earlierNames).
 */
const kept = new WeakMap();
/** The name a record was stored with, for the redactor only. Never shown, served or exported. */
export const earlierNames = (doc) => kept.get(doc) || [];
export function numberName(doc) {
  if (!doc || doc.resourceType !== 'Patient') return doc;
  if (Array.isArray(doc.name) && doc.name.length && !/^Patient /.test(doc.name[0]?.family || '')) kept.set(doc, doc.name);
  const mrn = (doc.identifier || []).find((i) => i.type?.coding?.some((c) => c.code === 'MR'))?.value ?? (doc.identifier || []).find((i) => i.value)?.value ?? null;
  const label = `Patient ${mrn ?? String(doc.id || '').slice(0, 8)}`;
  doc.name = [{ use: 'official', text: label, family: label }];
  return doc;
}
function rowToDoc(row) {
  const doc = numberName(typeof row.body === 'string' ? JSON.parse(row.body) : row.body);
  doc._seq = Number(row.seq);
  return doc;
}

function isConflict(err) {
  return err?.code === '23505' || err?.code === '40001' || /UNIQUE constraint failed/i.test(err?.message || '');
}

export function createStore({ adapter, clock = () => new Date() }) {
  return bindStore(adapter, { adapter, clock }, false);
}

function bindStore(db, root, inTransaction) {
  const now = () => iso(root.clock());
  const atomic = (fn) => (inTransaction ? fn(db) : db.transaction(fn));

  async function branchRow(q, id) {
    const row = await q.get('SELECT * FROM branches WHERE id = ?', [id]);
    if (!row) throw new StoreError('not-found', `Unknown branch "${id}"`, 404);
    return row;
  }

  const toBranch = (row) => ({
    id: row.id, parentBranch: row.parent_branch, forkedAt: row.forked_at, kind: row.kind,
    createdAt: row.created_at, droppedAt: row.dropped_at, careCap: row.care_cap ?? null,
  });

  // [{ id, cap }] from the branch itself (cap null) up to main. cap is the
  // latest recorded_at this branch is allowed to see on that ancestor.
  async function lineage(q, branchId) {
    if (branchId === 'main' && root.mainChain) return root.mainChain.map((b) => ({ ...b }));
    const chain = [];
    let row = await branchRow(q, branchId);
    if (row.dropped_at) throw new StoreError('gone', `Branch "${branchId}" was dropped`, 410);
    let cap = null;
    for (let depth = 0; depth < 64; depth += 1) {
      chain.push({ id: row.id, cap, kind: row.kind, forkedAt: row.forked_at, careCap: row.care_cap ?? null });
      if (!row.parent_branch) { if (branchId === 'main') root.mainChain = chain.map((b) => ({ ...b })); return chain; }
      cap = minIso(cap, row.forked_at);
      row = await branchRow(q, row.parent_branch);
    }
    throw new StoreError('invalid', 'Branch ancestry too deep', 500);
  }

  // Latest visible version per (type, id) for a branch view at asOf.
  async function latest(q, { type, id, patient, groupKey, internal, branch = 'main', asOf, contains }) {
    const chain = await lineage(q, branch);
    const bound = asOf == null ? null : iso(asOf);
    const careIdx = chain.findIndex((b) => b.careCap);
    const care = careIdx >= 0 ? chain[careIdx] : null;
    const depthParams = [];
    const whereParams = [];
    const depthSql = chain.map((b, i) => { depthParams.push(b.id); return `WHEN ? THEN ${i}`; }).join(' ');
    const visible = chain.map((b, idx) => {
      const limit = minIso(b.cap, bound);
      const parts = ['rv.branch = ?'];
      whereParams.push(b.id);
      if (limit != null) {
        parts.push('rv.recorded_at <= ?');
        whereParams.push(limit);
      }
      // Apply careCap before ROW_NUMBER() to ancestors of the care-capped branch so older versions still surface and child branches see their own writes.
      if (care && idx > careIdx) {
        parts.push(`(rv.valid_at <= ? OR rv.resource_type IN ${TIMELESS_TYPES_SQL})`);
        whereParams.push(care.careCap);
      }
      return `(${parts.join(' AND ')})`;
    }).join(' OR ');
    const inner = [`(${visible})`];
    if (type) { inner.push('rv.resource_type = ?'); whereParams.push(type); }
    if (id) { inner.push('rv.id = ?'); whereParams.push(id); }
    if (internal != null) { inner.push('rv.internal = ?'); whereParams.push(internal ? 1 : 0); }
    // A pre-filter done by the database: only resources with at least one version containing one of these JSON
    // fragments are read. The latest version is still chosen from all of that resource's versions, and the caller's
    // own check still runs, so this only saves reading rows that cannot match. Postgres only (SQLite reads everything).
    if (type && /^[A-Za-z]{1,64}$/.test(type) && contains?.length && root.adapter.dialect === 'postgres') {
      // The type is written into the SQL (a plain word, checked above) so Postgres can use the partial GIN index on it.
      inner.push(`rv.id IN (SELECT c.id FROM resource_versions c WHERE c.resource_type = '${type}' AND (${contains.map(() => 'c.body @> ?::jsonb').join(' OR ')}))`);
      whereParams.push(...contains.map((f) => JSON.stringify(f)));
    }
    // A patient's or a group's records: narrow to their ids first, through the (patient, resource_type) and
    // (resource_type, group_key) indexes, so the latest-version step reads only those resources and not the whole type.
    if (patient && type) { inner.push('rv.id IN (SELECT p.id FROM resource_versions p WHERE p.patient = ? AND p.resource_type = ?)'); whereParams.push(patient, type); }
    else if (patient) { inner.push('(rv.resource_type, rv.id) IN (SELECT p.resource_type, p.id FROM resource_versions p WHERE p.patient = ?)'); whereParams.push(patient); }
    if (groupKey && type) { inner.push('rv.id IN (SELECT g.id FROM resource_versions g WHERE g.resource_type = ? AND g.group_key = ?)'); whereParams.push(type, groupKey); }
    const outer = ['t.rn = 1'];
    const outerParams = [];
    if (patient) { outer.push('t.patient = ?'); outerParams.push(patient); }
    if (groupKey) { outer.push('t.group_key = ?'); outerParams.push(groupKey); }
    const sql = `SELECT t.seq, t.body FROM (
        SELECT rv.seq, rv.body, rv.patient, rv.group_key, rv.branch, rv.valid_at, rv.recorded_at,
               ROW_NUMBER() OVER (
                 PARTITION BY rv.resource_type, rv.id
                 ORDER BY CASE rv.branch ${depthSql} END ASC, rv.version_id DESC
               ) AS rn
        FROM resource_versions rv
        WHERE ${inner.join(' AND ')}
      ) t WHERE ${outer.join(' AND ')} ORDER BY t.seq ASC`;
    const rows = await q.all(sql, [...depthParams, ...whereParams, ...outerParams]);
    return { rows: rows.map(rowToDoc), chain };
  }

  function matches(doc, filters) {
    for (const [key, expected] of Object.entries(filters)) {
      const actual = key.split('.').reduce((v, part) => (v == null ? v : v[part]), doc);
      if (Array.isArray(expected) ? !expected.includes(actual) : actual !== expected) return false;
    }
    return true;
  }

  const store = {
    INTERNAL_TYPES,
    inTransaction,
    // The SQL executor this store is bound to, for the few side tables that are not versioned resources.
    sql: db,

    /** Runs fn with a store bound to one SQL transaction. All or nothing. */
    async transaction(fn) {
      if (inTransaction) return fn(store);
      // Serializable transactions (PostgreSQL) can fail against each other even when unrelated; nothing is committed
      // on a failure, so the whole transaction is run again a few times before the conflict is reported.
      for (let attempt = 0; ; attempt += 1) {
        try { return await db.transaction((tx) => fn(bindStore(tx, root, true))); } catch (err) {
          if (!isConflict(err) && !(err instanceof StoreError && err.code === 'conflict')) throw err;
          if (attempt >= 10) throw new StoreError('conflict', 'Concurrent write conflict; retry', 409);
          await new Promise((resolve) => setTimeout(resolve, Math.min(600, 15 * 2 ** attempt) + Math.random() * 40));
        }
      }
    },

    /**
     * Appends a new version and returns it. Never mutates an earlier version.
     * opts: branch, ifMatch (expected current versionId), recordedAt, validAt,
     * updatedBy, released.
     */
    async save(type, input, opts = {}) {
      if (inTransaction) return store.saveOnce(type, input, opts);
      for (let attempt = 0; ; attempt += 1) {
        try { return await store.saveOnce(type, input, opts); } catch (err) {
          if (!(err instanceof StoreError && err.code === 'conflict') || attempt >= 10) throw err;
          await new Promise((resolve) => setTimeout(resolve, Math.min(600, 15 * 2 ** attempt) + Math.random() * 40));
        }
      }
    },
    async saveOnce(type, input, opts = {}) {
      const branch = opts.branch ?? input?._branch ?? 'main';
      const doc = structuredClone(input ?? {});
      if (doc.id == null) doc.id = randomUUID();
      const issues = validateResource(type, doc);
      if (issues.length) throw new StoreError('invalid', issues.join('; '), 422);

      const run = async (q) => {
        const { rows, chain } = await latest(q, { type, id: doc.id, branch });
        const current = rows[0] ?? null;
        if (current && APPEND_ONLY_TYPES.has(type)) {
          throw new StoreError('append-only', `${type}/${doc.id} is append-only and already exists`, 409);
        }
        if (opts.ifMatch != null && String(opts.ifMatch) !== String(current?.meta?.versionId ?? '0')) {
          throw new StoreError('conflict',
            `Version conflict on ${type}/${doc.id}: expected ${opts.ifMatch}, current ${current?.meta?.versionId ?? 'none'}`, 409);
        }
        const wall = now();
        const recordedAt = opts.recordedAt ? iso(opts.recordedAt) : wall;
        if (current && recordedAt < current._recordedAt) {
          throw new StoreError('invalid',
            `recordedAt ${recordedAt} is earlier than the current version (${current._recordedAt})`, 422);
        }
        const self = chain[0];
        if (self.forkedAt && recordedAt < self.forkedAt) {
          throw new StoreError('invalid', `recordedAt ${recordedAt} is before branch fork time ${self.forkedAt}`, 422);
        }
        const versionId = current ? Number(current.meta.versionId) + 1 : 1;
        delete doc._seq;
        doc.meta = { ...(doc.meta || {}), versionId: String(versionId), lastUpdated: recordedAt };
        doc._patient = derivePatient(doc);
        doc._released = opts.released ?? doc._released ?? current?._released ?? false;
        doc._updatedBy = opts.updatedBy ?? doc._updatedBy ?? 'system';
        doc._org = doc._org ?? current?._org ?? 'org-default';
        doc._recordedAt = recordedAt;
        doc._validAt = opts.validAt ? iso(opts.validAt) : (deriveValidAt(doc) ?? current?._validAt ?? recordedAt);
        doc._branch = branch;
        doc._sandbox = self.kind === 'sandbox';
        const groupKey = type === 'TraceStep' ? doc.runId : (doc._groupKey ?? null);
        await q.run(
          `INSERT INTO resource_versions
             (resource_type, id, version_id, branch, recorded_at, valid_at, patient, group_key, internal, body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [type, doc.id, versionId, branch, recordedAt, doc._validAt, doc._patient, groupKey,
            INTERNAL_TYPES.has(type) ? 1 : 0, JSON.stringify(doc)],
        );
        return doc;
      };
      try {
        return await atomic(run);
      } catch (err) {
        if (isConflict(err)) throw new StoreError('conflict', `Concurrent write to ${type}/${doc.id}; retry`, 409);
        throw err;
      }
    },

    /** Latest version of one resource visible at { asOf, branch }, or null. */
    async get(type, id, opts = {}) {
      const { rows } = await latest(db, { type, id, branch: opts.branch ?? 'main', asOf: opts.asOf });
      return rows[0] ?? null;
    },

    /**
     * Latest visible version of every resource of a type that matches.
     * filters: patient, groupKey, where (function), contains (JSON fragments, any of: a database pre-filter), _branch, _asOf, and
     * equality on dotted paths (an array value means "any of").
     */
    async query(type, filters = {}, opts = {}) {
      const { patient, groupKey, where, contains, _branch, _asOf, ...equals } = filters || {};
      const { rows } = await latest(db, {
        type, patient, groupKey, contains, branch: opts.branch ?? _branch ?? 'main', asOf: opts.asOf ?? _asOf,
      });
      return rows.filter((doc) => matches(doc, equals) && (!where || where(doc)));
    },

    /** Every clinical (non-internal) resource for one patient. */
    async everything(patientRef, opts = {}) {
      const { rows } = await latest(db, {
        patient: patientRef, internal: false, branch: opts.branch ?? 'main', asOf: opts.asOf,
      });
      return rows;
    },

    /** Latest versions on main. */
    head(type) { return store.query(type, {}, { branch: 'main' }); },

    /** All versions visible to a branch, oldest first. */
    async history(type, id, opts = {}) {
      const chain = await lineage(db, opts.branch ?? 'main');
      const bound = opts.asOf == null ? null : iso(opts.asOf);
      const careIdx = chain.findIndex((b) => b.careCap);
      const care = careIdx >= 0 ? chain[careIdx] : null;
      const params = [type, id];
      const visible = chain.map((b, idx) => {
        const limit = minIso(b.cap, bound);
        const parts = ['branch = ?'];
        params.push(b.id);
        if (limit != null) {
          parts.push('recorded_at <= ?');
          params.push(limit);
        }
        if (care && idx > careIdx) {
          parts.push(`(valid_at <= ? OR resource_type IN ${TIMELESS_TYPES_SQL})`);
          params.push(care.careCap);
        }
        return `(${parts.join(' AND ')})`;
      }).join(' OR ');
      const rows = await db.all(
        `SELECT seq, body FROM resource_versions WHERE resource_type = ? AND id = ? AND (${visible})
         ORDER BY version_id ASC`, params,
      );
      return rows.map(rowToDoc);
    },

    /** Creates a branch and returns its id. */
    async fork({ parentBranch = 'main', forkedAt, kind, careCap = null } = {}) {
      if (!BRANCH_KINDS.has(kind)) {
        throw new StoreError('invalid', `Branch kind must be one of ${[...BRANCH_KINDS].join(', ')}`, 422);
      }
      const wall = now();
      const at = forkedAt ? iso(forkedAt) : wall;
      if (at > wall) throw new StoreError('invalid', 'forkedAt cannot be in the future', 422);
      const id = `${kind}-${randomUUID().slice(0, 13)}`;
      await atomic(async (q) => {
        await lineage(q, parentBranch);
        await q.run(
          careCap ? 'INSERT INTO branches (id, parent_branch, forked_at, kind, created_at, care_cap) VALUES (?, ?, ?, ?, ?, ?)' : 'INSERT INTO branches (id, parent_branch, forked_at, kind, created_at) VALUES (?, ?, ?, ?, ?)',
          [id, parentBranch, at, kind, wall, ...(careCap ? [iso(careCap)] : [])],
        );
      });
      return id;
    },

    /**
     * Retires a branch: reads and writes on it are refused from now on. Its
     * versions stay in the log, because the log is append-only.
     */
    /** Reads straight from the tables (for counting what a whole-unit deletion would remove). */
    raw() { return db; },
    /** The only way rows leave the log: one transaction that opens the delete guard, removes a whole unit, and closes the guard again. A failure undoes everything, the guard included. */
    async purge(fn) {
      return atomic(async (q) => { await q.run('UPDATE purge_guard SET open = 1 WHERE id = 1', []); const out = await fn(q, inTransaction ? this : bindStore(q, root, true)); await q.run('UPDATE purge_guard SET open = 0 WHERE id = 1', []); return out; });
    },
    async dropBranch(id) {
      if (id === 'main') throw new StoreError('invalid', 'main cannot be dropped', 422);
      await atomic(async (q) => {
        const row = await branchRow(q, id);
        if (row.dropped_at) return;
        const child = await q.get('SELECT id FROM branches WHERE parent_branch = ? AND dropped_at IS NULL', [id]);
        if (child) throw new StoreError('conflict', `Branch "${id}" has live child branch "${child.id}"`, 409);
        await q.run('UPDATE branches SET dropped_at = ? WHERE id = ?', [now(), id]);
      });
    },

    async getBranch(id) { return toBranch(await branchRow(db, id)); },

    async listBranches() {
      return (await db.all('SELECT * FROM branches ORDER BY created_at ASC, id ASC', [])).map(toBranch);
    },

    async getIdempotent(scope, key, { maxAgeMs = 24 * 3600 * 1000 } = {}) {
      const row = await db.get('SELECT status, response, created_at FROM idempotency_keys WHERE scope = ? AND key = ?', [scope, key]);
      if (!row) return null;
      if (Date.parse(now()) - Date.parse(row.created_at) > maxAgeMs) return null;
      return { status: Number(row.status), body: JSON.parse(row.response) };
    },

    async putIdempotent(scope, key, status, body) {
      await db.run('DELETE FROM idempotency_keys WHERE scope = ? AND key = ?', [scope, key]);
      await db.run(
        'INSERT INTO idempotency_keys (scope, key, status, response, created_at) VALUES (?, ?, ?, ?, ?)',
        [scope, key, status, JSON.stringify(body), now()],
      );
    },

    /** The newest version number of the given resource types: it changes on every write to them, so a result built from them stays right while the mark is the same. Reads write trace steps and audit events, so those are not counted unless named. */
    async changeMark(types) {
      const list = [...new Set(types)].filter((t) => typeof t === 'string' && t);
      if (!list.length) throw new Error('changeMark needs the resource types the result depends on');
      const row = await db.get(`SELECT ${list.map((_, i) => `(SELECT MAX(seq) FROM resource_versions WHERE resource_type = ?) AS m${i}`).join(', ')}`, list);
      return list.map((_, i) => Number(row?.[`m${i}`] ?? 0)).join('.');
    },

    async stats() {
      const row = await db.get('SELECT COUNT(*) AS versions FROM resource_versions', []);
      return { versions: Number(row.versions) };
    },

    now,
    close: () => root.adapter.close(),
    backup: (destination) => root.adapter.backup(destination),
  };
  return store;
}
