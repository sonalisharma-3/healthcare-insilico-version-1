// The agent safety envelope (§9b). Every check here runs in the server route
// handlers, so an agent cannot bypass it by skipping the UI. Humans are never
// subject to these rules; the clinical safety alerts apply to everyone.
import { HttpError } from '../../platform/server/http.mjs';
import { permissionsOf, refuseWrite, refuseRead, systemOfPath } from './permissions.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { FHIR_TYPES } from '../../platform/server/validate.mjs';
import { lifecycleOf } from '../../platform/server/state-machines.mjs';

const PHARMACY_ONLY_URLS = new Set(['urn:hospital-desktop:verified', 'urn:hospital-desktop:verification-note', 'urn:hospital-desktop:queried', 'urn:hospital-desktop:emergency-override']);

export const FLAG_SYSTEM = 'urn:hospital-desktop:flags';
export const TASK_LIMIT = 30;
export const TASK_WINDOW_MS = 60_000;
export const AGENT_IDEMPOTENCY_MS = 60_000;
const SIGNED_STATES = new Set(['final', 'amended', 'corrected', 'appended']);
const HUMAN_ONLY_OPERATIONS = new Set(['$release', '$acknowledge', '$cosign']);
// Moving a patient (assign, transfer, discharge, bed state) is a human decision: the bed routes and the records behind them.
const HUMAN_ONLY_ROUTES = ['/api/beds/', '/api/nursing/', '/api/lab/', '/api/rpm/enrol', '/api/rpm/alerts/', '/api/rpm/thresholds/', '/api/pathology/'];
const HUMAN_ONLY_TYPES = new Set(['Location', 'MedicationAdministration', 'Specimen']);

export class EnvelopeError extends HttpError {
  constructor(status, rule, message) {
    super(status, message, status === 429 ? 'throttled' : status === 400 ? 'required' : 'forbidden');
    this.rule = rule;
  }
}

// ---------- Kill switches ----------
export const KILL_SCOPES = ['global', 'agent', 'mode'];
export const switchId = (scope, target) => (scope === 'global' ? 'global' : `${scope}-${target}`);

/** The first engaged switch that covers this agent and mode, or null. */
export async function engagedSwitch(reader, { agentId, mode }) {
  const ids = ['global', agentId && switchId('agent', agentId), mode && switchId('mode', mode)].filter(Boolean);
  for (const id of ids) {
    const doc = await reader.get('KillSwitch', id);
    if (doc?.engaged) return doc;
  }
  return null;
}

export async function listSwitches(store) {
  const docs = await store.query('KillSwitch');
  const pick = (d) => ({ engaged: Boolean(d.engaged), reason: d.reason ?? null, at: d.at ?? null, by: d.by ?? null });
  const out = { global: { engaged: false, reason: null, at: null, by: null }, agents: {}, modes: {} };
  for (const d of docs) {
    if (d.scope === 'global') out.global = pick(d);
    else if (d.scope === 'agent') out.agents[d.target] = pick(d);
    else if (d.scope === 'mode') out.modes[d.target] = pick(d);
  }
  return out;
}

const describeSwitch = (sw) => (sw.scope === 'global' ? 'the global kill switch' : `the kill switch for ${sw.scope} "${sw.target}"`);

// ---------- Request gate: runs before any agent request is routed ----------
/**
 * area: 'fhir' | 'api' | 'dicom-web' | 'agent-ops'. Sets ctx.agent on success.
 */
const ORDER_TYPES = new Set(['ServiceRequest', 'MedicationRequest']);
/** Plan-master 8.5: cross-app records, more than one write per turn, and agent-raised alerts each need their capability. */
async function assertCapabilities(store, ctx, { method, area, path }) {
  const run = ctx.run;
  if (!run || !Array.isArray(run.capabilities) || area !== 'fhir') return;
  const caps = run.capabilities;
  const type = path.split('/')[3];
  if (!type || !/^[A-Z][A-Za-z]+$/.test(type)) return;
  const { assertType, assertCap } = await import('./capabilities.mjs');
  assertType(run, type, method === 'GET' ? 'Reading' : 'Writing');
  if (method === 'GET' || method === 'HEAD') return;
  if (type === 'Flag') assertCap(run, 'proactive-alerts', 'Raising an alert');
  const free = caps.includes('queue-orders') && ORDER_TYPES.has(type);
  const writes = run.turn?.writes ?? 0;
  if (!free && writes >= 1 && !caps.includes('multi-step')) throw new EnvelopeError(403, 'capability-off', `A second write in one turn needs the "multi-step" capability, which is not switched on for this run (condition: ${run.condition || 'custom'})`);
  if (!free) { for (let i = 0; ; i += 1) { try { await store.transaction(async (tx) => { const r = await tx.get('Run', run.id); if (r) await tx.save('Run', { ...r, turn: { ...(r.turn || {}), writes: (r.turn?.writes ?? 0) + 1 } }, { updatedBy: 'system' }); }); break; } catch (err) { if (err.code !== 'conflict' || i >= 6) throw err; await new Promise((res) => setTimeout(res, 15 * (i + 1))); } } }
}

