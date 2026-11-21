// /api/rpm/**: enrolment, readings (portal, device gateway, simulated feed),
// the rules engine, alerts and the monitoring dashboard.
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction, LIVE_RUN_ID } from '../../platform/server/audit.mjs';
import { enforcedFor, assertMayWrite, mayWrite, refusal } from '../../platform/server/roles.mjs';
import { mrnOf } from './clinical-rules.mjs';
import { PROGRAMMES, READINGS, DEVICES, RPM_PLAN_CATEGORY, RPM_URLS, isHomeReading, isRpmPlan, isRpmAlert, programmeOf, scheduleOf, keyOf, whenOf, thresholdGoals, thresholdsOf, plausibility, readingObservation, evaluate, adherence, duplicateOf, alertTask, SEVERITY } from './rpm.mjs';

const ext = (doc, url) => (doc?.extension || []).find((e) => e.url === url)?.valueString ?? null;
const withExt = (doc, url, value) => ({ ...doc, extension: [...(doc.extension || []).filter((e) => e.url !== url), ...(value == null ? [] : [{ url, valueString: value }])] });
const OPEN = ['requested', 'ready', 'accepted', 'in-progress'];
const SEV_RANK = { stat: 0, urgent: 1, routine: 2 };

export function createRpmApi({ store, fhir }) {
  const opts = (ctx) => ({ branch: ctx.branch, asOf: ctx.asOf });
  const log = (tx, ctx, fields) => recordAction(tx, { runId: ctx.runId ?? LIVE_RUN_ID, actor: ctx.actor, branch: ctx.branch, ...fields });
  const assertWrite = (ctx, type, interaction, extra) => { if (ctx.asOf) throw new HttpError(409, 'Writes are disabled while viewing a past time'); if (enforcedFor(ctx)) assertMayWrite(ctx.actor.role, type, interaction, extra); };

  async function activePlan(reader, patientRef, o) { return (await reader.query('CarePlan', { patient: patientRef, where: (p) => isRpmPlan(p) && p.status === 'active' }, o)).sort((a, b) => (a._recordedAt < b._recordedAt ? 1 : -1))[0] || null; }
  async function patientData(reader, patientRef, o, now) {
    const plan = await activePlan(reader, patientRef, o);
    const [goals, readings, tasks, devices] = await Promise.all([reader.query('Goal', { patient: patientRef, where: (g) => (g.category || []).some((c) => (c.coding || []).some((x) => x.code === 'rpm')) }, o), reader.query('Observation', { patient: patientRef, where: isHomeReading }, o), reader.query('Task', { patient: patientRef, where: isRpmAlert }, o), reader.query('Device', { patient: patientRef }, o)]);
    const planGoals = plan ? goals.filter((g) => (plan.goal || []).some((r) => r.reference === `Goal/${g.id}`)) : [];
    const sorted = readings.filter((r) => r.status !== 'cancelled').sort((a, b) => (whenOf(a) < whenOf(b) ? -1 : 1));
    const latest = {};
    for (const r of sorted) { const k = keyOf(r); if (k) latest[k] = { value: r.valueQuantity?.value, at: whenOf(r), flag: ext(r, RPM_URLS.plausibility) }; }
    const series = {};
    for (const r of sorted.slice(-400)) { const k = keyOf(r); if (k) (series[k] = series[k] || []).push({ at: whenOf(r), value: r.valueQuantity?.value, flag: ext(r, RPM_URLS.plausibility) }); }
    return { plan, goals: planGoals, thresholds: thresholdsOf(planGoals), readings: sorted, latest, series, alerts: tasks.sort((a, b) => SEV_RANK[a.priority || 'routine'] - SEV_RANK[b.priority || 'routine'] || (a.authoredOn || '').localeCompare(b.authoredOn || '')), devices, adherence: plan ? adherence({ schedule: scheduleOf(plan), readings: sorted, now }) : null };
  }

  // ---------- enrolment ----------
  async function enrol(body, ctx) {
    assertWrite(ctx, 'CarePlan', 'create');
    // Enrolment is a physician's decision: the roles that place orders may enrol.
    if (enforcedFor(ctx) && !mayWrite(ctx.actor.role, 'ServiceRequest', 'create')) throw refusal(ctx.actor.role, 'ServiceRequest', 'create');
    const programme = String(body.programme || '');
    if (!PROGRAMMES[programme]) throw new HttpError(422, `programme must be one of ${Object.keys(PROGRAMMES).join(', ')}`);
    const patientId = String(body.patient || '').split('/').pop();
    const out = await store.transaction(async (tx) => {
      const patient = await tx.get('Patient', patientId, { branch: ctx.branch });
      if (!patient) throw new HttpError(404, `Patient/${patientId} not found`);
      const ref = `Patient/${patient.id}`;
      if (await activePlan(tx, ref, { branch: ctx.branch })) throw new HttpError(409, 'This patient is already enrolled; end the current programme first');
      const spec = PROGRAMMES[programme];
      const deviceKinds = Array.isArray(body.devices) && body.devices.length ? body.devices : spec.devices;
      const devices = [];
      for (const kind of deviceKinds) {
        if (!DEVICES[kind]) throw new HttpError(422, `Unknown device "${kind}". Known: ${Object.keys(DEVICES).join(', ')}`);
        devices.push((await fhir.writeInTx(tx, 'Device', null, { resourceType: 'Device', status: 'active', patient: { reference: ref }, type: { coding: [{ system: 'urn:hospital-desktop:device', code: kind, display: DEVICES[kind] }], text: DEVICES[kind] }, deviceName: [{ name: `${DEVICES[kind]} (home)`, type: 'user-friendly-name' }], serialNumber: `SIM-${kind}-${patient.id.slice(0, 6)}` }, ctx, { action: 'rpm.device' })).saved);
      }
      const goals = [];
      for (const g of thresholdGoals(programme, ref, body.thresholds || {})) goals.push((await fhir.writeInTx(tx, 'Goal', null, g, ctx, { action: 'rpm.threshold' })).saved);
      const schedule = body.schedule && typeof body.schedule === 'object' ? body.schedule : spec.schedule;
      const plan = (await fhir.writeInTx(tx, 'CarePlan', null, {
        resourceType: 'CarePlan', status: 'active', intent: 'plan', title: `Remote monitoring: ${spec.label}`, category: [{ coding: [RPM_PLAN_CATEGORY] }], subject: { reference: ref }, created: tx.now(), author: { display: ctx.actor.id }, period: { start: tx.now() },
        goal: goals.map((g) => ({ reference: `Goal/${g.id}` })), activity: devices.map((d) => ({ detail: { status: 'in-progress', description: `${d.type.text}: readings as scheduled`, reasonReference: [{ reference: `Device/${d.id}` }] } })),
        extension: [{ url: RPM_URLS.programme, valueString: programme }, { url: RPM_URLS.schedule, valueString: JSON.stringify(schedule) }],
      }, ctx, { action: 'rpm.enrol' })).saved;
      return { plan: plan.id, devices: devices.map((d) => ({ id: d.id, kind: d.type.coding[0].code })), goals: goals.map((g) => g.id), thresholds: thresholdsOf(goals), schedule };
    });
    return { status: 201, body: out };
  }

  async function endProgramme(planId, body, ctx) {
    assertWrite(ctx, 'CarePlan', 'transition');
    const saved = await store.transaction(async (tx) => {
      const plan = await tx.get('CarePlan', planId, { branch: ctx.branch });
      if (!plan || !isRpmPlan(plan)) throw new HttpError(404, 'Programme not found');
      const { _seq, ...d } = plan;
      return (await fhir.writeInTx(tx, 'CarePlan', planId, { ...d, status: 'completed', period: { ...(d.period || {}), end: tx.now() }, note: [...(d.note || []), { time: tx.now(), text: `Ended: ${String(body.reason || 'completed').slice(0, 200)}` }] }, ctx, { action: 'rpm.end' })).saved;
    });
    return { status: 200, body: { id: saved.id, status: saved.status } };
  }

  async function adjust(goalId, body, ctx) {
    assertWrite(ctx, 'Goal', 'update');
    const saved = await store.transaction(async (tx) => {
      const g = await tx.get('Goal', goalId, { branch: ctx.branch });
      if (!g) throw new HttpError(404, 'Goal not found');
      const { _seq, ...d } = g;
      const unit = d.target[0].detailRange?.low?.unit || d.target[0].detailRange?.high?.unit || '';
      const range = { ...(body.low != null && body.low !== '' ? { low: { value: Number(body.low), unit } } : {}), ...(body.high != null && body.high !== '' ? { high: { value: Number(body.high), unit } } : {}) };
      if (!Object.keys(range).length) throw new HttpError(422, 'Give a low or a high limit');
      return (await fhir.writeInTx(tx, 'Goal', goalId, { ...d, description: { text: `${d.target[0].measure?.coding?.[0]?.display || 'Reading'}: ${range.low?.value ?? 'any'} to ${range.high?.value ?? 'any'} ${unit}` }, target: [{ ...d.target[0], detailRange: range }] }, ctx, { action: 'rpm.threshold' })).saved;
    });
    return { status: 200, body: saved };
  }

  // ---------- readings ----------
  /** Records one reading, runs the rules and opens alerts (de-duplicated). source: portal, device-gateway, feed. */
  /** Alerts from readings already in the chart (wearable batches, task 13): the usual thresholds and rules, as if the readings had arrived one by one. */
  async function alertsFromReadings(tx, { patientRef, branch, run = null, since = null }) {
    const ctx = { actor: { kind: 'human', id: 'timeline', role: 'system' }, branch, run, runId: run?.id ?? null, asOf: null, why: null, idempotencyKey: null };
    const plan = await activePlan(tx, patientRef, { branch });
    if (!plan) return [];
    const readings = (await tx.query('Observation', { patient: patientRef, where: isHomeReading }, { branch })).sort((a, b) => (whenOf(a) < whenOf(b) ? -1 : 1));
    const goals = (await tx.query('Goal', { patient: patientRef }, { branch })).filter((g) => (plan.goal || []).some((r) => r.reference === `Goal/${g.id}`));
    // As if the readings had arrived one by one: evaluate after each new reading, at that reading's time.
    const fresh = since ? readings.filter((o) => Date.parse(whenOf(o)) >= Date.parse(since)) : readings.slice(-1);
    const open = await tx.query('Task', { patient: patientRef, where: (t) => isRpmAlert(t) && OPEN.includes(t.status) }, { branch });
    const opened = [];
    for (const r of fresh.slice(0, 400)) {
      const upTo = readings.filter((o) => Date.parse(whenOf(o)) <= Date.parse(whenOf(r)));
      const alerts = evaluate({ programme: programmeOf(plan), thresholds: thresholdsOf(goals), readings: upTo, now: whenOf(r) });
      for (const a of alerts) {
        if (duplicateOf(a, open, whenOf(r))) continue;
        const task = (await fhir.writeInTx(tx, 'Task', null, alertTask({ patientRef, planRef: `CarePlan/${plan.id}`, alert: a, now: whenOf(r) }), ctx, { action: 'rpm.alert' })).saved;
        opened.push({ id: task.id, rule: a.rule, severity: a.severity, message: a.message, at: whenOf(r) }); open.push(task);
      }
    }
    return opened;
  }

  async function record(tx, { patientRef, key, value, at, device, source, ctx }) {
    const plan = await activePlan(tx, patientRef, { branch: ctx.branch });
    const readings = (await tx.query('Observation', { patient: patientRef, where: isHomeReading }, { branch: ctx.branch })).sort((a, b) => (whenOf(a) < whenOf(b) ? -1 : 1));
    const prev = readings.filter((o) => keyOf(o) === key).pop();
    const check = plausibility(key, Number(value), prev ? { value: prev.valueQuantity?.value, at: whenOf(prev) } : null, tx.now());
    if (!check.ok) throw new HttpError(422, check.refuse, 'business-rule');
    let deviceRef = null;
    if (device) { const d = await tx.get('Device', String(device).split('/').pop(), { branch: ctx.branch }); if (!d || d.patient?.reference !== patientRef) throw new HttpError(422, 'Unknown device for this patient'); deviceRef = `Device/${d.id}`; }
    else { const kind = READINGS[key].device; const d = (await tx.query('Device', { patient: patientRef }, { branch: ctx.branch })).find((x) => x.type?.coding?.[0]?.code === kind); if (d) deviceRef = `Device/${d.id}`; }
    const saved = (await fhir.writeInTx(tx, 'Observation', null, readingObservation({ patientRef, key, value: Number(value), at, deviceRef, source, flag: check.flag, planRef: plan ? `CarePlan/${plan.id}` : null }), ctx, { action: 'rpm.reading' })).saved;
    const opened = [];
    if (plan && !check.flag) {
      const goals = (await tx.query('Goal', { patient: patientRef }, { branch: ctx.branch })).filter((g) => (plan.goal || []).some((r) => r.reference === `Goal/${g.id}`));
      const alerts = evaluate({ programme: programmeOf(plan), thresholds: thresholdsOf(goals), readings: [...readings, saved], now: tx.now() });
      const open = (await tx.query('Task', { patient: patientRef, where: (t) => isRpmAlert(t) && OPEN.includes(t.status) }, { branch: ctx.branch }));
      for (const a of alerts) {
        if (duplicateOf(a, open, tx.now())) continue;
        const task = (await fhir.writeInTx(tx, 'Task', null, alertTask({ patientRef, planRef: `CarePlan/${plan.id}`, alert: a, now: tx.now() }), ctx, { action: 'rpm.alert' })).saved;
        opened.push({ id: task.id, rule: a.rule, severity: a.severity, message: a.message });
        open.push(task);
      }
    }
    return { reading: { id: saved.id, key, value: Number(value), at: saved.effectiveDateTime, flag: check.flag }, alerts: opened };
  }

  async function postReading(body, ctx, source, person = null) {
    assertWrite(ctx, 'Observation', 'create', { categories: ['home-reading'] });
    const key = String(body.key || '');
    if (!READINGS[key]) throw new HttpError(422, `key must be one of ${Object.keys(READINGS).join(', ')}`);
    const at = body.at ? new Date(body.at).toISOString() : store.now();
    if (Number.isNaN(Date.parse(at))) throw new HttpError(422, 'at must be a date-time');
    const out = await store.transaction(async (tx) => {
      const id = String(body.patient || '').split('/').pop();
      let patient = await tx.get('Patient', id, { branch: ctx.branch });
      if (!patient) patient = (await tx.query('Patient', {}, { branch: ctx.branch })).find((p) => mrnOf(p) === id) || null;
      if (!patient) throw new HttpError(404, `Patient "${id}" not found (id or MRN)`);
      const ownPatient = person?.patientId === patient.id || ctx.actor.id === `Patient/${patient.id}` || ctx.actor.id === 'patient';
      if (ctx.actor.role === 'patient' && !ownPatient) throw new HttpError(403, 'A patient records only their own readings');
      return record(tx, { patientRef: `Patient/${patient.id}`, key, value: body.value, at, device: body.device || null, source, ctx });
    });
    return { status: 201, body: out };
  }

  // ---------- alerts ----------
  async function act(taskId, action, body, ctx) {
    assertWrite(ctx, 'Task', 'transition');
    const out = await store.transaction(async (tx) => {
      const t = await tx.get('Task', taskId, { branch: ctx.branch });
      if (!t || !isRpmAlert(t)) throw new HttpError(404, 'Alert not found');
      const { _seq, ...d } = t;
      const now = tx.now();
      const minutes = Math.round((Date.parse(now) - Date.parse(d.authoredOn)) / 60000);
      let next = d; let extra = {};
      if (action === 'acknowledge') { if (!OPEN.includes(d.status)) throw new HttpError(409, 'This alert is closed'); next = withExt({ ...d, status: 'accepted' }, RPM_URLS.acknowledged, JSON.stringify({ by: ctx.actor.id, at: now, minutes })); extra = { minutes }; }
      else if (action === 'snooze') { const reason = String(body.reason || '').trim(); if (reason.length < 3) throw new HttpError(422, 'A snooze needs a reason'); const until = new Date(Date.parse(now) + Math.max(1, Number(body.hours || 24)) * 3600000).toISOString(); next = withExt(withExt({ ...d, status: 'accepted' }, RPM_URLS.snoozed, until), RPM_URLS.acknowledged, ext(d, RPM_URLS.acknowledged) || JSON.stringify({ by: ctx.actor.id, at: now, minutes })); next.note = [...(d.note || []), { time: now, text: `Snoozed until ${until}: ${reason}` }]; extra = { until, reason }; }
      else if (action === 'escalate') { next = { ...d, status: 'in-progress', priority: 'stat', owner: { display: 'Physician' }, note: [...(d.note || []), { time: now, text: `Escalated by ${ctx.actor.id}${body.reason ? `: ${body.reason}` : ''}` }] }; extra = { reason: body.reason || null }; }
      else if (action === 'call') { const to = String(body.to || 'patient'); next = { ...(OPEN.includes(d.status) && d.status === 'requested' ? withExt({ ...d, status: 'accepted' }, RPM_URLS.acknowledged, JSON.stringify({ by: ctx.actor.id, at: now, minutes })) : d), note: [...(d.note || []), { time: now, text: `Called ${to}: ${String(body.note || '').slice(0, 300)}` }] }; extra = { to, note: body.note || null }; }
      else if (action === 'close') { const outcome = String(body.outcome || '').trim(); if (!outcome) throw new HttpError(422, 'An outcome is required to close an alert'); next = withExt({ ...d, status: 'completed', output: [{ type: { text: 'outcome' }, valueString: outcome }] }, RPM_URLS.outcome, outcome); extra = { outcome }; }
      else throw new HttpError(404, `Unknown alert action ${action}`);
      const saved = (await fhir.writeInTx(tx, 'Task', taskId, next, ctx, { action: `rpm.${action}` })).saved;
      let message = null;
      if (action === 'message') { /* handled below */ }
      return { id: saved.id, status: saved.status, priority: saved.priority, ...extra, message };
    });
    return { status: 200, body: out };
  }

  async function message(taskId, body, ctx) {
    assertWrite(ctx, 'Communication', 'create');
    const text = String(body.text || '').trim();
    if (!text) throw new HttpError(422, 'Message text is required');
    const saved = await store.transaction(async (tx) => {
      const t = await tx.get('Task', taskId, { branch: ctx.branch });
      if (!t || !isRpmAlert(t)) throw new HttpError(404, 'Alert not found');
      const c = (await fhir.writeInTx(tx, 'Communication', null, { resourceType: 'Communication', status: 'completed', subject: t.for, recipient: [t.for], sender: { display: ctx.actor.id }, sent: tx.now(), topic: { text: 'About your home readings' }, about: [{ reference: `Task/${t.id}` }], payload: [{ contentString: text }] }, ctx, { action: 'rpm.message' })).saved;
      const { _seq, ...d } = t;
      await fhir.writeInTx(tx, 'Task', taskId, { ...d, status: OPEN.includes(d.status) ? 'accepted' : d.status, note: [...(d.note || []), { time: tx.now(), text: `Messaged the patient: ${text.slice(0, 120)}` }] }, ctx, { action: 'rpm.message' });
      return c;
    });
    return { status: 201, body: { id: saved.id } };
  }

  // ---------- views ----------
  async function dashboard(ctx) {
    const now = ctx.asOf ?? store.now();
    const o = opts(ctx);
    const plans = await store.query('CarePlan', { where: (p) => isRpmPlan(p) && p.status === 'active' }, o);
    const rows = [];
    for (const plan of plans) {
      const patient = await store.get('Patient', plan.subject.reference.split('/')[1], o);
      if (!patient) continue;
      const d = await patientData(store, plan.subject.reference, o, now);
      const open = d.alerts.filter((t) => OPEN.includes(t.status));
      rows.push({ patient: { id: patient.id, name: `${patient.name?.[0]?.family || ''}`.trim(), mrn: mrnOf(patient) }, plan: plan.id, programme: programmeOf(plan), programmeLabel: PROGRAMMES[programmeOf(plan)]?.label || programmeOf(plan), latest: d.latest, series: Object.fromEntries(Object.entries(d.series).map(([k, v]) => [k, v.slice(-14)])), adherence: d.adherence, openAlerts: open.length, topSeverity: open[0]?.priority || null, snoozed: open.filter((t) => ext(t, RPM_URLS.snoozed) && ext(t, RPM_URLS.snoozed) > now).length });
    }
    rows.sort((a, b) => SEV_RANK[a.topSeverity || 'zzz'] - SEV_RANK[b.topSeverity || 'zzz'] || b.openAlerts - a.openAlerts || a.patient.name.localeCompare(b.patient.name));
    const alerts = (await store.query('Task', { where: (t) => isRpmAlert(t) && OPEN.includes(t.status) }, o)).map((t) => ({ id: t.id, patient: rows.find((r) => `Patient/${r.patient.id}` === t.for?.reference)?.patient || null, priority: t.priority, severity: Object.entries(SEVERITY).find(([, v]) => v === t.priority)?.[0] || 'low', message: t.code?.text, rule: ext(t, RPM_URLS.rule), at: t.authoredOn, status: t.status, acknowledged: ext(t, RPM_URLS.acknowledged) ? JSON.parse(ext(t, RPM_URLS.acknowledged)) : null, snoozedUntil: ext(t, RPM_URLS.snoozed) })).sort((a, b) => SEV_RANK[a.priority] - SEV_RANK[b.priority] || (a.at || '').localeCompare(b.at || ''));
    const acked = (await store.query('Task', { where: (t) => isRpmAlert(t) && ext(t, RPM_URLS.acknowledged) }, o)).map((t) => JSON.parse(ext(t, RPM_URLS.acknowledged)).minutes).filter((m) => typeof m === 'number');
    const missed = rows.filter((r) => r.adherence?.missed).map((r) => ({ patient: r.patient, missedDays: r.adherence.missedDays }));
    return { status: 200, body: { now, programmes: Object.entries(PROGRAMMES).map(([id, p]) => ({ id, label: p.label, devices: p.devices, schedule: p.schedule, thresholds: p.thresholds })), devices: DEVICES, readings: READINGS, rows, alerts, missed, timeToAcknowledge: { count: acked.length, meanMinutes: acked.length ? Math.round(acked.reduce((a, b) => a + b, 0) / acked.length) : null, medianMinutes: acked.length ? acked.sort((a, b) => a - b)[Math.floor(acked.length / 2)] : null } } };
  }

  async function patientView(patientId, ctx) {
    const now = ctx.asOf ?? store.now();
    const o = opts(ctx);
    const patient = await store.get('Patient', patientId, o);
    if (!patient) throw new HttpError(404, `Patient/${patientId} not found`);
    const d = await patientData(store, `Patient/${patient.id}`, o, now);
    return { status: 200, body: { now, patient: { id: patient.id, name: `${patient.name?.[0]?.family || ''}`.trim(), mrn: mrnOf(patient) }, enrolled: Boolean(d.plan), plan: d.plan ? { id: d.plan.id, programme: programmeOf(d.plan), label: PROGRAMMES[programmeOf(d.plan)]?.label || programmeOf(d.plan), since: d.plan.period?.start, schedule: scheduleOf(d.plan) } : null, thresholds: d.thresholds, devices: d.devices.map((x) => ({ id: x.id, kind: x.type?.coding?.[0]?.code, name: x.type?.text })), latest: d.latest, series: d.series, adherence: d.adherence, alerts: d.alerts.map((t) => ({ id: t.id, status: t.status, priority: t.priority, message: t.code?.text, rule: ext(t, RPM_URLS.rule), at: t.authoredOn, acknowledged: ext(t, RPM_URLS.acknowledged) ? JSON.parse(ext(t, RPM_URLS.acknowledged)) : null, snoozedUntil: ext(t, RPM_URLS.snoozed), outcome: ext(t, RPM_URLS.outcome), notes: (t.note || []).map((n) => n.text) })), readingKinds: READINGS, programmes: Object.fromEntries(Object.entries(PROGRAMMES).map(([k, v]) => [k, v.label])) } };
  }

  return {
    alertsFromReadings,
    record,
    async handle(req, url, body, ctx) {
      const parts = url.pathname.split('/').filter(Boolean).slice(2);
      const m = req.method;
      if (parts[0] === 'dashboard' && m === 'GET') return dashboard(ctx);
      if (parts[0] === 'patients' && parts[1] && m === 'GET') return patientView(parts[1], ctx);
      if (parts[0] === 'enrol' && m === 'POST') return enrol(body || {}, ctx);
      if (parts[0] === 'programmes' && parts[1] && parts[2] === 'end' && m === 'POST') return endProgramme(parts[1], body || {}, ctx);
      if (parts[0] === 'thresholds' && parts[1] && m === 'PUT') return adjust(parts[1], body || {}, ctx);
      if (parts[0] === 'readings' && m === 'POST') return postReading(body || {}, ctx, ctx.actor.role === 'patient' ? 'portal' : 'device-gateway', req.person || null);
      if (parts[0] === 'alerts' && parts[1] && m === 'POST') { if (parts[2] === 'message') return message(parts[1], body || {}, ctx); return act(parts[1], parts[2], body || {}, ctx); }
      throw new HttpError(404, `${m} ${url.pathname} is not available`);
    },
  };
}
