// /agent-ops/** routes: runs, branches and the trace.
import { EventEmitter } from 'node:events';
import { writeReport, studyWriteReport } from './write-report.mjs';
import { randomUUID } from 'node:crypto';
import { narrowTo, highestLevel, DEFAULT_GRANT } from './permissions.mjs';
import { readFeatures, snapshot as featureSnapshot } from './ai-features.mjs';
import { pseudonym } from '../../platform/server/pseudonym.mjs';
import { recordAction, buildTraceStep, LIVE_RUN_ID, whichOf } from '../../platform/server/audit.mjs';
import { HttpError } from '../../platform/server/http.mjs';
import { EnvelopeError, engagedSwitch } from './envelope.mjs';
import { isPromoted } from './promotion.mjs';
import { validateOverlays, describeOverlay } from './ablation.mjs';
import { resolveCondition, normalizeTimeline, timelineForRun } from './capabilities.mjs';

export const ASK_FREQUENCIES = ['every-step', 'orders-signing', 'low-confidence'];

// Where a Run's writes land, by mode (§9a).
export const MODES = {
  'shadow-event': { umbrella: 'evaluate', branchKind: 'shadow' },
  'shadow-task': { umbrella: 'evaluate', branchKind: 'shadow' },
  hitl: { umbrella: 'evaluate', branchKind: 'shadow' },
  'rl-generate': { umbrella: 'rl', branchKind: 'rollout' },
  redteam: { umbrella: 'redteam', branchKind: 'redteam' },
  scribe: { umbrella: 'benchmark', branchKind: 'rollout' },
  regression: { umbrella: 'benchmark', branchKind: 'rollout' },
  capture: { umbrella: 'annotation', branchKind: null },
  label: { umbrella: 'annotation', branchKind: null },
  sandbox: { umbrella: 'sandbox', branchKind: 'sandbox' },
};
const FRICTION = new Set(['low', 'realistic', 'high']);

/** Listeners for runs starting and ending: on('created' | 'ended', (run) => ...). Used to tie live shadow work to a study. */
export const runEvents = new EventEmitter();

