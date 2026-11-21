// The interoperability layer: what outside software uses to connect to the platform as to a hospital system.
// SMART App Launch, terminology operations, Bulk Data, Subscriptions, the R5 face, IPS, the MPI (PIXm and PDQm),
// and Consent for app access. Each piece is in its own file; this one routes.
import { HttpError, readJson } from '../../platform/server/http.mjs';
import { createUdap } from './udap.mjs';
import { narrate } from './narrative.mjs';
import { createConsent } from './consent.mjs';
import { createSmart } from './smart.mjs';
import { handleTerminology } from './terminology.mjs';
import { createBulk } from './bulk.mjs';
import { createSubscriptions } from './subscriptions.mjs';
import { toR4 } from './r5.mjs';
import { mrnOf } from '../../ehr/server/clinical-rules.mjs';
import { withoutJudgements } from '../../platform/server/fhir-api.mjs';

const LOINC = 'http://loinc.org';
// IPS sections (International Patient Summary IG 1.1): LOINC code, title, the resources that fill it.
const IPS_SECTIONS = [['48765-2', 'Allergies and intolerances', ['AllergyIntolerance'], true], ['10160-0', 'Medication summary', ['MedicationRequest', 'MedicationStatement'], true], ['11450-4', 'Problem list', ['Condition'], true], ['11369-6', 'History of immunizations', ['Immunization']], ['47519-4', 'History of procedures', ['Procedure']], ['30954-2', 'Diagnostic results', ['Observation', 'DiagnosticReport'], false, (r) => r.resourceType !== 'Observation' || (r.category || []).some((c) => (c.coding || []).some((x) => x.code === 'laboratory'))], ['8716-3', 'Vital signs', ['Observation'], false, (r) => (r.category || []).some((c) => (c.coding || []).some((x) => x.code === 'vital-signs'))]];
const IPS_DISPLAY = { '48765-2': 'Allergies and adverse reactions Document', '10160-0': 'History of Medication use Narrative', '11450-4': 'Problem list - Reported', '11369-6': 'History of Immunization Narrative', '47519-4': 'History of Procedures Document', '30954-2': 'Relevant diagnostic tests/laboratory data Narrative', '8716-3': 'Vital signs' };
const ABSENT = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
const NONE = { '48765-2': (id, sub) => ({ resourceType: 'AllergyIntolerance', id: `${id}-no-allergy-info`, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] }, code: { coding: [{ system: ABSENT, code: 'no-allergy-info', display: 'No information about allergies' }] }, patient: sub }), '10160-0': (id, sub) => ({ resourceType: 'MedicationStatement', id: `${id}-no-medication-info`, status: 'unknown', medicationCodeableConcept: { coding: [{ system: ABSENT, code: 'no-medication-info', display: 'No information about medications' }] }, subject: sub, effectiveDateTime: new Date().toISOString().slice(0, 10) }), '11450-4': (id, sub) => ({ resourceType: 'Condition', id: `${id}-no-problem-info`, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code: { coding: [{ system: ABSENT, code: 'no-problem-info', display: 'No information about problems' }] }, subject: sub }) };
const clean = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !k.startsWith('_')));
async function rawBody(req) { if (req._raw !== undefined) return req._raw; const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 1e6) throw new HttpError(413, 'Request body too large'); chunks.push(c); } req._raw = Buffer.concat(chunks).toString('utf8'); return req._raw; }

