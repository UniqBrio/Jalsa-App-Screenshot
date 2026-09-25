/**
 * Evidence Index (C2) — offline, no browser.
 *
 *   npm run evidence:index -- --run <run_id> --require signin/sign-in-journey,attendance/course-detail
 *
 * Reads one C1 evidence run and writes evidence/<run_id>/c2/:
 *   evidence-index.json   every PNG in the run, classified (see evidence-index-types.ts)
 *   coverage.txt          the same coverage and canonical choices, for a human to read
 *
 * Deterministic by construction: the output is a pure function of the run's
 * files, the flow manifests and config/manual-review-items.json — no clock, no
 * randomness, every list sorted — so rebuilding an unchanged run reproduces the
 * index byte for byte (evidence:index:check verifies exactly that).
 *
 * Classification only ever reads what C1 recorded. Screen names come from the
 * manifest's expect_screen and nowhere else; a frame whose step names no screen
 * stays unnamed rather than being guessed at.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { env, paths, redactSecrets } from '../env';
import { relPosix, writeJson, writeText } from '../fsx';
import { log } from '../logger';
import type { Flow, FlowRun, FlowStep, StepResult } from '../types';
import { PRE_FRAME_ACTIONS } from './evidence-capture';
import { pngSize } from './evidence-sanitize';
import type { CensusEntry, DataClass, FrameRef, PhaseEvidence, StepEvidence } from './evidence-types';
import {
  EVIDENCE_INDEX_SCHEMA_VERSION,
  FRAME_KINDS,
  type EvidenceIndex,
  type EvidencePurpose,
  type ExclusionCode,
  type FlowCoverage,
  type FrameKind,
  type IndexedFlow,
  type IndexedFlowStep,
  type IndexedFrame,
  type IndexedStep,
  type NoteCode,
  type ReviewItemLink,
  type ScreenCatalogEntry,
  type VocabularyEntry,
} from './evidence-index-types';

export const INDEX_DIR = 'c2';
export const INDEX_FILE = 'evidence-index.json';
export const COVERAGE_FILE = 'coverage.txt';

export const ENGAGEMENT_BASIS =
  'No engagement decision is recorded in the evidence sources. C2 carries NO_EXPERIENCE unchanged and does not infer an experience.';

// ─── review items config ─────────────────────────────────────────────────────

export interface ReviewItemConfig {
  id: string;
  topic: string;
  status: 'open' | 'resolved';
  origin: string;
  question: string;
  match: { texts?: string[]; record_screen_query_id?: boolean };
  resolution: string | null;
}

export function parseReviewItems(raw: unknown, source = 'review items'): ReviewItemConfig[] {
  const obj = raw as { items?: unknown };
  if (typeof raw !== 'object' || raw === null || !Array.isArray(obj.items)) throw new Error(`${source}: { items: [...] } required`);
  const errs: string[] = [];
  const ids = new Set<string>();
  const items = obj.items.map((r: any, i: number) => {
    const where = `items[${i}]`;
    if (!r || typeof r.id !== 'string' || !r.id) errs.push(`${where}.id: required`);
    else if (ids.has(r.id)) errs.push(`${where}.id: duplicate "${r.id}"`);
    else ids.add(r.id);
    if (!['open', 'resolved'].includes(r?.status)) errs.push(`${where}.status: open or resolved`);
    for (const k of ['topic', 'origin', 'question']) if (typeof r?.[k] !== 'string' || !r[k]) errs.push(`${where}.${k}: required`);
    const m = r?.match ?? {};
    const hasTexts = Array.isArray(m.texts) && m.texts.length > 0 && m.texts.every((t: unknown) => typeof t === 'string' && t);
    if (!hasTexts && m.record_screen_query_id !== true) errs.push(`${where}.match: texts or record_screen_query_id required`);
    if (r?.status === 'resolved' && (typeof r.resolution !== 'string' || !r.resolution)) errs.push(`${where}.resolution: a resolved item needs its decision`);
    return {
      id: r?.id, topic: r?.topic, status: r?.status, origin: r?.origin, question: r?.question,
      match: { texts: hasTexts ? [...m.texts] : undefined, record_screen_query_id: m.record_screen_query_id === true ? true : undefined },
      resolution: r?.resolution ?? null,
    } as ReviewItemConfig;
  });
  if (errs.length) throw new Error(`${source} is invalid:\n  ${errs.join('\n  ')}`);
  return items;
}

export const REVIEW_ITEMS_FILE = path.join(paths.config, 'manual-review-items.json');

export function loadReviewItems(file = REVIEW_ITEMS_FILE): { items: ReviewItemConfig[]; sha256: string | null } {
  if (!fs.existsSync(file)) return { items: [], sha256: null };
  const buf = fs.readFileSync(file);
  return { items: parseReviewItems(JSON.parse(buf.toString('utf8')), file), sha256: sha256(buf) };
}

// ─── pure helpers ────────────────────────────────────────────────────────────

export function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*';
const DATE_PATTERNS = [
  new RegExp(`\\b\\d{1,2}[-/ ]${MONTH}[-/ ,]*\\d{2,4}\\b`, 'gi'),
  new RegExp(`\\b${MONTH} \\d{1,2}(?:, ?\\d{4})?\\b`, 'gi'),
  new RegExp(`\\b\\d{1,2} ${MONTH}\\b`, 'gi'),
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
];
const TIME_PATTERN = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?\b/g;
const NUMBER_PATTERN = /\d+(?:[.,]\d+)*/g;
/** Icon-font glyphs (Unicode private use area) carry no wording. */
const PRIVATE_USE = /[-]/g;