export async function createRun(store, input, actor) {
  const run = await createRunInner(store, input, actor);
  runEvents.emit('created', run, store);
  return run;
}
async function createRunInner(store, input, actor) {
  const mode = MODES[input?.mode];
  if (!mode) throw new HttpError(422, `mode must be one of ${Object.keys(MODES).join(', ')}`);
  const friction = input.friction ?? 'realistic';
  if (!FRICTION.has(friction)) throw new HttpError(422, 'friction must be low, realistic or high');
  const overlays = validateOverlays(input.overlays);
  let agent = null;
  if (input.agentId != null) {
    agent = await store.get('Agent', String(input.agentId));
    if (!agent) throw new HttpError(422, `Agent "${input.agentId}" is not registered. Register it at POST /agent-ops/agents first`);
    if (!agent.enabled) throw new HttpError(409, `Agent "${agent.id}" is disabled in the registry`);
    if (agent.approval?.status === 'pending') throw new HttpError(409, `Agent "${agent.id}" asked for permissions that the platform owner has not approved yet (Agent Dashboard, Settings)`, 'not-approved');
    if (agent.approval?.status === 'refused') throw new HttpError(409, `Agent "${agent.id}" was refused by the platform owner`, 'not-approved');
    const limit = agent.surveillance?.restrictedTo;
    if (limit && !['redteam', 'sandbox'].includes(input.mode)) {
      if (limit.condition && (input.condition ?? 'deployed-today') !== limit.condition) throw new HttpError(403, `Agent "${agent.id}" is restricted to the condition "${limit.condition}" after a surveillance review`, 'restricted');
      const want = Object.entries(limit.keys || {}); const given = { ...(input.trigger || {}), ...(input.context || {}) };
      if (want.some(([k, v]) => ['role', 'specialty', 'site', 'department'].includes(k) && given[k] !== v)) throw new HttpError(403, `Agent "${agent.id}" is restricted to ${want.map(([k, v]) => `${k} ${v}`).join(', ')} after a surveillance review`, 'restricted');
    }
    const sw = await engagedSwitch(store, { agentId: agent.id, mode: input.mode });
    if (sw) throw new EnvelopeError(403, 'kill-switch', `A kill switch is engaged (${sw.scope}${sw.target ? ` ${sw.target}` : ''}). Release it before starting agent runs`);
  }
  // Human in the loop: the agent drafts on a hidden staging branch; accepted content lands on the target.
  let hitl = null;
  if (input.mode === 'hitl') {
    if (!agent) throw new HttpError(422, 'A human-in-the-loop run needs an agent');
    const target = input.targetBranch ?? 'main';
    const info = await store.getBranch(target);
    if (!info || info.droppedAt) throw new HttpError(422, `Branch "${target}" does not exist`);
    if (target === 'main') {
      if (!isPromoted(agent)) throw new EnvelopeError(403, 'not-promoted', `${agent.name} v${agent.version} has not been promoted, so it cannot propose on the live chart. It can be tried on a practice copy (sandbox)`);
      if (input.probe) throw new EnvelopeError(403, 'probe-on-main', 'Deliberately wrong proposals are only allowed on a sandbox branch');
    } else if (info.kind !== 'sandbox') {
      throw new HttpError(422, 'A human-in-the-loop run can target main or a sandbox branch');
    }
    const askFrequency = input.askFrequency ?? (input.condition != null || input.capabilities != null ? 'orders-signing' : agent.hitl?.askFrequency ?? 'every-step');
    if (!ASK_FREQUENCIES.includes(askFrequency)) throw new HttpError(422, `askFrequency must be one of ${ASK_FREQUENCIES.join(', ')}`);
    const threshold = input.confidenceThreshold == null ? 0.6 : Number(input.confidenceThreshold);
    if (!(threshold >= 0 && threshold <= 1)) throw new HttpError(422, 'confidenceThreshold must be between 0 and 1');
    hitl = { targetBranch: target, askFrequency, confidenceThreshold: threshold, probe: Boolean(input.probe), awaitingDecision: false };
  }
  // Plan-master 8.4 to 8.6: what the agent may do, stored on the Run. Runs that name no condition get the deployed baseline.
  const condition = input.condition != null || input.capabilities != null ? await resolveCondition(store, input) : { condition: null, capabilities: null, clock: 'real', askTimeoutMs: input.askTimeoutMs != null && Number.isFinite(Number(input.askTimeoutMs)) ? Number(input.askTimeoutMs) : null };
  let timeline = normalizeTimeline(input.timeline);
  if (!timeline && input.caseId) { const c = await store.get('EvalCase', String(input.caseId)).catch(() => null); if (Array.isArray(c?.timeline) && c.timeline.length) timeline = c.timeline; }
  const [subjType, subjId] = String(input.subject || '').split('/');
  let patientRef = subjType === 'Patient' && subjId ? `Patient/${subjId}` : null;
  if (!patientRef && subjType && subjId) { const found = await store.get(subjType, subjId, { branch: hitl?.targetBranch ?? input.parentBranch ?? 'main' }).catch(() => null); patientRef = found?._patient ?? (found?.subject?.reference?.startsWith('Patient/') ? found.subject.reference : null); }
  // Research capabilities switched off in Settings -> AI features are taken out of the run's set; the settings in force are stored on the run.
  const ai = await readFeatures(store);
  if (Array.isArray(condition?.capabilities)) condition.capabilities = condition.capabilities.filter((c) => ai.research[c] !== false);
  return store.transaction(async (tx) => {
    const branch = mode.branchKind
      ? await tx.fork({ parentBranch: hitl?.targetBranch ?? input.parentBranch ?? 'main', forkedAt: input.forkedAt, kind: mode.branchKind })
      : 'main';
    // A scenario's patient exists only where it is being run: its chart is written onto this run's own branch now.
    const kase = input.caseId ? await tx.get('EvalCase', String(input.caseId)) : null;
    const plant = Array.isArray(input.plant) ? input.plant : Array.isArray(kase?.plant) ? kase.plant : null;
    if (plant?.length) {
      if (branch === 'main') throw new HttpError(409, 'A scenario patient is never written to the live record: run this on a sandbox or red-team branch');
      for (const doc of plant) await tx.save(doc.resourceType, doc, { branch, updatedBy: 'scenario' });
    }
    const run = await tx.save('Run', {
      resourceType: 'Run', id: randomUUID(), umbrella: mode.umbrella, mode: input.mode,
      agentId: agent?.id ?? null, version: input.version ?? agent?.version ?? null, policyHash: input.policyHash ?? agent?.policyHash ?? null,
      branch, caseId: input.caseId ?? null, overlays, friction,
      seed: Number.isInteger(input.seed) ? input.seed : 0,
      subject: typeof input.subject === 'string' ? input.subject.slice(0, 200) : null,
      goal: typeof input.goal === 'string' ? input.goal.slice(0, 500) : null,
      trigger: input.trigger && typeof input.trigger === 'object' ? input.trigger : null,
      context: input.context && typeof input.context === 'object' ? input.context : null,
      parentRunId: typeof input.parentRunId === 'string' ? input.parentRunId : null,
      // Which study or training run, task and attempt this work belongs to (docs/STUDY-DESIGN.md 5). Written by the server, never by the client.
      attempt: input.attempt && typeof input.attempt === 'object' ? input.attempt : null,
      study: typeof input.study === 'string' && input.study ? input.study : (actor.study || null),
      patientRef, ...(condition || {}), aiFeatures: featureSnapshot(ai),
      // The permissions this run works under: the agent's grant, or a narrower set asked for by whoever started the run (to compare levels side by side).
      permissions: agent ? (input.permissions ? narrowTo(agent.granted || DEFAULT_GRANT, input.permissions) : { ...(agent.granted || DEFAULT_GRANT) }) : null, permissionLevel: agent ? highestLevel(input.permissions ? narrowTo(agent.granted || DEFAULT_GRANT, input.permissions) : (agent.granted || DEFAULT_GRANT)) : null,
      // What produced this run (part 1.5), so results compare fairly. Tokens and wall time are added when it ends.
      record: agent || input.record ? { organisation: input.record?.organisation ?? agent?.organisation ?? (agent?.builtIn ? 'Built in' : null), agent: agent?.name ?? null, version: input.version ?? agent?.version ?? null, provider: input.record?.provider ?? agent?.adapter?.provider ?? (agent?.adapter?.kind === 'stub' ? 'built-in rules' : agent?.adapter?.kind === 'model' ? agent.adapter.model : agent?.adapter?.kind ?? null), model: input.record?.model ?? agent?.modelName ?? agent?.adapter?.model ?? null, modelVersion: null, harness: input.record?.harness ?? (agent?.adapter?.kind === 'harness' ? 'reference' : agent?.adapter?.kind === 'stub' || agent?.adapter?.kind === 'model' ? 'built-in' : 'theirs'), connection: agent?.connection ?? null } : null, ...(timeline ? { timeline: timelineForRun(timeline, tx.now()) } : {}), turn: null, awaitingReply: null,
      ...(hitl || {}), paused: false, startedAt: tx.now(), endedAt: null,
    }, { updatedBy: actor.role });
    // A run started from a mode page joins the researcher's current study (plan-master 6.2).
    if (run.study) { const study = await tx.get('Study', run.study); if (study && study.status !== 'archived') await tx.save('StudyLink', { resourceType: 'StudyLink', id: randomUUID(), study: run.study, kind: run.mode === 'capture' ? 'recording' : 'run', ref: run.id, addedBy: pseudonym(actor.id), addedAt: tx.now(), createdAt: tx.now() }, { updatedBy: actor.role }); }
    await recordAction(tx, {
      runId: run.id, actor, kind: 'execute', action: 'run.start', args: { mode: run.mode, branch }, branch,
      entityRef: `Run/${run.id}`, description: `run start ${run.id}`,
    });
    return run;
  });
}

