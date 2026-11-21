// FHIR R4 REST surface: /fhir/R4/**. Reads accept _asOf and _branch.
// Every write runs the state machines, safety checks and derived clinical
// rules, then commits the resource, its AuditEvent and its TraceStep in one
// transaction.
import { FHIR_TYPES, INTERNAL_FIELDS, StoreError } from './store.mjs';
import { createConsent, patientOf } from '../../standards/server/consent.mjs';
import { recordAction, LIVE_RUN_ID } from './audit.mjs';
import { HttpError, operationOutcome, errorStatus } from './http.mjs';
import { applyLifecycle, transitionDoc, lifecycleOf } from './state-machines.mjs';
import { checkNewOrder, alertIssues, isCritical } from '../../ehr/server/safety-alerts.mjs';
import { beforeSave, afterSave } from '../../ehr/server/clinical-rules.mjs';
import { EnvelopeError, checkAgentWrite, commitAgentWrite, logRejection, AGENT_IDEMPOTENCY_MS } from '../../agent-operations/server/envelope.mjs';
import {
  enforcedFor, mayWrite, refusal, assertMayWrite, orderModeRequired, permissionFor, logRoleRefusal, SIGNED_STATES, stateOf, categoriesOf,
  ORDER_TYPES, ORDER_MODES, ORDER_MODE_URL, PENDING_COSIGN_URL, COSIGNED_BY_URL, orderModeOf, pendingCosign, withExtension,
} from './roles.mjs';

import { PHARMACY_URLS } from '../../pharmacy/server/pharmacy.mjs';
import { simNow } from './simclock.mjs';
/** In a scenario run the actor's writes land at the current simulated time (task 12), when that is ahead of the wall clock. */
const simRecordedAt = (ctx, tx) => { if (!ctx.run?.sim) return {}; const wall = tx.now(); const at = simNow(ctx.run, wall); return at && Date.parse(at) > Date.parse(wall) ? { recordedAt: at } : {}; };

const BASE = '/fhir/R4';
const PHARMACY_EXTENSIONS = Object.values(PHARMACY_URLS);
export const FLAG_SYSTEM = 'urn:hospital-desktop:flags';
const CARRIED = ['_ack', '_import', '_shadow', '_lock'];

/** The public form of a stored resource: internal fields removed, state flags exposed as meta.tag. */
export function stripInternal(doc) {
  if (!doc) return doc;
  const out = { ...doc };
  for (const key of INTERNAL_FIELDS) delete out[key];
  delete out._groupKey;
  const tag = (out.meta?.tag || []).filter((t) => t.system !== FLAG_SYSTEM);
  if (doc._released) tag.push({ system: FLAG_SYSTEM, code: 'released' });
  if (doc._ack) tag.push({ system: FLAG_SYSTEM, code: 'acknowledged', display: `${doc._ack.by} at ${doc._ack.at}` });
  if (isCritical(doc) && !doc._ack) tag.push({ system: FLAG_SYSTEM, code: 'critical-unacknowledged' });
  out.meta = { ...out.meta };
  if (tag.length) out.meta.tag = tag; else delete out.meta.tag;
  return out;
}

const tokens = (concept) => (Array.isArray(concept) ? concept : concept ? [concept] : []).flatMap((c) => c.coding || []);

function tokenMatch(codings, value) {
  return value.split(',').some((v) => {
    const [system, code] = v.includes('|') ? v.split('|') : [null, v];
    return codings.some((c) => c.code === code && (!system || c.system === system));
  });
}
const refIs = (ref, value, type) => ref === (value.includes('/') ? value : `${type}/${value}`);

