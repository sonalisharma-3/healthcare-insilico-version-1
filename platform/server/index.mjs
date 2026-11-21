// API server and static file server. Node 22 http module, no framework.
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { createAiFeatures } from '../../agent-operations/server/ai-features.mjs';
import { createVisits } from '../../simulated-consultation/server/visits.mjs';
import { createInsApi } from '../../insurance-and-billing/server/api.mjs';
import { createDeletion, refuseSingleAction } from './deletion.mjs';
import { webFile, webDir } from './web-files.mjs';
import { createEmailSignIn } from './signin.mjs';
import { createInterop } from '../../standards/server/index.mjs';
import { INSURER_ROLES } from './roles.mjs';
import { createConnectors } from '../../agent-operations/server/connectors.mjs';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from './store.mjs';
import { openAdapter, migrate, dbConfig, REPO_ROOT } from './db/index.mjs';
import { createFhirApi } from './fhir-api.mjs';
import { createAgentOpsApi } from '../../agent-operations/server/runs.mjs';
import { createEhrApi } from '../../ehr/server/ehr-api.mjs';
import { createPatientMessages } from '../../patient-portal/server/patient-messages.mjs';
import { createAges } from '../../ehr/server/age.mjs';
import { createAccounts } from './accounts.mjs';
import { createStudies } from '../../agent-operations/server/studies.mjs';
import { createLegacy } from '../../agent-operations/server/legacy.mjs';
import { createTrainingRuns } from '../../agent-operations/server/training-runs.mjs';
import { createScores } from '../../agent-operations/server/scores.mjs';
import { createAgreement } from '../../data-annotation/server/agreement.mjs';
import { createSearch } from '../../agent-operations/server/search.mjs';
import { gate as patientGate, scopeBody, ownStudies } from './patient-scope.mjs';
import { studyUidOf } from '../../pacs/server/dicom.mjs';
import { createSurveillance } from '../../post-deployment-surveillance/server/index.mjs';
import { createPacsApi } from '../../pacs/server/pacs-api.mjs';
import { createDimseApi } from '../../standards/server/dimse-api.mjs';
import { createSdc } from '../../standards/server/sdc.mjs';
import { createXds } from '../../standards/server/xds.mjs';
import { createPathologyApi } from '../../pathology/server/pathology-api.mjs';
import { createPathologyAnalysis } from '../../pathology/server/pathology-analysis.mjs';
import { createResearch } from '../../agent-operations/server/research.mjs';
import { createSlideRoutes } from '../../pathology/server/slides.mjs';
import { createBedsApi } from '../../ehr/server/beds-api.mjs';
import { createPharmacyApi } from '../../pharmacy/server/pharmacy-api.mjs';
import { createNursingApi } from '../../ehr/server/nursing-api.mjs';
import { createEcgApi } from '../../ecg/server/ecg-api.mjs';
import { createLabApi } from '../../lab/server/lab-api.mjs';
import { createHl7Bridge } from '../../standards/server/hl7-bridge.mjs';
import { createRpmApi } from '../../ehr/server/rpm-api.mjs';
import { createModelLayer } from '../../agent-operations/server/models/index.mjs';
import { createCds, setCoverageCheck } from '../../standards/server/cds.mjs';
import { mllpFrame, MLLP } from '../../standards/server/hl7v2.mjs';
import net from 'node:net';
import { createDicomWeb } from '../../pacs/server/dicomweb.mjs';
import { ensureLiveRun } from './audit.mjs';
import { createAgentRuntime, ensureReferenceAgents } from '../../agent-operations/server/agents.mjs';
import { createHitl } from '../../agent-operations/server/hitl.mjs';
import { createRedTeam } from '../../agent-operations/server/red-team/runner.mjs';
import { createRl } from '../../agent-operations/server/cases.mjs';
import { createAblation, lensFor } from '../../agent-operations/server/ablation.mjs';
import { createCapture } from '../../data-annotation/server/capture.mjs';
import { createAnnotation } from '../../data-annotation/server/annotation.mjs';
import { createScribe } from '../../agent-operations/server/scribe.mjs';
import { createGrades } from '../../agent-operations/server/grades.mjs';
import { createTraceView } from '../../agent-operations/server/trace-view.mjs';
import { createRegression, createLeaderboard } from '../../agent-operations/server/regression.mjs';
import { assertAgentRequest, logRejection } from '../../agent-operations/server/envelope.mjs';
import { createTurns } from '../../agent-operations/server/turns.mjs';
import { createConditionsApi } from '../../agent-operations/server/capabilities.mjs';
import { createScenarios } from '../../agent-operations/server/scenarios.mjs';
import { createScenarioRuns } from '../../agent-operations/server/scenario-runs.mjs';
import { createSimClock } from './simclock.mjs';
import { createRedTeamTests } from '../../agent-operations/server/red-team/tests.mjs';
import { createGrading } from '../../agent-operations/server/grading.mjs';
import { createTaskSets } from '../../agent-operations/server/task-sets.mjs';
import { createEnvApi } from '../../agent-operations/server/env-api.mjs';
import { createImprovementLoop } from '../../agent-operations/server/improve.mjs';
import { createPreferences } from '../../agent-operations/server/preferences.mjs';
import { createReaderStudies } from '../../data-annotation/server/reader-studies.mjs';
import { createObjectStore, describeStorage, testStorage } from './storage.mjs';
import { ROLES, APPS, permissionFor, logRoleRefusal } from './roles.mjs';
import { HttpError, readJson, send, requestContext, operationOutcome, errorStatus } from './http.mjs';
import { migrateVerified } from '../../pharmacy/server/pharmacy.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json', '.wasm': 'application/wasm',
};

// The permission map lives in lib/roles.mjs; re-exported so existing imports keep working.
export { ROLES };

/**
 * What a browser that is not signed in may fetch: the sign-in page and exactly the files it loads (worked
 * out from its imports; tests/signin.mjs checks the list still matches). /auth/mode, /auth/check-email, /auth/signin
 * and /auth/logout are answered before this rule, and the wallpapers (pictures only) are served so the sign-in screen
 * shows them. Everything else waits for a session.
 */
