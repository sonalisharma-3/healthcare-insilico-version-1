// The episode store and the training exports (§9d). Every rollout, every
// human-in-the-loop decision and every shadow comparison becomes one Episode.
// Exports are JSONL with a manifest on the first line, are logged, never
// contain eval-split cases, and pass through a de-identification step.
import { gradeIndex } from './grades.mjs';
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { stripInternal } from '../../platform/server/fhir-api.mjs';
import { reward, rewardConfig, histogram, GRADE_VALUE } from './grader.mjs';
import { shadowReport } from './shadow.mjs';
import { datasetsForPatients } from '../../platform/server/datasets.mjs';

const ACTIONS = { 'fhir.read': 'read', 'chart.open': 'read', 'fhir.search': 'search', 'fhir.create': 'create', 'fhir.update': 'update' };
const REMOVED = ['name', 'identifier', 'telecom', 'address', 'photo', 'contact', 'text', 'meta'];

/** Removes direct identifiers. Dates of birth are cut to the year. Returns the copy and what was removed. */
export function deidentify(resource, removed = {}) {
  if (!resource || typeof resource !== 'object') return resource;
  const out = { ...resource };
  const drop = (key) => { if (out[key] !== undefined) { delete out[key]; removed[key] = (removed[key] || 0) + 1; } };
  for (const key of REMOVED) if (resource.resourceType === 'Patient' || key === 'text' || key === 'meta') drop(key);
  if (resource.resourceType === 'Patient' && out.birthDate) { out.birthYear = String(out.birthDate).slice(0, 4); drop('birthDate'); }
  for (const key of ['requester', 'performer', 'sender', 'resultsInterpreter']) {
    const scrub = (v) => (v && typeof v === 'object' && v.display ? (removed.display = (removed.display || 0) + 1, { ...v, display: undefined }) : v);
    if (Array.isArray(out[key])) out[key] = out[key].map(scrub); else if (out[key]) out[key] = scrub(out[key]);
  }
  return JSON.parse(JSON.stringify(out));
}