/**
 * A class-L text as manual vocabulary: icon glyphs removed, whitespace collapsed,
 * and every live date, time and number replaced by a placeholder. Label-allowlist
 * copy is human-reviewed fixed wording and is not templated.
 */
export function templateLabel(text: string, allowlisted: boolean): { text: string; variables: Array<'date' | 'time' | 'number'> } {
  let t = text.replace(PRIVATE_USE, '').replace(/\s+/g, ' ').trim();
  const vars = new Set<'date' | 'time' | 'number'>();
  if (!allowlisted) {
    for (const re of DATE_PATTERNS) t = t.replace(re, () => { vars.add('date'); return '{date}'; });
    t = t.replace(TIME_PATTERN, () => { vars.add('time'); return '{time}'; });
    t = t.replace(NUMBER_PATTERN, () => { vars.add('number'); return '{number}'; });
  }
  const order = ['date', 'time', 'number'] as const;
  return { text: t, variables: order.filter((v) => vars.has(v)) };
}

/** Whitespace-collapsed, trimmed — the comparison form for review-item texts (the texts themselves are stored verbatim). */
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

const RECORD_QUERY_KEY = /^(?:id|.*_id|.*Id)$/;

function walkFiles(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(f, base));
    else out.push(relPosix(base, f));
  }
  return out.sort();
}

const byCodepoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const emptyClassCount = (): Record<DataClass, number> => ({ S: 0, I: 0, P: 0, O: 0, L: 0, U: 0 });

function censusByClass(census: CensusEntry[]): Record<DataClass, number> {
  const c = emptyClassCount();
  for (const e of census) c[e.class] += 1;
  return c;
}

const CAPTURE_SUFFIX: Record<string, FrameKind> = {
  viewport: 'capture-viewport', full: 'capture-full', element: 'capture-element', failed: 'capture-failed', loading: 'capture-loading',
};
const KIND_SUFFIX: Record<FrameKind, string> = {
  'evidence-pre': 'pre', 'evidence-post': 'post', 'capture-viewport': 'viewport', 'capture-full': 'full',
  'capture-element': 'element', 'capture-failed': 'failed', 'capture-loading': 'loading', unreferenced: 'file',
};

/** `evidence/<run>/screenshots/m/f/010-x.viewport.png` (repo-relative, as the flow-run records it) → run-relative. */
export function runRelative(recorded: string, runDir: string, repoRoot: string): string {
  const abs = path.resolve(repoRoot, recorded);
  const rel = relPosix(runDir, abs);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  const i = recorded.replace(/\\/g, '/').lastIndexOf('screenshots/');
  return i >= 0 ? recorded.replace(/\\/g, '/').slice(i) : recorded;
}

// ─── build ───────────────────────────────────────────────────────────────────

export interface BuildOptions {
  runDir: string;
  /** Loaded flow manifests; `_sourcePath` names the manifest file. */
  flows: Flow[];
  /** flow key → sha256 of its manifest file. */
  manifestHashes: Record<string, string>;
  requiredFlows: string[];
  expectedDpr: number;
  reviewItems: ReviewItemConfig[];
  reviewItemsSha256: string | null;
  /** Base the flow-run manifests' screenshot paths are relative to. */
  repoRoot: string;
}

interface StepContext {
  flowKey: string;
  flow: Flow | null;
  run: FlowRun;
  runFile: string;
  runSha: string;
  index: number;
  result: StepResult;
  manifestStep: FlowStep | null;
  step: IndexedStep;
  doc: StepEvidence | null;
  docFile: string | null;
  docSha: string | null;
  /** The steps-phase step that ran immediately before this one, if any. */
  previous: StepContext | null;
}

interface PngInfo { bytes: number; sha: string; width: number; height: number; readable: boolean }

function readPng(runDir: string, rel: string, cache: Map<string, PngInfo>): PngInfo {
  const hit = cache.get(rel);
  if (hit) return hit;
  const abs = path.join(runDir, rel);
  if (!fs.existsSync(abs)) throw new Error(`referenced frame ${rel} does not exist in the evidence run`);
  const buf = fs.readFileSync(abs);
  let width = 0;
  let height = 0;
  let readable = true;
  try { ({ width, height } = pngSize(buf)); } catch { readable = false; }
  const info = { bytes: buf.length, sha: sha256(buf), width, height, readable };
  cache.set(rel, info);
  return info;
}