export const runStatus = (run) => (run.endedAt ? (run.endReason || 'completed') : run.paused ? 'paused' : run.awaitingDecision ? 'awaiting-decision' : 'running');
export const withStatus = (run) => ({ ...run, status: runStatus(run), overlayText: (run.overlays || []).map(describeOverlay) });

/** Pause holds an agent at its next step; resume lets it continue. */
export async function setPaused(store, id, paused, actor) {
  return store.transaction(async (tx) => {
    const run = await tx.get('Run', id);
    if (!run) throw new HttpError(404, `Run ${id} not found`);
    if (id === LIVE_RUN_ID) throw new HttpError(409, 'The ambient live run cannot be paused');
    if (run.endedAt) throw new HttpError(409, `Run ${id} has ended`);
    if (Boolean(run.paused) === paused) return run;
    const { _seq, ...doc } = run;
    const saved = await tx.save('Run', { ...doc, paused }, { updatedBy: actor.role });
    await recordAction(tx, {
      runId: id, actor, kind: 'execute', action: paused ? 'run.pause' : 'run.resume', args: {}, branch: run.branch,
      entityRef: `Run/${id}`, description: `run ${paused ? 'paused' : 'resumed'} ${id}`,
    });
    return saved;
  });
}

export async function endRun(store, id, actor, reason = 'completed', result = undefined) {
  const ended = await endRunInner(store, id, actor, reason, result);
  runEvents.emit('ended', ended, store);
  return ended;
}
async function endRunInner(store, id, actor, reason, result) {
  return store.transaction(async (tx) => {
    const run = await tx.get('Run', id);
    if (!run) throw new HttpError(404, `Run ${id} not found`);
    if (id === LIVE_RUN_ID) throw new HttpError(409, 'The ambient live run cannot be ended');
    if (run.endedAt) return run;
    const { _seq, ...doc } = run;
    let record = doc.record ?? null;
    if (record) {
      const calls = (await tx.query('TraceStep', { groupKey: id })).filter((s) => s.did?.type === 'model.call');
      const reported = calls.filter((s) => s.did.args?.promptTokens != null || s.did.args?.completionTokens != null);
      const said = result?.usage && (result.usage.promptTokens != null || result.usage.completionTokens != null) ? result.usage : null;
      record = { ...record, modelVersion: calls.map((s) => s.did.args?.model).filter(Boolean).pop() ?? record.modelVersion ?? null, modelCalls: calls.length,
        tokens: reported.length ? { prompt: reported.reduce((n, s) => n + (s.did.args.promptTokens || 0), 0), completion: reported.reduce((n, s) => n + (s.did.args.completionTokens || 0), 0), reportedBy: 'endpoint' } : said ? { prompt: said.promptTokens ?? null, completion: said.completionTokens ?? null, reportedBy: 'agent' } : null,
        wallMs: Date.parse(tx.now()) - Date.parse(doc.startedAt) };
    }
    const ended = await tx.save('Run', { ...doc, ...(record ? { record } : {}), paused: false, endedAt: tx.now(), endReason: reason, ...(result !== undefined ? { result } : {}) }, { updatedBy: actor.role });
    await recordAction(tx, {
      runId: id, actor, kind: 'execute', action: 'run.end', args: { reason }, branch: run.branch,
      entityRef: `Run/${id}`, description: `run end ${id}`,
    });
    return ended;
  });
}

