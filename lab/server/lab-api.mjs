// /api/lab/**: worklists, the specimen lifecycle, result entry with delta
// checks, verification and auto-verification, critical "phoned to" records,
// quality control and turnaround. Every write runs through
// fhir.writeInTx inside one transaction.
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { enforcedFor, assertMayWrite } from '../../platform/server/roles.mjs';
import { lifecycleOf, MACHINES } from '../../platform/server/state-machines.mjs';
import { mrnOf } from '../../ehr/server/clinical-rules.mjs';
import { isHistologyTask, PATH_URLS } from '../../pathology/server/pathology.mjs';
import { SYSTEMS, LAB_BY_CODE } from '../../ehr/server/catalog.mjs';
import { LAB_URLS, BENCHES, REJECTION_REASONS, TARGET_MINUTES, DELTA_LIMITS, accessionNumber, collectedSpecimen, deltaCheck, autoVerifiable, leveyJennings, isLabOrder, analytesOf, extString, withExt, turnaroundMinutes, criticalFlag, phonedOf } from './lab.mjs';

const MIN = 60000;
const loinc = (o) => (o?.code?.coding || []).find((c) => c.system === SYSTEMS.loinc)?.code ?? null;
const whenOf = (o) => o.effectiveDateTime || o._validAt || o._recordedAt;
const SIGNED = ['final', 'corrected', 'amended'];