export function createInterop({ store, fhir }) {
  let base = ''; const baseUrl = () => base;
  const smart = createSmart({ store, baseUrl }); const udap = createUdap({ store, smart, baseUrl }); const bulk = createBulk({ store, baseUrl }); const subs = createSubscriptions({ store, baseUrl });
  const setBase = (req) => { const pub = String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_ORIGINS || '').split(',')[0].trim().replace(/\/$/, ''); base = pub || `${req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http')}://${req.headers['x-forwarded-host'] || req.headers.host}`; };

  /** Before any session check: discovery, the token endpoint and introspection (an app has no session). Returns null when the path is not one of these. */
  async function open(req, url) {
    setBase(req); const p = url.pathname;
    if (p === '/.well-known/smart-configuration' || p === '/fhir/R4/.well-known/smart-configuration' || p === '/fhir/R5/.well-known/smart-configuration') return { status: 200, body: smart.configuration() };
    if (p === '/.well-known/jwks.json') return { status: 200, body: smart.jwks() };
    if (p === '/.well-known/udap' || p === '/fhir/R4/.well-known/udap' || p === '/fhir/R5/.well-known/udap') { try { return { status: 200, body: udap.metadata() }; } catch (err) { return { status: err.status || 400, body: { error: err.code || 'invalid_request', error_description: err.message } }; } }
    if (p === '/oauth/udap/register' && req.method === 'POST') { const text = await rawBody(req); try { const out = await udap.register(JSON.parse(text || '{}')); return { ...out, headers: { 'Cache-Control': 'no-store' } }; } catch (err) { return { status: err.status || 400, body: { error: err.code || 'invalid_client_metadata', error_description: err.message } }; } }
    if ((p === '/oauth/token' || p === '/oauth/introspect') && req.method === 'POST') {
      const text = await rawBody(req); const body = String(req.headers['content-type'] || '').includes('json') ? JSON.parse(text || '{}') : Object.fromEntries(new URLSearchParams(text));
      try { return { status: 200, body: p === '/oauth/token' ? (String(body.udap) === '1' ? await udap.token(body) : await smart.token(body, req.headers)) : await smart.introspect(body), headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } }; } catch (err) { return { status: err.status || 400, body: { error: err.code || 'invalid_request', error_description: err.message } }; }
    }
    return null;
  }
  /** After the session (or app token) is known. Returns null when the path is not handled here. */
  async function handle(req, url, ctx, res) {
    setBase(req); const p = url.pathname; const m = req.method; const person = req.person || null;
    if (p === '/oauth/authorize') { const out = await smart.authorize(url.searchParams, person); res.writeHead(302, { Location: out.redirect, 'Cache-Control': 'no-store' }); res.end(); return { done: true }; }
    if (p === '/oauth/register' && m === 'POST') return { status: 201, body: await smart.register(await readJson(req), person) };
    if (p === '/oauth/launch' && m === 'POST') return { status: 200, body: smart.launch(await readJson(req), person) };
    if (p === '/fhir/SubscriptionTopic' || p.startsWith('/fhir/SubscriptionTopic/') || p === '/fhir/R5/SubscriptionTopic' || p.startsWith('/fhir/R5/SubscriptionTopic/')) { const id = p.split('/').pop(); const all = subs.topicResources(); if (id === 'SubscriptionTopic') return { status: 200, body: { resourceType: 'Bundle', type: 'searchset', total: all.length, entry: all.map((r) => ({ fullUrl: r.url, resource: r })) } }; const one = all.find((t) => t.id === id); if (!one) throw new HttpError(404, 'No such topic', 'not-found'); return { status: 200, body: one }; }
    if (!/^\/fhir\/R4\//.test(p)) return null;
    const parts = p.split('/').filter(Boolean).slice(2); const op = parts.find((x) => x.startsWith('$')); const type = parts[0];
    // Terminology
    if (op && ['CodeSystem', 'ValueSet', 'ConceptMap'].includes(type) && (m === 'GET' || m === 'POST')) { const out = handleTerminology(type, op, url, m === 'POST' ? await readJson(req) : null, {}); if (out) return { status: 200, body: out }; }
    // Bulk Data
    if (op === '$export' && (m === 'GET' || m === 'POST')) return bulk.kickOff(parts.length === 1 ? 'system' : type === 'Group' ? 'group' : 'patient', type === 'Group' ? parts[1] : null, url, req);
    if (parts[0] === '$export-status' && parts[1]) return bulk.status(parts[1], req);
    if (parts[0] === '$export-file' && parts[1] && parts[2]) return bulk.file(parts[1], parts[2], req);
    // Subscriptions (R4 backport): checked, stored by the FHIR API as usual, then the handshake.
    if (type === 'Subscription' && (m === 'POST' || m === 'PUT') && parts.length <= 2) { const body = subs.check(await readJson(req)); req._json = Promise.resolve(body); return { forward: true, after: async (out) => { if (out.status < 300 && out.body?.id) await subs.handshake(out.body); } }; }
    if (type === 'Subscription' && parts[1] && (op === '$status' || op === '$events') && m === 'GET') return { status: 200, body: await subs.operation(parts[1], op, url) };
    // IPS
    if (type === 'Patient' && parts[1] && op === '$summary' && m === 'GET') return { status: 200, body: await summary(parts[1], ctx) };
    // MPI: PIXm (ITI-83). PDQm (ITI-78) is the Patient search with identifier, birthdate and gender: there are no names to search.
    if (type === 'Patient' && op === '$ihe-pix' && (m === 'GET' || m === 'POST')) return { status: 200, body: await pix(url, m === 'POST' ? await readJson(req) : null) };
    return null;
  }
  async function summary(id, ctx) {
    if (await createConsent(store).blocked(id, ctx)) throw new HttpError(403, 'The patient\'s consent does not allow this summary to be shared for this purpose', 'forbidden');
    const src = ctx.actor?.kind === 'agent' ? withoutJudgements(ctx.lens ?? store) : (ctx.lens ?? store);
    const patient = await src.get('Patient', id, { branch: ctx.branch, asOf: ctx.asOf }); if (!patient) throw new HttpError(404, `Patient/${id} not found`, 'not-found');
    const rows = await src.everything(`Patient/${id}`, { branch: ctx.branch, asOf: ctx.asOf }); const now = new Date().toISOString(); const entries = [clean(patient)]; const sections = [];
    for (const [code, title, types, required, pick] of IPS_SECTIONS) {
      const found = rows.filter((r) => types.includes(r.resourceType) && (!pick || pick(r)) && !['entered-in-error', 'cancelled'].includes(r.status)).slice(0, 200);
      const items = found.length || !NONE[code] ? found : [NONE[code](id, { reference: `Patient/${id}` })];
      for (const r of items) if (!entries.some((e) => e.resourceType === r.resourceType && e.id === r.id)) entries.push(clean(r));
      if (!items.length && !required) continue;
      sections.push({ title, code: { coding: [{ system: LOINC, code, display: IPS_DISPLAY[code] }] }, text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${items.length ? `${found.length ? `${found.length} ${title.toLowerCase()}` : `No ${title.toLowerCase()} recorded`}` : `No ${title.toLowerCase()} recorded`}</div>` }, ...(items.length ? { entry: items.map((r) => ({ reference: `${r.resourceType}/${r.id}` })) } : { emptyReason: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/list-empty-reason', code: 'unavailable' }] } }) });
    }
    const composition = { resourceType: 'Composition', id: `ips-${id}`, meta: { profile: ['http://hl7.org/fhir/uv/ips/StructureDefinition/Composition-uv-ips'] }, status: 'final', type: { coding: [{ system: LOINC, code: '60591-5', display: 'Patient summary Document' }] }, subject: { reference: `Patient/${id}` }, date: now, author: [{ display: 'Healthcare InSilico' }], title: `Patient summary: Patient ${mrnOf(patient) || id}`, confidentiality: 'N', section: sections };
    return { resourceType: 'Bundle', id: `ips-${id}-${Date.parse(now)}`, meta: { profile: ['http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips'] }, identifier: { system: 'urn:ietf:rfc:3986', value: `urn:uuid:${crypto.randomUUID()}` }, type: 'document', timestamp: now, entry: [composition, ...entries].map((r) => ({ fullUrl: `${base}/fhir/R4/${r.resourceType}/${r.id}`, resource: narrate(r) })) };
  }
  async function pix(url, body) {
    const q = Object.fromEntries(url.searchParams); for (const x of body?.parameter || []) q[x.name] = x.valueToken ?? x.valueString ?? x.valueUri ?? q[x.name];
    const [system, value] = String(q.sourceIdentifier || '').includes('|') ? String(q.sourceIdentifier).split('|') : [null, q.sourceIdentifier];
    if (!value) throw new HttpError(400, 'sourceIdentifier is required (system|value)', 'invalid');
    const hit = (await store.query('Patient', {}, { branch: 'main' })).filter((pt) => (pt.identifier || []).some((i) => i.value === value && (!system || i.system === system)));
    if (!hit.length) throw new HttpError(404, 'sourceIdentifier not found', 'not-found'); if (hit.length > 1) throw new HttpError(409, 'More than one patient has this identifier', 'conflict');
    const targets = (hit[0].identifier || []).filter((i) => !(i.value === value && i.system === system)).filter((i) => !q.targetSystem || String(q.targetSystem).split(',').includes(i.system));
    return { resourceType: 'Parameters', parameter: [...targets.map((i) => ({ name: 'targetIdentifier', valueIdentifier: { system: i.system, value: i.value } })), { name: 'targetId', valueReference: { reference: `Patient/${hit[0].id}` } }] };
  }
  /** /fhir/R5: the same API, converted. Call before routing; the response is converted by send(). */
  async function r5(req, url, res) {
    if (!(url.pathname === '/fhir/R5' || url.pathname.startsWith('/fhir/R5/'))) return false;
    if (/^\/fhir\/R5\/SubscriptionTopic/.test(url.pathname)) return false;
    url.pathname = url.pathname.replace(/^\/fhir\/R5/, '/fhir/R4'); req.url = `${url.pathname}${url.search}`; res.fhirR5 = true;
    if (['POST', 'PUT'].includes(req.method)) { const body = await readJson(req); req._json = Promise.resolve(toR4(body)); }
    return true;
  }
  return { open, handle, r5, smart, subs, onCommitted: (e) => subs.onCommitted(e).catch((err) => console.error('subscriptions:', err.message)) };
}
