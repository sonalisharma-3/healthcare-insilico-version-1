// FHIR R4 import adapter: JSON resources, Bundles and NDJSON.
// Idempotent (unchanged resources are skipped by checksum), resumable (one
// transaction per file), with dry-run validation and an error quarantine.
// Handles Synthea output: hospital and practitioner bundles are read first,
// conditional references (Practitioner?identifier=...) are resolved to real
// ids, claims and provenance are skipped, and --assign-mrn adds a house MRN
// next to the source identifiers. Data is only ever written to the database
// under data/.
import fs from 'node:fs';
import { createObjectStore } from './storage.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FHIR_TYPES, INTERNAL_FIELDS } from './store.mjs';
import { validateResource } from './validate.mjs';
import { recordAction } from './audit.mjs';
import { assignHouseMrn, houseMrnOf } from '../../ehr/server/clinical-rules.mjs';
import { tagPatient } from './datasets.mjs';

const ORDER = ['Organization', 'Location', 'Practitioner', 'PractitionerRole', 'Patient', 'Encounter'];
const rank = (type) => { const i = ORDER.indexOf(type); return i === -1 ? ORDER.length : i; };
// Types the importer never writes even though the store knows them: billing
// and provenance records from a generator are noise for a clinical simulation.
export const SKIPPED_TYPES = new Set(['AuditEvent', 'Provenance', 'Claim', 'ExplanationOfBenefit']);
// Reference-bearing fields never checked beyond the Patient reference; the
// conditional-reference walk covers every object with a "reference" string.
const CONDITIONAL = /^([A-Z][A-Za-z]+)\?identifier=(.+)$/;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const checksum = (doc) => createHash('sha256').update(canonical(doc)).digest('hex');

// Synthea writes hospitalInformation*.json and practitionerInformation*.json
// next to the patient bundles; they must load first so references resolve.
const fileRank = (file) => { const b = path.basename(file); return /^hospitalInformation/i.test(b) ? 0 : /^practitionerInformation/i.test(b) ? 1 : 2; };

/** Every importable file under the targets: reference bundles first, then the rest in a stable order. */
export function listImportFiles(targets) {
  const under = (target) => {
    const stat = fs.statSync(target);
    if (stat.isFile()) return [target];
    return fs.readdirSync(target, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? under(path.join(target, e.name)) : [path.join(target, e.name)]))
      .filter((f) => /\.(json|ndjson)$/i.test(f));
  };
  return [...new Set(targets.flatMap(under))].sort((a, b) => fileRank(a) - fileRank(b) || a.localeCompare(b));
}

function parseFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  const urn = new Map();
  const add = (resource, fullUrl) => {
    if (resource?.resourceType === 'Bundle') {
      for (const entry of resource.entry || []) add(entry.resource, entry.fullUrl);
      return;
    }
    if (!resource || typeof resource !== 'object') return;
    if (fullUrl?.startsWith('urn:uuid:') && resource.resourceType) {
      const id = resource.id || fullUrl.slice('urn:uuid:'.length);
      resource.id = id;
      urn.set(fullUrl, `${resource.resourceType}/${id}`);
    }
    out.push(resource);
  };
  if (/\.ndjson$/i.test(file)) {
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      try { add(JSON.parse(line)); } catch { out.push({ __parseError: `line ${i + 1} is not valid JSON` }); }
    });
  } else {
    try { add(JSON.parse(text)); } catch { out.push({ __parseError: 'file is not valid JSON' }); }
  }
  const rewrite = (node) => {
    if (Array.isArray(node)) return node.forEach(rewrite);
    if (!node || typeof node !== 'object') return undefined;
    if (typeof node.reference === 'string' && urn.has(node.reference)) node.reference = urn.get(node.reference);
    Object.values(node).forEach(rewrite);
    return undefined;
  };
  out.forEach(rewrite);
  return out;
}

