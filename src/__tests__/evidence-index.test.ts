/**
 * C2 Evidence Index — everything testable without a browser: frame identity and
 * provenance, the classification and exclusion rules (including the failed,
 * loading, unstable and transitional cases a healthy run never produces),
 * canonical selection, required-vs-optional coverage, label templating, the
 * carried review items, and the index checker against tampered fixtures.
 *
 * All personal-looking values are synthetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { useSampleApp } from './helpers/sample-app';

useSampleApp({ SIGNIN_MOBILE: '9000048261', SIGNIN_PIN: '4826' });

/* eslint-disable @typescript-eslint/no-var-requires */
const idx = require('../manual/evidence-index') as typeof import('../manual/evidence-index');
const idxTypes = require('../manual/evidence-index-types') as typeof import('../manual/evidence-index-types');
const idxCheck = require('../manual/evidence-index-check') as typeof import('../manual/evidence-index-check');
/* eslint-enable @typescript-eslint/no-var-requires */

import type { Flow, FlowRun, StepResult } from '../types';
import type { CensusEntry, PhaseEvidence, StepEvidence } from '../manual/evidence-types';
import type { EvidenceIndex } from '../manual/evidence-index-types';

const IDENTIFIERS = [{ name: 'SIGNIN_MOBILE', digits: '9000048261' }];
const SECRETS = ['4826'];
const RUN_ID = '2026-09-15T00-00-00Z';

// ─── fixture helpers ─────────────────────────────────────────────────────────