// UI telemetry: structured identifiers only. Anything else is refused, so a
// field value or keystroke cannot reach the log by accident.
const SAFE = /^[A-Za-z0-9_\-.:/#]{0,128}$/;
const EVENT_TYPES = new Set(['click', 'change', 'focus', 'scroll', 'nav', 'context', 'viewer', 'dialog', 'submit']);
const EVENT_FIELDS = {
  seq: (v) => Number.isInteger(v) && v >= 0,
  type: (v) => EVENT_TYPES.has(v),
  target: (v) => typeof v === 'string' && SAFE.test(v),
  field: (v) => typeof v === 'string' && SAFE.test(v),
  app: (v) => ['desktop', 'ehr', 'pacs', 'portal', 'agent-ops', 'pharmacy', 'lab', 'beds', 'monitoring', 'pathology', 'visit', 'payer'].includes(v),
  route: (v) => typeof v === 'string' && SAFE.test(v),
  patient: (v) => v === null || (typeof v === 'string' && /^Patient\/[A-Za-z0-9\-.]{1,64}$/.test(v)),
  uiStateHash: (v) => typeof v === 'string' && /^[a-f0-9]{8,64}$/.test(v),
  clientTime: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
  sessionId: (v) => typeof v === 'string' && SAFE.test(v),
  asOf: (v) => v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v))),
  branch: (v) => typeof v === 'string' && SAFE.test(v),
  resources: (v) => Array.isArray(v) && v.length <= 200 && v.every((r) => r && typeof r.ref === 'string' && SAFE.test(r.ref)
    && Object.keys(r).every((k) => ['ref', 'versionId'].includes(k)) && (r.versionId == null || SAFE.test(String(r.versionId)))),
  viewer: (v) => v && typeof v === 'object' && Object.entries(v).every(([k, x]) => SAFE.test(k)
    && (typeof x === 'number' || typeof x === 'boolean' || (typeof x === 'string' && SAFE.test(x)))),
};

