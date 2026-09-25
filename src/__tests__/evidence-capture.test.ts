/**
 * C1 evidence capture against a real Chromium and a synthetic offline app
 * (fixtures/evidence-app.ts). No network, no live account, no .env.
 *
 *   1. evidence mode end to end — layout, schema, privacy, classification,
 *      signals, isolation from runs/ and the baseline, and a PASS
 *      from the evidence:check acceptance checker
 *   2. element evidence precision — box against Playwright's own boundingBox,
 *      occlusion by a fixed bar, list-instance detection
 *   3. a failing flow in evidence mode — recorded, contained, and FAILed by the checker
 *   4. normal capture non-regression — same flow without a sink: identical
 *      manifest shape, baseline behaviour, output paths, and the page never
 *      sees an evidence probe
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Browser, BrowserContext } from '@playwright/test';
import { SYNTHETIC_MOBILE, SYNTHETIC_PIN, FIXTURE_ORIGIN, FIXTURE_PII, COURSE_ID, serveFixture } from './fixtures/evidence-app';

import { useSampleApp } from './helpers/sample-app';

// The synthetic Sample App profile, with synthetic credentials in its .env.
useSampleApp({ SIGNIN_MOBILE: SYNTHETIC_MOBILE, SIGNIN_PIN: SYNTHETIC_PIN });
process.env.STEP_TIMEOUT_MS = '5000';

/* eslint-disable @typescript-eslint/no-var-requires */
const { chromium } = require('@playwright/test') as typeof import('@playwright/test');
const { executeFlow } = require('../flow-executor') as typeof import('../flow-executor');
const { EvidenceSink } = require('../manual/evidence-capture') as typeof import('../manual/evidence-capture');
const { loadPiiConfig } = require('../manual/pii-config') as typeof import('../manual/pii-config');
const { validateStepEvidence } = require('../manual/evidence-types') as typeof import('../manual/evidence-types');
const { checkEvidenceRun } = require('../manual/evidence-check') as typeof import('../manual/evidence-check');
const { evidenceRoutes } = require('../manual/evidence-sanitize') as typeof import('../manual/evidence-sanitize');
const { resolveCapture } = require('../flow-loader') as typeof import('../flow-loader');
const { paths } = require('../env') as typeof import('../env');
const { readJson } = require('../fsx') as typeof import('../fsx');
const { loadDevicesConfig } = require('../devices') as typeof import('../devices');
/* eslint-enable @typescript-eslint/no-var-requires */

import type { Flow, FlowStep, KnownRoutes, RunSummary } from '../types';
import type { StepEvidence } from '../manual/evidence-types';

const MODULE = 'zzfixture';
const RUN_ID = '1999-01-01T00-00-00Z';
const RUN_TAG = `SCRSHOT_${RUN_ID}_`;
const DEVICE = loadDevicesConfig().devices.find((d) => d.id === 'Mobile')!;

/** The slice, shaped like the real flows: sign in → courses → a course → a member. */
function sliceFlow(name: string, extra: FlowStep[] = []): Flow {
  const steps: FlowStep[] = [
    { id: '010-sign-in', action: 'goto', value: '/', screenshot: 'viewport', expect_screen: 'sign-in' },
    { id: '015-partial-number', action: 'type', selector: '[data-testid="signin-phone"]', value: '{{PARTIAL}}', run_tag: false },
    { id: '020-full-number', action: 'type', selector: '[data-testid="signin-phone"]', value: '{{SIGNIN_MOBILE}}', run_tag: false },
    { id: '030-continue', action: 'click', selector: '[data-testid="signin-continue"]', assert: { url_contains: '/pin' } },
    { id: '040-enter-pin', action: 'type', selector: '[data-testid="signin-pin"]', value: '{{SIGNIN_PIN}}', run_tag: false, settle_ms: 400 },
    { id: '050-courses', action: 'waitFor', selector: '[data-testid="nav-tab-attendance"]', assert: { url_contains: '/courses' } },
    { id: '060-add-member-form', action: 'click', selector: '[data-testid="courses-add-member"]', screenshot: 'viewport', assert: { selector_visible: '[data-testid="member-close"]' } },
    { id: '070-close-form', action: 'click', selector: '[data-testid="member-close"]' },
    { id: '080-open-course', action: 'click', selector: '[data-testid^="courses-open-"]', assert: { url_contains: '/course/' } },
    { id: '085-roster-row-under-bar', action: 'scrollTo', selector: '[data-testid="roster-row-under-bar"]' },
    { id: '090-search-roster', action: 'type', selector: '[data-testid="course-member-search"]', value: 'a', run_tag: false },
    { id: '100-open-member', action: 'click', selector: 'role=button[name=/, (active|inactive)\\. /]', assert: { url_contains: '/member/' } },
    ...extra,
  ];
  for (const s of steps) {
    const spec = resolveCapture(s, 'steps');
    if (typeof spec === 'string') throw new Error(`fixture step ${s.id}: ${spec}`);
    s._capture = spec;
  }
  return { schema_version: 2, module: MODULE, flow: name, title: name, auth: 'none', vars: { PARTIAL: '90000' }, depends_on_routes: ['/courses', '/course/[id]', '/member/[id]'], steps };
}