function clinicalValidAt(doc) {
  // Prefer issued (result availability) over effectiveDateTime (specimen draw); preserve future shifted dates (e.g. MIMIC-IV 2100-2210).
  const raw = doc.issued ?? doc.effectiveDateTime ?? doc.effectivePeriod?.start ?? doc.authoredOn
    ?? doc.performedDateTime ?? doc.performedPeriod?.start ?? doc.occurrenceDateTime
    ?? doc.whenHandedOver ?? doc.whenPrepared ?? doc.receivedTime ?? doc.collection?.collectedDateTime
    ?? doc.identifiedDateTime ?? doc.onsetDateTime ?? doc.recordedDate ?? doc.date ?? doc.period?.start
    ?? doc.started ?? doc.start ?? doc.sent ?? doc.created ?? doc.meta?.lastUpdated;
  const t = typeof raw === 'string' ? new Date(raw) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toISOString() : null;
}

function importRecordedAt(doc, valid, nowIso) {
  if (valid) return valid > nowIso ? nowIso : valid;
  // Anchor historical Patients to birthDate (when in the past) so Patient/$everything?_asOf=<past> finds the Patient resource.
  if (doc.resourceType === 'Patient' && typeof doc.birthDate === 'string') {
    const b = new Date(doc.birthDate);
    if (!Number.isNaN(b.getTime()) && b.toISOString() <= nowIso) return b.toISOString();
  }
  return nowIso;
}

const identifierKeys = (doc) => (doc.identifier || []).flatMap((i) => (i?.value ? [`${i.system ?? ''}|${i.value}`, `|${i.value}`] : []));

/**
 * Imports files or folders. Returns a report:
 * { files, seen, written, unchanged, unsupported, quarantined, errors[], dryRun,
 *   byType: { [type]: { seen, written, unchanged, unsupported, quarantined } },
 *   patients: [Patient ids written or already present], mrnsAssigned, referencesResolved, referencesDropped }.
 * Options: assignMrn (house MRN first in identifier[]), synthetic / restricted / source (patient tags),
 * onProgress({ done, total, file }) after each file.
 */
