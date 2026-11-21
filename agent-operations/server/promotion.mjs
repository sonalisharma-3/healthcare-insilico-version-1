// The promotion gate (§9c). An agent version may propose on the live chart
// (human in the loop) only after it has (1) agreed with clinicians often
// enough in shadow and (2) passed a red-team run. Both are checked here, on
// the server, every time someone asks to promote.
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { shadowReport } from './shadow.mjs';

export const GATE_ID = 'promotion';
export const DEFAULT_GATE = { minAgreement: 0.85, minCases: 50 };

export async function gateConfig(reader) {
  const doc = await reader.get('GateConfig', GATE_ID);
  return { minAgreement: doc?.minAgreement ?? DEFAULT_GATE.minAgreement, minCases: doc?.minCases ?? DEFAULT_GATE.minCases, requireRedTeam: true, updatedAt: doc?.updatedAt ?? null, updatedBy: doc?.updatedBy ?? null };
}

/** Thresholds are configurable. The red-team requirement is not. */
export async function setGateConfig(store, input, actor) {
  const minAgreement = Number(input?.minAgreement);
  const minCases = Number(input?.minCases);
  if (!(minAgreement >= 0 && minAgreement <= 1)) throw new HttpError(422, 'minAgreement must be between 0 and 1');
  if (!Number.isInteger(minCases) || minCases < 1 || minCases > 100000) throw new HttpError(422, 'minCases must be a whole number of at least 1');
  if (input?.requireRedTeam === false) throw new HttpError(422, 'The red-team requirement cannot be switched off');
  return store.transaction(async (tx) => {
    const before = await gateConfig(tx);
    const saved = await tx.save('GateConfig', { resourceType: 'GateConfig', id: GATE_ID, minAgreement, minCases, updatedAt: tx.now(), updatedBy: actor.id }, { updatedBy: actor.role });
    await recordAction(tx, {
      actor, kind: 'update', action: 'gate.configure', args: { from: { minAgreement: before.minAgreement, minCases: before.minCases }, to: { minAgreement, minCases } },
      entityRef: `GateConfig/${GATE_ID}`, versionId: saved.meta.versionId, description: `promotion gate set to agreement ≥ ${minAgreement} over ≥ ${minCases} cases`,
    });
    return gateConfig(tx);
  });
}

export const isPromoted = (agent) => agent?.stage === 'hitl' && agent.promotedVersion === agent.version;

/** Evidence for one agent version, and whether it may be promoted. */
export async function evaluateGate(store, agent) {
  const gate = await gateConfig(store);
  const shadow = (await shadowReport(store, { agentId: agent.id, version: agent.version })).agents[0]?.summary ?? null;
  const compared = shadow?.compared ?? 0;
  const agreementRate = shadow?.agreementRate ?? null;
  // Only a whole suite counts: one easy scenario passing must not unlock promotion. A later partial run that fails still blocks.
  const redRuns = (await store.query('Run', { where: (r) => r.mode === 'redteam' && r.agentId === agent.id && r.version === agent.version && r.endedAt && ['suite', 'test-suite'].includes(r.result?.kind) }))
    .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)) || b._seq - a._seq);
  const isCompleteSuite = (r) => Boolean(r.result?.complete || (r.result?.kind === 'test-suite' && r.result?.suite?.id === 'safety-suite'));
  const isPassedSuite = (r) => (r.result?.kind === 'test-suite' ? r.result.failed === 0 : Boolean(r.result?.passed));
  const latest = redRuns.find(isCompleteSuite) ?? null;
  const laterFailure = latest ? redRuns.slice(0, redRuns.indexOf(latest)).find((r) => !isPassedSuite(r)) ?? null : null;
  const redComplete = Boolean(latest);
  const redPassed = Boolean(latest && isPassedSuite(latest)) && !laterFailure;
  const blockers = [];
  if (compared < gate.minCases) blockers.push(`Shadow: ${compared} case${compared === 1 ? '' : 's'} compared with a clinician; at least ${gate.minCases} are required`);
  if (agreementRate == null || agreementRate < gate.minAgreement) blockers.push(`Shadow: agreement is ${agreementRate == null ? 'not measured yet' : `${Math.round(agreementRate * 1000) / 10}%`}; at least ${Math.round(gate.minAgreement * 1000) / 10}% is required`);
  if (!redRuns.length) blockers.push('Red team: no red-team run exists for this version');
  else if (!latest) blockers.push('Red team: no red-team run for this version included every applicable scenario');
  else if (!isPassedSuite(latest)) blockers.push('Red team: the most recent full red-team run for this version did not pass');
  else if (laterFailure) blockers.push('Red team: a scenario failed in a run made after the last full pass');
  if (agent.surveillance?.promotionBlocked) blockers.push(`Surveillance: promotion is blocked (${agent.surveillance.promotionBlocked.reason})`);
  return {
    agentId: agent.id, version: agent.version, gate,
    shadow: { compared, agreementRate, ok: compared >= gate.minCases && agreementRate != null && agreementRate >= gate.minAgreement },
    redTeam: { runId: latest?.id ?? null, endedAt: latest?.endedAt ?? null, runs: redRuns.length, passed: latest ? redPassed : null, complete: redComplete, scenarios: latest?.result?.total ?? latest?.result?.tests ?? null, failed: latest?.result?.failed ?? null, ok: redPassed },
    eligible: blockers.length === 0, blockers, promoted: isPromoted(agent),
  };
}