let browser: Browser;
async function fixtureContext(): Promise<{ context: BrowserContext; server: { probeInstalls: number } }> {
  const context = await browser.newContext({
    baseURL: FIXTURE_ORIGIN, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, reducedMotion: 'reduce',
  });
  context.setDefaultTimeout(5000);
  const server = await serveFixture(context);
  return { context, server };
}

function newSink(root: string) {
  const known = readJson<KnownRoutes>(paths.knownRoutes, { last_checked: '', routes: [] }).routes;
  return new EvidenceSink({
    runId: RUN_ID, root, knownRoutes: evidenceRoutes(known, [sliceFlow('x')]), pii: loadPiiConfig(), devices: [DEVICE],
    identifiers: [{ name: 'SIGNIN_MOBILE', digits: SYNTHETIC_MOBILE }], secrets: [SYNTHETIC_PIN],
  });
}

function summaryFor(runs: Array<{ module: string; flow: string; status: string }>): RunSummary {
  return {
    run_id: RUN_ID, app_id: 'sample-app', started_at: '', finished_at: '', app_git_sha: null, app_repo_available: false,
    env: { app_url: FIXTURE_ORIGIN, app_host: 'fixture.test' }, write_mode: 'off', run_tag: RUN_TAG, devices: [DEVICE.id],
    totals: { flows_total: runs.length, flows_run: runs.length, flows_skipped: 0, flows_failed: 0, flows_changed: 0, screenshots: 0 },
    flows: runs.map((r) => ({ ...r, device: DEVICE.id, status: r.status as RunSummary['flows'][0]['status'], reason: 'test', duration_ms: 0 })),
    flagged: [],
  };
}

function allFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/** runs/sample-app/<RUN_ID>/ — where a normal (non-evidence) capture writes. */
const runDir = path.join(paths.runs, RUN_ID);
const execOpts = { runId: RUN_ID, runDir, runTag: RUN_TAG, device: DEVICE, appGitSha: null, reason: 'test' };
const tmpRoots: string[] = [];