export async function importFhirPaths(store, targets, {
  dryRun = false, quarantineDir = null, actor = { kind: 'human', id: 'import-script', role: 'administrator' },
  assignMrn = false, synthetic = false, restricted = false, source = null, onProgress = null,
} = {}) {
  const report = { files: 0, seen: 0, written: 0, unchanged: 0, unsupported: 0, quarantined: 0, errors: [], dryRun, byType: {}, patients: [], mrnsAssigned: 0, referencesResolved: 0, referencesDropped: 0 };
  const count = (type, key) => {
    const row = report.byType[type] ??= { seen: 0, written: 0, unchanged: 0, unsupported: 0, quarantined: 0 };
    row[key] += 1;
    if (key !== 'seen') report[key] += 1;
  };
  const quarantine = [];
  const inBatch = new Set();
  const patients = new Set();
  const reject = (file, resource, reason) => {
    count(resource?.resourceType || 'unknown', 'quarantined');
    report.errors.push({ file, ref: resource?.resourceType ? `${resource.resourceType}/${resource.id ?? '?'}` : null, reason });
    quarantine.push({ file, reason, resource });
  };

  // Identifier index per type: everything already in the store plus what this run has seen (dry runs included).
  const index = new Map();
  const indexFor = async (tx, type) => {
    if (!index.has(type)) {
      const map = new Map();
      if (FHIR_TYPES.has(type)) for (const doc of await tx.query(type, {}, { branch: 'main' })) for (const key of identifierKeys(doc)) if (!map.has(key)) map.set(key, doc.id);
      index.set(type, map);
    }
    return index.get(type);
  };
  const remember = (type, doc) => { if (index.has(type)) for (const key of identifierKeys(doc)) if (!index.get(type).has(key)) index.get(type).set(key, doc.id); };
  const resolveConditional = async (tx, node) => {
    if (Array.isArray(node)) { for (const item of node) await resolveConditional(tx, item); return; }
    if (!node || typeof node !== 'object') return;
    const m = typeof node.reference === 'string' ? CONDITIONAL.exec(node.reference) : null;
    if (m) {
      const [, type, raw] = m;
      const value = decodeURIComponent(raw);
      const map = await indexFor(tx, type);
      const id = map.get(value.includes('|') ? value : `|${value}`) ?? map.get(`|${value.split('|').pop()}`);
      if (id) { node.reference = `${type}/${id}`; report.referencesResolved += 1; } else {
        delete node.reference;
        if (!node.display) node.display = value.split('|').pop();
        report.referencesDropped += 1;
      }
    }
    for (const value of Object.values(node)) if (value && typeof value === 'object') await resolveConditional(tx, value);
  };

  const files = listImportFiles(targets);
  for (const file of files) {
    report.files += 1;
    const resources = parseFile(file).sort((a, b) => rank(a.resourceType) - rank(b.resourceType));
    const fileCounts = { written: 0, unchanged: 0 };
    class Rollback extends Error {}
    try {
      await store.transaction(async (tx) => {
        for (const raw of resources) {
          report.seen += 1;
          if (raw.__parseError) { reject(file, null, raw.__parseError); continue; }
          const type = raw.resourceType;
          if (type) count(type, 'seen');
          if (!type || !FHIR_TYPES.has(type) || SKIPPED_TYPES.has(type)) { count(type || 'unknown', 'unsupported'); continue; }
          let doc = { ...raw };
          for (const key of INTERNAL_FIELDS) delete doc[key];
          if (!doc.id) { reject(file, doc, 'resource has no id (ids are required for idempotent import)'); continue; }
          doc = JSON.parse(JSON.stringify(doc));
          await resolveConditional(tx, doc);
          const issues = validateResource(type, doc);
          if (issues.length) { reject(file, doc, issues.join('; ')); continue; }
          const ref = type === 'Patient' ? null : (doc.subject?.reference ?? doc.patient?.reference ?? null);
          if (typeof ref === 'string' && ref.startsWith('Patient/')
            && !inBatch.has(ref) && !(await tx.get('Patient', ref.slice(8)))) {
            reject(file, doc, `unresolved reference ${ref}`);
            continue;
          }
          if (type === 'Patient') doc = tagPatient(doc, { synthetic, restricted, source: source ?? path.basename(path.dirname(file)) });
          // The checksum is taken before any MRN is added, so a rerun with a generated MRN still counts as unchanged.
          const sum = checksum(doc);
          const existing = await tx.get(type, doc.id);
          inBatch.add(`${type}/${doc.id}`);
          remember(type, doc);
          if (type === 'Patient') patients.add(doc.id);
          if (existing?._import?.checksum === sum) { count(type, 'unchanged'); fileCounts.unchanged += 1; continue; }
          if (type === 'Patient') {
            const kept = existing ? houseMrnOf(existing) : null;
            if (kept && !houseMrnOf(doc)) doc = { ...doc, identifier: [existing.identifier.find((i) => i.value === kept), ...(doc.identifier || [])] };
            else if (assignMrn && !houseMrnOf(doc)) { doc = await assignHouseMrn(tx, doc, 'main'); report.mrnsAssigned += 1; }
          }
          const wall = tx.now();
          const valid = clinicalValidAt(doc);
          const recorded = existing ? wall : importRecordedAt(doc, valid, wall);
          await tx.save(type, { ...doc, _import: { checksum: sum, source: path.basename(file), importedAt: wall } }, {
            recordedAt: recorded, validAt: valid ?? recorded, updatedBy: 'import',
          });
          count(type, 'written');
          fileCounts.written += 1;
        }
        if (dryRun) throw new Rollback();
        if (fileCounts.written) {
          await recordAction(tx, {
            actor, kind: 'execute', action: 'import.fhir', args: { file: path.basename(file), ...fileCounts },
            description: `import ${path.basename(file)}: ${fileCounts.written} written`,
          });
        }
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    if (onProgress) onProgress({ done: report.files, total: files.length, file });
  }
  report.patients = [...patients];
  if (quarantine.length && quarantineDir && !dryRun) {
    const key = `quarantine-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`;
    const clinical = await createObjectStore('clinical', { localRoot: quarantineDir, prefix: 'quarantine/' });
    await clinical.put(key, Buffer.from(quarantine.map((q) => JSON.stringify(q)).join('\n') + '\n', 'utf8'));
    report.quarantineFile = clinical.pathOf ? clinical.pathOf(key) : key;
  }
  return report;
}