export function buildEvidenceIndex(o: BuildOptions): EvidenceIndex {
  const runId = path.basename(o.runDir);
  const pngCache = new Map<string, PngInfo>();
  const manifests = new Map(o.flows.map((f) => [`${f.module}/${f.flow}`, f]));
  const fileSha = (rel: string) => (fs.existsSync(path.join(o.runDir, rel)) ? sha256(fs.readFileSync(path.join(o.runDir, rel))) : null);

  // Flow-run manifests, sorted by flow key.
  const runsDir = path.join(o.runDir, 'runs');
  const runs = (fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.flow-run.json')).sort() : [])
    .map((name) => {
      const buf = fs.readFileSync(path.join(runsDir, name));
      const run = JSON.parse(buf.toString('utf8')) as FlowRun;
      return { key: `${run.module}/${run.flow}`, run, file: `runs/${name}`, sha: sha256(buf) };
    })
    .sort((a, b) => byCodepoint(a.key, b.key));

  const flows: IndexedFlow[] = [];
  const frames: IndexedFrame[] = [];
  const contexts: StepContext[] = [];

  for (const r of runs) {
    const flow = manifests.get(r.key) ?? null;
    const manifestSteps = flow ? [...(flow.setup ?? []), ...(flow.steps ?? []), ...(flow.teardown ?? [])] : [];
    let previous: StepContext | null = null;
    const flowSteps: IndexedFlowStep[] = [];

    r.run.steps.forEach((result, index) => {
      const manifestStep = manifestSteps.find((s) => s.id === result.id) ?? null;
      // A step the manifest does not mark optional is required — the conservative reading when a manifest is missing.
      const optional = manifestStep?.optional === true;
      const step: IndexedStep = {
        id: result.id,
        order: index,
        phase: result.phase,
        action: result.action,
        label: manifestStep?.label !== undefined ? redactSecrets(manifestStep.label) : null,
        optional,
        required: result.phase === 'steps' && !optional,
        status: result.status,
        expect_screen: result.next_screen ?? null,
      };
      const docRel = `${r.run.module}/${r.run.flow}/${result.id}.evidence.json`;
      const docAbs = path.join(o.runDir, docRel);
      const docBuf = result.phase === 'steps' && fs.existsSync(docAbs) ? fs.readFileSync(docAbs) : null;
      const ctx: StepContext = {
        flowKey: r.key, flow, run: r.run, runFile: r.file, runSha: r.sha, index, result, manifestStep, step,
        doc: docBuf ? (JSON.parse(docBuf.toString('utf8')) as StepEvidence) : null,
        docFile: docBuf ? docRel : null,
        docSha: docBuf ? sha256(docBuf) : null,
        previous,
      };
      contexts.push(ctx);
      if (result.phase === 'steps') previous = ctx;

      const stepFrames = framesForStep(ctx, o, pngCache);
      frames.push(...stepFrames);
      flowSteps.push({
        ...step,
        frame_ids: stepFrames.map((f) => f.frame_id),
        canonical_screen_frame: null,
        canonical_control_frame: null,
        interaction: result.phase === 'steps' && PRE_FRAME_ACTIONS.has(result.action),
      });
    });

    flows.push({
      flow: r.key,
      title: flow?.title ?? null,
      required: o.requiredFlows.includes(r.key),
      manifest_file: flow?._sourcePath ?? null,
      manifest_sha256: o.manifestHashes[r.key] ?? null,
      flow_run_file: r.file,
      flow_run_sha256: r.sha,
      flow_run_status: r.run.status,
      app_git_sha: r.run.app_git_sha,
      steps: flowSteps,
    });
  }

  // Every PNG nobody references is still indexed — and excluded.
  const referenced = new Set(frames.map((f) => f.file.path));
  for (const rel of walkFiles(o.runDir).filter((f) => f.toLowerCase().endsWith('.png') && !referenced.has(f))) {
    const png = readPng(o.runDir, rel, pngCache);
    frames.push({
      frame_id: `file:${rel}`,
      kind: 'unreferenced',
      file: { path: rel, png_sha256: png.sha, bytes: png.bytes, width: png.width, height: png.height },
      provenance: provenance(runId, 'none', null, null),
      flow: null, step: null, route: null,
      screen: { name: null, source: 'undeclared' },
      state: { stable: null, stability_reason: null, overlays: null, errors: null, toasts: null, loading: null, disabled: null, signals: [] },
      purpose: 'unreferenced',
      privacy: { paired_census: false, census_by_class: null, census_truncated: null, redaction_required: null },
      target: null, label_ids: [], suitability: 'excluded', exclusions: ['unreferenced-file'], notes: [],
      canonical_role: null, same_state_as: null, duplicate_of: null,
    });
  }

  selectCanonical(flows, frames);
  const { vocabulary, excluded } = buildVocabulary(frames, contexts, o.reviewItems);
  const reviewItems = linkReviewItems(o.reviewItems, frames, contexts, vocabulary);
  const screens = screenCatalog(frames);
  const coverage = o.requiredFlows.slice().sort(byCodepoint).map((key) => coverageFor(key, flows, frames));

  const byKind = Object.fromEntries(FRAME_KINDS.map((k) => [k, 0])) as Record<FrameKind, number>;
  const bySuit = { canonical: 0, supporting: 0, excluded: 0 };
  for (const f of frames) { byKind[f.kind] += 1; bySuit[f.suitability] += 1; }

  const check = path.join(o.runDir, 'evidence-check.json');
  return {
    schema: EVIDENCE_INDEX_SCHEMA_VERSION,
    kind: 'evidence-index',
    run_id: runId,
    generator: 'evidence-index@1',
    sources: {
      evidence_summary_sha256: fileSha('evidence-summary.json'),
      evidence_check_passed: fs.existsSync(check) ? (JSON.parse(fs.readFileSync(check, 'utf8')) as { passed?: boolean }).passed === true : null,
      label_review_sha256: fileSha('label-review.txt'),
      review_items_sha256: o.reviewItemsSha256,
    },
    engagement: { experience: 'NO_EXPERIENCE', basis: ENGAGEMENT_BASIS },
    required_flows: o.requiredFlows.slice().sort(byCodepoint),
    expected_dpr: o.expectedDpr,
    totals: {
      frames: frames.length,
      by_kind: byKind,
      by_suitability: bySuit,
      canonical_screen_frames: frames.filter((f) => f.canonical_role === 'screen-state').length,
      canonical_control_frames: frames.filter((f) => f.canonical_role === 'control-location').length,
    },
    flows,
    frames,
    screens,
    vocabulary,
    vocabulary_excluded: excluded,
    review_items: reviewItems,
    coverage,
  };
}

function provenance(runId: string, source: 'step-evidence' | 'flow-run' | 'none', ctx: StepContext | null, pointer: 'before.frame' | 'after.frame' | null) {
  return {
    run_id: runId,
    source,
    evidence_file: ctx?.docFile ?? null,
    evidence_sha256: ctx?.docSha ?? null,
    evidence_pointer: source === 'step-evidence' ? pointer : null,
    flow_run_file: ctx?.runFile ?? null,
    flow_run_sha256: ctx?.runSha ?? null,
    flow_run_step_index: ctx ? ctx.index : null,
    manifest_file: ctx?.flow?._sourcePath ?? null,
    manifest_sha256: null as string | null,
    app_git_sha: ctx?.run.app_git_sha ?? null,
    captured_at: ctx?.doc?.captured_at ?? null,
  };
}

function framesForStep(ctx: StepContext, o: BuildOptions, cache: Map<string, PngInfo>): IndexedFrame[] {
  const out: IndexedFrame[] = [];
  const runId = path.basename(o.runDir);
  const { doc, step } = ctx;
  const idBase = `${ctx.flowKey}/${step.id}`;
  const ok = step.status === 'ok';
  const statusExclusion: ExclusionCode[] = step.status === 'failed' ? ['step-failed'] : step.status === 'skipped' ? ['step-skipped'] : [];
  const docErrors: ExclusionCode[] = doc && doc.evidence_errors.length ? ['evidence-reading-error'] : [];
  const postScreen = ok && step.expect_screen
    ? { name: step.expect_screen, source: 'step.expect_screen' as const }
    : { name: null, source: 'undeclared' as const };
  const prev = ctx.previous;
  const preScreen = prev && prev.step.status === 'ok' && prev.step.expect_screen
    ? { name: prev.step.expect_screen, source: 'previous-step.expect_screen' as const }
    : { name: null, source: 'undeclared' as const };
  const withManifest = <T extends { manifest_sha256: string | null }>(p: T): T => ({ ...p, manifest_sha256: o.manifestHashes[ctx.flowKey] ?? null });

  const phaseExclusions = (ph: PhaseEvidence): ExclusionCode[] => {
    const ex: ExclusionCode[] = [];
    if (ph.visual.loading.length) ex.push('loading-indicator');
    if (ph.url.pattern !== ph.visual.route.pattern) ex.push('transitional-url');
    if (/unreadable|\[unparseable\]|^about:blank$/.test(ph.url.pattern) || /unreadable|\[unparseable\]/.test(ph.visual.route.pattern)) ex.push('transitional-unreadable');
    return ex;
  };
  const dprExclusion = (png: PngInfo, viewportWidth: number | null): ExclusionCode[] =>
    viewportWidth && Math.abs(png.width / viewportWidth - o.expectedDpr) > 0.01 ? ['provenance-dpr-mismatch'] : [];
  const state = (ph: PhaseEvidence | null, stable: boolean | null, reason: string | null) => ({
    stable,
    stability_reason: reason,
    overlays: ph ? ph.visual.overlays.length : null,
    errors: ph ? ph.visual.errors.length : null,
    toasts: ph ? ph.visual.toasts.length : null,
    loading: ph ? ph.visual.loading.length : null,
    disabled: ph ? ph.visual.disabled.length : null,
    signals: doc ? doc.signals.slice().sort(byCodepoint) : [],
  });
  const route = (ph: PhaseEvidence | null) => ph
    ? { pattern: ph.url.pattern, record_screen: ph.url.record_screen, query_keys: ph.url.query.map((q) => q.key).sort(byCodepoint) }
    : null;

  // C1 evidence frames: before and after.
  if (doc) {
    for (const [kind, pointer, ph] of [['evidence-pre', 'before.frame', doc.before], ['evidence-post', 'after.frame', doc.after]] as Array<[FrameKind, 'before.frame' | 'after.frame', PhaseEvidence]>) {
      const frame: FrameRef | null = ph.frame;
      if (!frame) continue;
      const png = readPng(o.runDir, frame.path, cache);
      const classes = censusByClass(ph.census);
      const ex: ExclusionCode[] = [...statusExclusion, ...docErrors, ...phaseExclusions(ph)];
      if (!frame.stable) ex.push('unstable-frame');
      if (ph.census_truncated) ex.push('census-truncated');
      if (classes.S > 0) ex.push('secret-visible');
      if (png.sha !== frame.png_sha256) ex.push('provenance-hash-mismatch');
      if (!png.readable || png.width !== frame.image.width || png.height !== frame.image.height) ex.push('provenance-size-mismatch');
      ex.push(...dprExclusion(png, frame.viewport.width));

      const notes: NoteCode[] = [];
      const isPre = kind === 'evidence-pre';
      const screen = isPre ? preScreen : postScreen;
      if (!isPre && screen.name === null) notes.push('screen-undeclared');
      let target: IndexedFrame['target'] = null;
      if (isPre) {
        const t = doc.target;
        target = t
          ? { described: true, in_viewport: t.in_viewport, occlusion_clear: t.occlusion.clear, occlusion_points: t.occlusion.points }
          : { described: false, in_viewport: null, occlusion_clear: null, occlusion_points: null };
        if (!t || !t.box || t.in_viewport !== 'full') notes.push('target-undescribed');
        else if (t.occlusion.clear < t.occlusion.points) notes.push('target-partially-occluded');
      }
      const redaction = classes.I + classes.P + classes.U > 0;
      if (redaction) notes.push('redaction-required');

      const purpose: EvidencePurpose = !ok ? 'failure-diagnostic' : isPre ? 'control-location' : 'step-result';
      out.push({
        frame_id: `${idBase}#${KIND_SUFFIX[kind]}`,
        kind,
        file: { path: frame.path, png_sha256: png.sha, bytes: png.bytes, width: png.width, height: png.height },
        provenance: withManifest(provenance(runId, 'step-evidence', ctx, pointer)),
        flow: ctx.flowKey,
        step,
        route: route(ph),
        screen,
        state: state(ph, frame.stable, frame.stability_reason),
        purpose,
        privacy: { paired_census: true, census_by_class: classes, census_truncated: ph.census_truncated, redaction_required: redaction },
        target,
        label_ids: [],
        suitability: ex.length ? 'excluded' : 'supporting',
        exclusions: uniqueSorted(ex),
        notes: uniqueSorted(notes),
        canonical_role: null,
        same_state_as: null,
        duplicate_of: null,
      });
    }
  }

  // Executor captures recorded in the flow-run manifest.
  const postFrame = out.find((f) => f.kind === 'evidence-post');
  for (const recorded of (ctx.result.screenshot_paths ?? []).slice().sort(byCodepoint)) {
    const rel = runRelative(recorded, o.runDir, o.repoRoot);
    const mode = rel.match(/\.([a-z]+)\.png$/)?.[1] ?? '';
    const kind = CAPTURE_SUFFIX[mode];
    if (!kind) continue; // left for the unreferenced sweep
    const png = readPng(o.runDir, rel, cache);
    const ph = doc ? doc.after : null;
    const ex: ExclusionCode[] = [...statusExclusion, ...docErrors];
    if (ph) ex.push(...phaseExclusions(ph));
    if (kind === 'capture-failed') ex.push('failure-capture');
    if (kind === 'capture-loading') ex.push('loading-capture', 'unstable-frame');
    if (ctx.result.unstable) ex.push('unstable-frame');
    if (!png.readable) ex.push('provenance-size-mismatch');
    if (kind !== 'capture-element') ex.push(...dprExclusion(png, ph?.frame?.viewport.width ?? doc?.before.frame?.viewport.width ?? null));
    const notes: NoteCode[] = ['no-paired-census'];
    if (postScreen.name === null && kind !== 'capture-failed' && kind !== 'capture-loading') notes.push('screen-undeclared');
    const purpose: EvidencePurpose = kind === 'capture-failed' ? 'failure-diagnostic'
      : kind === 'capture-loading' ? 'unstable-capture'
      : kind === 'capture-full' ? 'screen-full'
      : kind === 'capture-element' ? 'screen-element' : 'screen-viewport';
    out.push({
      frame_id: `${idBase}#${KIND_SUFFIX[kind]}`,
      kind,
      file: { path: rel, png_sha256: png.sha, bytes: png.bytes, width: png.width, height: png.height },
      provenance: withManifest(provenance(runId, 'flow-run', ctx, null)),
      flow: ctx.flowKey,
      step,
      route: route(ph),
      screen: kind === 'capture-failed' || kind === 'capture-loading' ? { name: null, source: 'undeclared' } : postScreen,
      state: state(ph, ctx.result.unstable ? false : kind === 'capture-loading' ? false : true, ctx.result.unstable || kind === 'capture-loading' ? 'stability gate expired' : 'settled'),
      purpose,
      privacy: { paired_census: false, census_by_class: null, census_truncated: null, redaction_required: null },
      target: null,
      label_ids: [],
      suitability: ex.length ? 'excluded' : 'supporting',
      exclusions: uniqueSorted(ex),
      notes: uniqueSorted(notes),
      canonical_role: null,
      same_state_as: ok && postFrame && !ex.length ? postFrame.frame_id : null,
      duplicate_of: null,
    });
  }

  const order = (k: FrameKind) => FRAME_KINDS.indexOf(k);
  return out.sort((a, b) => order(a.kind) - order(b.kind));
}

function uniqueSorted<T extends string>(xs: T[]): T[] {
  return Array.from(new Set(xs)).sort(byCodepoint);
}

/**
 * control-location: the before-frame of every ok interaction whose target was described fully in view.
 * screen-state: per flow and screen name, the after-frame of the first ok step declaring that screen —
 * required steps first, so an optional step can never stand in for a required screen.
 */
function selectCanonical(flows: IndexedFlow[], frames: IndexedFrame[]): void {
  const byId = new Map(frames.map((f) => [f.frame_id, f]));
  for (const flow of flows) {
    for (const s of flow.steps) {
      if (!s.interaction || s.status !== 'ok') continue;
      const pre = s.frame_ids.map((id) => byId.get(id)!).find((f) => f.kind === 'evidence-pre');
      if (pre && pre.suitability !== 'excluded' && !pre.notes.includes('target-undescribed')) {
        pre.suitability = 'canonical';
        pre.canonical_role = 'control-location';
        s.canonical_control_frame = pre.frame_id;
      }
    }
    const ordered = [...flow.steps.filter((s) => s.required), ...flow.steps.filter((s) => !s.required)];
    const chosen = new Map<string, IndexedFrame>();
    for (const s of ordered) {
      const post = s.frame_ids.map((id) => byId.get(id)!).find((f) => f.kind === 'evidence-post');
      if (!post || post.suitability === 'excluded' || post.screen.name === null) continue;
      const first = chosen.get(post.screen.name);
      if (!first) {
        chosen.set(post.screen.name, post);
        post.suitability = 'canonical';
        post.canonical_role = 'screen-state';
      } else {
        post.notes = uniqueSorted([...post.notes, 'duplicate-screen']);
        post.duplicate_of = first.frame_id;
      }
    }
    for (const s of flow.steps) {
      const post = s.frame_ids.map((id) => byId.get(id)!).find((f) => f.kind === 'evidence-post');
      if (post?.canonical_role === 'screen-state') s.canonical_screen_frame = post.frame_id;
      else if (post?.duplicate_of) s.canonical_screen_frame = post.duplicate_of;
    }
  }
}

function buildVocabulary(frames: IndexedFrame[], contexts: StepContext[], items: ReviewItemConfig[]) {
  const ctxByFrame = new Map<string, StepContext>();
  for (const c of contexts) ctxByFrame.set(`${c.flowKey}/${c.step.id}`, c);
  const excluded = { symbol_only: 0, variable_only: 0, input_value: 0 };
  const textItems = items.filter((i) => i.match.texts).map((i) => ({ id: i.id, texts: new Set(i.match.texts!.map(collapse)) }));
  const entries = new Map<string, { variables: Set<string>; sources: Set<string>; rules: Set<string>; items: Set<string>; frames: Set<string> }>();
  const frameLabels = new Map<string, Set<string>>();

  for (const f of frames) {
    if ((f.kind !== 'evidence-pre' && f.kind !== 'evidence-post') || f.suitability === 'excluded' || !f.step) continue;
    const ctx = ctxByFrame.get(`${f.flow}/${f.step.id}`);
    const ph = f.kind === 'evidence-pre' ? ctx?.doc?.before : ctx?.doc?.after;
    for (const e of ph?.census ?? []) {
      if (e.class !== 'L' || typeof e.text !== 'string') continue;
      if (e.source === 'value') { excluded.input_value += 1; continue; }
      const { text, variables } = templateLabel(e.text, e.rule === 'label-allowlist');
      if (!/\p{L}/u.test(text)) { excluded.symbol_only += 1; continue; }
      if (!/\p{L}/u.test(text.replace(/\{(?:date|time|number)\}/g, ''))) { excluded.variable_only += 1; continue; }
      const entry = entries.get(text) ?? { variables: new Set(), sources: new Set(), rules: new Set(), items: new Set(), frames: new Set() };
      variables.forEach((v) => entry.variables.add(v));
      entry.sources.add(e.source);
      entry.rules.add(e.rule);
      entry.frames.add(f.frame_id);
      for (const it of textItems) if (it.texts.has(collapse(e.text))) entry.items.add(it.id);
      entries.set(text, entry);
      const set = frameLabels.get(f.frame_id) ?? new Set<string>();
      set.add(text);
      frameLabels.set(f.frame_id, set);
    }
  }

  const openItems = new Set(items.filter((i) => i.status === 'open').map((i) => i.id));
  const texts = Array.from(entries.keys()).sort(byCodepoint);
  const width = Math.max(4, String(texts.length).length);
  const idOf = new Map(texts.map((t, i) => [t, `V${String(i + 1).padStart(width, '0')}`]));
  const vocabulary: VocabularyEntry[] = texts.map((t) => {
    const e = entries.get(t)!;
    const itemIds = Array.from(e.items).sort(byCodepoint);
    return {
      id: idOf.get(t)!,
      text: t,
      variables: (['date', 'time', 'number'] as const).filter((v) => e.variables.has(v)),
      fixed_wording: e.variables.size === 0 && !itemIds.some((id) => openItems.has(id)),
      sources: Array.from(e.sources).sort(byCodepoint) as Array<'text' | 'placeholder'>,
      rules: Array.from(e.rules).sort(byCodepoint),
      review_items: itemIds,
      frame_count: e.frames.size,
    };
  });
  for (const f of frames) {
    f.label_ids = Array.from(frameLabels.get(f.frame_id) ?? []).map((t) => idOf.get(t)!).sort(byCodepoint);
  }
  return { vocabulary, excluded };
}

function linkReviewItems(items: ReviewItemConfig[], frames: IndexedFrame[], contexts: StepContext[], vocabulary: VocabularyEntry[]): ReviewItemLink[] {
  const ctxByStep = new Map(contexts.map((c) => [`${c.flowKey}/${c.step.id}`, c]));
  return items.slice().sort((a, b) => byCodepoint(a.id, b.id)).map((item) => {
    const frameIds = new Set<string>();
    if (item.match.texts) {
      const wanted = new Set(item.match.texts.map(collapse));
      for (const f of frames) {
        if ((f.kind !== 'evidence-pre' && f.kind !== 'evidence-post') || !f.step) continue;
        const c = ctxByStep.get(`${f.flow}/${f.step.id}`);
        const ph = f.kind === 'evidence-pre' ? c?.doc?.before : c?.doc?.after;
        if ((ph?.census ?? []).some((e) => e.class === 'L' && typeof e.text === 'string' && wanted.has(collapse(e.text)))) frameIds.add(f.frame_id);
      }
    }
    if (item.match.record_screen_query_id) {
      for (const f of frames) {
        if (f.route && !f.route.record_screen && f.route.query_keys.some((k) => RECORD_QUERY_KEY.test(k))) frameIds.add(f.frame_id);
      }
    }
    return {
      id: item.id,
      topic: item.topic,
      status: item.status,
      origin: item.origin,
      question: item.question,
      resolution: item.resolution,
      texts: item.match.texts ? [...item.match.texts] : [],
      vocabulary_ids: vocabulary.filter((v) => v.review_items.includes(item.id)).map((v) => v.id),
      frame_ids: frames.filter((f) => frameIds.has(f.frame_id)).map((f) => f.frame_id),
    };
  });
}

function screenCatalog(frames: IndexedFrame[]): ScreenCatalogEntry[] {
  const names = uniqueSorted(frames.map((f) => f.screen.name).filter((n): n is string => !!n));
  return names.map((name) => {
    const own = frames.filter((f) => f.screen.name === name);
    return {
      name,
      flows: uniqueSorted(own.map((f) => f.flow!).filter(Boolean)),
      frame_ids: own.map((f) => f.frame_id),
      // Frames are in flow-key then step order, so the first canonical is a stable choice.
      canonical_frame_id: own.find((f) => f.canonical_role === 'screen-state')?.frame_id ?? null,
    };
  });
}

function coverageFor(key: string, flows: IndexedFlow[], frames: IndexedFrame[]): FlowCoverage {
  const flow = flows.find((f) => f.flow === key);
  const byId = new Map(frames.map((f) => [f.frame_id, f]));
  if (!flow) {
    return {
      flow: key, flow_run_status: null, flow_failed: true,
      required_steps: { total: 0, ok: 0, not_ok: [] }, required_screens: { total: 0, covered: 0, missing: [] },
      required_interactions: { total: 0, covered: 0, missing: [] }, optional_steps: [], complete: false,
    };
  }
  const required = flow.steps.filter((s) => s.required);
  const notOk = required.filter((s) => s.status !== 'ok').map((s) => s.id);
  // A required screen is covered only by a canonical frame from a required step.
  const screens = uniqueSorted(required.map((s) => s.expect_screen).filter((n): n is string => !!n));
  const missingScreens = screens.filter((name) => !frames.some((f) =>
    f.flow === key && f.canonical_role === 'screen-state' && f.screen.name === name && f.step?.required));
  const interactions = required.filter((s) => s.interaction);
  const missingControls = interactions.filter((s) => !s.canonical_control_frame).map((s) => s.id);
  const flowFailed = flow.flow_run_status === 'failed';
  return {
    flow: key,
    flow_run_status: flow.flow_run_status,
    flow_failed: flowFailed,
    required_steps: { total: required.length, ok: required.length - notOk.length, not_ok: notOk },
    required_screens: { total: screens.length, covered: screens.length - missingScreens.length, missing: missingScreens },
    required_interactions: { total: interactions.length, covered: interactions.length - missingControls.length, missing: missingControls },
    optional_steps: flow.steps.filter((s) => s.optional).map((s) => ({
      id: s.id,
      status: s.status,
      expect_screen: s.expect_screen,
      covered: s.status === 'ok' && [s.canonical_screen_frame, s.canonical_control_frame].some((id) => id && byId.get(id)),
    })),
    complete: !flowFailed && notOk.length === 0 && missingScreens.length === 0 && missingControls.length === 0,
  };
}

// ─── human-readable coverage ─────────────────────────────────────────────────

export function renderCoverage(index: EvidenceIndex): string {
  const byId = new Map(index.frames.map((f) => [f.frame_id, f]));
  const lines = [
    `# Evidence Index (C2) — run ${index.run_id}`,
    '# Frames are named by id; no personal data appears here. Full detail: evidence-index.json.',
    '',
    `engagement: ${index.engagement.experience}`,
    `frames: ${index.totals.frames} (canonical ${index.totals.by_suitability.canonical} · supporting ${index.totals.by_suitability.supporting} · excluded ${index.totals.by_suitability.excluded})`,
    `canonical: ${index.totals.canonical_screen_frames} screen-state · ${index.totals.canonical_control_frames} control-location`,
    `vocabulary: ${index.vocabulary.length} entries (${index.vocabulary.filter((v) => v.variables.length).length} with variables); kept out: ${index.vocabulary_excluded.symbol_only} symbol-only, ${index.vocabulary_excluded.variable_only} variable-only, ${index.vocabulary_excluded.input_value} typed input value(s)`,
    '',
  ];
  for (const c of index.coverage) {
    lines.push(`## ${c.flow} — ${c.complete ? 'COMPLETE' : 'INCOMPLETE'} (flow ${c.flow_run_status ?? 'missing'})`);
    lines.push(`   required steps         ${c.required_steps.ok}/${c.required_steps.total}${c.required_steps.not_ok.length ? `  not ok: ${c.required_steps.not_ok.join(', ')}` : ''}`);
    lines.push(`   required screens       ${c.required_screens.covered}/${c.required_screens.total}${c.required_screens.missing.length ? `  missing: ${c.required_screens.missing.join(', ')}` : ''}`);
    lines.push(`   required interactions  ${c.required_interactions.covered}/${c.required_interactions.total}${c.required_interactions.missing.length ? `  missing: ${c.required_interactions.missing.join(', ')}` : ''}`);
    lines.push(`   optional steps         ${c.optional_steps.map((s) => `${s.id} ${s.status}${s.covered ? ' (evidenced, not counted)' : ''}`).join(' · ') || 'none'}`);
    const flow = index.flows.find((f) => f.flow === c.flow);
    for (const s of flow?.steps ?? []) {
      const tag = s.required ? 'required' : s.phase === 'steps' ? 'optional' : s.phase;
      lines.push(`   ${s.id.padEnd(24)} ${s.status.padEnd(7)} ${tag.padEnd(8)} screen=${s.expect_screen ?? '-'}`);
      if (s.canonical_screen_frame) lines.push(`      screen-state      ${s.canonical_screen_frame}${byId.get(s.canonical_screen_frame)?.step?.id !== s.id ? ' (same screen, earlier step)' : ''}`);
      if (s.canonical_control_frame) lines.push(`      control-location  ${s.canonical_control_frame}`);
      for (const id of s.frame_ids) {
        // Tolerates a hand-edited index: the checker renders whatever it was given, and reports the gap itself.
        const f = byId.get(id);
        if (f?.suitability === 'excluded') lines.push(`      excluded          ${id}  [${f.exclusions.join(', ')}]`);
      }
    }
    lines.push('');
  }
  const unreferenced = index.frames.filter((f) => f.kind === 'unreferenced');
  if (unreferenced.length) {
    lines.push('## unreferenced files (excluded)');
    for (const f of unreferenced) lines.push(`   ${f.file.path}`);
    lines.push('');
  }
  lines.push('## review items');
  for (const r of index.review_items) {
    lines.push(`   ${r.id} [${r.status}] ${r.topic} — ${r.frame_ids.length} frame(s), ${r.vocabulary_ids.length} vocabulary entr${r.vocabulary_ids.length === 1 ? 'y' : 'ies'}`);
    lines.push(`      ${r.question}`);
    if (r.texts.length) lines.push(`      texts (verbatim): ${r.texts.map((t) => JSON.stringify(t)).join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export function manifestHashes(flows: Flow[], repoRoot = paths.root): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of flows) {
    if (!f._sourcePath) continue;
    const abs = path.join(repoRoot, f._sourcePath);
    if (fs.existsSync(abs)) out[`${f.module}/${f.flow}`] = sha256(fs.readFileSync(abs));
  }
  return out;
}

export function latestEvidenceRun(): string | null {
  if (!fs.existsSync(paths.evidence)) return null;
  const runs = fs.readdirSync(paths.evidence, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  return runs.length ? runs[runs.length - 1] : null;
}

export function cliArgs(argv: string[]): { runId: string | null; require: string[] } {
  const val = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    runId: val('--run') ?? latestEvidenceRun(),
    require: (val('--require') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { loadFlows } = require('../flow-loader') as typeof import('../flow-loader');
  const { runId, require: requireFlows } = cliArgs(process.argv.slice(2));
  if (!runId) {
    log.error('No evidence run found — run `npm run capture:evidence` first.');
    process.exitCode = 1;
  } else {
    const runDir = path.join(paths.evidence, runId);
    const { flows } = loadFlows({ includeDisabled: true });
    const review = loadReviewItems();
    const index = buildEvidenceIndex({
      runDir,
      flows,
      manifestHashes: manifestHashes(flows),
      requiredFlows: requireFlows,
      expectedDpr: env.browser.deviceScaleFactor,
      reviewItems: review.items,
      reviewItemsSha256: review.sha256,
      repoRoot: paths.root,
    });
    writeJson(path.join(runDir, INDEX_DIR, INDEX_FILE), index);
    writeText(path.join(runDir, INDEX_DIR, COVERAGE_FILE), renderCoverage(index));
    if (index.sources.evidence_check_passed !== true) log.warn('evidence-check.json is missing or did not pass — run `npm run evidence:check` first; the index check will fail.');
    for (const c of index.coverage) (c.complete ? log.info : log.warn)(`${c.flow}: ${c.complete ? 'complete' : 'INCOMPLETE'} — steps ${c.required_steps.ok}/${c.required_steps.total}, screens ${c.required_screens.covered}/${c.required_screens.total}, interactions ${c.required_interactions.covered}/${c.required_interactions.total}`);
    log.banner(`Evidence Index — run ${runId}: ${index.totals.frames} frame(s), ${index.totals.by_suitability.canonical} canonical, ${index.totals.by_suitability.excluded} excluded`);
    log.info(`index: ${relPosix(paths.root, path.join(runDir, INDEX_DIR, INDEX_FILE))}`);
    log.info(`next:  npm run evidence:index:check -- --run ${runId}${requireFlows.length ? ` --require ${requireFlows.join(',')}` : ''}`);
  }
}