export async function assertAgentRequest(store, ctx, { method, area, path }) {
  if (ctx.actor.kind !== 'agent') return;
  const agent = await store.get('Agent', ctx.actor.id);
  if (!agent) throw new EnvelopeError(403, 'unregistered-agent', `Agent "${ctx.actor.id}" is not registered`);
  if (!agent.enabled) throw new EnvelopeError(403, 'agent-disabled', `Agent "${agent.id}" is disabled in the registry`);
  if (ctx.run.agentId !== agent.id) {
    throw new EnvelopeError(403, 'run-mismatch', `Run ${ctx.run.id} does not belong to agent "${agent.id}"`);
  }
  if (ctx.run.branch && ctx.branch !== ctx.run.branch) {
    throw new EnvelopeError(403, 'branch', `Agents may only access their Run's branch (run branch: ${ctx.run.branch})`);
  }
  const sw = await engagedSwitch(store, { agentId: agent.id, mode: ctx.run.mode });
  if (sw) throw new EnvelopeError(403, 'kill-switch', `Stopped by ${describeSwitch(sw)}`);
  if (ctx.run.paused && !ctx.run.endedAt) throw new EnvelopeError(409, 'run-paused', `Run ${ctx.run.id} is paused`);
  // Agent Ops holds the answer keys: gold actions, reference notes, human grades, other runs. An agent may send telemetry there and nothing else.
  // A verifier agent files reports and reads its queue and its own reports; that is all it may touch here.
  const verifierCall = Boolean(agent.verifier?.enabled) && ((method === 'POST' && ['/agent-ops/surveillance/reports', '/agent-ops/surveillance/verifier/reviewed'].includes(path)) || (method === 'GET' && (path === '/agent-ops/surveillance/verifier/queue' || path.startsWith('/agent-ops/surveillance/reports'))));
  if (area === 'agent-ops' && !verifierCall && !(method === 'POST' && path === '/agent-ops/trace')) {
    throw new EnvelopeError(403, 'out-of-scope', `Agents may not use the Agent Ops API (${method} ${path} refused)`);
  }
  if (method !== 'GET' && method !== 'HEAD') {
    if (HUMAN_ONLY_ROUTES.some((prefix) => path.startsWith(prefix))) {
      throw new EnvelopeError(403, 'human-only', `Agents may not move patients: bed assignment, transfer, discharge and bed state are human decisions (${method} ${path} refused)`);
    }
    const telemetry = area === 'agent-ops' && path === '/agent-ops/trace';
    // The payer and the business office are written through their own routes: allowed with at least read and propose there (a decision is then a proposal unless the agent has read and write).
    const adminWrite = path.startsWith('/api/ins/');
    // Questions asked with POST (eligibility, an estimate, a scrub, a packet or letter put together from the chart) change nothing: they are reads.
    const adminQuery = adminWrite && /\/(eligibility|estimates|pharmacy-claims|scrub|packet|prefill|appeal-letter|need|questionnaire|edits|order-sign|order-select|\$questionnaire-package|\$inquire|\$searchByClaim|\$downloadRemittance)$/.test(path);
    if (adminQuery) { const no = refuseRead(permissionsOf(ctx.run, agent), path); if (no) throw new EnvelopeError(403, no.rule, no.message); }
    if (adminWrite && !adminQuery) { const level = permissionsOf(ctx.run, agent).systems?.[systemOfPath(path)] || 'none'; if (level === 'none' || level === 'read-only') throw new EnvelopeError(403, 'permission', `This agent may not write to ${systemOfPath(path)} (${level})`); if (!ctx.idempotencyKey) throw new EnvelopeError(400, 'idempotency-key-required', 'Agent writes must send an Idempotency-Key header'); }
    // Calling a CDS Hooks service asks for advice and changes nothing (feedback on a card is a person's).
    const hookCall = method === 'POST' && /^\/cds-services\/[^/]+$/.test(path);
    if (hookCall) { const no = refuseRead(permissionsOf(ctx.run, agent), path); if (no) throw new EnvelopeError(403, no.rule, no.message); }
    if (area !== 'fhir' && !telemetry && !adminWrite && !hookCall && !verifierCall) {
      throw new EnvelopeError(403, 'out-of-scope', `Agents may only write through the FHIR API (${method} ${path} refused)`);
    }
    if (area === 'fhir' && !ctx.idempotencyKey) {
      throw new EnvelopeError(400, 'idempotency-key-required', 'Agent writes must send an Idempotency-Key header');
    }
  }
  // Permissions set when the agent was added (and recorded on the run): no access to a system means no reads either; calls per minute are limited.
  if (agent) {
    const perms = permissionsOf(ctx.run, agent);
    if (method === 'GET' || method === 'HEAD') { const no = refuseRead(perms, path); if (no) throw new EnvelopeError(403, no.rule, no.message); }
    const list = rateWindow(store, agent.id, Date.parse(store.now())); list.push(Date.parse(store.now()));
    if (list.length > (perms.rateLimit || 600)) throw new EnvelopeError(429, 'rate-limit', `Agent "${agent.id}" exceeded ${perms.rateLimit} calls per minute`);
  }
  await assertCapabilities(store, ctx, { method, area, path });
  ctx.agent = agent;
}