export function validateTraceBatch(batch) {
  if (!batch || typeof batch !== 'object') throw new HttpError(400, 'Batch body required');
  if (typeof batch.batchId !== 'string' || !/^[A-Za-z0-9\-]{8,64}$/.test(batch.batchId)) throw new HttpError(422, 'batchId is required');
  if (!Array.isArray(batch.events) || batch.events.length === 0 || batch.events.length > 500) {
    throw new HttpError(422, 'events must be a non-empty array of at most 500 items');
  }
  const seen = new Set();
  for (const event of batch.events) {
    if (!event || typeof event !== 'object') throw new HttpError(422, 'Each event must be an object');
    for (const [key, value] of Object.entries(event)) {
      if (!EVENT_FIELDS[key]) throw new HttpError(422, `Event field "${key}" is not allowed in telemetry`);
      if (!EVENT_FIELDS[key](value)) throw new HttpError(422, `Event field "${key}" has a disallowed value`);
    }
    if (event.seq == null || event.type == null) throw new HttpError(422, 'Each event needs seq and type');
    if (seen.has(event.seq)) throw new HttpError(422, `Duplicate seq ${event.seq} in batch`);
    seen.add(event.seq);
  }
  return [...batch.events].sort((a, b) => a.seq - b.seq);
}

export async function ingestTraceBatch(store, batch, ctx) {
  const events = validateTraceBatch(batch);
  const runId = ctx.runId ?? LIVE_RUN_ID;
  return store.transaction(async (tx) => {
    const replay = await tx.getIdempotent('trace-batch', batch.batchId);
    if (replay) return { ...replay.body, replayed: true };
    const wall = tx.now();
    const ids = [];
    for (const event of events) {
      const { type, seq, target, field, resources, uiStateHash, asOf, branch, patient, ...rest } = event;
      // Events are sent in batches a moment after they happen. One made while a recording was still on belongs to it, even if the batch arrives just after the stop.
      const late = ctx.endedCapture && typeof rest.clientTime === 'string' && new Date(rest.clientTime).toISOString() <= ctx.endedCapture.endedAt && new Date(rest.clientTime).toISOString() >= ctx.endedCapture.startedAt;
      const step = buildTraceStep({
        runId: late ? ctx.endedCapture.id : runId, actor: ctx.actor, action: `ui.${type}`, args: { target: target ?? null, field: field ?? null, patient: patient ?? null, ...rest },
        branch: branch ?? ctx.branch, asOf: asOf ?? null, resources: resources ?? [], uiStateHash: uiStateHash ?? null,
        wall, source: 'ui', client: { batchId: batch.batchId, seq }, which: await whichOf(tx, late ? ctx.endedCapture.id : runId),
      });
      await tx.save('TraceStep', step, { branch: 'main', updatedBy: ctx.actor.role });
      ids.push(step.id);
    }
    const body = { accepted: ids.length, traceStepIds: ids };
    await tx.putIdempotent('trace-batch', batch.batchId, 200, body);
    return body;
  });
}