export const SIGN_IN_PAGE = new Set(['/', '/index.html', '/desktop.js', '/shared/ui.css', '/shared/recorder.js', '/shared/context.js', '/shared/fhir.js', '/shared/roles.js', '/shared/capture.js', '/auth/roles']);
function serveStatic(webRoot, url, res) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  if (rel.includes('\0') || rel.split('/').includes('..')) return send(res, 403, { error: 'Forbidden' });
  const file = webFile(webRoot, rel);
  if (!file) {
    if (webDir(webRoot, rel)) { res.writeHead(302, { Location: `${url.pathname}/` }); return res.end(); }
    return send(res, 404, { error: `Not found: ${url.pathname}` });
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      if (!err && stat.isDirectory()) {
        res.writeHead(302, { Location: `${url.pathname}/` });
        return res.end();
      }
      return send(res, 404, { error: `Not found: ${url.pathname}` });
    }
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    // Pages and what the sign-in screen is made of are never kept (the site may be locked). The apps' own code and
    // pictures are kept by this browser only and checked each time ("has it changed?"), so a new release shows at once
    // and nothing is downloaded twice. The large viewer library and the icons are simply kept for a day.
    const rel2 = url.pathname; const page = rel.endsWith('.html') || SIGN_IN_PAGE.has(rel2);
    const etag = `W/"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}"`;
    const cache = page ? 'private, no-store' : /^\/(vendor|shared\/icons)\//.test(rel2) ? 'private, max-age=86400' : 'private, no-cache';
    const head = { 'Content-Type': type, 'Cache-Control': cache, ...(page ? {} : { ETag: etag }) };
    if (!page && res.req?.headers?.['if-none-match'] === etag) { res.writeHead(304, head); return res.end(); }
    const zip = /javascript|css|html|json|svg|text/.test(type) && stat.size > 1400 && /\bgzip\b/.test(String(res.req?.headers?.['accept-encoding'] || ''));
    if (!zip) { res.writeHead(200, { ...head, 'Content-Length': stat.size }); return fs.createReadStream(file).pipe(res); }
    const hit = zipped.get(file);
    if (hit && hit.etag === etag) { res.writeHead(200, { ...head, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': hit.buf.length }); return res.end(hit.buf); }
    fs.readFile(file, (e1, raw) => { if (e1) return send(res, 404, { error: `Not found: ${url.pathname}` });
      zlib.gzip(raw, { level: 6 }, (e2, buf) => { if (e2) { res.writeHead(200, head); return res.end(raw); }
        if (zipped.size > 400) zipped.clear(); zipped.set(file, { etag, buf });
        res.writeHead(200, { ...head, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': buf.length }); res.end(buf); }); });
  });
}
const zipped = new Map(); // file -> { etag, buf }: each static file is compressed once per version

export function createApp({ store, webRoot = REPO_ROOT, corsOrigins = [], hooks = {}, autoRedTeam = false, horizonTimer = false, captureKey = null, auth = {} }) {
  // Who may come in: see lib/accounts.mjs. Tests and DEMO_MODE trust the role the browser names.
  const accounts = createAccounts({ store, demo: auth.demo === true, adminPassword: auth.adminPassword || null });
  // The hosted sign-in (lib/signin.mjs): any real email with a chosen role, a signed session cookie, and every route behind it.
  const signin = auth.email ? createEmailSignIn({ store, ...auth.email }) : null;
  const started = Date.now();
  const agents = createAgentRuntime({ store });
  let hl7 = null;
  let interop = null; // SMART, terminology, Bulk Data, Subscriptions, the R5 face (lib/interop)
  const fhir = createFhirApi({ store, hooks: { ...hooks, onChartOpen: (event) => { hooks.onChartOpen?.(event); agents.onChartOpened(event); }, onCommitted: (event) => { hooks.onCommitted?.(event); agents.onCommitted(event); interop?.onCommitted(event); hl7?.onCommitted(event).catch((err) => console.error(err)); } } });
  hl7 = createHl7Bridge({ store, fhir });
  interop = createInterop({ store, fhir });
  agents.setHitl(createHitl({ store, fhir }));
  const models = createModelLayer({ store });
  agents.setModels(models);
  const cds = createCds({ store, agents });
  const redTeam = createRedTeam({ store, agents, auto: autoRedTeam });
  agents.setRedTeam(redTeam);
  const rl = createRl({ store, agents });
  agents.setRl(rl);
  let redTeamTestsRef = null;
  const studies = createStudies({ store, agents, rl, accounts, redTeamTests: { ensureBuiltins: () => redTeamTestsRef.ensureBuiltins(), runTest: (...a) => redTeamTestsRef.runTest(...a) } });
  const legacy = createLegacy({ store });
  const trainingRuns = createTrainingRuns({ store, rl });
  const scores = createScores({ store, studies, rl, accounts });
  const agreement = createAgreement({ store, studies, accounts, scores, legacy });
  const search = createSearch({ store, studies, accounts });
  agents.setAblation(createAblation({ store, agents, rl }));
  const capture = createCapture({ store, rl, key: captureKey });
  const annotation = createAnnotation({ store, fhir });
  const scribe = createScribe({ store, agents });
  const grades = createGrades({ store, fhir, rl });
  const traceView = createTraceView({ store, capture, rl });
  const research = createResearch({ store, rl });
  const regression = createRegression({ store, agents, rl });
  const leaderboard = createLeaderboard({ store, rl, scribe });
  const turns = createTurns({ store, agents });
  agents.setTurns(turns);
  const conditions = createConditionsApi({ store });
  const scenarios = createScenarios({ store, fhir });
  const scenarioRuns = createScenarioRuns({ store, scenarios, agents, rpm: null });
  const simClock = createSimClock({ store, release: scenarioRuns.release });
  turns.setScenarioRelease(scenarioRuns.release);
  agents.setSimClock(simClock);
  const redTeamTests = createRedTeamTests({ store, agents });
  redTeamTestsRef = redTeamTests;
  const grading = createGrading({ store, episodes: rl.episodes });
  const taskSetsApi = createTaskSets({ store, episodes: rl.episodes });
  const envApi = createEnvApi({ store, agents, grading, taskSets: taskSetsApi, episodes: rl.episodes, turns, trainingRuns });
  const improvementLoop = createImprovementLoop({ store, rl, redTeamTests });
  envApi.setLoop(improvementLoop);
  const preferences = createPreferences({ store, rl });
  research.setPreferences(preferences);
  const readerStudies = createReaderStudies({ store });
  research.setReaderStudies(readerStudies);
  const aiFeatures = createAiFeatures({ store });
  const visits = createVisits({ store, agents });
  const insApi = createInsApi({ store });
  const deletion = createDeletion({ store });
  setCoverageCheck((body, ctx) => insApi.auths.need(body, ctx));
  const connectors = createConnectors({ store, agents });
  agents.setConnectors(connectors);
  envApi.setVisits?.(visits);
  agents.setParts([{ handle: (...a) => surveillance.handle(...a) }, aiFeatures, improvementLoop, preferences, capture, annotation, scribe, grades, traceView, regression, leaderboard, research, turns, conditions, scenarios, scenarioRuns, simClock,  redTeamTests, grading, taskSetsApi, readerStudies]);
  // Administration → Storage and database (task 21.5): the active database and storage per kind, never keys, and a connection test.
  async function storageAdmin(req, url, body, ctx) {
    if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people may see storage settings');
    if (req.method === 'GET') return { status: 200, body: await describeStorage() };
    if (req.method === 'POST' && url.pathname.endsWith('/test')) return { status: 200, body: { results: await testStorage() } };
    throw new HttpError(404, 'No such storage route');
  }
  const agentOps = createAgentOpsApi({ store, agents });
  const ehrApi = createEhrApi({ store });
  const patientMessages = createPatientMessages({ store, agents });
  const ages = createAges({ store });
  // Surveillance and Reporting: reports from people, automatic rules and verifier agents; rules and subgroup search run on a timer.
  const surveillance = createSurveillance({ store, agents });
  insApi.setHarmReporter((body, ctx) => surveillance.reports.file(body, ctx, { rule: { id: 'insurance-delay-or-denial', version: 1 } }));
  const surveillanceTimer = setInterval(() => surveillance.sweep().then(() => surveillance.analysis.discoverJob()).catch((err) => console.error(err)), 60000); surveillanceTimer.unref();
  // Simulated patient messages are sent when their time comes, on the live clock or a run's simulation clock.
  const messageTimer = setInterval(() => patientMessages.fireDue().catch((err) => console.error(err)), 1000); messageTimer.unref();
  const pathologyAnalysis = createPathologyAnalysis({ store });
  const pathologyApi = createPathologyApi({ store, fhir, analysis: pathologyAnalysis });
  const slideRoutes = createSlideRoutes({ store });
  const pacsApi = createPacsApi({ store, fhir, onOpen: (event) => agents.onStudyOpened(event) });
  const dimseApi = createDimseApi({ store, fhir });
  const sdcApi = createSdc({ store, fhir });
  const xds = createXds({ store, baseUrl: () => process.env.PUBLIC_BASE_URL || '' });
  const dicomWeb = createDicomWeb({ store });
  const bedsApi = createBedsApi({ store, fhir });
  const pharmacyApi = createPharmacyApi({ store, fhir });
  const nursingApi = createNursingApi({ store, fhir });
  const ecgApi = createEcgApi({ store, fhir });
  const labApi = createLabApi({ store, fhir });
  const rpmApi = createRpmApi({ store, fhir });
  scenarioRuns.setRpm(rpmApi);
  const allowed = new Set(corsOrigins);
  // The public addresses this server is reached through (for example a hosting front end). A request from one of these is from the platform's own pages, not from another site.
  const publicOrigins = new Set(String(process.env.PUBLIC_ORIGINS || '').split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean));

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    let originHost = null; try { originHost = origin ? new URL(origin).host : null; } catch { originHost = null; }
    const sameOrigin = Boolean(origin && ((req.headers.host && originHost === req.headers.host) || publicOrigins.has(origin)));
    const cors = {};
    if (origin && !sameOrigin) {
      if (!allowed.has(origin)) return send(res, 403, { error: `Origin ${origin} is not allowed` });
      Object.assign(cors, {
        'Access-Control-Allow-Origin': origin, Vary: 'Origin',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,If-Match,Idempotency-Key,X-Role,X-User-Id,X-Agent-Id,X-Run-Id,X-Reasoning',
        'Access-Control-Expose-Headers': 'ETag,Location',
      });
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    // /fhir/R5 is the same API in R5: the path becomes /fhir/R4 here, bodies are converted, and send() converts the answer.
    try { await interop.r5(req, url, res); } catch (err) { return send(res, errorStatus(err), operationOutcome(errorStatus(err), err.message), cors); }
    const p = url.pathname;
    const isFhir = p === '/fhir/R4' || p.startsWith('/fhir/R4/');
    let ctx = null;
    // Who is asking, and (for agents) whether the safety envelope lets the request through at all.
    const context = async (area) => {
      ctx = await requestContext(store, req, url);
      ctx.area = area; ctx.smart = req.person?.smart || null; ctx.breakGlass = req.headers['x-break-glass'] ? String(req.headers['x-break-glass']).slice(0, 200) : null;
      // A person working on their open attempt: the server, not the browser, ties what they do to that attempt's run.
      if (ctx.actor.kind === 'human' && ctx.branch !== 'main') { const w = studies.workOn(ctx.branch, ctx.actor); if (w && (!ctx.run || ctx.run.id !== w.runId)) { ctx.run = await store.get('Run', w.runId); ctx.runId = w.runId; } }
      // A closed attempt is locked: nothing more is written to its branch of the chart.
      if (req.method !== 'GET' && req.method !== 'HEAD' && ctx.branch !== 'main' && studies.isLocked(ctx.branch)) throw new HttpError(409, 'This attempt is closed and locked: nothing more can be written to it', 'attempt-locked');
      await assertAgentRequest(store, ctx, { method: req.method, area, path: p });
      ctx.lens = lensFor(store, ctx);
      // Under an ablation the agent reads only through the FHIR API, where the overlays apply.
      if (ctx.lens && !['fhir', 'agent-ops'].includes(area)) throw new HttpError(403, 'This run has ablation overlays, so its agent may read only through the FHIR API', 'forbidden');
      return ctx;
    };
    try {
      if (p === '/healthz') return send(res, 200, { ok: true, uptime: Math.round((Date.now() - started) / 1000) }, cors);
      // What an app needs before it has a token: SMART discovery, the keys, the token endpoint and introspection.
      { const pub = await interop.open(req, url); if (pub) return send(res, pub.status, pub.body, { ...cors, ...(pub.headers || {}) }); }
      if (['/auth/mode', '/auth/me', '/auth/login', '/auth/logout', '/auth/accept', '/auth/demo', '/auth/check-email', '/auth/signin'].includes(p)) {
        const out = await (signin || accounts).auth(req, url, req.method === 'POST' ? await readJson(req) : null);
        if (req.method === 'POST' && out.status === 200 && ['/auth/signin', '/auth/login', '/auth/demo', '/auth/accept'].includes(p)) warm('sign-in'); // someone is coming in: get the first screens ready
        return send(res, out.status, out.body, { ...cors, ...(out.headers || {}) });
      }
      refuseSingleAction(req.method, p);
      if (signin) {
        // Without a session only the sign-in page and what it is made of can be fetched; everything else is refused.
        // An app's access token (SMART) stands in for a session on the FHIR API; the CapabilityStatement is public, as SMART discovery expects.
        if (!(await interop.smart.apply(req, url)) && !(await signin.apply(req)) && !((SIGN_IN_PAGE.has(p) || p === '/fhir/R4/metadata' || p === '/api/wallpapers' || /^\/wallpapers\/[^/]+$/.test(p)) && (req.method === 'GET' || req.method === 'HEAD'))) {
          if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html') && !isFhir && !p.startsWith('/api/') && !p.startsWith('/dicom-web')) { res.writeHead(302, { Location: '/', 'Cache-Control': 'private, no-store' }); return res.end(); }
          throw new HttpError(401, 'Sign in to continue', 'sign-in-required');
        }
      } else if (!(await interop.smart.apply(req, url)))
      await accounts.apply(req, { needsIdentity: isFhir || p.startsWith('/api/') || p.startsWith('/agent-ops/') && isApiPath(p) || p === '/auth/patients' || p.startsWith('/hl7') });
      // Insurer roles see only what the hospital sent: the insurance API and the Agent Dashboard. No chart, images or other apps by address.
      { const roleNow = req.headers['x-agent-id'] ? null : req.person && !req.person.operator ? req.person.role : String(req.headers['x-role'] || ''); if (INSURER_ROLES.includes(roleNow) && (isFhir || p.startsWith('/dicom-web') || p.startsWith('/hl7') || p.startsWith('/env/') || p.startsWith('/cds-services') || p.startsWith('/pathology/') || p === '/auth/patients' || (p.startsWith('/api/') && !p.startsWith('/api/ins/') && !['/api/ages', '/api/counters'].includes(p)))) throw new HttpError(403, 'The insurer sees only what the hospital sent, in the Payer Portal', 'forbidden'); }
      // A signed-in patient reads and writes only their own record, on every route.
      if (req.person && !req.person.operator && req.person.role === 'patient') {
        const pid = req.person.patientId || '(none)';
        await patientGate({ req, url, pid, body: ['POST', 'PUT'].includes(req.method) ? await readJson(req) : null, store, studyUidOf, isApi: isApiPath(p) });
        const qido = p === '/dicom-web/studies' ? await ownStudies(store, pid, studyUidOf) : null;
        res.patientScope = (body) => (qido ? { body: Array.isArray(body) ? body.filter((row) => qido.has(row?.['0020000D']?.Value?.[0])) : body } : scopeBody(body, pid, { fhir: isFhir }));
      }
      if (p === '/auth/roles') {
        const built = Object.fromEntries(APPS.map((a) => [a, Boolean(webFile(webRoot, `/${a}/index.html`))]));
        return send(res, 200, { roles: ROLES.map((r) => permissionFor(r.id)), built, apps: APPS }, cors);
      }
      if (p === '/auth/patients') {
        const pctx = await requestContext(store, req, url);
        const patients = (await store.query('Patient', {}, { branch: pctx.branch, asOf: pctx.asOf })).map((pt) => {
          const name = pt.name?.[0] || {};
          return {
            id: pt.id,
            mrn: pt.identifier?.find((i) => i.type?.coding?.some((c) => c.code === 'MR'))?.value ?? pt.identifier?.[0]?.value ?? null,
            family: name.family ?? '', given: (name.given || []).join(' '), birthDate: pt.birthDate ?? null, gender: pt.gender ?? null,
          };
        }).sort((a, b) => a.family.localeCompare(b.family) || a.given.localeCompare(b.given) || a.id.localeCompare(b.id));
        return send(res, 200, { patients }, cors);
      }
      // HL7 v2 over HTTP: one message per request, text body, an HL7 ACK as the answer. Agents never reach it.
      if (p === '/xds/soap' && req.method === 'POST') {
        // XDS.b and XCA SOAP from another community: it proves itself with XCA_PEER_KEY, and is never treated as this hospital's own care.
        const gk = String(req.headers['x-gateway-key'] || ''); const want = String(process.env.XCA_PEER_KEY || '');
        if (!want || gk.length !== want.length || !timingSafeEqual(Buffer.from(gk), Buffer.from(want))) return send(res, 401, { error: 'Unknown gateway key' }, cors);
        const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 20 * 1024 * 1024) return send(res, 413, { error: 'Too large' }, cors); chunks.push(chunk); }
        const out = await xds.gateway.soap(Buffer.concat(chunks).toString('utf8'), { actor: { kind: 'human', id: 'xca-peer', role: 'peer' }, community: String(req.headers['x-home-community-id'] || 'peer').slice(0, 200) });
        res.writeHead(out.status, { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Cache-Control': 'no-store', ...cors }); return res.end(out.xml);
      }
      if (p === '/hl7/v2' && req.method === 'POST') {
        if (req.headers['x-agent-id']) throw new HttpError(403, 'Agents may not send HL7 messages');
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new HttpError(413, 'HL7 message too large'); chunks.push(chunk); }
        const { ack: response, record, duplicate } = await hl7.receive(Buffer.concat(chunks).toString('latin1'));
        res.writeHead(duplicate ? 200 : record.ackCode === 'AA' ? 200 : 422, { 'Content-Type': 'x-application/hl7-v2+er7; charset=iso-8859-1', 'X-Hl7-Message-Id': record.id, 'X-Hl7-Ack': record.ackCode, 'Cache-Control': 'no-store', ...cors });
        return res.end(response);
      }
      // CDS Hooks 2.0: this server as a service host and, under /api/cds, as the EHR's client.
      if (p === '/cds-services' && req.method === 'GET') return send(res, 200, { services: await cds.services() }, cors);
      if (p.startsWith('/cds-services/') && req.method === 'POST') {
        const [, , sid, fb] = p.split('/');
        const body = await readJson(req);
        await context('api');
        if (fb === 'feedback') { const out = await cds.feedback(sid, body, ctx); return send(res, out.status, out.body, cors); }
        return send(res, 200, await cds.serve(sid, body || {}, ctx), cors);
      }
      if (p === '/api/ins/events' && req.method === 'GET') { // answers from the insurer, pushed to open EHR screens
        await context('api'); if (ctx.actor.kind !== 'human' || ctx.actor.role === 'patient' || INSURER_ROLES.includes(ctx.actor.role)) throw new HttpError(403, 'This stream is for hospital staff');
        res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.write(': connected\n\n'); insApi.addStream(res); return;
      }
      if (p.startsWith('/api/cds/')) {
        const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : null;
        await context('api');
        const [, , , what, sid, op] = p.split('/');
        if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Agents do not call CDS services');
        if (what === 'invoke' && req.method === 'POST') { const out = await cds.invoke(body, ctx); return send(res, out.status, out.body, cors); }
        if (what === 'feedback' && req.method === 'POST') { const out = await cds.feedback(String(body?.serviceId || ''), { feedback: [{ card: body?.card, outcome: body?.outcome, overrideReason: body?.overrideReason, acceptedSuggestions: body?.acceptedSuggestions }] }, ctx); return send(res, out.status, out.body, cors); }
        if (what === 'services' && req.method === 'GET') return send(res, 200, { services: await cds.services(), externalAllowed: process.env.ALLOW_EXTERNAL_CDS === 'true' }, cors);
        if (what === 'services' && req.method === 'POST') { const out = await cds.registerExternal(body, ctx); return send(res, out.status, out.body, cors); }
        if (what === 'report' && req.method === 'GET') return send(res, 200, await cds.report(), cors);
        throw new HttpError(404, `${req.method} ${p} is not available`);
      }
      if (p.startsWith('/api/hl7/')) {
        await context('api');
        const parts = p.split('/').filter(Boolean).slice(2);
        if (parts[0] === 'messages' && !parts[1] && req.method === 'GET') return send(res, 200, { messages: await hl7.list(url) }, cors);
        if (parts[0] === 'messages' && parts[1] && parts[2] === 'raw' && req.method === 'GET') {
          const m = await store.get('Hl7Message', parts[1]);
          if (!m) throw new HttpError(404, 'Message not found');
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=iso-8859-1', 'Content-Disposition': `attachment; filename="${m.id}.hl7"`, 'Cache-Control': 'no-store', ...cors });
          return res.end((hl7.readRaw(m.raw) || '').replace(/\r/g, '\n'));
        }
        if (parts[0] === 'messages' && parts[1] && parts[2] === 'replay' && req.method === 'POST') {
          const body = await readJson(req);
          const m = await store.get('Hl7Message', parts[1]);
          if (!m || m.direction !== 'in') throw new HttpError(404, 'Inbound message not found');
          if (ctx.actor.kind !== 'human') throw new HttpError(403, 'People replay messages');
          const text = typeof body?.text === 'string' && body.text.trim() ? body.text.replace(/\r?\n/g, '\r') : hl7.readRaw(m.raw);
          const { record } = await hl7.receive(text, { replayOf: m.id });
          return send(res, record.ackCode === 'AA' ? 200 : 422, { id: record.id, status: record.status, ackCode: record.ackCode, error: record.error || null, result: record.result || null }, cors);
        }
        throw new HttpError(404, `${req.method} ${p} is not available`);
      }
      // Workstation wallpapers (plan-master task 1.1): image files dropped in data/wallpapers (gitignored), listed and served read-only.
      if (p === '/api/wallpapers' && req.method === 'GET') {
        const files = (await (await createObjectStore('default')).list('wallpapers')).map((k) => k.slice('wallpapers/'.length)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && !f.startsWith('.') && !f.includes('/')).sort();
        return send(res, 200, { wallpapers: files }, cors);
      }
      if (p.startsWith('/wallpapers/') && (req.method === 'GET' || req.method === 'HEAD')) {
        const name = decodeURIComponent(p.slice('/wallpapers/'.length));
        if (!/^[\w .()-]+\.(jpe?g|png|webp)$/i.test(name)) throw new HttpError(404, 'No such wallpaper');
        const bytes = await (await createObjectStore('default')).get(`wallpapers/${name}`);
        if (!bytes) throw new HttpError(404, 'No such wallpaper');
        res.writeHead(200, { 'Content-Type': /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg', 'Cache-Control': 'private, max-age=3600', 'Content-Length': bytes.length }); // pictures only: kept by this browser for an hour
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
      if (p.startsWith('/dicom-web/')) return await dicomWeb.handle(req, res, url, await context('dicom-web'), cors);
      // Whole-slide tiles and slide info: read-only, logged once per slide open, never decoded here.
      if (p.startsWith('/pathology/slides/')) { const out = await slideRoutes.handle(req, url, await context('api')); return send(res, out.status, out.raw ? Buffer.from(out.raw) : out.body, { ...cors, ...(out.headers || {}) }); }
      // The environment API (plan-master task 15): bearer keys, no request context of its own; off unless ENV_API_ENABLED=true.
      // Connectors for outside agents (MCP, FHIR, CDS Hooks): per-agent keys, off until switched on for an approved agent.
      if (p.startsWith('/connect/v1/')) {
        const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : null;
        const out = await connectors.handle(req, url, body);
        return send(res, out.status, out.body, cors);
      }
      if (p === '/env/v1' || p.startsWith('/env/v1/')) {
        const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : null;
        const out = await envApi.handle(req, url, body);
        return send(res, out.status, out.body, cors);
      }
      if (p.startsWith('/oauth/') || /^\/fhir\/(R5\/)?SubscriptionTopic(\/|$)/.test(p)) { const io = await interop.handle(req, url, { branch: 'main' }, res); if (io?.done) return; if (io) return send(res, io.status, io.body, { ...cors, ...(io.headers || {}) }); throw new HttpError(404, 'Not found'); }
      if (isFhir || isApiPath(p) || p.startsWith('/api/')) {
        await context(isFhir ? 'fhir' : p.startsWith('/api/') ? 'api' : 'agent-ops');
        const io = isFhir ? await interop.handle(req, url, ctx, res) : null;
        if (io?.done) return;
        if (io && !io.forward) return send(res, io.status, io.raw ? Buffer.from(io.raw) : io.body, { ...cors, ...(io.headers || {}) });
        const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : null;
        const out = isFhir ? await fhir.handle(req, url, body, ctx)
          : p.startsWith('/api/pacs/') ? await pacsApi.handle(req, url, body, ctx)
            : p.startsWith('/api/dimse/') ? await dimseApi.handle(req, url, body, ctx)
            : p.startsWith('/api/sdc/') ? await sdcApi.handle(req, url, body, ctx)
            : p.startsWith('/api/xds/') ? await (async () => { const seg = p.split('/').slice(3); if (seg[0] === 'publish' && req.method === 'POST') return { status: 201, body: await xds.publish(body, ctx) }; if (seg[0] === 'remote' && !seg[1] && req.method === 'GET') return { status: 200, body: { documents: await xds.remoteQuery(url.searchParams.get('patient'), ctx) } }; if (seg[0] === 'remote' && seg[3] && req.method === 'GET') { const d = await xds.remoteRetrieve(decodeURIComponent(seg[1]), seg[2], seg[3], ctx); return { status: 200, body: d.data, headers: { 'Content-Type': d.mimeType || 'application/octet-stream' } }; } if (seg[0] === 'documents' && seg[1] && req.method === 'GET') { const d = await xds.retrieveLocal(seg[1], ctx); return { status: 200, body: d.bytes, headers: { 'Content-Type': d.entry.mimeType } }; } if (seg[0] === 'mhd' && seg[1] === 'DocumentReference' && req.method === 'GET') return { status: 200, body: await xds.mhdFind(url, ctx), headers: { 'Content-Type': 'application/fhir+json' } }; if (seg[0] === 'mhd' && !seg[1] && req.method === 'POST') return { status: 200, body: await xds.mhdProvide(body, ctx), headers: { 'Content-Type': 'application/fhir+json' } }; throw new HttpError(404, 'Not found'); })()
            : p.startsWith('/api/beds/') ? await bedsApi.handle(req, url, body, ctx)
            : p.startsWith('/api/pharmacy/') ? await pharmacyApi.handle(req, url, body, ctx)
            : p.startsWith('/api/nursing/') ? await nursingApi.handle(req, url, body, ctx)
            : p.startsWith('/api/ecg') ? await ecgApi.handle(req, url, body, ctx)
            : p.startsWith('/api/lab/') ? await labApi.handle(req, url, body, ctx)
            : p.startsWith('/api/rpm/') ? await rpmApi.handle(req, url, body, ctx)
            : p.startsWith('/api/pathology/') ? await pathologyApi.handle(req, url, body, ctx)
            : p.startsWith('/api/visits') || p.startsWith('/api/speech/') ? await visits.handle(req, url, body, ctx)
            : p.startsWith('/agent-ops/delete/') ? await deletion.handle(req, url, body, ctx)
            : p.startsWith('/api/ins/') ? await insApi.handle(req, url, body, ctx)
            : p.startsWith('/api/surveillance/') ? await surveillance.handle(req, url, body, ctx)
            : p === '/agent-ops/studies/twin' && req.method === 'GET' ? (ctx.actor.kind === 'human' ? { status: 200, body: { id: await legacy.twinFor(['AnnotationProject', 'earlier-screen'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'Study', String(url.searchParams.get('id') || '')) } } : (() => { throw new HttpError(403, 'For people'); })())
            : p === '/agent-ops/studies/migrate' && req.method === 'POST' ? (ctx.actor.role === 'researcher' ? { status: 200, body: await legacy.migrate() } : (() => { throw new HttpError(403, 'Only a Researcher brings earlier work over'); })())
            : p === '/agent-ops/studies' && req.method === 'GET' ? (await legacy.ensureTwins(), await studies.handle(req, url, body, ctx))
            : p.startsWith('/agent-ops/studies') || p.startsWith('/agent-ops/attempts') ? await studies.handle(req, url, body, ctx)
            : p.startsWith('/agent-ops/report-card') || p.startsWith('/agent-ops/attempt-grades') ? await scores.handle(req, url, body, ctx)
            : p.startsWith('/agent-ops/my-work') || p.startsWith('/agent-ops/agreement') || p.startsWith('/agent-ops/adjudications') ? await agreement.handle(req, url, body, ctx)
            : p.startsWith('/agent-ops/library-list') || p.startsWith('/agent-ops/search') ? await search.handle(req, url, body, ctx)
            : p.startsWith('/agent-ops/training-runs') ? await trainingRuns.handle(req, url, body, ctx)
            : p.startsWith('/agent-ops/people') ? await accounts.handlePeople(req, url, body, ctx)
            : p === '/api/ages' ? await ages.handle(req, url, body, ctx)
            : p === '/api/counters' || p === '/api/visit-summary' || p.startsWith('/api/messages/') ? (await patientMessages.handle(req, url, body, ctx)) || (() => { throw new HttpError(404, 'Not available'); })()
            : p.startsWith('/api/admin/env-') ? await envApi.handleAdmin(req, url, body, ctx)
            : p.startsWith('/api/admin/storage') ? await storageAdmin(req, url, body, ctx)
              : p.startsWith('/api/') ? await ehrApi.handle(req, url, body, ctx) : await agentOps.handle(req, url, body, ctx);
        if (io?.after) await io.after(out);
        return send(res, out.status, out.raw ? Buffer.from(out.raw) : out.body, { ...cors, ...(out.headers || {}), ...(isFhir ? { 'Content-Type': 'application/fhir+json; charset=utf-8' } : {}) });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, `${req.method} ${p} is not supported`);
      return serveStatic(webRoot, url, res);
    } catch (err) {
      const status = errorStatus(err);
      if (status >= 500) console.error(err);
      await logRejection(store, ctx, err, { method: req.method, path: p });
      await logRoleRefusal(store, ctx, err, { method: req.method, path: p });
      const message = status >= 500 ? 'Internal server error' : err.message;
      return send(res, status, isFhir ? operationOutcome(status, message) : { error: message, code: err.code, ...(err.issues ? { issues: err.issues } : {}) }, cors);
    }
  }

  const server = http.createServer(async (req, res) => { if (signin) await signin.gate(req, res); handler(req, res); });
  // WebSockets are for agents with keys: a patient's session cannot open one.
  // Work done on the earlier screens before this build is brought into studies once, in the background.
  legacy.ready();
  envApi.setUpgradeGuard(async (req) => { if (signin) { const sn = await signin.sessionOf(req); return Boolean(sn && sn.role === 'patient'); } const sn = await accounts.sessionOf(req); return Boolean(sn && !sn.person.operator && sn.person.role === 'patient'); });
  envApi.attach(server);
  server.envApi = envApi;
  server.hl7 = hl7;
  server.models = models;
  server.cds = cds;
  server.rpm = rpmApi;
  // Optional MLLP listener, loopback only, off unless HL7_MLLP_PORT is set.
  if (process.env.HL7_MLLP_PORT && process.env.NODE_ENV !== 'test') {
    const mllp = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', async (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        let start = buf.indexOf(MLLP.VT); let end = buf.indexOf(Buffer.from([MLLP.FS, MLLP.CR]));
        while (start >= 0 && end > start) {
          const text = buf.subarray(start + 1, end).toString('latin1');
          buf = buf.subarray(end + 2);
          try { const { ack: response } = await hl7.receive(text); socket.write(mllpFrame(response)); } catch (err) { console.error(err); }
          start = buf.indexOf(MLLP.VT); end = buf.indexOf(Buffer.from([MLLP.FS, MLLP.CR]));
        }
      });
    });
    mllp.listen(Number(process.env.HL7_MLLP_PORT), '127.0.0.1', () => console.log(`  HL7 MLLP    127.0.0.1:${process.env.HL7_MLLP_PORT} (loopback only)`));
    server.on('close', () => mllp.close());
  }
  // Warm-up, for everyone: the first patients' charts, the lists every screen opens with, and the first studies' images are
  // read ahead of time so nobody waits for the database or the image store to wake up. Runs at start, on every sign-in
  // (at most once every two minutes) and every ten minutes. It only reads.
  let warmAt = 0; let warming = false;
  async function warm(why) {
    if (warming || Date.now() - warmAt < 120e3) return; warming = true; warmAt = Date.now(); const t0 = Date.now();
    try {
      const patients = (await store.query('Patient', {}, { branch: 'main' })).slice(0, 10);
      for (const type of ['Appointment', 'ServiceRequest', 'DocumentReference', 'Communication', 'Task', 'MedicationRequest', 'List', 'Location', 'Consent', 'Agent', 'Study', 'DiagnosticReport']) await store.query(type, {}, { branch: 'main' }).catch(() => []);
      for (const pt of patients) await store.everything(`Patient/${pt.id}`, { branch: 'main' }).catch(() => []);
      const slices = await dicomWeb.warm().catch(() => 0);
      console.log(`Warm-up (${why}): ${patients.length} charts, ${slices} images in memory, ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (err) { console.warn(`Warm-up (${why}) stopped: ${err.message}`); } finally { warming = false; }
  }
  server.warm = warm;
  server.agents = agents;
  { const closeServer = server.close.bind(server); server.close = (cb) => { insApi.closeStreams(); return closeServer(cb); }; }
  server.patientMessages = patientMessages; server.surveillance = surveillance; server.studies = studies; server.trainingRuns = trainingRuns; server.legacy = legacy; server.on('close', () => { studies.dispose(); scores.dispose(); legacy.dispose(); }); server.on('close', () => { clearInterval(messageTimer); clearInterval(surveillanceTimer); });
  server.redTeam = redTeam;
  server.rl = rl;
  server.capture = capture;
  server.annotation = annotation;
  server.scribe = scribe;
  // Outcome horizons come due in real time; check once a minute without keeping the process alive.
  // Recorded free text expires: drop anything past its retention date at start and then hourly.
  if (horizonTimer) { capture.purge().catch((err) => console.error(err)); const sweep = setInterval(() => capture.purge().catch((err) => console.error(err)), 3600000); sweep.unref(); server.on('close', () => clearInterval(sweep)); }
  if (horizonTimer) { const timer = setInterval(() => rl.runDueHorizons().catch((err) => console.error(err)), 60000); timer.unref(); server.on('close', () => clearInterval(timer)); }
  server.on('listening', () => {
    agents.setBaseUrl(`http://127.0.0.1:${server.address().port}`);
    redTeam.autoRunMissing().catch((err) => console.error(err));
  });
  return server;
}

const API_AREAS = new Set(['delete', 'people', 'library-list', 'search', 'my-work', 'agreement', 'adjudications', 'report-card', 'attempt-grades', 'training-runs', 'studies', 'attempts', 'ai-features', 'write-report', 'admin-tasks', 'surveillance', 'loop', 'preferences', 'benchmarks', 'reader-studies', 'grading', 'task-sets', 'tasks', 'scenarios', 'scenario-runs', 'clock', 'panel', 'drafts', 'timeline', 'conditions', 'capabilities', 'research', 'replay', 'mode', 'runs', 'trace', 'branches', 'agents', 'kill-switches', 'shadow', 'proposals', 'hitl', 'gate', 'red-team', 'cases', 'rollouts', 'episodes', 'episodes.jsonl', 'export', 'reward', 'policies', 'horizons', 'ablation', 'capture', 'annotation', 'scribe', 'grades', 'trace-view', 'regression', 'leaderboard', 'models']);
function isApiPath(p) { return p.startsWith('/agent-ops/') && API_AREAS.has(p.split('/')[2]); }

export async function openStore(env = process.env) {
  const adapter = await openAdapter(dbConfig(env));
  await migrate(adapter);
  const store = createStore({ adapter });
  // Speed for large imports: an index on Observation bodies for the critical-result and ECG look-ups, built in the
  // background (CONCURRENTLY, so the server starts and keeps serving while it builds; already there next time).
  if (adapter.dialect === 'postgres' && adapter.pool) (async () => {
    for (const [name, ddl] of [
      ['idx_rv_type_seq', 'ON resource_versions (resource_type, seq DESC)'], // "has anything of this kind changed?" is asked on most requests
      ['idx_rv_patient_type_id', 'ON resource_versions (patient, resource_type, id)'], // a patient's records of one kind, straight from the index
      ['idx_rv_obs_body', "ON resource_versions USING GIN (body jsonb_path_ops) WHERE resource_type = 'Observation'"],
    ]) { try { await adapter.pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ${ddl}`); console.log(`Index ${name} ready`); } catch (err) { console.warn(`Index ${name} not built: ${err.message}`); } }
    try { await adapter.pool.query('ANALYZE resource_versions'); console.log('Table statistics refreshed'); } catch { /* not allowed: fine */ }
  })();
  await ensureLiveRun(store);
  await ensureReferenceAgents(store);
  // Pharmacy verification arrived after orders could be active: tag those once as verified by migration.
  const migrated = await migrateVerified(store);
  if (migrated) console.log(`Pharmacy: ${migrated} active medication order(s) tagged as verified by migration`);
  return store;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const config = dbConfig();
  if (args.has('--reset') || args.has('--reset-demo')) {
    if (config.backend !== 'sqlite') throw new Error('--reset only applies to the local SQLite database');
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.file + suffix, { force: true });
    console.log(`Reset: removed ${path.relative(REPO_ROOT, config.file)}`);
  }
  const store = await openStore();

  // Nothing writes a patient at startup: patients arrive only when someone imports them (npm run import) or enters them.

  // The hospital layout (site, units, rooms, beds) loads once, on an empty database; data/hospital.json is written from the default layout when missing.
  if ((await store.head('Location')).length === 0) {
    // No layout ships with the release: units, rooms and beds come from your own data/hospital.json (npm run import -- --hospital --layout <file>).
    const { readHospitalFile, loadHospital, HOSPITAL_FILE } = await import('../../ehr/server/beds.mjs');
    const locations = readHospitalFile();
    if (locations) { const report = await loadHospital(store, locations); console.log(`Hospital: loaded ${report.written} locations from ${path.relative(REPO_ROOT, HOSPITAL_FILE)}`); }
    else console.log('Hospital: no units or beds yet. Load your layout with npm run import -- --hospital --layout <file>.');
  }

  // Restricted data: no "Try as", and no model or advice service outside this server (local stubs only).
  const restrictedData = process.env.RESTRICTED_DATA === 'true';
  if (restrictedData) { process.env.DEMO_MODE = 'false'; for (const k of ['ALLOW_EXTERNAL_MODELS', 'ALLOW_EXTERNAL_CDS', 'ALLOW_EXTERNAL_AGENTS']) process.env[k] = 'false'; }
  const emailMode = Boolean(process.env.SESSION_SECRET);
  const port = Number(process.env.PORT || 3000);
  const corsOrigins = (process.env.CORS_ORIGINS || `http://localhost:${port},http://127.0.0.1:${port}`).split(',').map((s) => s.trim()).filter(Boolean);
  const server = createApp({ store, corsOrigins, autoRedTeam: process.env.AUTO_RED_TEAM !== 'false', horizonTimer: true,
    auth: emailMode ? { email: { secret: process.env.SESSION_SECRET, restricted: restrictedData, secureCookie: process.env.COOKIE_INSECURE !== 'true' } }
      : { demo: process.env.DEMO_MODE === 'true', adminPassword: process.env.ADMIN_PASSWORD || null } });
  // Open by default only on this computer. With restricted data, or when other computers can reach the platform, sign-in is required.
  const host = process.env.HOST || (emailMode ? '0.0.0.0' : '127.0.0.1'); const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if ((restrictedData || !local) && !emailMode) throw new Error(`${restrictedData ? 'RESTRICTED_DATA=true' : `HOST=${host} lets other computers reach this platform, which`} needs the sign-in: set SESSION_SECRET (npm run session-secret).`);
  console.log(`Database ${config.backend}`);
  if (process.env.WARM_UP !== 'false') { setTimeout(() => server.warm('start'), 3000); setInterval(() => server.warm('keep warm'), 600e3).unref(); }
  server.listen(port, host, () => {
    const base = `http://localhost:${port}`;
    console.log([
      'Healthcare InSilico is running (simulation only, synthetic data only).',
      `  Desktop     ${base}/`,
      `  EHR         ${base}/ehr/`,
      `  PACS        ${base}/pacs/`,
      `  Portal      ${base}/portal/`,
      `  Agent Ops   ${base}/agent-ops/`,
      `  Beds        ${base}/beds/`,
      `  Pharmacy    ${base}/pharmacy/`,
      `  Lab         ${base}/lab/`,
      `  Monitoring  ${base}/monitoring/`,
      `  HL7 v2      POST ${base}/hl7/v2 (text/plain, one message per request)`,
      `  FHIR API    ${base}/fhir/R4/metadata`,
      `  DICOMweb    ${base}/dicom-web/studies`,
      `  Health      ${base}/healthz`,
      `  Database    ${config.backend}${config.file ? ` (${path.relative(REPO_ROOT, config.file)})` : ''}`,
    ].join('\n'));
  });
  const shutdown = async () => { server.close(); await store.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