export function createEpisodes({ store, getHitl = () => null }) {
  /** The agent's turns in a run: each is one tool call with what came back. */
  async function turnsOf(run, removed = {}) {
    const steps = (await store.query('TraceStep', { groupKey: run.id })).filter((s) => s.who.kind === 'agent' && (ACTIONS[s.did.type] || ['envelope.reject', 'safety.block'].includes(s.did.type)));
    const turns = [];
    for (const s of steps) {
      const args = s.did.args || {};
      if (args.type === 'Provenance') continue;
      const tool = ACTIONS[s.did.type];
      if (!tool) {
        turns.push({ stepId: s.id, action: { tool: 'create', type: args.type ?? null }, reasoning: s.why ?? null, observation: { refused: true, by: s.did.type === 'safety.block' ? 'safety alert' : 'safety envelope', rule: args.rule ?? (args.alerts || []).join(', ') }, wrote: null, refused: true });
        continue;
      }
      if (tool === 'read' || tool === 'search') {
        const resources = [];
        for (const r of (s.saw.resources || []).slice(0, 40)) {
          const [type, id] = r.ref.split('/');
          const doc = (await store.history(type, id, { branch: run.branch }).catch(() => [])).find((v) => String(v.meta.versionId) === String(r.versionId));
          if (doc) resources.push(deidentify(stripInternal(doc), removed));
        }
        turns.push({ stepId: s.id, action: tool === 'read' ? { tool, type: args.type, id: args.id } : { tool, type: args.type, params: args.params ?? {} }, reasoning: s.why ?? null, observation: { resources }, wrote: null, refused: false });
      } else {
        const doc = await store.get(args.type, args.id, { branch: run.branch });
        const { id: _id, ...body } = doc ? deidentify(stripInternal(doc), removed) : { resourceType: args.type };
        turns.push({ stepId: s.id, action: { tool, resource: body }, reasoning: s.why ?? null, observation: { written: `${args.type}/${args.id}` }, wrote: `${args.type}/${args.id}`, refused: false });
      }
    }
    return turns;
  }

  const stepIdsOf = async (runId) => (await store.query('TraceStep', { groupKey: runId })).map((s) => s.id);

  async function redTeamShare(agentId, version) {
    const suites = (await store.query('Run', { where: (r) => r.mode === 'redteam' && r.agentId === agentId && r.version === version && r.result?.kind === 'suite' && r.result.complete })).sort((a, b) => b._seq - a._seq);
    return suites[0] ? suites[0].result.failed / Math.max(suites[0].result.total, 1) : null;
  }

  // Annotation agreement: a classifier's findings on its run branch against the human labels of a labelling project on the same image (Jaccard over label names). null when there are no human labels.
  async function annotationAgreement(e) {
    if (!e.runId) return null;
    const run = await store.get('Run', e.runId);
    if (!run?.subject?.startsWith('ImagingStudy/') || !run.branch) return null;
    const mine = (await store.query('Observation', { where: (o) => (o.category || []).some((c) => (c.coding || []).some((x) => x.code === 'model-finding')) && (o.focus || []).some((f) => f.reference === run.subject) }, { branch: run.branch })).map((o) => o.code?.coding?.[0]?.code).filter(Boolean);
    if (!mine.length) return null;
    const theirs = (await store.query('Observation', { where: (o) => (o.category || []).some((c) => (c.coding || []).some((x) => x.code === 'annotation')) && (o.focus || []).some((f) => f.reference === run.subject) && o.valueCodeableConcept })).map((o) => o.valueCodeableConcept.coding?.[0]?.code).filter(Boolean);
    if (!theirs.length) return null;
    const a = new Set(mine.map((x) => x.toLowerCase())); const b = new Set(theirs.map((x) => x.toLowerCase()));
    const union = new Set([...a, ...b]);
    return Math.round(([...a].filter((x) => b.has(x)).length / union.size) * 100) / 100;
  }

  async function saveEpisode(doc, actor = { kind: 'human', id: 'system', role: 'system' }) {
    return store.transaction(async (tx) => {
      const existing = await tx.get('Episode', doc.id);
      if (existing) return existing;
      const saved = await tx.save('Episode', { resourceType: 'Episode', ...doc }, { updatedBy: actor.role });
      await recordAction(tx, { runId: doc.runId, actor, kind: 'create', action: 'episode.create', args: { episode: saved.id, kind: saved.kind, caseId: saved.caseId ?? null }, entityRef: `Episode/${saved.id}`, versionId: saved.meta.versionId, description: `episode recorded (${saved.kind})`, audit: false });
      return saved;
    });
  }

  /** Shadow comparisons and human-in-the-loop decisions become episodes the first time anyone asks for episodes. */
  async function sync() {
    const have = new Set((await store.query('Episode')).map((e) => e.id));
    const runs = new Map((await store.query('Run')).map((r) => [r.id, r]));
    for (const group of (await shadowReport(store)).agents) {
      for (const c of group.cases.filter((x) => x.status === 'compared')) {
        const id = `ep-${c.runId}`;
        const run = runs.get(c.runId);
        if (have.has(id) || !run || run.caseId) continue;
        await saveEpisode({
          id, kind: 'shadow', agentId: run.agentId, version: run.version, policyHash: run.policyHash, runId: run.id, caseId: null, caseSlug: null, split: 'train',
          state: { subject: run.subject, branch: run.branch, asOf: run.startedAt }, action: { summary: run.result?.summary ?? null, output: c.agentRef }, trajectory: await stepIdsOf(run.id),
          outcome: { raw: { agree: c.outcome.agree, timeSaved: c.cost.humanSeconds ? Math.max(-1, Math.min(1, (c.cost.humanSeconds - c.cost.agentSeconds) / c.cost.humanSeconds)) : null, safetyViolations: c.rejected }, comparison: { agent: c.outcome.agent, clinician: c.outcome.human, pathSimilarity: c.path.similarity } },
          timestamp: run.endedAt ?? run.startedAt,
        });
      }
    }
    const hitl = getHitl();
    if (hitl) {
      for (const group of (await hitl.report()).agents) {
        for (const p of group.proposals.filter((x) => ['accepted', 'edited', 'rejected'].includes(x.status) && !x.plantedError)) {
          const id = `ep-${p.id}`;
          const run = runs.get(p.runId);
          if (have.has(id) || !run) continue;
          const rejected = (await store.query('TraceStep', { groupKey: run.id })).filter((s) => s.did.type === 'envelope.reject').length;
          await saveEpisode({
            id, kind: 'hitl', agentId: run.agentId, version: run.version, policyHash: run.policyHash, runId: run.id, caseId: null, caseSlug: null, split: 'train',
            state: { subject: p.subject, branch: run.branch, asOf: run.startedAt, practice: p.practice }, action: { summary: run.result?.summary ?? null, proposal: p.content }, trajectory: await stepIdsOf(run.id),
            outcome: { raw: { acceptance: p.status === 'rejected' ? 0 : 1, editRatio: p.status === 'edited' ? p.edit?.ratio ?? 0 : p.status === 'accepted' ? 0 : null, safetyViolations: rejected }, decision: { status: p.status, decidedBy: p.decidedBy, seconds: p.decisionSeconds, reason: p.reason } },
            timestamp: p.decidedAt ?? run.startedAt,
          });
        }
      }
    }
  }

  // Human grades are read fresh every time, so a new grade changes an episode's reward at once and the next export picks it up.
  const expertGrades = () => gradeIndex(store);

  /** Episodes with rewards computed from the current weights. */
  async function list({ agentId = null, version = null, caseId = null, kind = null, split = null, config = null } = {}) {
    await sync();
    const cfg = config ?? await rewardConfig(store);
    const grades = await expertGrades();
    const shares = new Map();
    const episodes = (await store.query('Episode', { where: (e) => (!agentId || e.agentId === agentId) && (!version || e.version === version) && (!caseId || e.caseId === caseId) && (!kind || e.kind === kind) && (!split || e.split === split) }))
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)) || b._seq - a._seq);
    const out = [];
    for (const e of episodes) {
      const key = `${e.agentId}@${e.version}`;
      if (!shares.has(key)) shares.set(key, await redTeamShare(e.agentId, e.version));
      const mine = grades.get(e.id) ?? null;
      const expert = mine ? mine.value : null;
      const raw = { ...e.outcome.raw, caseKey: e.caseSlug ?? e.caseId ?? '', redTeamFailedShare: shares.get(key), expertGrade: expert, judge: e.outcome.judge ?? null, annotationAgreement: e.outcome.raw?.annotationAgreement ?? await annotationAgreement(e) };
      const r = reward(raw, cfg);
      const { _seq, meta, resourceType, ...rest } = e;
      out.push({ ...rest, outcome: { ...e.outcome, checks: e.outcome.raw?.checks ?? null, rewardBreakdown: r.breakdown, totalReward: r.total, rewardVersion: r.rewardVersion, verifier: r.verifier, judged: r.judged, judgeDisagreement: r.judgeDisagreement, humanGrade: mine } });
    }
    return out;
  }

  /** How rewards are spread, and how often re-evaluating an episode changed its score. */
  async function rewardSummary(config = null) {
    const episodes = await list({ config });
    const again = episodes.filter((e) => (e.evaluations || []).length >= 2);
    const flipped = again.filter((e) => { const [a, b] = e.evaluations.slice(-2); return a.signature !== b.signature; });
    return {
      episodes: episodes.length, histogram: histogram(episodes.map((e) => e.outcome.totalReward)),
      byKind: Object.fromEntries(['rollout', 'environment', 'shadow', 'hitl', 'shadow-case', 'ablation', 'regression'].map((k) => [k, episodes.filter((e) => e.kind === k).length])),
      flipRate: again.length ? Math.round((flipped.length / again.length) * 1000) / 1000 : null, reEvaluated: again.length, flipped: flipped.length,
    };
  }

  // ---------- Exports ----------
  const windowOf = (url) => {
    const raw = url.searchParams.get('window');
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw new HttpError(422, 'window must be a whole number of turns between 0 and 1000');
    return n;
  };
  const pairs = (turns) => turns.map((t) => ({ action: t.action, observation: t.observation }));
  const lastN = (list, n) => (n == null ? list : n === 0 ? [] : list.slice(-n));

  /** Reward credited to each turn: the checks its record satisfied, a penalty for refused requests, the rest on the last turn. */
  function stepRewards(turns, episode, cfg) {
    const rows = episode.outcome.verifier?.rows ?? [];
    const scale = episode.outcome.verifier?.possible ? cfg.components.verifier / episode.outcome.verifier.possible : 0;
    const out = turns.map((t) => {
      let r = 0;
      if (t.wrote) for (const c of rows) if (c.evidence.includes(t.wrote)) r += c.contribution * scale;
      if (t.refused) r -= cfg.components.safety;
      return Math.round(r * 10000) / 10000;
    });
    if (out.length) out[out.length - 1] = Math.round((out[out.length - 1] + episode.outcome.totalReward - out.reduce((n, v) => n + v, 0)) * 10000) / 10000;
    return out;
  }

  /** The patients the episodes are about (the subject, or the patient of the subject record), for the dataset register. */
  async function patientsOf(episodes) {
    const out = new Set();
    for (const e of episodes) {
      const subject = String(e.state?.patient || e.state?.subject || '');
      const [type, id] = subject.split('/');
      if (type === 'Patient' && id) out.add(id);
      else if (type && id) { const doc = await store.get(type, id, { branch: e.state?.branch }).catch(() => null); if (doc?._patient) out.add(String(doc._patient).replace('Patient/', '')); }
    }
    return [...out];
  }

  async function exportLines(kind, url, ctx) {
    const window = kind === 'episodes' ? null : windowOf(url);
    const agentId = url.searchParams.get('agentId'); const version = url.searchParams.get('version');
    const wantEval = kind === 'episodes' && url.searchParams.get('split') === 'eval';
    if (kind !== 'episodes' && url.searchParams.get('split') === 'eval') throw new HttpError(403, 'Eval-split cases are frozen and never appear in a training export');
    const cfg = await rewardConfig(store);
    const all = await list({ agentId, version, config: cfg });
    const cases = new Map((await store.query('EvalCase')).map((c) => [c.id, c]));
    // Belt and braces: the split is checked on the episode and again on its case.
    // Training exports hold train-split work only: validation attempts are for monitoring and are never exported as training data.
    const allowed = all.filter((e) => (wantEval ? e.split === 'eval' : !['eval', 'validation'].includes(e.split) && !['eval', 'validation'].includes(cases.get(e.caseId)?.split)));
    const runs = new Map((await store.query('Run')).map((r) => [r.id, r]));
    const removed = {};
    const lines = [];
    const context = (e) => { const c = cases.get(e.caseId); return c ? { caseId: c.id, title: c.title, scenario: c.scenario, task: c.task } : { caseId: null, title: null, scenario: null, task: runs.get(e.runId)?.goal ?? null }; };
    let used = allowed;
    if (kind === 'episodes') {
      for (const e of allowed) lines.push(e);
    } else {
      const rollouts = allowed.filter((e) => ['rollout', 'environment'].includes(e.kind) && e.caseId);
      const byCase = new Map();
      for (const e of rollouts) { if (!byCase.has(e.caseId)) byCase.set(e.caseId, []); byCase.get(e.caseId).push(e); }
      for (const group of byCase.values()) group.sort((a, b) => b.outcome.totalReward - a.outcome.totalReward || String(a.timestamp).localeCompare(String(b.timestamp)) || a.id.localeCompare(b.id));
      const turnsFor = async (e) => turnsOf(runs.get(e.runId), removed);
      if (kind === 'sft') {
        used = [...byCase.values()].map((g) => g[0]);
        for (const e of used) {
          const turns = await turnsFor(e);
          turns.forEach((t, i) => { if (!t.refused) lines.push({ episodeId: e.id, ...context(e), reward: e.outcome.totalReward, turn: i + 1, history: lastN(pairs(turns.slice(0, i)), window), action: t.action, reasoning: t.reasoning }); });
        }
      } else if (kind === 'preferences') {
        used = [];
        for (const group of byCase.values()) {
          for (let i = 0; i < group.length; i += 1) for (let j = i + 1; j < group.length; j += 1) {
            if (group[i].outcome.totalReward - group[j].outcome.totalReward < 1e-9) continue;
            const [good, bad] = [group[i], group[j]];
            lines.push({ ...context(good), preferred: { episodeId: good.id, reward: good.outcome.totalReward, trajectory: lastN(pairs(await turnsFor(good)), window) }, rejected: { episodeId: bad.id, reward: bad.outcome.totalReward, trajectory: lastN(pairs(await turnsFor(bad)), window) }, margin: Math.round((good.outcome.totalReward - bad.outcome.totalReward) * 10000) / 10000 });
            for (const x of [good, bad]) if (!used.includes(x)) used.push(x);
          }
        }
      } else {
        used = rollouts;
        for (const e of rollouts) {
          const turns = await turnsFor(e);
          const rewards = stepRewards(turns, e, cfg);
          lines.push({ episodeId: e.id, ...context(e), seed: runs.get(e.runId)?.seed ?? null, totalReward: e.outcome.totalReward, steps: turns.map((t, i) => ({ t: i + 1, history: lastN(pairs(turns.slice(0, i)), window), action: t.action, reasoning: t.reasoning, observation: t.observation, reward: rewards[i] })) });
        }
      }
    }
    const manifest = {
      manifest: true, export: kind, exportedAt: store.now(), agentId: agentId ?? 'all', version: version ?? 'all', windowSize: window ?? 'unlimited', splitFilter: wantEval ? 'eval' : 'train',
      episodeCount: used.length, lineCount: lines.length, evalSplitExcluded: !wantEval, rewardVersion: cfg.version,
      deidentified: kind !== 'episodes', removedFields: removed, datasets: datasetsForPatients(await patientsOf(used)),
      note: 'Train with the same window size you will use at inference. See train/README.md.',
    };
    await store.transaction((tx) => recordAction(tx, {
      actor: ctx.actor, kind: 'read', action: 'export.download', args: { export: kind, agentId: manifest.agentId, version: manifest.version, window: manifest.windowSize, split: manifest.splitFilter, episodes: used.length, lines: lines.length },
      description: `training export ${kind}.jsonl (${used.length} episodes, split ${manifest.splitFilter})`,
    }));
    return { status: 200, body: `${[manifest, ...lines].map((l) => JSON.stringify(l)).join('\n')}\n`, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': `attachment; filename="${kind}.jsonl"` } };
  }

  return { saveEpisode, sync, list, rewardSummary, turnsOf, stepIdsOf, stepRewards, exportLines, redTeamShare };
}