export function createLabApi({ store, fhir }) {
  const opts = (ctx) => ({ branch: ctx.branch, asOf: ctx.asOf });
  const log = (tx, ctx, fields) => recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, branch: ctx.branch, ...fields });
  const assertWrite = (ctx, type, interaction, extra) => { if (ctx.asOf) throw new HttpError(409, 'Writes are disabled while viewing a past time'); if (enforcedFor(ctx)) assertMayWrite(ctx.actor.role, type, interaction, extra); };
  const config = async (reader) => (await reader.get('LabConfig', 'default')) || { resourceType: 'LabConfig', id: 'default', autoVerify: [] };
  const patients = async (reader, refs, o) => { const map = new Map(); const unique = [...new Set(refs.filter(Boolean))]; const found = await Promise.all(unique.map((ref) => reader.get('Patient', ref.split('/')[1], o))); unique.forEach((ref, i) => { const p = found[i]; if (p) map.set(ref, { id: p.id, name: `${p.name?.[0]?.family || ''}`.trim(), mrn: mrnOf(p) }); }); return map; };

  const worklistCache = new Map();
  /** The worklist only changes when something is written or a minute passes (the ages), so it is kept until then. */
  async function worklist(ctx, url) {
    const mark = await store.changeMark(['ServiceRequest', 'Specimen', 'Observation', 'Patient', 'Task']);
    const key = `${ctx.branch}|${ctx.asOf ?? ''}|${url.searchParams.toString()}|${Math.floor(Date.parse(ctx.asOf ?? store.now()) / MIN)}`;
    const hit = worklistCache.get(key);
    if (hit && hit.mark === mark) return hit.out;
    const out = await buildWorklist(ctx, url);
    if (worklistCache.size > 50) worklistCache.clear();
    worklistCache.set(key, { mark, out });
    return out;
  }
  async function buildWorklist(ctx, url) {
    const now = ctx.asOf ?? store.now();
    const o = opts(ctx);
    const [orders, specimens, observations] = await Promise.all([store.query('ServiceRequest', { where: isLabOrder }, o), store.query('Specimen', {}, o), store.query('Observation', { where: (x) => (x.category || []).some((c) => (c.coding || []).some((y) => y.code === 'laboratory')) }, o)]);
    const pmap = await patients(store, [...orders.map((x) => x.subject?.reference), ...specimens.map((x) => x.subject?.reference)], o);
    const byOrder = new Map();
    for (const s of specimens) { const ref = s.request?.[0]?.reference; if (ref && lifecycleOf(s) !== 'rejected') byOrder.set(ref, s); }
    const minutesSince = (iso) => Math.round((Date.parse(now) - Date.parse(iso)) / MIN);
    const prio = (p) => ({ stat: 0, urgent: 1, routine: 2 }[p || 'routine'] ?? 2);
    const orderRow = (x) => ({ id: x.id, patient: pmap.get(x.subject?.reference) || null, test: x.code?.text || x.code?.coding?.[0]?.display || 'Lab order', priority: x.priority || 'routine', authoredOn: x.authoredOn || x._recordedAt, ageMinutes: minutesSince(x.authoredOn || x._recordedAt), lifecycle: lifecycleOf(x) });
    const resultsOf = (orderId) => observations.filter((r) => (r.basedOn || []).some((b) => b.reference === `ServiceRequest/${orderId}`) && r.status !== 'cancelled');
    const specRow = (s) => {
      const order = orders.find((x) => `ServiceRequest/${x.id}` === s.request?.[0]?.reference);
      const collected = s.collection?.collectedDateTime || s._recordedAt;
      const target = TARGET_MINUTES[order?.priority || 'routine'];
      return { id: s.id, accession: s.accessionIdentifier?.value || null, state: lifecycleOf(s), bench: extString(s, LAB_URLS.bench), patient: pmap.get(s.subject?.reference) || null, order: order ? orderRow(order) : null, test: order?.code?.text || order?.code?.coding?.[0]?.display || '', priority: order?.priority || 'routine', collectedAt: collected, turnaroundMinutes: minutesSince(collected), targetMinutes: target, overTarget: minutesSince(collected) > target, type: s.type?.text || '', rejection: lifecycleOf(s) === 'rejected' ? extString(s, 'urn:hospital-desktop:status-reason') : null, results: order ? resultsOf(order.id).map((r) => ({ id: r.id, code: loinc(r), status: r.status })) : [] };
    };
    const sortRows = (rows) => rows.sort((a, b) => prio(a.priority) - prio(b.priority) || (a.collectedAt || a.authoredOn || '').localeCompare(b.collectedAt || b.authoredOn || ''));
    const bench = url.searchParams.get('bench');
    const open = orders.filter((x) => ['active', 'results-received'].includes(lifecycleOf(x)));
    const pendingCollection = sortRows(open.filter((x) => !byOrder.has(`ServiceRequest/${x.id}`) && !resultsOf(x.id).length).map(orderRow));
    const rows = specimens.map(specRow);
    const pendingReceipt = sortRows(rows.filter((r) => ['collected', 'in-transit'].includes(r.state)));
    const inProcess = sortRows(rows.filter((r) => ['received', 'in-process'].includes(r.state) && (!bench || r.bench === bench)));
    const awaitingVerification = sortRows([...rows.filter((r) => r.state === 'resulted'), ...open.filter((x) => !byOrder.has(`ServiceRequest/${x.id}`) && resultsOf(x.id).some((r) => r.status === 'preliminary')).map((x) => ({ ...orderRow(x), id: `order:${x.id}`, state: 'resulted', bench: null, orderOnly: true, collectedAt: x.authoredOn }))]);
    const criticals = observations.filter((r) => criticalFlag(r) && SIGNED.includes(r.status) && !phonedOf(r)).map((r) => ({ id: r.id, patient: pmap.get(r.subject?.reference) || null, test: r.code?.coding?.[0]?.display || r.code?.text, value: r.valueQuantity?.value, unit: r.valueQuantity?.unit, flag: r.interpretation?.[0]?.coding?.[0]?.code, at: whenOf(r), acknowledged: Boolean(r._ack) }));
    const verified = rows.filter((r) => ['verified', 'corrected'].includes(r.state));
    const turnaround = {};
    for (const p of ['stat', 'urgent', 'routine']) {
      const mins = verified.filter((r) => r.priority === p).map((r) => { const s = specimens.find((x) => x.id === r.id); return turnaroundMinutes(s, extString(s, 'urn:hospital-desktop:verified-at')); }).filter((m) => m != null);
      turnaround[p] = { count: mins.length, meanMinutes: mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null, withinTargetPercent: mins.length ? Math.round((mins.filter((m) => m <= TARGET_MINUTES[p]).length / mins.length) * 100) : null, targetMinutes: TARGET_MINUTES[p] };
    }
    // Histology requests from pathology sign-out: recuts, levels and additional stains, done by generating a slide.
    const histologyTasks = await store.query('Task', { where: (t) => isHistologyTask(t) && ['requested', 'accepted', 'in-progress', 'ready'].includes(t.status) }, o);
    const cases = histologyTasks.length ? await store.query('Specimen', { where: (s) => (s.extension || []).some((e) => e.url === 'urn:hospital-desktop:specimen-level' && e.valueCode === 'case') }, o) : [];
    const blocks = histologyTasks.length ? await store.query('Specimen', { where: (s) => (s.extension || []).some((e) => e.url === 'urn:hospital-desktop:specimen-level' && e.valueCode === 'block') }, o) : [];
    const hp = await patients(store, histologyTasks.map((t) => t.for?.reference), o);
    const histology = histologyTasks.map((t) => { const caseRef = (t.extension || []).find((e) => e.url === PATH_URLS.caseRef)?.valueReference?.reference; const c = cases.find((x) => `Specimen/${x.id}` === caseRef); const b = blocks.find((x) => `Specimen/${x.id}` === t.focus?.reference); return { id: t.id, kind: t.code?.coding?.[0]?.code, text: t.code?.text, stain: (t.extension || []).find((e) => e.url === PATH_URLS.stain)?.valueCoding?.display || null, caseId: c?.id || null, accession: c?.accessionIdentifier?.value || '', block: b?.id || null, blockLabel: b?.identifier?.[0]?.value || '', patient: hp.get(t.for?.reference) || null, priority: t.priority || 'routine', authoredOn: t.authoredOn || t._recordedAt, status: t.status }; }).sort((a, b) => prio(a.priority) - prio(b.priority) || String(a.authoredOn).localeCompare(String(b.authoredOn)));
    return { status: 200, body: { now, benches: BENCHES, bench: bench || null, pendingCollection, pendingReceipt, inProcess, awaitingVerification, criticals, turnaround, histology, rejectionReasons: REJECTION_REASONS, counts: { pendingCollection: pendingCollection.length, pendingReceipt: pendingReceipt.length, inProcess: inProcess.length, awaitingVerification: awaitingVerification.length, criticals: criticals.length } } };
  }

  async function specimen(id, ctx) {
    const o = opts(ctx);
    const s = await store.get('Specimen', id, o);
    if (!s) throw new HttpError(404, `Specimen/${id} not found`);
    const order = s.request?.[0]?.reference ? await store.get('ServiceRequest', s.request[0].reference.split('/')[1], o) : null;
    const patient = (await patients(store, [s.subject?.reference], o)).get(s.subject?.reference) || null;
    const all = await store.query('Observation', { patient: s.subject?.reference }, o);
    const results = order ? all.filter((r) => (r.basedOn || []).some((b) => b.reference === `ServiceRequest/${order.id}`) && r.status !== 'cancelled') : [];
    const analytes = order ? analytesOf(order) : [];
    const previous = (code) => all.filter((r) => loinc(r) === code && SIGNED.includes(r.status) && !results.some((x) => x.id === r.id)).sort((a, b) => (whenOf(a) < whenOf(b) ? 1 : -1))[0] || null;
    const cfg = await config(store);
    const qc = await Promise.all(analytes.map(async (a) => ({ code: a.code, ...(await qcStatus(a.code, ctx)) })));
    return { status: 200, body: {
      id: s.id, accession: s.accessionIdentifier?.value || null, state: lifecycleOf(s), bench: extString(s, LAB_URLS.bench), type: s.type?.text || '', collectedAt: s.collection?.collectedDateTime || null, collector: s.collection?.collector?.display || null, receivedAt: s.receivedTime || null, rejection: extString(s, 'urn:hospital-desktop:status-reason'), tubeLabel: extString(s, LAB_URLS.tubeLabel), versionId: s.meta?.versionId,
      patient, order: order ? { id: order.id, test: order.code?.text || order.code?.coding?.[0]?.display, priority: order.priority || 'routine', lifecycle: lifecycleOf(order), requester: order.requester?.display || null, authoredOn: order.authoredOn } : null,
      analytes: analytes.map((a) => { const r = results.find((x) => loinc(x) === a.code); const prev = previous(a.code); return { code: a.code, name: a.name, unit: a.unit, low: a.low, high: a.high, critLow: a.critLow, critHigh: a.critHigh, deltaLimit: DELTA_LIMITS[a.code] ?? 0.5, autoVerify: cfg.autoVerify.includes(a.code), previous: prev ? { value: prev.valueQuantity?.value, at: whenOf(prev) } : null, result: r ? { id: r.id, value: r.valueQuantity?.value, status: r.status, flag: r.interpretation?.[0]?.coding?.[0]?.code || null, delta: extString(r, LAB_URLS.delta), enteredBy: extString(r, LAB_URLS.enteredBy), autoVerified: Boolean(extString(r, LAB_URLS.autoVerified)), phoned: phonedOf(r), acknowledged: Boolean(r._ack) } : null }; }),
      qc, deltaLimitsUnverified: true,
    } };
  }

  // ---------- lifecycle ----------
  async function collect(body, ctx) {
    assertWrite(ctx, 'Specimen', 'create');
    const saved = await store.transaction(async (tx) => {
      const order = await tx.get('ServiceRequest', String(body.order || '').split('/').pop(), { branch: ctx.branch });
      if (!order || !isLabOrder(order)) throw new HttpError(404, 'Lab order not found');
      if (!['active', 'results-received'].includes(lifecycleOf(order))) throw new HttpError(409, `The order is ${lifecycleOf(order)}; only active orders can be collected`);
      const patient = await tx.get('Patient', order.subject.reference.split('/')[1], { branch: ctx.branch });
      const failures = [];
      if (String(body.patientScan || '').trim() !== mrnOf(patient)) failures.push(`Wrong patient: the wristband scan "${body.patientScan || ''}" does not match MRN ${mrnOf(patient)}`);
      if (String(body.tubeLabel || '').trim() !== order.id) failures.push(`Wrong tube: the label "${body.tubeLabel || ''}" does not match the order ${order.id}`);
      if (failures.length) throw new HttpError(409, failures.join(' '), 'business-rule', { issues: failures.map((m) => ({ severity: 'error', code: 'business-rule', diagnostics: m })) });
      const existing = (await tx.query('Specimen', { patient: `Patient/${patient.id}` }, { branch: ctx.branch })).filter((s) => s.request?.[0]?.reference === `ServiceRequest/${order.id}` && lifecycleOf(s) !== 'rejected');
      if (existing.length) throw new HttpError(409, `A specimen (${lifecycleOf(existing[0])}) already exists for this order`);
      const doc = collectedSpecimen({ order, patientRef: `Patient/${patient.id}`, collector: ctx.actor.id, now: tx.now(), type: body.type, tubeLabel: String(body.tubeLabel).trim() });
      return (await fhir.writeInTx(tx, 'Specimen', null, doc, ctx, { action: 'specimen.collect' })).saved;
    });
    return { status: 201, body: saved };
  }

  async function move(id, to, body, ctx) {
    assertWrite(ctx, 'Specimen', 'transition');
    const saved = await store.transaction(async (tx) => {
      const current = await tx.get('Specimen', id, { branch: ctx.branch });
      if (!current) throw new HttpError(404, `Specimen/${id} not found`);
      const { _seq, ...doc } = current;
      let next = MACHINES.Specimen.set(doc, to);
      if (to === 'received') {
        const all = await tx.query('Specimen', {}, { branch: ctx.branch });
        next = { ...next, accessionIdentifier: { system: 'urn:hospital-desktop:accession', value: accessionNumber(tx.now(), all) }, receivedTime: tx.now() };
        if (body.bench) { if (!BENCHES.includes(body.bench)) throw new HttpError(422, `bench must be one of ${BENCHES.join(', ')}`); next = withExt(next, LAB_URLS.bench, 'valueString', body.bench); }
      }
      if (to === 'rejected') {
        const reason = String(body.reason || '').trim();
        if (!REJECTION_REASONS.includes(reason)) throw new HttpError(422, `reason must be one of ${REJECTION_REASONS.join(', ')}`);
        next = withExt({ ...next, status: 'unsatisfactory' }, 'urn:hospital-desktop:status-reason', 'valueString', reason);
      }
      const saved = (await fhir.writeInTx(tx, 'Specimen', id, next, ctx, { action: `specimen.${to}` })).saved;
      if (to === 'rejected') {
        const order = saved.request?.[0]?.reference ? await tx.get('ServiceRequest', saved.request[0].reference.split('/')[1], { branch: ctx.branch }) : null;
        await fhir.writeInTx(tx, 'Task', null, {
          resourceType: 'Task', status: 'requested', intent: 'order', priority: order?.priority === 'stat' ? 'stat' : 'urgent', authoredOn: tx.now(), for: { reference: saved._patient }, focus: { reference: `ServiceRequest/${order?.id || ''}` },
          code: { coding: [{ system: 'urn:hospital-desktop:task', code: 'recollect' }], text: `Recollect: ${order?.code?.text || order?.code?.coding?.[0]?.display || 'specimen'} (${body.reason})` }, description: `Specimen ${saved.accessionIdentifier?.value || saved.id} rejected at receipt: ${body.reason}. Collect a new sample.`,
          owner: { display: 'Nurse' }, requester: { display: ctx.actor.id },
        }, ctx, { action: 'specimen.recollect-task' });
      }
      return saved;
    });
    return { status: 200, body: saved };
  }

  // ---------- results ----------
  async function enterResults(id, body, ctx) {
    assertWrite(ctx, 'Observation', 'create');
    const values = body.values && typeof body.values === 'object' ? body.values : {};
    const out = await store.transaction(async (tx) => {
      const s = await tx.get('Specimen', id, { branch: ctx.branch });
      if (!s) throw new HttpError(404, `Specimen/${id} not found`);
      const state = lifecycleOf(s);
      if (!['received', 'in-process', 'resulted'].includes(state)) throw new HttpError(409, `Results can be entered once the specimen is received (it is ${state})`);
      const order = await tx.get('ServiceRequest', s.request[0].reference.split('/')[1], { branch: ctx.branch });
      const analytes = analytesOf(order);
      const all = await tx.query('Observation', { patient: s.subject.reference }, { branch: ctx.branch });
      const existing = all.filter((r) => (r.basedOn || []).some((b) => b.reference === `ServiceRequest/${order.id}`) && r.status !== 'cancelled');
      const cfg = await config(tx);
      const written = [];
      const autoVerified = [];
      for (const [code, raw] of Object.entries(values)) {
        const a = analytes.find((x) => x.code === code);
        if (!a) throw new HttpError(422, `${code} is not part of this order`);
        if (raw === null || raw === '') continue;
        const value = Number(raw);
        if (!Number.isFinite(value)) throw new HttpError(422, `${a.name} must be a number`);
        const prior = existing.find((r) => loinc(r) === code);
        if (prior && SIGNED.includes(prior.status)) throw new HttpError(409, `${a.name} is already verified; correct it with a corrected result instead`);
        const previous = all.filter((r) => loinc(r) === code && SIGNED.includes(r.status) && !existing.some((x) => x.id === r.id)).sort((x, y) => (whenOf(x) < whenOf(y) ? 1 : -1))[0] || null;
        const delta = deltaCheck(code, value, previous);
        let doc = prior ? { ...(({ _seq, ...d }) => d)(prior), valueQuantity: { ...prior.valueQuantity, value } } : {
          resourceType: 'Observation', status: 'preliminary', subject: s.subject, effectiveDateTime: s.collection?.collectedDateTime || tx.now(), issued: tx.now(), basedOn: [{ reference: `ServiceRequest/${order.id}` }], specimen: { reference: `Specimen/${s.id}` }, performer: [{ display: ctx.actor.id }],
          category: [{ coding: [{ system: SYSTEMS.obsCategory, code: 'laboratory' }] }], code: { coding: [{ system: SYSTEMS.loinc, code: a.code, display: a.name }] }, valueQuantity: { value, unit: a.unit, system: 'http://unitsofmeasure.org', code: a.unit },
        };
        delete doc.interpretation;
        doc = withExt(doc, LAB_URLS.delta, 'valueString', delta ? delta.message : null);
        doc = withExt(doc, LAB_URLS.enteredBy, 'valueString', ctx.actor.id);
        let saved = (await fhir.writeInTx(tx, 'Observation', prior ? prior.id : null, doc, ctx, { action: 'lab.result' })).saved;
        if (autoVerifiable(saved, cfg) && !criticalFlag(saved)) {
          const qc = await qcStatus(code, ctx, tx);
          if (!qc.outOfRange) {
            const { _seq, ...d } = saved;
            saved = (await fhir.writeInTx(tx, 'Observation', saved.id, withExt({ ...d, status: 'final' }, LAB_URLS.autoVerified, 'valueString', `rule: in range, no delta flag, not critical, QC in range at ${tx.now()}`), { ...ctx, actor: { kind: 'human', id: 'auto-verification', role: ctx.actor.role } }, { action: 'lab.autoverify' })).saved;
            autoVerified.push(saved.id);
          }
        }
        written.push(saved);
      }
      if (!written.length) throw new HttpError(422, 'Enter at least one value');
      if (state !== 'resulted') {
        const { _seq, ...d } = s;
        await fhir.writeInTx(tx, 'Specimen', s.id, MACHINES.Specimen.set(state === 'received' ? MACHINES.Specimen.set(d, 'in-process') : d, 'resulted'), ctx, { action: 'specimen.resulted' });
      }
      return { written: written.map((r) => ({ id: r.id, code: loinc(r), value: r.valueQuantity.value, status: r.status, flag: r.interpretation?.[0]?.coding?.[0]?.code || null, delta: extString(r, LAB_URLS.delta) })), autoVerified };
    });
    return { status: 201, body: out };
  }

  async function verify(id, body, ctx) {
    assertWrite(ctx, 'Observation', 'transition', { signing: true, categories: ['laboratory'] });
    const out = await store.transaction(async (tx) => {
      const s = await tx.get('Specimen', id, { branch: ctx.branch });
      if (!s) throw new HttpError(404, `Specimen/${id} not found`);
      if (lifecycleOf(s) !== 'resulted') throw new HttpError(409, `Only a resulted specimen can be verified (it is ${lifecycleOf(s)})`);
      const order = await tx.get('ServiceRequest', s.request[0].reference.split('/')[1], { branch: ctx.branch });
      const pending = (await tx.query('Observation', { patient: s.subject.reference }, { branch: ctx.branch })).filter((r) => (r.basedOn || []).some((b) => b.reference === `ServiceRequest/${order.id}`) && r.status === 'preliminary');
      if (!pending.length) throw new HttpError(409, 'There is nothing preliminary to verify');
      const mine = pending.filter((r) => extString(r, LAB_URLS.enteredBy) === ctx.actor.id);
      if (mine.length && ctx.actor.role !== 'administrator') throw new HttpError(409, 'Verification is a second step: the technologist who entered a result cannot verify it');
      for (const code of new Set(pending.map(loinc))) { const qc = await qcStatus(code, ctx, tx); if (qc.outOfRange) throw new HttpError(409, `Quality control for ${LAB_BY_CODE.get(code)?.name || code} is out of range (last z ${qc.lastZ}); results cannot be released until QC passes`); }
      const verified = [];
      for (const r of pending) { const { _seq, ...d } = r; verified.push((await fhir.writeInTx(tx, 'Observation', r.id, { ...d, status: 'final', issued: tx.now(), performer: [...(d.performer || []), { display: ctx.actor.id }] }, ctx, { action: 'lab.verify' })).saved); }
      const { _seq, ...sd } = s;
      await fhir.writeInTx(tx, 'Specimen', s.id, withExt(MACHINES.Specimen.set(sd, 'verified'), 'urn:hospital-desktop:verified-at', 'valueString', tx.now()), ctx, { action: 'specimen.verified' });
      if (body.comment) await log(tx, ctx, { kind: 'execute', action: 'lab.comment', args: { specimen: s.id }, why: String(body.comment).slice(0, 500), entityRef: `Specimen/${s.id}`, patientRef: s.subject.reference, description: 'verification comment', audit: false });
      return { verified: verified.map((r) => ({ id: r.id, code: loinc(r), flag: r.interpretation?.[0]?.coding?.[0]?.code || null, critical: criticalFlag(r) })) };
    });
    return { status: 200, body: out };
  }

  async function correct(id, body, ctx) {
    assertWrite(ctx, 'Observation', 'transition', { signing: true, categories: ['laboratory'] });
    const value = Number(body.value);
    if (!Number.isFinite(value)) throw new HttpError(422, 'value must be a number');
    const saved = await store.transaction(async (tx) => {
      const r = await tx.get('Observation', id, { branch: ctx.branch });
      if (!r || !SIGNED.includes(r.status)) throw new HttpError(409, 'Only a verified result can be corrected');
      const { _seq, ...d } = r;
      const out = (await fhir.writeInTx(tx, 'Observation', id, withExt({ ...d, status: 'corrected', valueQuantity: { ...d.valueQuantity, value } }, 'urn:hospital-desktop:status-reason', 'valueString', String(body.reason || 'corrected')), ctx, { action: 'lab.correct' })).saved;
      const spec = d.specimen?.reference ? await tx.get('Specimen', d.specimen.reference.split('/')[1], { branch: ctx.branch }) : null;
      if (spec && ['verified', 'corrected'].includes(lifecycleOf(spec))) { const { _seq: s2, ...sd } = spec; await fhir.writeInTx(tx, 'Specimen', spec.id, MACHINES.Specimen.set(sd, 'corrected'), ctx, { action: 'specimen.corrected' }); }
      return out;
    });
    return { status: 200, body: saved };
  }

  async function phone(id, body, ctx) {
    assertWrite(ctx, 'Observation', 'update');
    const to = String(body.to || '').trim();
    if (to.length < 2) throw new HttpError(422, 'Who was called is required');
    if (body.readBack !== true) throw new HttpError(422, 'Read-back must be confirmed before a critical value counts as communicated');
    const saved = await store.transaction(async (tx) => {
      const r = await tx.get('Observation', id, { branch: ctx.branch });
      if (!r || !criticalFlag(r)) throw new HttpError(409, 'Only a critical result (HH or LL) is phoned');
      const { _seq, ...d } = r;
      return (await fhir.writeInTx(tx, 'Observation', id, withExt(d, LAB_URLS.phoned, 'valueString', JSON.stringify({ to, by: ctx.actor.id, at: tx.now(), readBack: true })), ctx, { action: 'lab.phone' })).saved;
    });
    return { status: 200, body: { id: saved.id, phoned: phonedOf(saved) } };
  }

  // ---------- auto-verification and QC ----------
  async function autoverify(method, body, ctx) {
    if (method === 'GET') return { status: 200, body: await config(store) };
    assertWrite(ctx, 'Observation', 'transition', { signing: true, categories: ['laboratory'] });
    const list = Array.isArray(body.autoVerify) ? body.autoVerify.map(String) : [];
    for (const code of list) if (!LAB_BY_CODE.has(code)) throw new HttpError(422, `Unknown analyte ${code}`);
    const saved = await store.transaction(async (tx) => {
      const next = await tx.save('LabConfig', { resourceType: 'LabConfig', id: 'default', autoVerify: list }, { updatedBy: ctx.actor.role });
      await log(tx, ctx, { kind: 'update', action: 'lab.autoverify-rules', args: { analytes: list }, entityRef: 'LabConfig/default', description: `auto-verification rules: ${list.join(', ') || 'none'}` });
      return next;
    });
    return { status: 200, body: { autoVerify: saved.autoVerify } };
  }

  async function qcStatus(code, ctx, reader = store) {
    const points = (await reader.query('Observation', { where: (o) => (o.category || []).some((c) => (c.coding || []).some((x) => x.code === 'quality-control')) && loinc(o) === code }, opts(ctx))).sort((a, b) => (whenOf(a) < whenOf(b) ? -1 : 1));
    if (!points.length) return { outOfRange: false, lastZ: null, points: 0 };
    const last = points[points.length - 1];
    const lot = JSON.parse(extString(last, 'urn:hospital-desktop:qc-lot') || '{}');
    const lj = leveyJennings(points.filter((p) => extString(p, 'urn:hospital-desktop:qc-lot') === extString(last, 'urn:hospital-desktop:qc-lot')).map((p) => ({ id: p.id, at: whenOf(p), value: p.valueQuantity?.value, analyser: p.device?.display })), lot);
    return { outOfRange: lj.outOfRange, lastZ: lj.last?.z ?? null, rules: lj.rules, points: points.length, analyser: last.device?.display || null, level: lot.level || null };
  }

  async function qc(method, body, ctx, url) {
    if (method === 'GET') {
      const code = url.searchParams.get('analyte');
      const all = (await store.query('Observation', { where: (o) => (o.category || []).some((c) => (c.coding || []).some((x) => x.code === 'quality-control')) && (!code || loinc(o) === code) }, opts(ctx))).sort((a, b) => (whenOf(a) < whenOf(b) ? -1 : 1));
      const groups = {};
      for (const p of all) { const key = `${loinc(p)}|${p.device?.display || ''}|${extString(p, 'urn:hospital-desktop:qc-lot')}`; (groups[key] = groups[key] || []).push(p); }
      const series = Object.values(groups).map((list) => { const lot = JSON.parse(extString(list[0], 'urn:hospital-desktop:qc-lot') || '{}'); const lj = leveyJennings(list.map((p) => ({ id: p.id, at: whenOf(p), value: p.valueQuantity?.value })), lot); return { analyte: loinc(list[0]), name: LAB_BY_CODE.get(loinc(list[0]))?.name || loinc(list[0]), analyser: list[0].device?.display || '', level: lot.level || '', mean: lot.mean, sd: lot.sd, points: lj.points, rules: lj.rules, outOfRange: lj.outOfRange }; });
      return { status: 200, body: { series, analytes: [...LAB_BY_CODE.values()].map((a) => ({ code: a.code, name: a.name, unit: a.unit })) } };
    }
    assertWrite(ctx, 'Observation', 'create');
    const a = LAB_BY_CODE.get(String(body.analyte || ''));
    if (!a) throw new HttpError(422, 'Unknown analyte');
    for (const k of ['value', 'mean', 'sd']) if (!Number.isFinite(Number(body[k]))) throw new HttpError(422, `${k} must be a number`);
    if (Number(body.sd) <= 0) throw new HttpError(422, 'sd must be positive');
    const saved = await store.transaction(async (tx) => (await fhir.writeInTx(tx, 'Observation', null, {
      resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: 'urn:hospital-desktop:category', code: 'quality-control' }] }], code: { coding: [{ system: SYSTEMS.loinc, code: a.code, display: a.name }], text: `QC: ${a.name}` },
      effectiveDateTime: tx.now(), device: { display: String(body.analyser || 'Analyser 1') }, performer: [{ display: ctx.actor.id }], valueQuantity: { value: Number(body.value), unit: a.unit },
      extension: [{ url: 'urn:hospital-desktop:qc-lot', valueString: JSON.stringify({ level: String(body.level || 'Level 1'), mean: Number(body.mean), sd: Number(body.sd) }) }],
    }, ctx, { action: 'lab.qc' })).saved);
    const status = await qcStatus(a.code, ctx);
    return { status: 201, body: { id: saved.id, ...status } };
  }

  return {
    async handle(req, url, body, ctx) {
      const parts = url.pathname.split('/').filter(Boolean).slice(2);
      const m = req.method;
      if (parts[0] === 'worklist' && m === 'GET') return worklist(ctx, url);
      if (parts[0] === 'specimens') {
        if (parts[1] === 'collect' && m === 'POST') return collect(body || {}, ctx);
        if (parts[1] && !parts[2] && m === 'GET') return specimen(parts[1], ctx);
        if (parts[1] && m === 'POST') {
          if (['in-transit', 'received', 'in-process', 'rejected'].includes(parts[2])) return move(parts[1], parts[2], body || {}, ctx);
          if (parts[2] === 'results') return enterResults(parts[1], body || {}, ctx);
          if (parts[2] === 'verify') return verify(parts[1], body || {}, ctx);
        }
      }
      if (parts[0] === 'results' && parts[1] && m === 'POST') { if (parts[2] === 'phone') return phone(parts[1], body || {}, ctx); if (parts[2] === 'correct') return correct(parts[1], body || {}, ctx); }
      if (parts[0] === 'autoverify') return autoverify(m, body || {}, ctx);
      if (parts[0] === 'qc') return qc(m, body || {}, ctx, url);
      throw new HttpError(404, `${m} ${url.pathname} is not available`);
    },
  };
}