// ---------- Write checks: run inside the write transaction ----------
function forbiddenField(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (doc._released === true) return '_released: true';
  if ((doc.meta?.tag || []).some((t) => t.system === FLAG_SYSTEM && t.code === 'released')) return 'the released flag';
  if (SIGNED_STATES.has(doc.status)) return `status: ${doc.status}`;
  if (SIGNED_STATES.has(doc.docStatus)) return `docStatus: ${doc.docStatus}`;
  return null;
}

const rateWindows = new WeakMap();
function rateWindow(store, agentId, nowMs) { let by = rateWindows.get(store); if (!by) { by = new Map(); rateWindows.set(store, by); } const list = (by.get(agentId) || []).filter((t) => nowMs - t < 60000); by.set(agentId, list); return list; }
const windows = new WeakMap();
function taskWindow(store, agentId, nowMs) {
  let byAgent = windows.get(store);
  if (!byAgent) { byAgent = new Map(); windows.set(store, byAgent); }
  const list = (byAgent.get(agentId) || []).filter((t) => nowMs - t < TASK_WINDOW_MS);
  byAgent.set(agentId, list);
  return list;
}

/**
 * Throws EnvelopeError when an agent write breaks a rule.
 * stage 'input' checks the raw body; stage 'resolved' checks the document
 * after the state machine has applied the requested transition.
 */