const SEARCH = {
  _id: (r, v) => v.split(',').includes(r.id),
  _released: (r, v) => String(Boolean(r._released)) === v,
  status: (r, v) => v.split(',').includes(r.status),
  docstatus: (r, v) => v.split(',').includes(r.docStatus),
  lifecycle: (r, v) => v.split(',').includes(lifecycleOf(r)),
  code: (r, v) => tokenMatch([...tokens(r.code), ...tokens(r.medicationCodeableConcept)], v),
  category: (r, v) => tokenMatch(tokens(r.category), v),
  type: (r, v) => tokenMatch(tokens(r.type), v),
  identifier: (r, v) => (r.identifier || []).some((i) => {
    const [system, value] = v.includes('|') ? v.split('|') : [null, v];
    return i.value === value && (!system || i.system === system);
  }),
  // PDQm (IHE ITI-78) without names: birth date and gender
  birthdate: (r, v) => String(r.birthDate || '').startsWith(v.replace(/^eq/, '')),
  gender: (r, v) => v.split(',').includes(r.gender),
  family: (r, v) => (r.name || []).some((n) => (n.family || '').toLowerCase().startsWith(v.toLowerCase())),
  name: (r, v) => (r.name || []).some((n) => [n.family, ...(n.given || []), n.text]
    .some((part) => (part || '').toLowerCase().startsWith(v.toLowerCase()))),
  encounter: (r, v) => [r.encounter?.reference, r.context?.encounter?.[0]?.reference].some((ref) => ref && refIs(ref, v, 'Encounter')),
  'based-on': (r, v) => (r.basedOn || []).some((b) => refIs(b.reference, v, 'ServiceRequest')),
  focus: (r, v) => r.focus?.reference === v,
  date: (r, v) => {
    const at = r.start || r.effectiveDateTime || r.period?.start || r.authoredOn || r.date || '';
    const m = v.match(/^(ge|le|gt|lt|eq)?(.+)$/);
    const [op, when] = [m[1] || 'eq', m[2]];
    if (op === 'ge') return at >= when;
    if (op === 'le') return at <= when;
    if (op === 'gt') return at > when;
    if (op === 'lt') return at < when;
    return at.startsWith(when);
  },
  // Beds: the Location hierarchy and where an Encounter's patient is right now.
  partof: (r, v) => Boolean(r.partOf?.reference) && v.split(',').some((x) => refIs(r.partOf.reference, x, 'Location')),
  'physical-type': (r, v) => tokenMatch(tokens(r.physicalType), v),
  'operational-status': (r, v) => Boolean(r.operationalStatus) && tokenMatch([r.operationalStatus], v),
  location: (r, v) => (r.location || []).some((l) => l.status === 'active' && l.location?.reference && v.split(',').some((x) => refIs(l.location.reference, x, 'Location'))),
};
const CONTROL = new Set(['_asOf', '_branch', '_count', '_sort', 'patient', 'subject', 'dry']);

const patientRef = (value) => (value.includes('/') ? value : `Patient/${value}`);

function bundle(type, resources, total) {
  return {
    resourceType: 'Bundle',
    type,
    total: total ?? resources.length,
    entry: resources.map((r) => ({
      fullUrl: `${BASE}/${r.resourceType}/${r.id}`,
      resource: stripInternal(r),
      ...(type === 'history' ? { request: { method: r.meta.versionId === '1' ? 'POST' : 'PUT', url: `${r.resourceType}/${r.id}` } } : {}),
    })),
  };
}