/** A real PNG header: signature + IHDR + IEND. Nothing here decodes pixels. */
function png(width: number, height: number, salt = ''): Buffer {
  const sig = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; ihdr[17] = 6;
  const iend = Buffer.concat([Buffer.alloc(4), Buffer.from('IEND'), Buffer.alloc(4)]);
  return Buffer.concat([sig, ihdr, iend, Buffer.from(salt)]);
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

function tmpRun(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c2-')), RUN_ID);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(runDir: string, rel: string, buf: Buffer | string): void {
  const abs = path.join(runDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
}

interface FrameOpts { stable?: boolean; reason?: string; width?: number; height?: number; salt?: string }

function frameRef(runDir: string, rel: string, kind: 'pre' | 'post', o: FrameOpts = {}) {
  const width = o.width ?? 780;
  const height = o.height ?? 1688;
  const buf = png(width, height, o.salt ?? rel);
  writeFile(runDir, rel, buf);
  return {
    path: rel, kind, mode: 'viewport' as const,
    image: { width, height },
    viewport: { width: 390, height: 844 },
    dpr: 2,
    scroll: { x: 0, y: 0, containers: [] },
    origin: null,
    png_sha256: sha(buf),
    stable: o.stable ?? true,
    stability_reason: o.reason ?? 'settled',
    masked: [],
  };
}

const census = (entries: Array<Partial<CensusEntry> & { class: CensusEntry['class'] }>): CensusEntry[] =>
  entries.map((e, i) => ({
    class: e.class,
    rule: e.rule ?? 'static-control',
    length: (e.text ?? '').length,
    sha256: 'a'.repeat(64),
    text: e.text,
    source: e.source ?? 'text',
    box: { x: 0, y: i * 20, w: 10, h: 10 },
    region_id: null,
    testid_family: null,
  })) as CensusEntry[];

function phase(o: Partial<PhaseEvidence> & { pattern?: string; visualPattern?: string; loading?: string[] } = {}): PhaseEvidence {
  const pattern = o.pattern ?? '/courses';
  const url = { pattern, path_sha256: 'b'.repeat(64), query: [] as any[], record_screen: pattern.includes('[') };
  return {
    url,
    visual: {
      route: { ...url, pattern: o.visualPattern ?? pattern },
      overlays: [], scroll_tops: [], visible_keys: [], lists: [], errors: [], toasts: [],
      active_tab: '', loading: o.loading ?? [], disabled: [],
    },
    frame: o.frame ?? null,
    census: o.census ?? census([{ class: 'L', text: 'Attendance', rule: 'label-allowlist' }]),
    census_truncated: o.census_truncated ?? false,
    inventory: [],
  };
}

function stepDoc(o: {
  module: string; flow: string; stepId: string; device?: string; action?: StepEvidence['action']; status?: StepEvidence['status'];
  before?: PhaseEvidence; after?: PhaseEvidence; target?: boolean; occluded?: number; errors?: string[];
}): StepEvidence {
  return {
    schema: 2, run_id: RUN_ID, device: o.device ?? 'Mobile', module: o.module, flow: o.flow, step_id: o.stepId,
    phase: 'steps', action: o.action ?? 'click', input: null,
    target: o.target === false ? null : {
      testid: 'ctl', testid_family: 'ctl', role: 'button', tag: 'button', input_type: null,
      name: { class: 'L', rule: 'static-control', length: 4, sha256: 'c'.repeat(64), text: 'Open' },
      name_source: 'aria-label',
      visible_text: { class: 'L', rule: 'static-control', length: 4, sha256: 'c'.repeat(64), text: 'Open' },
      box: { x: 1, y: 2, w: 3, h: 4 }, in_viewport: 'full', occluded_by: null,
      occlusion: { points: 5, clear: o.occluded ?? 5 }, enabled: true, region_id: null,
      ref: `${o.module}/${o.flow}/${o.stepId}#target`, selector: '[data-testid="ctl"]', selector_kind: 'testid',
      match_count: 1, list_instance: false, sensitive: null,
    },
    target_reason: o.target === false ? 'selector matched no element before the action' : null,
    before: o.before ?? phase(),
    after: { ...(o.after ?? phase()), dom_hash: 'd'.repeat(64) },
    signals: [], assertions: [], status: o.status ?? 'ok', error: null,
    evidence_errors: o.errors ?? [], captured_at: '2026-09-15T00:00:01.000Z',
  } as StepEvidence;
}

function stepResult(o: Partial<StepResult> & { id: string }): StepResult {
  return {
    id: o.id, action: o.action ?? 'click', phase: o.phase ?? 'steps', selector: '[data-testid="ctl"]', input: null,
    result: 'clicked', status: o.status ?? 'ok', next_screen: o.next_screen ?? null,
    screenshot_path: o.screenshot_paths?.[0] ?? null, screenshot_paths: o.screenshot_paths ?? [],
    capture_mode: o.capture_mode ?? 'none', visual_signals: null, capture_skipped_reason: null,
    dom_hash: null, fingerprint: null, unstable: o.unstable, duration_ms: 1,
  };
}

function flowRun(runDir: string, module: string, flow: string, steps: StepResult[], status: FlowRun['status'] = 'unchanged', device = 'Mobile'): void {
  const run: FlowRun = {
    module, flow, device, run_id: RUN_ID, app_git_sha: 'abc123', status, reason: 'forced',
    started_at: '2026-09-15T00:00:00.000Z', duration_ms: 10, steps,
    screenshots: steps.flatMap((s) => s.screenshot_paths), errors: [],
  };
  writeFile(runDir, `runs/${device}/${module}-${flow}.flow-run.json`, JSON.stringify(run, null, 2) + '\n');
}

function manifest(module: string, flow: string, steps: Flow['steps']): Flow {
  return { schema_version: 2, module, flow, title: `${flow} title`, steps, _sourcePath: `flows/${module}.${flow}.yaml` } as Flow;
}

function options(runDir: string, flows: Flow[], required: string[]): import('../manual/evidence-index').BuildOptions {
  return {
    runDir, flows,
    manifestHashes: Object.fromEntries(flows.map((f) => [`${f.module}/${f.flow}`, 'e'.repeat(64)])),
    requiredFlows: required,
    expectedDpr: 2,
    reviewItems: [],
    reviewItemsSha256: null,
    repoRoot: path.dirname(runDir),
  };
}

/** One healthy flow: a goto, a required interaction, an optional skipped one. */
function healthyRun(): { runDir: string; flows: Flow[]; required: string[] } {
  const runDir = tmpRun();
  const m = 'mod';
  const f = 'flow';
  writeFile(runDir, `Mobile/${m}/${f}/010-open.evidence.json`, JSON.stringify(stepDoc({
    module: m, flow: f, stepId: '010-open',
    before: phase({ frame: frameRef(runDir, `Mobile/${m}/${f}/010-open.pre.png`, 'pre') }),
    after: phase({ pattern: '/course/[id]', frame: frameRef(runDir, `Mobile/${m}/${f}/010-open.post.png`, 'post') }),
  }), null, 2) + '\n');
  writeFile(runDir, `Mobile/${m}/${f}/020-optional.evidence.json`, JSON.stringify(stepDoc({
    module: m, flow: f, stepId: '020-optional', status: 'skipped', target: false,
    before: phase({ pattern: '/course/[id]', frame: frameRef(runDir, `Mobile/${m}/${f}/020-optional.pre.png`, 'pre') }),
    after: phase({ pattern: '/course/[id]', frame: frameRef(runDir, `Mobile/${m}/${f}/020-optional.post.png`, 'post') }),
  }), null, 2) + '\n');
  const shot = `evidence/${RUN_ID}/Mobile/screenshots/${m}/${f}/010-open.viewport.png`;
  writeFile(runDir, `Mobile/screenshots/${m}/${f}/010-open.viewport.png`, png(780, 1688, 'shot'));
  const failed = `evidence/${RUN_ID}/Mobile/screenshots/${m}/${f}/020-optional.failed.png`;
  writeFile(runDir, `Mobile/screenshots/${m}/${f}/020-optional.failed.png`, png(780, 1688, 'failed'));
  flowRun(runDir, m, f, [
    stepResult({ id: '010-open', next_screen: 'course-detail', capture_mode: 'viewport', screenshot_paths: [shot] }),
    stepResult({ id: '020-optional', status: 'skipped', next_screen: 'branch-open', screenshot_paths: [failed] }),
  ]);
  writeFile(runDir, 'evidence-check.json', JSON.stringify({ passed: true, files: 1, steps: 2, findings: [] }, null, 2) + '\n');
  const flows = [manifest(m, f, [
    { id: '010-open', action: 'click', label: 'Open it', expect_screen: 'course-detail', screenshot: 'viewport' },
    { id: '020-optional', action: 'click', label: 'Optional', expect_screen: 'branch-open', optional: true, screenshot: 'viewport' },
  ] as Flow['steps'])];
  return { runDir, flows, required: ['mod/flow'] };
}

const build = (runDir: string, flows: Flow[], required: string[]): EvidenceIndex => idx.buildEvidenceIndex(options(runDir, flows, required));
const frameOf = (index: EvidenceIndex, id: string) => index.frames.find((f) => f.frame_id === id)!;

function writeIndex(runDir: string, flows: Flow[], required: string[]): EvidenceIndex {
  const index = build(runDir, flows, required);
  writeFile(runDir, `${idx.INDEX_DIR}/${idx.INDEX_FILE}`, JSON.stringify(index, null, 2) + '\n');
  writeFile(runDir, `${idx.INDEX_DIR}/${idx.COVERAGE_FILE}`, idx.renderCoverage(index));
  return index;
}

const runCheck = (runDir: string, flows: Flow[], required: string[]) =>
  idxCheck.checkEvidenceIndex({ ...options(runDir, flows, required), identifiers: IDENTIFIERS, secrets: SECRETS });

// ─── 1. identity, provenance, and indexing every frame ───────────────────────

test('every captured PNG is indexed once, with provenance back to the C1 evidence', () => {
  const { runDir, flows, required } = healthyRun();
  const index = build(runDir, flows, required);

  assert.deepEqual(idxTypes.validateEvidenceIndex(index), []);
  const onDisk = ['Mobile/mod/flow/010-open.post.png', 'Mobile/mod/flow/010-open.pre.png', 'Mobile/mod/flow/020-optional.post.png',
    'Mobile/mod/flow/020-optional.pre.png', 'Mobile/screenshots/mod/flow/010-open.viewport.png', 'Mobile/screenshots/mod/flow/020-optional.failed.png'];
  assert.deepEqual(index.frames.map((f) => f.file.path).sort(), onDisk.sort());
  assert.equal(new Set(index.frames.map((f) => f.frame_id)).size, index.frames.length);

  const post = frameOf(index, 'Mobile/mod/flow/010-open#post');
  assert.equal(post.provenance.evidence_file, 'Mobile/mod/flow/010-open.evidence.json');
  assert.equal(post.provenance.evidence_pointer, 'after.frame');
  assert.equal(post.provenance.flow_run_file, 'runs/Mobile/mod-flow.flow-run.json');
  assert.equal(post.provenance.flow_run_step_index, 0);
  assert.equal(post.provenance.manifest_file, 'flows/mod.flow.yaml');
  assert.equal(post.provenance.app_git_sha, 'abc123');
  assert.equal(post.provenance.captured_at, '2026-09-15T00:00:01.000Z');
  assert.equal(post.file.png_sha256, sha(fs.readFileSync(path.join(runDir, post.file.path))));
  // The frame id is run-independent, so the same step compares across runs.
  assert.ok(!post.frame_id.includes(RUN_ID));

  const viewport = frameOf(index, 'Mobile/mod/flow/010-open#viewport');
  assert.equal(viewport.kind, 'capture-viewport');
  assert.equal(viewport.provenance.source, 'flow-run');
  assert.equal(viewport.same_state_as, 'Mobile/mod/flow/010-open#post');
  assert.ok(viewport.notes.includes('no-paired-census'));
});

test('a PNG nothing references is indexed and excluded', () => {
  const { runDir, flows, required } = healthyRun();
  writeFile(runDir, 'screenshots/mod/flow/stray.png', png(10, 10, 'stray'));
  const index = build(runDir, flows, required);
  const stray = frameOf(index, 'file:screenshots/mod/flow/stray.png');
  assert.equal(stray.kind, 'unreferenced');
  assert.equal(stray.suitability, 'excluded');
  assert.deepEqual(stray.exclusions, ['unreferenced-file']);
  assert.equal(stray.step, null);
});

test('a referenced frame that does not exist fails the build loudly', () => {
  const { runDir, flows, required } = healthyRun();
  fs.rmSync(path.join(runDir, 'Mobile/mod/flow/010-open.post.png'));
  assert.throws(() => build(runDir, flows, required), /does not exist in the evidence run/);
});

// ─── 2. classification ───────────────────────────────────────────────────────

test('frames are classified by flow, route, screen, step and purpose', () => {
  const { runDir, flows, required } = healthyRun();
  const index = build(runDir, flows, required);
  const pre = frameOf(index, 'Mobile/mod/flow/010-open#pre');
  const post = frameOf(index, 'Mobile/mod/flow/010-open#post');

  assert.equal(pre.flow, 'mod/flow');
  assert.equal(pre.purpose, 'control-location');
  assert.equal(pre.route!.pattern, '/courses');
  assert.equal(post.purpose, 'step-result');
  assert.equal(post.route!.pattern, '/course/[id]');
  assert.equal(post.route!.record_screen, true);
  assert.equal(post.screen.name, 'course-detail');
  assert.equal(post.screen.source, 'step.expect_screen');
  assert.deepEqual(post.step!.required, true);
  assert.equal(post.step!.label, 'Open it');
});

test('a screen is never invented: an undeclared step leaves the frame unnamed', () => {
  const runDir = tmpRun();
  writeFile(runDir, 'Mobile/mod/flow/010-x.evidence.json', JSON.stringify(stepDoc({
    module: 'mod', flow: 'flow', stepId: '010-x',
    before: phase({ frame: frameRef(runDir, 'Mobile/mod/flow/010-x.pre.png', 'pre') }),
    after: phase({ frame: frameRef(runDir, 'Mobile/mod/flow/010-x.post.png', 'post') }),
  }), null, 2) + '\n');
  flowRun(runDir, 'mod', 'flow', [stepResult({ id: '010-x' })]);
  const flows = [manifest('mod', 'flow', [{ id: '010-x', action: 'click' }] as Flow['steps'])];
  const index = build(runDir, flows, ['mod/flow']);
  const post = frameOf(index, 'Mobile/mod/flow/010-x#post');
  assert.equal(post.screen.name, null);
  assert.equal(post.screen.source, 'undeclared');
  assert.ok(post.notes.includes('screen-undeclared'));
  assert.equal(post.canonical_role, null, 'an unnamed screen is never canonical');
});

test('a before-frame takes its screen from the previous ok step, never from its own', () => {
  const { runDir, flows, required } = healthyRun();
  const index = build(runDir, flows, required);
  const pre = frameOf(index, 'Mobile/mod/flow/020-optional#pre');
  assert.equal(pre.screen.name, 'course-detail');
  assert.equal(pre.screen.source, 'previous-step.expect_screen');
});

// ─── 3. exclusions ───────────────────────────────────────────────────────────

test('failed, skipped and failure-capture frames are excluded from canonical evidence', () => {
  const { runDir, flows, required } = healthyRun();
  const index = build(runDir, flows, required);
  for (const id of ['Mobile/mod/flow/020-optional#pre', 'Mobile/mod/flow/020-optional#post']) {
    const f = frameOf(index, id);
    assert.equal(f.suitability, 'excluded');
    assert.deepEqual(f.exclusions, ['step-skipped']);
    assert.equal(f.canonical_role, null);
  }
  const failed = frameOf(index, 'Mobile/mod/flow/020-optional#failed');
  assert.equal(failed.kind, 'capture-failed');
  assert.equal(failed.purpose, 'failure-diagnostic');
  assert.deepEqual(failed.exclusions, ['failure-capture', 'step-skipped']);
});

test('loading, unstable, transitional, truncated, secret-bearing and error frames are excluded', () => {
  const runDir = tmpRun();
  const m = 'mod';
  const f = 'flow';
  const mk = (id: string, docOpts: Parameters<typeof stepDoc>[0]) =>
    writeFile(runDir, `Mobile/${m}/${f}/${id}.evidence.json`, JSON.stringify(stepDoc(docOpts), null, 2) + '\n');

  mk('010-unstable', {
    module: m, flow: f, stepId: '010-unstable',
    before: phase({ frame: frameRef(runDir, `Mobile/${m}/${f}/010-unstable.pre.png`, 'pre') }),
    after: phase({ frame: frameRef(runDir, `Mobile/${m}/${f}/010-unstable.post.png`, 'post', { stable: false, reason: 'DOM still changing after 8000ms' }) }),
  });
  mk('020-loading', {
    module: m, flow: f, stepId: '020-loading',
    before: phase({ frame: frameRef(runDir, `Mobile/${m}/${f}/020-loading.pre.png`, 'pre') }),
    after: phase({ frame: frameRef(runDir, `Mobile/${m}/${f}/020-loading.post.png`, 'post'), loading: ['testid:spinner'] }),
  });
  mk('030-transitional', {
    module: m, flow: f, stepId: '030-transitional',
    before: phase({ frame: frameRef(runDir, `Mobile/${m}/${f}/030-transitional.pre.png`, 'pre') }),
    after: phase({ frame: frameRef(runDir, `Mobile/${m}/${f}/030-transitional.post.png`, 'post'), pattern: '/courses', visualPattern: '/course/[id]' }),
  });
  mk('040-truncated', {
    module: m, flow: f, stepId: '040-truncated',
    before: phase({ frame: frameRef(runDir, `Mobile/${m}/${f}/040-truncated.pre.png`, 'pre') }),
    after: phase({ frame: frameRef(runDir, `Mobile/${m}/${f}/040-truncated.post.png`, 'post'), census_truncated: true }),
  });
  mk('050-secret', {
    module: m, flow: f, stepId: '050-secret',
    before: phase({ frame: frameRef(runDir, `Mobile/${m}/${f}/050-secret.pre.png`, 'pre') }),
    after: phase({ frame: frameRef(runDir, `Mobile/${m}/${f}/050-secret.post.png`, 'post'), census: census([{ class: 'S', rule: 'secret-value' }]) }),
  });
  mk('060-everr', {
    module: m, flow: f, stepId: '060-everr', errors: ['describe: failed'],
    before: phase({ frame: frameRef(runDir, `Mobile/${m}/${f}/060-everr.pre.png`, 'pre') }),
    after: phase({ frame: frameRef(runDir, `Mobile/${m}/${f}/060-everr.post.png`, 'post') }),
  });
  const loadingShot = `evidence/${RUN_ID}/Mobile/screenshots/${m}/${f}/010-unstable.loading.png`;
  writeFile(runDir, `Mobile/screenshots/${m}/${f}/010-unstable.loading.png`, png(780, 1688, 'loading'));

  const ids = ['010-unstable', '020-loading', '030-transitional', '040-truncated', '050-secret', '060-everr'];
  flowRun(runDir, m, f, ids.map((id, i) => stepResult({
    id, next_screen: `screen-${i}`,
    unstable: id === '010-unstable' ? true : undefined,
    screenshot_paths: id === '010-unstable' ? [loadingShot] : [],
  })));
  const flows = [manifest(m, f, ids.map((id, i) => ({ id, action: 'click', expect_screen: `screen-${i}` })) as Flow['steps'])];
  const index = build(runDir, flows, ['mod/flow']);

  const ex = (id: string) => frameOf(index, id).exclusions;
  assert.deepEqual(ex('Mobile/mod/flow/010-unstable#post'), ['unstable-frame']);
  assert.deepEqual(ex('Mobile/mod/flow/020-loading#post'), ['loading-indicator']);
  assert.deepEqual(ex('Mobile/mod/flow/030-transitional#post'), ['transitional-url']);
  assert.deepEqual(ex('Mobile/mod/flow/040-truncated#post'), ['census-truncated']);
  assert.deepEqual(ex('Mobile/mod/flow/050-secret#post'), ['secret-visible']);
  assert.deepEqual(ex('Mobile/mod/flow/060-everr#post'), ['evidence-reading-error']);
  const loading = frameOf(index, 'Mobile/mod/flow/010-unstable#loading');
  assert.equal(loading.purpose, 'unstable-capture');
  assert.deepEqual(loading.exclusions, ['loading-capture', 'unstable-frame']);
  assert.equal(index.frames.filter((fr) => fr.canonical_role === 'screen-state').length, 0, 'no unsuitable frame became canonical');
  // Each of those screens is then uncovered, and the flow is not complete.
  assert.equal(index.coverage[0].complete, false);
  assert.equal(index.coverage[0].required_screens.covered, 0);
});

test('a frame whose bytes do not match the recorded hash is excluded', () => {
  const { runDir, flows, required } = healthyRun();
  fs.writeFileSync(path.join(runDir, 'Mobile/mod/flow/010-open.post.png'), png(780, 1688, 'tampered'));
  const index = build(runDir, flows, required);
  assert.deepEqual(frameOf(index, 'Mobile/mod/flow/010-open#post').exclusions, ['provenance-hash-mismatch']);
});

test('redaction-required is a note on I, P or U text, not an exclusion', () => {
  const runDir = tmpRun();
  writeFile(runDir, 'Mobile/mod/flow/010-x.evidence.json', JSON.stringify(stepDoc({
    module: 'mod', flow: 'flow', stepId: '010-x',
    before: phase({ frame: frameRef(runDir, 'Mobile/mod/flow/010-x.pre.png', 'pre') }),
    after: phase({
      frame: frameRef(runDir, 'Mobile/mod/flow/010-x.post.png', 'post'),
      census: census([{ class: 'L', text: 'Members', rule: 'label-allowlist' }, { class: 'P', rule: 'region:member-rows' }]),
    }),
  }), null, 2) + '\n');
  flowRun(runDir, 'mod', 'flow', [stepResult({ id: '010-x', next_screen: 'members' })]);
  const flows = [manifest('mod', 'flow', [{ id: '010-x', action: 'click', expect_screen: 'members' }] as Flow['steps'])];
  const post = frameOf(build(runDir, flows, ['mod/flow']), 'Mobile/mod/flow/010-x#post');
  assert.deepEqual(post.exclusions, []);
  assert.equal(post.privacy.redaction_required, true);
  assert.ok(post.notes.includes('redaction-required'));
  assert.equal(post.canonical_role, 'screen-state');
});

// ─── 4. canonical selection ──────────────────────────────────────────────────

test('canonical selection is deterministic and prefers a required step over an optional one', () => {
  const runDir = tmpRun();
  const mk = (id: string) => writeFile(runDir, `Mobile/mod/flow/${id}.evidence.json`, JSON.stringify(stepDoc({
    module: 'mod', flow: 'flow', stepId: id,
    before: phase({ frame: frameRef(runDir, `Mobile/mod/flow/${id}.pre.png`, 'pre') }),
    after: phase({ frame: frameRef(runDir, `Mobile/mod/flow/${id}.post.png`, 'post') }),
  }), null, 2) + '\n');
  ['010-optional', '020-required', '030-required-again'].forEach(mk);
  flowRun(runDir, 'mod', 'flow', [
    stepResult({ id: '010-optional', next_screen: 'shared' }),
    stepResult({ id: '020-required', next_screen: 'shared' }),
    stepResult({ id: '030-required-again', next_screen: 'shared' }),
  ]);
  const flows = [manifest('mod', 'flow', [
    { id: '010-optional', action: 'click', expect_screen: 'shared', optional: true },
    { id: '020-required', action: 'click', expect_screen: 'shared' },
    { id: '030-required-again', action: 'click', expect_screen: 'shared' },
  ] as Flow['steps'])];
  const index = build(runDir, flows, ['mod/flow']);

  assert.equal(frameOf(index, 'Mobile/mod/flow/020-required#post').canonical_role, 'screen-state');
  assert.equal(frameOf(index, 'Mobile/mod/flow/010-optional#post').canonical_role, null);
  assert.equal(frameOf(index, 'Mobile/mod/flow/010-optional#post').duplicate_of, 'Mobile/mod/flow/020-required#post');
  assert.ok(frameOf(index, 'Mobile/mod/flow/030-required-again#post').notes.includes('duplicate-screen'));
  assert.equal(index.screens.find((s) => s.name === 'shared')!.canonical_frame_id, 'Mobile/mod/flow/020-required#post');
  assert.equal(index.coverage[0].required_screens.covered, 1);
});

test('a before-frame with no described target is never a control-location frame', () => {
  const runDir = tmpRun();
  writeFile(runDir, 'Mobile/mod/flow/010-x.evidence.json', JSON.stringify(stepDoc({
    module: 'mod', flow: 'flow', stepId: '010-x', target: false,
    before: phase({ frame: frameRef(runDir, 'Mobile/mod/flow/010-x.pre.png', 'pre') }),
    after: phase({ frame: frameRef(runDir, 'Mobile/mod/flow/010-x.post.png', 'post') }),
  }), null, 2) + '\n');
  flowRun(runDir, 'mod', 'flow', [stepResult({ id: '010-x' })]);
  const flows = [manifest('mod', 'flow', [{ id: '010-x', action: 'click' }] as Flow['steps'])];
  const index = build(runDir, flows, ['mod/flow']);
  const pre = frameOf(index, 'Mobile/mod/flow/010-x#pre');
  assert.ok(pre.notes.includes('target-undescribed'));
  assert.equal(pre.canonical_role, null);
  assert.equal(index.coverage[0].required_interactions.covered, 0);
  assert.deepEqual(index.coverage[0].required_interactions.missing, ['010-x']);
});

// ─── 5. coverage keeps required and optional apart ───────────────────────────

test('optional steps are reported but never counted as required coverage', () => {
  const { runDir, flows, required } = healthyRun();
  const index = build(runDir, flows, required);
  const cov = index.coverage[0];
  assert.equal(cov.complete, true);
  assert.deepEqual(cov.required_steps, { total: 1, ok: 1, not_ok: [] });
  assert.deepEqual(cov.required_screens, { total: 1, covered: 1, missing: [] });
  assert.deepEqual(cov.optional_steps, [{ id: '020-optional', status: 'skipped', expect_screen: 'branch-open', covered: false }]);
  assert.ok(!index.screens.some((s) => s.name === 'branch-open'), 'a skipped optional screen is not in the catalog');
});

test('a failed required step makes coverage incomplete', () => {
  const { runDir, flows, required } = healthyRun();
  const run = JSON.parse(fs.readFileSync(path.join(runDir, 'runs/Mobile/mod-flow.flow-run.json'), 'utf8')) as FlowRun;
  run.steps[0].status = 'failed';
  run.status = 'failed';
  writeFile(runDir, 'runs/Mobile/mod-flow.flow-run.json', JSON.stringify(run, null, 2) + '\n');
  const cov = build(runDir, flows, required).coverage[0];
  assert.equal(cov.complete, false);
  assert.equal(cov.flow_failed, true);
  assert.deepEqual(cov.required_steps.not_ok, ['010-open']);
});

// ─── 6. determinism ──────────────────────────────────────────────────────────

test('the index is byte-identical when rebuilt, and independent of manifest order', () => {
  const { runDir, flows, required } = healthyRun();
  const a = JSON.stringify(build(runDir, flows, required));
  const b = JSON.stringify(build(runDir, [...flows].reverse(), required));
  const c = JSON.stringify(build(runDir, flows, [...required].reverse()));
  assert.equal(a, b);
  assert.equal(a, c);
  assert.ok(!a.includes(new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0') + '-' + String(new Date().getDate()).padStart(2, '0') + 'T'), 'no build clock leaked in');
});

// ─── 7. label vocabulary: live values become variables ───────────────────────

test('templateLabel turns live dates and counts into variables and leaves allowlisted copy alone', () => {
  assert.deepEqual(idx.templateLabel('15-Sep-2026', false), { text: '{date}', variables: ['date'] });
  assert.deepEqual(idx.templateLabel('Active from. 15-Sep-2026. Opens a picker', false), { text: 'Active from. {date}. Opens a picker', variables: ['date'] });
  assert.deepEqual(idx.templateLabel('Notifications, 2 things still to act on', false), { text: 'Notifications, {number} things still to act on', variables: ['number'] });
  assert.deepEqual(idx.templateLabel('PIN, 0 of 4 digits entered', false), { text: 'PIN, {number} of {number} digits entered', variables: ['number'] });
  assert.deepEqual(idx.templateLabel('Starts 9:30 AM', false), { text: 'Starts {time}', variables: ['time'] });
  // Human-reviewed allowlist copy is fixed wording, digits and all.
  assert.deepEqual(idx.templateLabel('Your number, then your 4-digit PIN.', true), { text: 'Your number, then your 4-digit PIN.', variables: [] });
  // Icon-font glyphs carry no wording.
  assert.deepEqual(idx.templateLabel(' Add Course', false), { text: 'Add Course', variables: [] });
});

test('the vocabulary holds only class-L wording, with live values templated out', () => {
  const runDir = tmpRun();
  writeFile(runDir, 'Mobile/mod/flow/010-x.evidence.json', JSON.stringify(stepDoc({
    module: 'mod', flow: 'flow', stepId: '010-x',
    before: phase({ frame: frameRef(runDir, 'Mobile/mod/flow/010-x.pre.png', 'pre') }),
    after: phase({
      frame: frameRef(runDir, 'Mobile/mod/flow/010-x.post.png', 'post'),
      census: census([
        { class: 'L', text: 'Notifications, 2 things still to act on' },
        { class: 'L', text: '15-Sep-2026' },
        { class: 'L', text: '' },
        { class: 'L', text: 'a', rule: 'safe-literal', source: 'value' },
        { class: 'L', text: 'Add Member', rule: 'label-allowlist' },
        { class: 'P', text: undefined, rule: 'region:member-rows' },
      ]),
    }),
  }), null, 2) + '\n');
  flowRun(runDir, 'mod', 'flow', [stepResult({ id: '010-x', next_screen: 'overview' })]);
  const flows = [manifest('mod', 'flow', [{ id: '010-x', action: 'click', expect_screen: 'overview' }] as Flow['steps'])];
  const index = build(runDir, flows, ['mod/flow']);

  assert.deepEqual(index.vocabulary.map((v) => v.text).sort(),
    ['Add Member', 'Attendance', 'Notifications, {number} things still to act on'].sort());
  const counted = index.vocabulary.find((v) => v.text.includes('{number}'))!;
  assert.deepEqual(counted.variables, ['number']);
  assert.equal(counted.fixed_wording, false, 'a live count is not fixed manual wording');
  assert.equal(index.vocabulary.find((v) => v.text === 'Add Member')!.fixed_wording, true);
  assert.equal(index.vocabulary_excluded.symbol_only, 1);
  assert.equal(index.vocabulary_excluded.variable_only, 1, 'a bare date is a variable, not wording');
  assert.equal(index.vocabulary_excluded.input_value, 1, 'the value the flow typed is not app wording');
  assert.deepEqual(idxTypes.validateEvidenceIndex(index), []);
});

// ─── 8. carried decisions ────────────────────────────────────────────────────

test('NO_EXPERIENCE is carried unchanged and never inferred', () => {
  const { runDir, flows, required } = healthyRun();
  const index = build(runDir, flows, required);
  assert.equal(index.engagement.experience, 'NO_EXPERIENCE');
  assert.match(index.engagement.basis, /does not infer/i);
});

test('a review item keeps its text verbatim, links its frames, and blocks fixed wording while open', () => {
  const runDir = tmpRun();
  writeFile(runDir, 'Mobile/mod/flow/010-x.evidence.json', JSON.stringify(stepDoc({
    module: 'mod', flow: 'flow', stepId: '010-x',
    before: phase({ frame: frameRef(runDir, 'Mobile/mod/flow/010-x.pre.png', 'pre') }),
    after: phase({
      frame: frameRef(runDir, 'Mobile/mod/flow/010-x.post.png', 'post'),
      census: census([{ class: 'L', text: 'e.g. Anitha R', rule: 'placeholder', source: 'placeholder' }]),
    }),
  }), null, 2) + '\n');
  flowRun(runDir, 'mod', 'flow', [stepResult({ id: '010-x', next_screen: 'form' })]);
  const flows = [manifest('mod', 'flow', [{ id: '010-x', action: 'click', expect_screen: 'form' }] as Flow['steps'])];
  const items = idx.parseReviewItems({
    items: [{
      id: 'R-C2-001', topic: 'placeholder-example-name', status: 'open', origin: 'C1 gate', question: 'Verbatim or neutral?',
      match: { texts: ['e.g. Anitha R'] }, resolution: null,
    }],
  });
  const index = idx.buildEvidenceIndex({ ...options(runDir, flows, ['mod/flow']), reviewItems: items });

  const item = index.review_items[0];
  assert.deepEqual(item.texts, ['e.g. Anitha R'], 'the text is carried verbatim, not normalised');
  assert.equal(item.status, 'open');
  assert.deepEqual(item.frame_ids, ['Mobile/mod/flow/010-x#post']);
  const entry = index.vocabulary.find((v) => v.text === 'e.g. Anitha R')!;
  assert.deepEqual(entry.review_items, ['R-C2-001']);
  assert.equal(entry.fixed_wording, false, 'an open question is not settled wording');
  assert.deepEqual(item.vocabulary_ids, [entry.id]);
});

test('review item config is validated', () => {
  assert.throws(() => idx.parseReviewItems({ items: [{ id: 'x', topic: 't', status: 'open', origin: 'o', question: 'q', match: {} }] }), /texts or record_screen_query_id/);
  assert.throws(() => idx.parseReviewItems({ items: [{ id: 'x', topic: 't', status: 'resolved', origin: 'o', question: 'q', match: { texts: ['a'] } }] }), /resolution/);
  assert.throws(() => idx.parseReviewItems({}), /items/);
});

test('the Sample App manual-review-items.json loads', () => {
  const loaded = idx.loadReviewItems();
  assert.ok(loaded.items.length >= 1);
  assert.ok(loaded.items.every((i) => i.id && i.question));
});

// ─── 9. the checker ──────────────────────────────────────────────────────────

test('the checker passes a healthy index and fails a stale one', () => {
  const { runDir, flows, required } = healthyRun();
  writeIndex(runDir, flows, required);
  const ok = runCheck(runDir, flows, required);
  assert.deepEqual(ok.findings, []);
  assert.equal(ok.passed, true);

  const doc = JSON.parse(fs.readFileSync(path.join(runDir, 'c2/evidence-index.json'), 'utf8')) as EvidenceIndex;
  doc.totals.frames = 999;
  writeFile(runDir, 'c2/evidence-index.json', JSON.stringify(doc, null, 2) + '\n');
  const stale = runCheck(runDir, flows, required);
  assert.equal(stale.passed, false);
  assert.ok(stale.findings.some((f) => f.check === 'determinism'));
});

test('the checker re-derives exclusions instead of trusting the index', () => {
  const { runDir, flows, required } = healthyRun();
  const index = writeIndex(runDir, flows, required);
  // Promote a skipped step's frame by hand, exactly as a buggy builder would.
  const doc = JSON.parse(JSON.stringify(index)) as EvidenceIndex;
  const bad = doc.frames.find((f) => f.frame_id === 'Mobile/mod/flow/020-optional#post')!;
  bad.suitability = 'canonical';
  bad.exclusions = [];
  bad.canonical_role = 'screen-state';
  bad.screen = { name: 'branch-open', source: 'step.expect_screen' };
  writeFile(runDir, 'c2/evidence-index.json', JSON.stringify(doc, null, 2) + '\n');
  const result = runCheck(runDir, flows, required);
  assert.equal(result.passed, false);
  assert.ok(result.findings.some((f) => f.check === 'exclusion' && f.where === 'Mobile/mod/flow/020-optional#post'));
});

test('the checker catches a missing frame, a coverage gap and a lost review item', () => {
  const { runDir, flows, required } = healthyRun();
  const index = writeIndex(runDir, flows, required);

  const doc = JSON.parse(JSON.stringify(index)) as EvidenceIndex;
  doc.frames = doc.frames.filter((f) => f.frame_id !== 'Mobile/mod/flow/010-open#viewport');
  doc.engagement.experience = 'PRIMARY_EXPERIENCE' as 'NO_EXPERIENCE';
  writeFile(runDir, 'c2/evidence-index.json', JSON.stringify(doc, null, 2) + '\n');
  const result = runCheck(runDir, flows, required);
  assert.equal(result.passed, false);
  assert.ok(result.findings.some((f) => f.check === 'frames-indexed'));
  assert.ok(result.findings.some((f) => f.check === 'engagement'));

  // An optional step promoted to required in the manifest is drift the checker must see.
  const drifted = [manifest('mod', 'flow', [
    { id: '010-open', action: 'click', label: 'Open it', expect_screen: 'course-detail', screenshot: 'viewport' },
    { id: '020-optional', action: 'click', label: 'Optional', expect_screen: 'branch-open', screenshot: 'viewport' },
  ] as Flow['steps'])];
  writeIndex(runDir, flows, required);
  const drift = runCheck(runDir, drifted, required);
  assert.equal(drift.passed, false);
  assert.ok(drift.findings.some((f) => f.check === 'manifest-drift' || f.check === 'coverage'));
});

test('the checker fails when a required flow is missing from the run', () => {
  const { runDir, flows } = healthyRun();
  writeIndex(runDir, flows, ['mod/flow', 'other/missing']);
  const result = runCheck(runDir, flows, ['mod/flow', 'other/missing']);
  assert.equal(result.passed, false);
  assert.ok(result.findings.some((f) => f.check === 'coverage' && f.where === 'Mobile/other/missing'));
});

/** The same one-step flow captured on two devices, in the device-first layout. */
function twoDeviceRun(): { runDir: string; flows: Flow[]; required: string[] } {
  const runDir = tmpRun();
  const m = 'mod';
  const f = 'flow';
  for (const device of ['Mobile', 'Laptop']) {
    writeFile(runDir, `${device}/${m}/${f}/010-open.evidence.json`, JSON.stringify(stepDoc({
      module: m, flow: f, stepId: '010-open', device,
      before: phase({ frame: frameRef(runDir, `${device}/${m}/${f}/010-open.pre.png`, 'pre', { salt: device }) }),
      after: phase({ pattern: '/course/[id]', frame: frameRef(runDir, `${device}/${m}/${f}/010-open.post.png`, 'post', { salt: device }) }),
    }), null, 2) + '\n');
    const shot = `evidence/${RUN_ID}/${device}/screenshots/${m}/${f}/010-open.viewport.png`;
    writeFile(runDir, `${device}/screenshots/${m}/${f}/010-open.viewport.png`, png(780, 1688, `shot-${device}`));
    flowRun(runDir, m, f, [
      stepResult({ id: '010-open', next_screen: 'course-detail', capture_mode: 'viewport', screenshot_paths: [shot] }),
    ], 'unchanged', device);
  }
  writeFile(runDir, 'evidence-check.json', JSON.stringify({ passed: true, files: 1, steps: 2, findings: [] }, null, 2) + '\n');
  const flows = [manifest(m, f, [
    { id: '010-open', action: 'click', label: 'Open it', expect_screen: 'course-detail', screenshot: 'viewport' },
  ] as Flow['steps'])];
  return { runDir, flows, required: ['mod/flow'] };
}

// ─── 10. two devices never share a frame ─────────────────────────────────────

test('two devices capturing the same step get different frame ids', () => {
  const { runDir, flows, required } = twoDeviceRun();
  const index = build(runDir, flows, required);

  assert.deepEqual(idxTypes.validateEvidenceIndex(index), []);
  // The one thing this whole axis exists to prevent.
  const ids = index.frames.map((fr) => fr.frame_id);
  assert.equal(new Set(ids).size, ids.length, 'frame ids collided across devices');
  assert.ok(ids.includes('Mobile/mod/flow/010-open#post'));
  assert.ok(ids.includes('Laptop/mod/flow/010-open#post'));
  // Every referenced frame is led by its own device, and files stay apart too.
  for (const fr of index.frames.filter((x) => x.kind !== 'unreferenced')) {
    assert.ok(fr.device, `${fr.frame_id} has no device`);
    assert.ok(fr.frame_id.startsWith(`${fr.device}/`), `${fr.frame_id} is not led by ${fr.device}`);
    assert.ok(fr.file.path.startsWith(`${fr.device}/`), `${fr.file.path} is not under ${fr.device}/`);
  }
  assert.deepEqual(uniqueDevices(index), ['Laptop', 'Mobile']);

  // The same screen on two devices is two pictures, each with its own canonical frame.
  const screens = index.screens.filter((sc) => sc.name === 'course-detail');
  assert.deepEqual(screens.map((sc) => sc.device).sort(), ['Laptop', 'Mobile']);
  assert.equal(new Set(screens.map((sc) => sc.canonical_frame_id)).size, 2);

  // Coverage is reported per device, and both are complete.
  assert.deepEqual(index.coverage.map((c) => `${c.device}/${c.flow}:${c.complete}`).sort(),
    ['Laptop/mod/flow:true', 'Mobile/mod/flow:true']);
});

test('the checker rejects an index where two devices share a frame id', () => {
  const { runDir, flows, required } = twoDeviceRun();
  const index = writeIndex(runDir, flows, required);
  assert.equal(runCheck(runDir, flows, required).passed, true, 'the honest two-device index should pass');

  // Hand the checker exactly what a device-blind builder would have produced.
  const doc = JSON.parse(JSON.stringify(index)) as EvidenceIndex;
  for (const fr of doc.frames) {
    if (fr.device === 'Laptop' && fr.frame_id.startsWith('Laptop/')) fr.frame_id = fr.frame_id.replace('Laptop/', 'Mobile/');
  }
  writeFile(runDir, `${idx.INDEX_DIR}/${idx.INDEX_FILE}`, JSON.stringify(doc, null, 2) + '\n');
  const result = runCheck(runDir, flows, required);
  assert.equal(result.passed, false);
  assert.ok(result.findings.some((fd) => /share one frame_id|does not start with its device/.test(fd.message)),
    'the checker must name the collision');
});

const uniqueDevices = (index: EvidenceIndex): string[] =>
  Array.from(new Set(index.frames.map((fr) => fr.device).filter((d): d is string => !!d))).sort();