before(async () => {
  // This must not pre-exist: the tests assert on and then remove exactly what they create.
  assert.equal(fs.existsSync(runDir), false, `${runDir} already exists`);
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  fs.rmSync(runDir, { recursive: true, force: true });
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

const tmpRoot = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-run-')); tmpRoots.push(d); return d; };
const read = (root: string, flow: string, step: string) =>
  JSON.parse(fs.readFileSync(path.join(root, DEVICE.id, MODULE, flow, `${step}.evidence.json`), 'utf8')) as StepEvidence;

// ─── 1. evidence mode end to end ─────────────────────────────────────────────

test('evidence mode captures the slice with complete, private, isolated evidence', async () => {
  const root = tmpRoot();
  const sink = newSink(root);
  const flow = sliceFlow('evidence-slice');
  const baseline = {};
  const { context, server } = await fixtureContext();
  let run;
  try {
    run = await executeFlow(context, flow, { ...execOpts, baseline, evidence: sink });
  } finally {
    await context.close();
  }
  sink.finish(summaryFor([run]));

  // The flow itself behaved exactly as it would without evidence.
  assert.equal(run.status, 'unchanged', JSON.stringify(run.errors));
  assert.deepEqual(run.steps.map((s) => s.status), flow.steps.map(() => 'ok'));
  assert.ok(server.probeInstalls > 0, 'evidence mode installs its probes');

  // Isolation: nothing under runs/ or the baseline.
  assert.equal(fs.existsSync(runDir), false, 'evidence mode wrote into runs/');
  assert.deepEqual(baseline, {}, 'evidence mode touched the fingerprint baseline');
  assert.ok(run.steps.every((s) => s.fingerprint === null), 'evidence mode judged fingerprints');
  assert.ok(fs.existsSync(path.join(root, 'runs', DEVICE.id, `${MODULE}-evidence-slice.flow-run.json`)));
  assert.ok(fs.existsSync(path.join(root, DEVICE.id, 'screenshots', MODULE, 'evidence-slice', '010-sign-in.viewport.png')));
  assert.ok(run.steps.find((s) => s.id === '010-sign-in')!.dom_hash, 'the DOM hash is still recorded');

  // Layout + schema: one document per step, frames where required.
  for (const step of flow.steps) {
    const doc = read(root, 'evidence-slice', step.id);
    assert.deepEqual(validateStepEvidence(doc), [], `${step.id} schema`);
    assert.ok(doc.after.frame, `${step.id} has a post-frame`);
    if (!['goto', 'waitFor'].includes(step.action)) {
      assert.ok(doc.before.frame, `${step.id} has a pre-frame`);
      assert.ok(doc.target?.box, `${step.id} has a described target with a box`);
      assert.equal(doc.before.frame!.dpr, 2);
      assert.equal(doc.before.frame!.image.width, 780);
    }
  }

  // Privacy: no fixture personal data, identifier or PIN anywhere in any text file.
  for (const file of allFiles(root).filter((f) => !f.endsWith('.png'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pii of FIXTURE_PII) assert.equal(text.includes(pii), false, `${path.relative(root, file)} contains a fixture PII string`);
    assert.doesNotMatch(text, /(?<![0-9A-Za-z])4826(?![0-9A-Za-z])/, `${path.relative(root, file)} contains the PIN`);
    assert.doesNotMatch(text, /@example\.com/, `${path.relative(root, file)} contains an email`);
  }

  // Inputs: tokens for the PIN and the number, L text only for the literal search.
  const partial = read(root, 'evidence-slice', '015-partial-number');
  assert.equal(partial.input?.class, 'I');
  const number = read(root, 'evidence-slice', '020-full-number');
  assert.equal(number.input?.class, 'I');
  assert.equal(number.input?.token, '«redacted:SIGNIN_MOBILE»');
  assert.deepEqual(number.target?.sensitive, { kind: 'identifier', var: 'SIGNIN_MOBILE' });
  assert.ok(number.after.census.some((c) => c.class === 'I' && c.rule.startsWith('identifier')), 'the on-screen echo of the number is I');
  const pin = read(root, 'evidence-slice', '040-enter-pin');
  assert.equal(pin.input?.class, 'S');
  assert.equal(pin.input?.token, '«redacted»');
  assert.equal(pin.before.census.find((c) => c.source === 'text' && c.class === 'I')?.rule, 'identifier:SIGNIN_MOBILE', 'the PIN screen number line is I');
  const search = read(root, 'evidence-slice', '090-search-roster');
  assert.equal(search.input?.class, 'L');
  assert.equal(search.input?.text, 'a');

  // Classification of targets.
  const cont = read(root, 'evidence-slice', '030-continue');
  assert.equal(cont.target?.name.class, 'L');
  assert.equal(cont.target?.name.text, 'Continue');
  assert.equal(cont.target?.selector_kind, 'testid');
  assert.equal(cont.target?.match_count, 1);
  assert.equal(cont.target?.list_instance, false);
  const card = read(root, 'evidence-slice', '080-open-course');
  assert.equal(card.target?.testid, null, 'an id-suffixed test id is never stored whole');
  assert.equal(card.target?.testid_family, 'courses-open-*');
  assert.equal(card.target?.list_instance, true);
  assert.equal(card.target?.name.class, 'P');
  assert.equal(card.target?.name.rule, 'region:course-cards');
  assert.equal(card.before.census.find((c) => c.region_id === 'org-header')?.class, 'O');

  // Record screens and labels.
  const openMember = read(root, 'evidence-slice', '100-open-member');
  assert.equal(openMember.after.url.pattern, '/member/[id]');
  assert.equal(openMember.after.url.record_screen, true);
  assert.equal(openMember.target?.name.rule, 'region:course-roster-rows');
  const heading = openMember.after.census.find((c) => c.class !== 'L' && c.source === 'text' && c.region_id === null);
  assert.ok(heading, 'the member-name heading on the record screen is not a label');
  assert.ok(openMember.after.census.some((c) => c.rule === 'region:member-record'));
  const form = read(root, 'evidence-slice', '060-add-member-form');
  assert.ok(form.after.census.some((c) => c.class === 'L' && c.text === 'e.g. Anitha Rajesh'), 'an app placeholder that looks like a name is L');
  assert.ok(form.after.census.some((c) => c.class === 'L' && c.text === 'Welcome a new member'));

  // Signals from the before/after diff.
  assert.ok(cont.signals.includes('route'));
  assert.ok(form.signals.includes('overlays'));
  assert.ok(search.signals.includes('lists'));

  // Run summary, label review, and the acceptance checker.
  assert.ok(fs.existsSync(path.join(root, 'evidence-summary.json')));
  const review = fs.readFileSync(path.join(root, 'label-review.txt'), 'utf8');
  assert.match(review, /"Welcome a new member"/);
  const result = checkEvidenceRun({
    runDir: root, expectedDpr: 2, requireFlows: [`${MODULE}/evidence-slice`],
    identifiers: [{ name: 'SIGNIN_MOBILE', digits: SYNTHETIC_MOBILE }], secrets: [SYNTHETIC_PIN],
  });
  assert.deepEqual(result.findings.filter((f) => f.severity === 'error'), []);
  assert.equal(result.passed, true);
  assert.equal(result.steps, flow.steps.length);
});

// ─── 2. element evidence precision ───────────────────────────────────────────

test('target box matches Playwright, and a row under the fixed bar is reported occluded', async () => {
  const root = tmpRoot();
  const sink = newSink(root);
  const flow = sliceFlow('precision');
  const { context } = await fixtureContext();
  try {
    const page = await context.newPage();
    await page.goto(`/course/${COURSE_ID}`);
    const step: FlowStep = { id: '085-roster-row-under-bar', action: 'scrollTo', selector: '[data-testid="roster-row-under-bar"]' };
    const pre = await sink.before(page, DEVICE, flow, step, step.selector!, []);
    assert.deepEqual(pre.errors, []);
    const pw = await page.locator(step.selector!).first().boundingBox();
    assert.ok(pw && pre.target?.box);
    for (const k of ['x', 'y'] as const) assert.ok(Math.abs(pre.target!.box![k] - pw![k]) <= 1, `box.${k}`);
    assert.ok(Math.abs(pre.target!.box!.w - pw!.width) <= 1, 'box.w');
    assert.ok(Math.abs(pre.target!.box!.h - pw!.height) <= 1, 'box.h');
    assert.equal(pre.target?.in_viewport, 'full');
    assert.equal(pre.target?.occluded_by, 'testid:bottom-bar');
    assert.equal(pre.target?.selector_kind, 'testid');
    assert.equal(pre.target?.name.rule, 'region:course-roster-rows', 'a roster row stays P even with a static test id');

    const clearStep: FlowStep = { id: '090-search-roster', action: 'type', selector: '[data-testid="course-member-search"]', value: 'a', run_tag: false };
    const clear = await sink.before(page, DEVICE, flow, clearStep, clearStep.selector!, []);
    assert.equal(clear.target?.occluded_by, null);
    assert.equal(clear.target?.name.class, 'L', 'a placeholder-named search box is L');
    await page.close();
  } finally {
    await context.close();
  }
});

// ─── 3. failing flow in evidence mode (negative) ─────────────────────────────

test('a failing step is recorded as evidence, contained to the evidence run, and FAILs the checker', async () => {
  const root = tmpRoot();
  const sink = newSink(root);
  const flow = sliceFlow('failing', [{ id: '110-missing-control', action: 'click', selector: '[data-testid="does-not-exist"]' }]);
  const { context } = await fixtureContext();
  let run;
  try {
    run = await executeFlow(context, flow, { ...execOpts, baseline: {}, evidence: sink });
  } finally {
    await context.close();
  }
  sink.finish(summaryFor([run]));

  assert.equal(run.status, 'failed');
  const doc = read(root, 'failing', '110-missing-control');
  assert.deepEqual(validateStepEvidence(doc), []);
  assert.equal(doc.status, 'failed');
  assert.ok(doc.error && doc.error.includes('does-not-exist'));
  assert.equal(doc.target, null);
  assert.ok(doc.after.frame, 'the failure state is framed');
  assert.ok(fs.existsSync(path.join(root, DEVICE.id, 'screenshots', MODULE, 'failing', '110-missing-control.failed.png')), 'failure shot stays inside the evidence run');
  assert.equal(fs.existsSync(runDir), false);

  const result = checkEvidenceRun({
    runDir: root, expectedDpr: 2, requireFlows: [`${MODULE}/failing`],
    identifiers: [{ name: 'SIGNIN_MOBILE', digits: SYNTHETIC_MOBILE }], secrets: [SYNTHETIC_PIN],
  });
  assert.equal(result.passed, false);
  assert.ok(result.findings.some((f) => f.check === 'required-flow'));
  assert.equal(result.findings.some((f) => f.check.startsWith('privacy')), false);
});

// ─── 4. normal capture non-regression ────────────────────────────────────────

const STEP_RESULT_KEYS = [
  'id', 'action', 'phase', 'selector', 'input', 'result', 'status', 'next_screen', 'screenshot_path', 'screenshot_paths',
  'capture_mode', 'visual_signals', 'capture_skipped_reason', 'dom_hash', 'fingerprint', 'duration_ms',
];
const OPTIONAL_STEP_RESULT_KEYS = ['unstable', 'error'];
const FLOW_RUN_KEYS = ['module', 'flow', 'device', 'run_id', 'app_git_sha', 'status', 'reason', 'started_at', 'duration_ms', 'steps', 'screenshots', 'errors'];

test('normal capture (no sink) is unchanged: manifest shape, baseline, output paths, and no probes in the page', async () => {
  const flow = sliceFlow('normal-slice');
  const baseline: Record<string, unknown> = {};
  const evidenceBefore = allFiles(paths.evidence).length;
  const { context, server } = await fixtureContext();
  let run;
  try {
    run = await executeFlow(context, flow, { ...execOpts, baseline: baseline as never });
  } finally {
    await context.close();
  }

  assert.equal(run.status, 'new', JSON.stringify(run.errors));
  assert.equal(server.probeInstalls, 0, 'normal capture injected an evidence probe');
  assert.equal(allFiles(paths.evidence).length, evidenceBefore, 'normal capture wrote under evidence/');

  assert.deepEqual(Object.keys(run).sort(), [...FLOW_RUN_KEYS].sort());
  for (const s of run.steps) {
    const keys = Object.keys(s);
    for (const k of STEP_RESULT_KEYS) assert.ok(keys.includes(k), `${s.id} lacks ${k}`);
    for (const k of keys) assert.ok(STEP_RESULT_KEYS.includes(k) || OPTIONAL_STEP_RESULT_KEYS.includes(k), `${s.id} has unexpected key ${k}`);
  }

  // Captured steps compare against, and seed, the baseline exactly as before.
  const captured = run.steps.filter((s) => s.screenshot_paths.length);
  assert.deepEqual(captured.map((s) => s.id), ['010-sign-in', '060-add-member-form']);
  for (const s of captured) {
    assert.equal(s.fingerprint, 'new');
    assert.ok(baseline[`${DEVICE.id}/${MODULE}/normal-slice/${s.id}`], `baseline entry for ${s.id}`);
  }
  // runs/<app-id>/<run-id>/<Device>/<module>/<flow>/<step>.<mode>.png
  assert.deepEqual(captured[0].screenshot_paths, [`runs/sample-app/${RUN_ID}/${DEVICE.id}/${MODULE}/normal-slice/010-sign-in.viewport.png`]);
  assert.ok(fs.existsSync(path.join(runDir, DEVICE.id, MODULE, 'normal-slice', '010-sign-in.viewport.png')));
  assert.ok(fs.existsSync(path.join(runDir, DEVICE.id, `${MODULE}-normal-slice.flow-run.json`)));

  // P0 redaction still holds in the normal manifest.
  const manifest = fs.readFileSync(path.join(runDir, DEVICE.id, `${MODULE}-normal-slice.flow-run.json`), 'utf8');
  assert.equal(manifest.includes(SYNTHETIC_MOBILE), false);
  assert.match(manifest, /«redacted:SIGNIN_MOBILE»/);
});