function capabilityStatement() {
  return {
    resourceType: 'CapabilityStatement',
    text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml"><p>Healthcare InSilico FHIR server: the resources, searches and operations it supports, and SMART on FHIR security.</p></div>' },
    status: 'active',
    date: new Date().toISOString(),
    kind: 'instance',
    fhirVersion: '4.0.1',
    format: ['json'],
    software: { name: 'hospital-desktop', version: '0.8.0' },
    implementation: { description: 'Simulation environment. Synthetic data only.' },
    instantiates: ['http://hl7.org/fhir/uv/bulkdata/CapabilityStatement/bulk-data'],
    implementationGuide: ['http://hl7.org/fhir/us/core/ImplementationGuide/hl7.fhir.us.core', 'http://hl7.org/fhir/uv/ips/ImplementationGuide/hl7.fhir.uv.ips', 'http://hl7.org/fhir/uv/subscriptions-backport/ImplementationGuide/hl7.fhir.uv.subscriptions-backport', 'http://hl7.org/fhir/smart-app-launch/ImplementationGuide/hl7.fhir.uv.smart-app-launch'],
    rest: [{
      mode: 'server',
      security: { service: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/restful-security-service', code: 'SMART-on-FHIR' }] }], description: 'SMART App Launch 2.x: see /.well-known/smart-configuration' },
      interaction: [{ code: 'transaction' }],
      resource: [...FHIR_TYPES].sort().map((type) => ({
        type,
        versioning: 'versioned',
        readHistory: true,
        interaction: (type === 'AuditEvent' ? ['read', 'search-type', 'history-instance']
          : ['read', 'search-type', 'create', 'update', 'history-instance']).map((code) => ({ code })),
        searchParam: [
          { name: '_asOf', type: 'date', documentation: 'Read the chart as it was recorded at this instant' },
          { name: '_branch', type: 'token', documentation: 'Read or write on this branch' },
          { name: '_released', type: 'token', documentation: 'true: only items released to the patient portal' },
          ...['_id', 'patient', 'status', 'code', 'category', 'identifier', 'partof', 'physical-type', 'operational-status', 'location', 'gender'].map((name) => ({ name, type: 'token' })),
          ...(type === 'Patient' ? [{ name: 'birthdate', type: 'date' }] : []),
        ],
      })),
      operation: [
        { name: 'everything', definition: 'http://hl7.org/fhir/OperationDefinition/Patient-everything' },
        { name: 'export', definition: 'http://hl7.org/fhir/uv/bulkdata/OperationDefinition/export' },
        { name: 'summary', definition: 'http://hl7.org/fhir/uv/ips/OperationDefinition/summary' },
        { name: 'ihe-pix', definition: 'https://profiles.ihe.net/ITI/PIXm/OperationDefinition/IHE.PIXm.pix' },
        { name: 'lookup', definition: 'http://hl7.org/fhir/OperationDefinition/CodeSystem-lookup' },
        { name: 'validate-code', definition: 'http://hl7.org/fhir/OperationDefinition/ValueSet-validate-code' },
        { name: 'expand', definition: 'http://hl7.org/fhir/OperationDefinition/ValueSet-expand' },
        { name: 'translate', definition: 'http://hl7.org/fhir/OperationDefinition/ConceptMap-translate' },
        { name: 'status', definition: 'http://hl7.org/fhir/uv/subscriptions-backport/OperationDefinition/backport-subscription-status' },
        { name: 'events', definition: 'http://hl7.org/fhir/uv/subscriptions-backport/OperationDefinition/backport-subscription-events' },
        { name: 'transition', definition: 'urn:hospital-desktop:operation:transition' },
        { name: 'release', definition: 'urn:hospital-desktop:operation:release' },
        { name: 'acknowledge', definition: 'urn:hospital-desktop:operation:acknowledge' },
        { name: 'cosign', definition: 'urn:hospital-desktop:operation:cosign' },
      ],
    }],
  };
}

function assertType(type) {
  if (!FHIR_TYPES.has(type)) throw new HttpError(404, `Unknown or unsupported resource type "${type}"`, 'not-supported');
}

function assertWritable(type, ctx) {
  if (type === 'AuditEvent') throw new HttpError(405, 'AuditEvent is written by the server only');
  if (ctx.asOf) throw new HttpError(409, 'Writes are disabled while viewing a past time (_asOf)');
  if (ctx.run?.endedAt) throw new HttpError(409, `Run ${ctx.run.id} has ended`);
  if (ctx.actor.kind === 'agent') {
    if (ctx.branch === 'main' || ctx.branch !== ctx.run.branch) {
      throw new EnvelopeError(403, 'branch', `Agents may only write to their Run's branch, never main (run branch: ${ctx.run.branch})`);
    }
  }
}

function cleanInput(type, body, id) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'A JSON resource body is required', 'structure');
  const doc = { ...body };
  for (const key of INTERNAL_FIELDS) delete doc[key];
  if (doc.meta?.tag) {
    doc.meta = { ...doc.meta, tag: doc.meta.tag.filter((t) => t.system !== FLAG_SYSTEM) };
    if (!doc.meta.tag.length) delete doc.meta.tag;
  }
  if (id) {
    if (doc.id && doc.id !== id) throw new HttpError(400, `Body id "${doc.id}" does not match URL id "${id}"`);
    doc.id = id;
  } else {
    delete doc.id;
  }
  if (doc.resourceType !== type) throw new HttpError(400, `resourceType "${doc.resourceType}" does not match URL type "${type}"`);
  return doc;
}

async function assertPatientExists(tx, doc, branch) {
  const ref = doc.resourceType === 'Patient' ? null
    : (doc.subject?.reference ?? doc.patient?.reference ?? doc.for?.reference ?? null);
  if (typeof ref !== 'string' || !ref.startsWith('Patient/')) return;
  const found = await tx.get('Patient', ref.slice('Patient/'.length), { branch });
  if (!found) throw new HttpError(422, `Referenced ${ref} does not exist on branch "${branch}"`, 'processing');
}

/**
 * hooks.beforeCommit(tx, saved) runs inside the write transaction, after the
 * resource, AuditEvent and TraceStep are staged. Throwing rolls all three back.
 */
// Human labels and expert grades are answers about the chart, not part of it. An agent never reads them, so they cannot leak into an evaluation.
const HUMAN_JUDGEMENT = ['annotation', 'expert-grade'];
const isJudgement = (doc) => (doc?.resourceType === 'Observation' && (doc.category || []).some((c) => (c.coding || []).some((x) => HUMAN_JUDGEMENT.includes(x.code))))
  // A scribe benchmark's reference note is the answer key. It is recorded after the case moment, and hidden from agents outright as well.
  || (doc?.resourceType === 'DocumentReference' && (doc.extension || []).some((e) => e.url === 'urn:hospital-desktop:gold-note'));