export async function checkAgentWrite(tx, store, ctx, { type, existed, doc, op = null, stage = 'input' }) {
  if (ctx.actor.kind !== 'agent') return;
  const agent = ctx.agent ?? await tx.get('Agent', ctx.actor.id);
  if (!agent) throw new EnvelopeError(403, 'unregistered-agent', `Agent "${ctx.actor.id}" is not registered`);
  if (type === 'Patient') throw new EnvelopeError(403, 'demographics', 'Agents may not write patient demographics');
  // Pharmacy: verifying and dispensing are human decisions. An agent may propose a decision through a proposal, never write it.
  if (type === 'MedicationDispense') throw new EnvelopeError(403, 'dispense', 'Agents may not dispense medications');
  if (type === 'DetectedIssue' && doc && (doc.mitigation || doc.status === 'final')) throw new EnvelopeError(403, 'verification', 'Agents may not close a pharmacy check: recording its outcome is the pharmacist\'s decision');
  if (type === 'MedicationRequest' && doc && (doc.extension || []).some((e) => PHARMACY_ONLY_URLS.has(e.url))) throw new EnvelopeError(403, 'verification', 'Agents may not set the pharmacy verification, query or override record on a medication order');
  if (type === 'MedicationRequest' && doc && existed && lifecycleOf(existed) === 'pending-verification' && lifecycleOf(doc) !== 'pending-verification') {
    throw new EnvelopeError(403, 'verification', 'Agents may not move a medication order out of pending-verification: verification is a pharmacist\'s decision');
  }
  if (op && HUMAN_ONLY_OPERATIONS.has(op)) {
    throw new EnvelopeError(403, 'forbidden-field', `Agents may not call ${op}: releasing, acknowledging and co-signing are human decisions`);
  }
  const field = forbiddenField(doc);
  if (field) throw new EnvelopeError(403, 'forbidden-field', `Agents may not set ${field}. Signing and release are human decisions`);
  if (HUMAN_ONLY_TYPES.has(type)) throw new EnvelopeError(403, 'human-only', type === 'MedicationAdministration' ? 'Agents never administer medication: a medication administration record is written by the nurse who gave the dose' : 'Agents may not change beds or locations: bed state is a human decision');
  if (type === 'Encounter' && JSON.stringify(doc?.location ?? null) !== JSON.stringify(existed?.location ?? null)) {
    throw new EnvelopeError(403, 'human-only', 'Agents may not move a patient: Encounter.location is set by people through the Beds app');
  }
  if (stage !== 'input') return;
  // Permissions: read only refuses every write; read and propose refuses writes that settle something; read and write is only ever on the run's branch.
  {
    const perms = permissionsOf(ctx.run, agent); const patientRef = doc?._patient || doc?.subject?.reference || doc?.patient?.reference || null;
    let synthetic = true;
    if (perms.patients === 'all-synthetic' && patientRef?.startsWith('Patient/')) { const p = await tx.get('Patient', patientRef.split('/')[1], { branch: ctx.branch }); synthetic = Boolean(p?.meta?.security?.some((x) => x.code === 'HTEST')); }
    const no = refuseWrite(perms, { type, doc, existed, branch: ctx.branch, patientRef, synthetic, runPatient: ctx.run?.patientRef || null });
    if (no) { const err = new EnvelopeError(403, no.rule, no.message); if (no.settling) err.settling = true; throw err; }
  }
  const interaction = existed ? 'update' : 'create';
  const scope = (agent.scopes || []).find((s) => s.type === type);
  if (!scope || !(scope.interactions || []).includes(interaction)) {
    throw new EnvelopeError(403, 'scope', `Agent "${agent.id}" is not allowed to ${interaction} ${type} (declared scopes: ${(agent.scopes || []).map((s) => `${s.type}:${s.interactions.join('+')}`).join(', ') || 'none'})`);
  }
  if (type === 'Task' && !existed) {
    const list = taskWindow(store, agent.id, Date.parse(tx.now()));
    ctx.pendingTaskCreates = (ctx.pendingTaskCreates || 0) + 1;
    if (list.length + ctx.pendingTaskCreates > TASK_LIMIT) {
      throw new EnvelopeError(429, 'rate-limit', `Agent "${agent.id}" exceeded ${TASK_LIMIT} Task creates per minute`);
    }
  }
}

/** Counts Task creates that actually committed (dry runs and rollbacks do not count). */
export function commitAgentWrite(store, ctx) {
  if (ctx.actor.kind !== 'agent' || !ctx.pendingTaskCreates) return;
  const nowMs = Date.parse(store.now());
  const list = taskWindow(store, ctx.actor.id, nowMs);
  for (let i = 0; i < ctx.pendingTaskCreates; i += 1) list.push(nowMs);
  ctx.pendingTaskCreates = 0;
}

/** A refused agent action is still part of the history of its run. */
export async function logRejection(store, ctx, err, { method, path }) {
  if (ctx?.actor?.kind !== 'agent' || !err?.rule) return;
  try {
    await store.transaction((tx) => recordAction(tx, {
      runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, kind: 'execute', action: 'envelope.reject',
      args: { rule: err.rule, method, path, status: err.status, ...(err.settling ? { settling: true } : {}) }, why: ctx.why ?? null,
      branch: ctx.run?.branch ?? 'main', description: `agent action refused (${err.rule}): ${err.message}`, outcome: '4',
    }));
  } catch (logErr) {
    console.error('Could not log envelope rejection', logErr);
  }
}

// ---------- Registry validation ----------
const INTERACTIONS = new Set(['create', 'update']);
const NEVER_WRITABLE = new Set(['Patient', 'AuditEvent', 'MedicationDispense']);

export function validateScopes(scopes) {
  if (!Array.isArray(scopes)) throw new HttpError(422, 'scopes must be an array of { type, interactions }');
  return scopes.map((s) => {
    if (!s || !FHIR_TYPES.has(s.type)) throw new HttpError(422, `Scope type "${s?.type}" is not a supported FHIR resource type`);
    if (NEVER_WRITABLE.has(s.type)) throw new HttpError(422, `Agents can never be given write scope on ${s.type}`);
    if (!Array.isArray(s.interactions) || !s.interactions.length || !s.interactions.every((i) => INTERACTIONS.has(i))) {
      throw new HttpError(422, `Scope ${s.type}: interactions must be a non-empty list of create, update`);
    }
    return { type: s.type, interactions: [...new Set(s.interactions)] };
  });
}