export function createAgentOpsApi({ store, agents = null }) {
  return {
    async handle(req, url, body, ctx) {
      const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
      const method = req.method;
      const [area, id, op] = parts;
      if (agents) {
        const out = await agents.handle(req, url, body, ctx, parts);
        if (out) return out;
      }

      if (area === 'trace' && parts.length === 1) {
        if (method === 'POST') return { status: 200, body: await ingestTraceBatch(store, body, ctx) };
        if (method === 'GET') {
          const runId = url.searchParams.get('runId');
          if (!runId) throw new HttpError(400, 'runId query parameter is required');
          const owner = await store.get('Run', runId);
          if (!owner) throw new HttpError(404, `Run ${runId} not found`);
          if (owner.result?.heldOut && ctx.actor.kind === 'human') throw new HttpError(403, 'This run belongs to a held-out red-team test. Its trace is never shown; only the leaderboard summary is');
          const steps = await store.query('TraceStep', { groupKey: runId });
          return { status: 200, body: { runId, count: steps.length, steps: steps.map(({ _seq, ...s }) => ({ seq: _seq, ...s })) } };
        }
      }
      if (area === 'write-report' && method === 'GET') {
        const q = url.searchParams;
        if (q.get('study')) return { status: 200, body: await studyWriteReport(store, q.get('study')) };
        if (!q.get('run')) throw new HttpError(400, 'Name a run or a study: ?run= or ?study=');
        return { status: 200, body: await writeReport(store, q.get('run')) };
      }
      if (area === 'runs') {
        if (parts.length === 1 && method === 'POST') return { status: 201, body: await createRun(store, body, ctx.actor) };
        if (parts.length === 1 && method === 'GET') return { status: 200, body: { runs: (await store.query('Run')).map((r) => withStatus(r.result?.heldOut && ctx.actor.kind === 'human' ? { ...r, result: { kind: r.result.kind, heldOut: true, passed: r.result.passed ?? null }, timeline: undefined } : r)) } };
        if (parts.length === 2 && method === 'GET') {
          const run = await store.get('Run', id);
          if (!run) throw new HttpError(404, `Run ${id} not found`);
          // A held-out red-team test run shows only that it is held out (task 14.3).
          return { status: 200, body: withStatus(run.result?.heldOut && ctx.actor.kind === 'human' ? { ...run, result: { kind: run.result.kind, heldOut: true, passed: run.result.passed ?? null }, timeline: undefined } : run) };
        }
        if (parts.length === 3 && method === 'POST' && ctx.actor.kind === 'human') {
          if (op === 'end') return { status: 200, body: withStatus(await endRun(store, id, ctx.actor, body?.reason)) };
          if (op === 'cancel') return { status: 200, body: withStatus(await endRun(store, id, ctx.actor, 'cancelled')) };
          if (op === 'pause') return { status: 200, body: withStatus(await setPaused(store, id, true, ctx.actor)) };
          if (op === 'resume') return { status: 200, body: withStatus(await setPaused(store, id, false, ctx.actor)) };
        }
      }
      if (area === 'branches') {
        if (parts.length === 1 && method === 'GET') return { status: 200, body: { branches: await store.listBranches() } };
        if (parts.length === 1 && method === 'POST') {
          const branchId = await store.transaction(async (tx) => {
            if (body?.careAt != null && Number.isNaN(new Date(body.careAt).getTime())) throw new HttpError(422, 'careAt must be a date and time');
            const created = await tx.fork({ parentBranch: body?.parentBranch, forkedAt: body?.forkedAt, kind: body?.kind, careCap: body?.careAt ?? null });
            await recordAction(tx, {
              actor: ctx.actor, kind: 'execute', action: 'branch.fork', args: { branch: created, kind: body?.kind }, branch: created,
              description: `fork ${created}`,
            });
            return created;
          });
          return { status: 201, body: await store.getBranch(branchId) };
        }
        if (parts.length === 2 && method === 'DELETE') {
          await store.transaction(async (tx) => {
            await tx.dropBranch(id);
            await recordAction(tx, {
              actor: ctx.actor, kind: 'execute', action: 'branch.drop', args: { branch: id }, branch: 'main',
              description: `drop ${id}`,
            });
          });
          return { status: 200, body: await store.getBranch(id) };
        }
      }
      throw new HttpError(404, `${method} ${url.pathname} is not available`);
    },
  };
}