function withoutJudgements(source) {
  return {
    query: async (...a) => (await source.query(...a)).filter((d) => !isJudgement(d)),
    get: async (...a) => { const doc = await source.get(...a); return isJudgement(doc) ? null : doc; },
    history: async (...a) => (await source.history(...a)).filter((d) => !isJudgement(d)),
    everything: async (...a) => (await source.everything(...a)).filter((d) => !isJudgement(d)),
  };
}

export function createFhirApi({ store, hooks = {} }) {
  const consent = createConsent(store);
  const reader = (ctx) => (ctx.actor?.kind === 'agent' ? withoutJudgements(ctx.lens ?? store) : (ctx.lens ?? store));
  const log = (tx, ctx, fields) => recordAction(tx, {
    runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, branch: ctx.branch, ...fields, why: fields.why ?? ctx.why ?? null,
  });
  const committed = (ctx, results) => {
    commitAgentWrite(store, ctx);
    if (!hooks.onCommitted) return;
    for (const r of results) {
      try { hooks.onCommitted({ type: r.saved.resourceType, saved: r.saved, existed: r.existed, ctx }); } catch (err) { console.error(err); }
    }
  };

  // One resource write with every rule applied. Must run inside a transaction.
  // pharmacy: the write comes from the pharmacy decision route and may set the verification record. unlock: drop the order's _lock.
  async function writeInTx(tx, type, id, body, ctx, { ifMatch, action, cosign = false, pharmacy = false, unlock = false } = {}) {
    assertType(type);
    assertWritable(type, ctx);
    const existed = id ? await tx.get(type, id, { branch: ctx.branch }) : null;
    await checkAgentWrite(tx, store, ctx, { type, existed, doc: body, stage: 'input' });
    let doc = cleanInput(type, body, id);
    await assertPatientExists(tx, doc, ctx.branch);
    // Nurse-entered orders carry a mode (verbal, telephone, protocol) and then wait for a physician co-signature.
    const orderMode = !existed && ORDER_TYPES.includes(type) ? orderModeOf(doc) : null;
    if (orderMode !== null && !ORDER_MODES.includes(orderMode)) throw new HttpError(422, `Order mode must be one of ${ORDER_MODES.join(', ')} (extension ${ORDER_MODE_URL} valueCode)`, 'value');
    for (const key of CARRIED) if (existed?.[key] !== undefined && !(unlock && key === '_lock')) doc[key] = existed[key];
    if (ctx.run?.mode?.startsWith('shadow')) doc._shadow = true;
    // The verification record belongs to the pharmacy decision route: a plain write can neither add nor remove it (checked before the lifecycle guard).
    if (type === 'MedicationRequest' && !pharmacy) {
      const kept = (existed?.extension || []).filter((e) => PHARMACY_EXTENSIONS.includes(e.url));
      const rest = (doc.extension || []).filter((e) => !PHARMACY_EXTENSIONS.includes(e.url));
      doc = { ...doc, extension: [...rest, ...kept] };
      if (!doc.extension.length) delete doc.extension;
    }
    doc = applyLifecycle(type, existed, doc);
    await checkAgentWrite(tx, store, ctx, { type, existed, doc, stage: 'resolved' });
    const prepared = await beforeSave(tx, type, existed, doc, ctx);
    const safety = existed ? { blocking: [], overridden: [] } : await checkNewOrder(tx, prepared.doc, ctx.branch);
    if (safety.blocking.length) {
      throw new HttpError(409, safety.blocking.map((a) => a.message).join(' '), 'business-rule', { issues: alertIssues(safety.blocking) });
    }
    let toSave = prepared.doc;
    // AI Transparency on FHIR: what an agent writes is labelled as asserted by AI.
    if (ctx.actor.kind === 'agent') toSave = { ...toSave, meta: { ...(toSave.meta || {}), security: [...((toSave.meta?.security) || []).filter((s) => s.code !== 'AIAST'), { system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationValue', code: 'AIAST', display: 'Artificial Intelligence asserted' }] } };
    // Role check, for people only and after the safety checks: an allergy conflict surfaces for anyone who may order. Agents are governed by the envelope instead.
    if (enforcedFor(ctx)) {
      const role = ctx.actor.role;
      const interaction = existed ? (lifecycleOf(existed) !== lifecycleOf(toSave) ? 'transition' : 'update') : 'create';
      const signing = SIGNED_STATES.has(stateOf(type, toSave)) && !(existed && SIGNED_STATES.has(stateOf(type, existed)));
      const opts = { signing, categories: categoriesOf(toSave), orderMode: Boolean(orderMode) };
      if (!mayWrite(role, type, interaction, opts)) {
        if (interaction === 'create' && !orderMode && orderModeRequired(role, type)) {
          throw new HttpError(422, `A ${permissionFor(role).label.toLowerCase()} may enter this order only as a verbal, telephone or protocol order: add extension ${ORDER_MODE_URL} with valueCode verbal, telephone or protocol. It will wait for a physician co-signature.`, 'required');
        }
        throw refusal(role, type, interaction, opts);
      }
    }
    if (orderMode) toSave = withExtension(toSave, PENDING_COSIGN_URL, { valueBoolean: true });
    // The co-signature flags belong to $cosign: a plain update cannot clear or forge them.
    if (existed && ORDER_TYPES.includes(type) && !cosign) {
      const kept = (existed.extension || []).filter((e) => [PENDING_COSIGN_URL, COSIGNED_BY_URL].includes(e.url));
      const rest = (toSave.extension || []).filter((e) => ![PENDING_COSIGN_URL, COSIGNED_BY_URL].includes(e.url));
      toSave = { ...toSave, extension: [...rest, ...kept] };
      if (!toSave.extension.length) delete toSave.extension;
    }
    const saved = await tx.save(type, toSave, { branch: ctx.branch, ifMatch, updatedBy: ctx.actor.role, released: prepared.released, ...simRecordedAt(ctx, tx) });
    const kind = existed ? 'update' : 'create';
    const moved = existed && lifecycleOf(existed) !== lifecycleOf(saved);
    await log(tx, ctx, {
      kind, action: action ?? (moved ? 'fhir.transition' : `fhir.${kind}`),
      args: { type, id: saved.id, ...(moved ? { from: lifecycleOf(existed), to: lifecycleOf(saved) } : {}) },
      resources: existed ? [{ ref: `${type}/${id}`, versionId: existed.meta.versionId }] : [],
      entityRef: `${type}/${saved.id}`, versionId: saved.meta.versionId, patientRef: saved._patient,
      description: moved ? `${type}/${saved.id} ${lifecycleOf(existed)} → ${lifecycleOf(saved)}` : `${kind} ${type}/${saved.id}`,
    });
    for (const alert of safety.overridden) {
      await log(tx, ctx, {
        kind: 'execute', action: 'safety.override', args: { alert: alert.code, existing: alert.existing, order: `${type}/${saved.id}` },
        why: alert.reason, entityRef: `${type}/${saved.id}`, patientRef: saved._patient,
        description: `safety override (${alert.code}) on ${type}/${saved.id}: ${alert.reason}`,
      });
    }
    await afterSave(tx, saved, existed, ctx, async (t, d, { released, description } = {}) => {
      const derived = await tx.save(t, d, { branch: ctx.branch, updatedBy: 'system', released });
      await log(tx, ctx, {
        kind: Number(derived.meta.versionId) > 1 ? 'update' : 'create', action: 'system.derive',
        args: { type: t, id: derived.id, from: `${type}/${saved.id}` }, entityRef: `${t}/${derived.id}`,
        versionId: derived.meta.versionId, patientRef: derived._patient, description: `${description} (${t}/${derived.id})`,
      });
      return derived;
    });
    if (ctx.actor.kind === 'agent') {
      const prov = await tx.save('Provenance', {
        resourceType: 'Provenance', target: [{ reference: `${type}/${saved.id}/_history/${saved.meta.versionId}` }], recorded: tx.now(),
        activity: { text: existed ? 'AI-drafted update' : 'AI-drafted, not signed' },
        meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationValue', code: 'AIAST', display: 'Artificial Intelligence asserted' }] },
        agent: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type', code: 'author' }], text: 'author' }, who: { identifier: { system: 'urn:hospital-desktop:agent', value: ctx.actor.id }, display: `${ctx.agent?.name ?? ctx.actor.id} ${ctx.run?.version ?? ''}`.trim(), type: 'Device' } }],
        entity: [{ role: 'source', what: { identifier: { system: 'urn:hospital-desktop:run', value: ctx.runId } } }],
        reason: ctx.why ? [{ text: ctx.why.slice(0, 500) }] : undefined, _patient: saved._patient, _shadow: saved._shadow,
      }, { branch: ctx.branch, updatedBy: 'system' });
      await log(tx, ctx, {
        kind: 'create', action: 'system.derive', args: { type: 'Provenance', id: prov.id, from: `${type}/${saved.id}` },
        entityRef: `Provenance/${prov.id}`, versionId: prov.meta.versionId, patientRef: saved._patient, description: `provenance for agent write (Provenance/${prov.id})`, why: null,
      });
    }
    if (hooks.beforeCommit) await hooks.beforeCommit(tx, saved);
    return { saved, existed };
  }

  class DryRun extends Error {}

  async function write(type, id, body, ctx, url, req) {
    const dry = url.searchParams.get('dry') === 'true';
    const scope = `fhir:${req.method}:${type}:${id || ''}:${ctx.branch}`;
    const ifMatch = req.headers['if-match'] ? String(req.headers['if-match']).replace(/^W\//, '').replaceAll('"', '') : undefined;
    let result;
    try {
      result = await store.transaction(async (tx) => {
        if (ctx.idempotencyKey) {
          const replay = await tx.getIdempotent(scope, ctx.idempotencyKey, ctx.actor.kind === 'agent' ? { maxAgeMs: AGENT_IDEMPOTENCY_MS } : undefined);
          if (replay) return { ...replay, replayed: true };
        }
        const { saved, existed } = await writeInTx(tx, type, id, body, ctx, { ifMatch });
        const response = { status: existed ? 200 : 201, body: stripInternal(saved), written: { saved, existed } };
        if (dry) { result = response; throw new DryRun(); }
        if (ctx.idempotencyKey) await tx.putIdempotent(scope, ctx.idempotencyKey, response.status, response.body);
        return response;
      });
    } catch (err) {
      ctx.pendingTaskCreates = 0;
      if (!(err instanceof DryRun)) throw err;
      return { status: 200, body: { dryRun: true, wouldWrite: result.body }, headers: {} };
    }
    if (result.written) committed(ctx, [result.written]);
    const r = result.body;
    return {
      status: result.replayed ? 200 : result.status,
      body: r,
      headers: { ETag: `W/"${r.meta.versionId}"`, Location: `${BASE}/${type}/${r.id}/_history/${r.meta.versionId}`, 'Last-Modified': new Date(r.meta.lastUpdated).toUTCString() },
    };
  }

  // POST /fhir/R4 with a transaction Bundle: all entries commit or none do.
  async function transaction(body, ctx) {
    if (body?.resourceType !== 'Bundle' || !['transaction', 'batch'].includes(body.type)) {
      throw new HttpError(400, 'POST to the base URL requires a Bundle of type transaction');
    }
    const entries = body.entry || [];
    if (!entries.length || entries.length > 200) throw new HttpError(422, 'A transaction needs between 1 and 200 entries');
    const written = [];
    const results = await store.transaction(async (tx) => {
      const out = [];
      for (const [i, entry] of entries.entries()) {
        const method = entry.request?.method ?? 'POST';
        const [type, id] = String(entry.request?.url ?? entry.resource?.resourceType ?? '').split('/');
        if (!['POST', 'PUT'].includes(method) || (method === 'PUT' && !id)) throw new HttpError(422, `Entry ${i}: only POST {Type} and PUT {Type}/{id} are supported`);
        try {
          const { saved, existed } = await writeInTx(tx, type, method === 'PUT' ? id : null, entry.resource, ctx);
          written.push({ saved, existed });
          out.push({ response: { status: existed ? '200' : '201', location: `${type}/${saved.id}/_history/${saved.meta.versionId}` }, resource: stripInternal(saved) });
        } catch (err) {
          if (err instanceof HttpError || err instanceof StoreError) err.message = `Entry ${i} (${type}): ${err.message}`;
          throw err;
        }
      }
      return out;
    });
    committed(ctx, written);
    return { status: 200, body: { resourceType: 'Bundle', type: 'transaction-response', entry: results } };
  }

  async function operation(type, id, op, body, ctx) {
    assertType(type);
    let before = null;
    const saved = await store.transaction(async (tx) => {
      const current = await tx.get(type, id, { branch: ctx.branch });
      if (!current) throw new HttpError(404, `${type}/${id} not found`, 'not-found');
      before = current;
      const { _seq, ...doc } = current;
      await checkAgentWrite(tx, store, ctx, { type, existed: current, doc: null, op, stage: 'resolved' });
      if (op === '$transition') {
        return (await writeInTx(tx, type, id, transitionDoc(stripInternal(doc), body?.to, body?.reason), ctx)).saved;
      }
      if (op === '$cosign') {
        if (!ORDER_TYPES.includes(type)) throw new HttpError(405, 'Only orders (ServiceRequest, MedicationRequest) can be co-signed', 'not-supported');
        if (enforcedFor(ctx)) assertMayWrite(ctx.actor.role, type, 'cosign');
        if (!pendingCosign(doc)) throw new HttpError(409, 'This order does not need a co-signature', 'business-rule');
        let next = withExtension(stripInternal(doc), PENDING_COSIGN_URL, { valueBoolean: false });
        next = withExtension(next, COSIGNED_BY_URL, { valueString: `${ctx.actor.id} (${ctx.actor.role}) at ${tx.now()}` });
        return (await writeInTx(tx, type, id, next, ctx, { action: 'order.cosign', cosign: true })).saved;
      }
      assertWritable(type, ctx);
      if (enforcedFor(ctx) && (op === '$release' || op === '$acknowledge')) assertMayWrite(ctx.actor.role, type, op);
      if (op === '$release') {
        const released = body?.released !== false;
        const state = type === 'DocumentReference' ? doc.docStatus : doc.status;
        if (released && !['final', 'amended', 'corrected', 'appended'].includes(state)) {
          throw new HttpError(409, `Only final items can be released to the portal (this one is "${state}")`);
        }
        if (released && isCritical(doc) && !doc._ack) {
          throw new HttpError(409, 'This critical result must be acknowledged before it can be released to the portal', 'business-rule', {
            issues: alertIssues([{ code: 'critical-unacknowledged', message: 'This critical result must be acknowledged before it can be released to the portal', existing: `${type}/${id}`, existingDate: doc._recordedAt }]),
          });
        }
        const next = await tx.save(type, doc, { branch: ctx.branch, updatedBy: ctx.actor.role, released });
        await log(tx, ctx, {
          kind: 'update', action: released ? 'portal.release' : 'portal.hide', args: { type, id },
          resources: [{ ref: `${type}/${id}`, versionId: current.meta.versionId }], entityRef: `${type}/${id}`,
          versionId: next.meta.versionId, patientRef: next._patient, description: `${released ? 'released to' : 'hidden from'} portal: ${type}/${id}`,
        });
        return next;
      }
      if (op === '$acknowledge') {
        if (!isCritical(doc)) throw new HttpError(409, 'Only critical results (LL or HH) need acknowledgment');
        if (doc._ack) return current;
        const next = await tx.save(type, { ...doc, _ack: { by: ctx.actor.id, role: ctx.actor.role, at: tx.now() } }, { branch: ctx.branch, updatedBy: ctx.actor.role });
        await log(tx, ctx, {
          kind: 'update', action: 'result.acknowledge', args: { type, id }, why: body?.comment ? String(body.comment).slice(0, 500) : null,
          resources: [{ ref: `${type}/${id}`, versionId: current.meta.versionId }], entityRef: `${type}/${id}`,
          versionId: next.meta.versionId, patientRef: next._patient, description: `critical result acknowledged: ${type}/${id}`,
        });
        return next;
      }
      throw new HttpError(404, `Unknown operation ${op}`, 'not-supported');
    });
    // Lifecycle moves and releases are commits too: the same hooks fire as for a PUT (the HL7 bridge and the agent triggers read them).
    committed(ctx, [{ saved, existed: before }]);
    return { status: 200, body: stripInternal(saved), headers: { ETag: `W/"${saved.meta.versionId}"` } };
  }

  async function logRead(ctx, { action, args, resources, chartOpen, patient }) {
    if (!chartOpen && !ctx.runId) return;
    // What an ablation overlay removed or altered in this read is recorded, so the report can tell whether the overlay ever mattered.
    const touched = ctx.lens ? { ...ctx.lens.stats } : null;
    if (ctx.lens) Object.assign(ctx.lens.stats, { hidden: 0, delayed: 0, changed: 0 });
    await store.transaction((tx) => log(tx, ctx, {
      kind: 'read', action, args: touched && touched.hidden + touched.delayed + touched.changed ? { ...args, ablated: touched } : args, asOf: ctx.asOf,
      resources: resources.slice(0, 500).map((r) => ({ ref: `${r.resourceType}/${r.id}`, versionId: r.meta.versionId })),
      entityRef: chartOpen ? patient : undefined, patientRef: patient, audit: Boolean(chartOpen),
      description: chartOpen ? `chart open ${patient}` : action,
    }));
  }

  async function search(type, ctx, url) {
    assertType(type);
    const params = url.searchParams;
    const tests = [];
    for (const [key, value] of params) {
      if (CONTROL.has(key)) continue;
      if (!SEARCH[key]) throw new HttpError(400, `Unsupported search parameter "${key}" for ${type}`, 'not-supported');
      tests.push((r) => SEARCH[key](r, value));
    }
    const patient = params.get('patient') || params.get('subject');
    let rows = await consent.filter(await reader(ctx).query(type, {
      patient: patient ? patientRef(patient) : undefined,
      where: (r) => tests.every((t) => t(r)),
    }, { branch: ctx.branch, asOf: ctx.asOf }), ctx);
    const sort = params.get('_sort');
    if (sort === '-_lastUpdated') rows.reverse();
    else if (sort && sort !== '_lastUpdated') throw new HttpError(400, `Unsupported _sort "${sort}"`);
    const total = rows.length;
    const count = Math.min(Math.max(Number(params.get('_count') || 500) || 500, 1), 2000);
    rows = rows.slice(0, count);
    await logRead(ctx, { action: 'fhir.search', args: { type, params: Object.fromEntries(params) }, resources: rows });
    return { status: 200, body: bundle('searchset', rows, total) };
  }

  async function read(type, id, ctx) {
    assertType(type);
    const doc = await reader(ctx).get(type, id, { branch: ctx.branch, asOf: ctx.asOf });
    if (!doc) throw new HttpError(404, `${type}/${id} not found${ctx.asOf ? ` as of ${ctx.asOf}` : ''}`, 'not-found');
    const denial = await consent.blocked(patientOf(doc, type), ctx);
    if (denial) { await logRead(ctx, { action: 'consent.deny', args: { type, id, consent: denial.id }, resources: [] }); throw new HttpError(403, 'The patient\'s consent does not allow this record to be shared for this purpose', 'forbidden'); }
    await logRead(ctx, {
      action: type === 'Patient' ? 'chart.open' : 'fhir.read', args: { type, id }, resources: [doc],
      chartOpen: type === 'Patient', patient: doc._patient,
    });
    return { status: 200, body: stripInternal(doc), headers: { ETag: `W/"${doc.meta.versionId}"` } };
  }

  async function history(type, id, ctx) {
    assertType(type);
    const versions = await reader(ctx).history(type, id, { branch: ctx.branch, asOf: ctx.asOf });
    if (!versions.length) throw new HttpError(404, `${type}/${id} not found`, 'not-found');
    await logRead(ctx, { action: 'fhir.history', args: { type, id }, resources: versions });
    return { status: 200, body: bundle('history', versions.reverse()) };
  }

  async function everything(id, ctx) {
    const patient = await reader(ctx).get('Patient', id, { branch: ctx.branch, asOf: ctx.asOf });
    if (!patient) throw new HttpError(404, `Patient/${id} not found`, 'not-found');
    const rows = (await reader(ctx).everything(`Patient/${id}`, { branch: ctx.branch, asOf: ctx.asOf }))
      .filter((r) => r.resourceType !== 'AuditEvent');
    await logRead(ctx, {
      action: 'chart.open', args: { type: 'Patient', id, operation: '$everything' }, resources: rows,
      chartOpen: true, patient: `Patient/${id}`,
    });
    if (hooks.onChartOpen) { try { hooks.onChartOpen({ patientId: id, ctx }); } catch (err) { console.error(err); } }
    return { status: 200, body: bundle('searchset', rows) };
  }

  async function route(req, url, body, ctx) {
    const parts = url.pathname.slice(BASE.length).split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method;
    if (parts.length === 0 && method === 'POST') return transaction(body, ctx);
    if (parts.length === 1 && parts[0] === 'metadata' && method === 'GET') return { status: 200, body: capabilityStatement() };
    const [type, id, op] = parts;
    if (parts.length === 1) {
      if (method === 'GET') return search(type, ctx, url);
      if (method === 'POST') return write(type, null, body, ctx, url, req);
    }
    if (parts.length === 2) {
      if (method === 'GET') return read(type, id, ctx);
      if (method === 'PUT') return write(type, id, body, ctx, url, req);
    }
    if (parts.length === 3 && method === 'GET') {
      if (op === '_history') return history(type, id, ctx);
      if (op === '$everything' && type === 'Patient') return everything(id, ctx);
    }
    if (parts.length === 3 && method === 'POST' && op.startsWith('$')) return operation(type, id, op, body, ctx);
    throw new HttpError(parts.length ? 405 : 404, `${method} ${url.pathname} is not supported`, 'not-supported');
  }

  return {
    writeInTx,
    async handle(req, url, body, ctx) {
      try {
        return await route(req, url, body, ctx);
      } catch (err) {
        const status = err instanceof StoreError && err.code === 'conflict' && req.headers['if-match'] ? 412 : errorStatus(err);
        if (status >= 500) console.error(err);
        ctx.pendingTaskCreates = 0;
        await logRejection(store, ctx, err, { method: req.method, path: url.pathname });
        await logRoleRefusal(store, ctx, err, { method: req.method, path: url.pathname });
        // A clinical safety alert that stopped an agent's order is part of that run's history too.
        if (ctx.actor.kind === 'agent' && err.issues && !err.rule) {
          const alerts = err.issues.map((i) => i.details?.coding?.[0]?.code ?? i.details?.text ?? i.code).filter(Boolean);
          await store.transaction((tx) => recordAction(tx, {
            runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'execute', action: 'safety.block', args: { alerts, method: req.method, path: url.pathname, type: url.pathname.split('/')[3] ?? null },
            why: ctx.why ?? null, branch: ctx.run?.branch ?? 'main', description: `agent order stopped by a safety alert: ${err.message}`, outcome: '4',
          })).catch((e) => console.error(e));
        }
        return { status, body: operationOutcome(status, status >= 500 ? 'Internal server error' : err.message, err.issues) };
      }
    },
  };
}