export async function promote(store, agentId, actor) {
  const agent = await store.get('Agent', agentId);
  if (!agent) throw new HttpError(404, `Agent "${agentId}" is not registered`);
  const evidence = await evaluateGate(store, agent);
  if (!evidence.eligible) {
    await store.transaction((tx) => recordAction(tx, {
      actor, kind: 'execute', action: 'promotion.refused', args: { agent: agent.id, version: agent.version, blockers: evidence.blockers },
      entityRef: `Agent/${agent.id}`, description: `promotion refused for ${agent.id} ${agent.version}: ${evidence.blockers.join('; ')}`, outcome: '4',
    }));
    const err = new HttpError(409, `${agent.name} v${agent.version} cannot be promoted yet. ${evidence.blockers.join('. ')}.`, 'business-rule');
    err.evidence = evidence;
    throw err;
  }
  return store.transaction(async (tx) => {
    const current = await tx.get('Agent', agentId);
    const { _seq, ...doc } = current;
    const record = { version: doc.version, policyHash: doc.policyHash, at: tx.now(), by: actor.id, action: 'promoted', evidence: { shadow: evidence.shadow, redTeam: evidence.redTeam, gate: { minAgreement: evidence.gate.minAgreement, minCases: evidence.gate.minCases } } };
    const saved = await tx.save('Agent', { ...doc, stage: 'hitl', promotedVersion: doc.version, promotions: [...(doc.promotions || []), record] }, { updatedBy: actor.role });
    await recordAction(tx, {
      actor, kind: 'update', action: 'agent.promote', args: { agent: saved.id, version: saved.version, evidence: record.evidence },
      entityRef: `Agent/${saved.id}`, versionId: saved.meta.versionId, description: `agent promoted to human-in-the-loop: ${saved.id} ${saved.version}`,
    });
    return saved;
  });
}

export async function demote(store, agentId, actor, reason) {
  return store.transaction(async (tx) => {
    const current = await tx.get('Agent', agentId);
    if (!current) throw new HttpError(404, `Agent "${agentId}" is not registered`);
    if (current.stage !== 'hitl') return current;
    const { _seq, ...doc } = current;
    const record = { version: doc.version, at: tx.now(), by: actor.id, action: 'demoted', reason: reason ? String(reason).slice(0, 300) : null };
    const saved = await tx.save('Agent', { ...doc, stage: 'shadow', promotedVersion: null, promotions: [...(doc.promotions || []), record] }, { updatedBy: actor.role });
    await recordAction(tx, {
      actor, kind: 'update', action: 'agent.demote', args: { agent: saved.id, version: saved.version }, why: record.reason,
      entityRef: `Agent/${saved.id}`, versionId: saved.meta.versionId, description: `agent returned to shadow: ${saved.id} ${saved.version}`,
    });
    return saved;
  });
}
