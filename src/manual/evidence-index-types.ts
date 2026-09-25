/**
 * The on-disk shape of `evidence/<run_id>/c2/evidence-index.json` — the Evidence
 * Index (C2): every frame a C1 evidence run captured, with a stable identity,
 * provenance back to the C1 step evidence and flow-run manifest, a
 * classification (flow, route, screen/state, step, purpose) and a verdict on
 * whether it may serve as canonical, customer-facing manual evidence.
 *
 * Privacy carries over from C1 unchanged: raw text exists only in the
 * vocabulary, only for class-L source text, and live numbers and dates are
 * replaced by {number} / {date} / {time} placeholders.
 */
import type { StepAction, StepPhase, StepStatus } from '../types';
import type { DataClass } from './evidence-types';

export const EVIDENCE_INDEX_SCHEMA_VERSION = 1;

export type FrameKind =
  | 'evidence-pre'      // C1 before-frame: the screen right before the step's action
  | 'evidence-post'     // C1 after-frame: the screen once the step settled
  | 'capture-viewport'  // executor documentation shot
  | 'capture-full'      // executor whole-content shot
  | 'capture-element'   // executor element shot
  | 'capture-failed'    // executor failure shot
  | 'capture-loading'   // executor shot taken after the stability gate expired
  | 'unreferenced';     // a PNG in the run that no manifest or evidence file mentions
export const FRAME_KINDS: FrameKind[] = [
  'evidence-pre', 'evidence-post', 'capture-viewport', 'capture-full', 'capture-element', 'capture-failed', 'capture-loading', 'unreferenced',
];

export type EvidencePurpose =
  | 'control-location'   // where the control the step acts on sits
  | 'step-result'        // what the step left on screen
  | 'screen-viewport'
  | 'screen-full'
  | 'screen-element'
  | 'failure-diagnostic'
  | 'unstable-capture'
  | 'unreferenced';
export const EVIDENCE_PURPOSES: EvidencePurpose[] = [
  'control-location', 'step-result', 'screen-viewport', 'screen-full', 'screen-element', 'failure-diagnostic', 'unstable-capture', 'unreferenced',
];

/** Why a frame may not be customer-facing evidence. Any one excludes it. */
export const EXCLUSION_CODES = [
  'step-failed',
  'step-skipped',
  'failure-capture',
  'loading-capture',
  'unstable-frame',
  'loading-indicator',
  'transitional-url',
  'transitional-unreadable',
  'evidence-reading-error',
  'census-truncated',
  'secret-visible',
  'provenance-hash-mismatch',
  'provenance-size-mismatch',
  'provenance-dpr-mismatch',
  'unreferenced-file',
] as const;
export type ExclusionCode = (typeof EXCLUSION_CODES)[number];

/** Facts about an eligible frame that do not exclude it. */
export const NOTE_CODES = [
  'no-paired-census',          // an executor shot: no classified text census was read against it
  'screen-undeclared',         // the step names no expect_screen, so the frame cannot be named without inventing
  'target-undescribed',        // a before-frame with no described, fully in-viewport target
  'target-partially-occluded', // the target is described but something overlaps part of it
  'redaction-required',        // I, P or U text is visible
  'duplicate-screen',          // an earlier step in the flow already supplies this screen's canonical frame
] as const;
export type NoteCode = (typeof NOTE_CODES)[number];

export type CanonicalRole = 'screen-state' | 'control-location';
export type Suitability = 'canonical' | 'supporting' | 'excluded';

export interface IndexedStep {
  id: string;
  /** Position in the flow-run manifest (execution order, setup through teardown). */
  order: number;
  phase: StepPhase;
  action: StepAction;
  /** Authored step label from the flow manifest. */
  label: string | null;
  optional: boolean;
  /** steps-phase and not optional. Setup and teardown are never coverage. */
  required: boolean;
  status: StepStatus;
  expect_screen: string | null;
}

export interface FrameProvenance {
  run_id: string;
  /** Where the frame is referenced from. */
  source: 'step-evidence' | 'flow-run' | 'none';
  evidence_file: string | null;
  evidence_sha256: string | null;
  /** JSON path of the frame record inside evidence_file. */
  evidence_pointer: 'before.frame' | 'after.frame' | null;
  flow_run_file: string | null;
  flow_run_sha256: string | null;
  /** Index into the flow-run manifest's steps array. */
  flow_run_step_index: number | null;
  manifest_file: string | null;
  manifest_sha256: string | null;
  app_git_sha: string | null;
  captured_at: string | null;
}

export interface IndexedFrame {
  /** Stable across runs: `<module>/<flow>/<step_id>#<kind-suffix>`, or `file:<path>` for unreferenced files. */
  frame_id: string;
  kind: FrameKind;
  file: { path: string; png_sha256: string; bytes: number; width: number; height: number };
  provenance: FrameProvenance;
  flow: string | null;
  step: IndexedStep | null;
  route: { pattern: string; record_screen: boolean; query_keys: string[] } | null;
  screen: { name: string | null; source: 'step.expect_screen' | 'previous-step.expect_screen' | 'undeclared' };
  state: {
    stable: boolean | null;
    stability_reason: string | null;
    overlays: number | null;
    errors: number | null;
    toasts: number | null;
    loading: number | null;
    disabled: number | null;
    /** Visual-state signals that fired across the step. */
    signals: string[];
  };
  purpose: EvidencePurpose;
  privacy: {
    paired_census: boolean;
    census_by_class: Record<DataClass, number> | null;
    census_truncated: boolean | null;
    /** null when there is no paired census to decide from. */
    redaction_required: boolean | null;
  };
  target: { described: boolean; in_viewport: 'full' | 'partial' | 'none' | null; occlusion_clear: number | null; occlusion_points: number | null } | null;
  /** Vocabulary ids of the label texts visible in this frame. */
  label_ids: string[];
  suitability: Suitability;
  exclusions: ExclusionCode[];
  notes: NoteCode[];
  canonical_role: CanonicalRole | null;
  /** Executor shots: the evidence-post frame taken in the same settled state. */
  same_state_as: string | null;
  /** duplicate-screen frames: the flow's canonical frame for the same screen. */
  duplicate_of: string | null;
}

export interface IndexedFlowStep extends IndexedStep {
  frame_ids: string[];
  canonical_screen_frame: string | null;
  canonical_control_frame: string | null;
  /** Interaction steps (the ones C1 gives a before-frame and target). */
  interaction: boolean;
}

export interface IndexedFlow {
  flow: string;
  title: string | null;
  required: boolean;
  manifest_file: string | null;
  manifest_sha256: string | null;
  flow_run_file: string | null;
  flow_run_sha256: string | null;
  flow_run_status: string | null;
  app_git_sha: string | null;
  steps: IndexedFlowStep[];
}

export interface VocabularyEntry {
  id: string;
  /**
   * L source text with icon glyphs removed, whitespace collapsed, and live values replaced by
   * placeholders. Label-allowlist copy (human-reviewed, config/pii-regions.json) is never templated.
   */
  text: string;
  variables: Array<'date' | 'time' | 'number'>;
  /** False when the text holds a variable or is under an open review item. */
  fixed_wording: boolean;
  sources: Array<'text' | 'placeholder'>;
  rules: string[];
  review_items: string[];
  frame_count: number;
}

export interface ReviewItemLink {
  id: string;
  topic: string;
  status: 'open' | 'resolved';
  origin: string;
  question: string;
  resolution: string | null;
  /** Exact texts the item is about, verbatim from config. */
  texts: string[];
  vocabulary_ids: string[];
  frame_ids: string[];
}

export interface FlowCoverage {
  flow: string;
  flow_run_status: string | null;
  flow_failed: boolean;
  required_steps: { total: number; ok: number; not_ok: string[] };
  required_screens: { total: number; covered: number; missing: string[] };
  required_interactions: { total: number; covered: number; missing: string[] };
  optional_steps: Array<{ id: string; status: StepStatus; expect_screen: string | null; covered: boolean }>;
  complete: boolean;
}

export interface ScreenCatalogEntry {
  name: string;
  flows: string[];
  frame_ids: string[];
  canonical_frame_id: string | null;
}

export interface EvidenceIndex {
  schema: number;
  kind: 'evidence-index';
  run_id: string;
  generator: 'evidence-index@1';
  sources: {
    evidence_summary_sha256: string | null;
    /** Pass flag only: evidence-check.json is rewritten by every C1 check, so its bytes are not a stable source. */
    evidence_check_passed: boolean | null;
    label_review_sha256: string | null;
    review_items_sha256: string | null;
  };
  engagement: { experience: 'NO_EXPERIENCE'; basis: string };
  required_flows: string[];
  expected_dpr: number;
  totals: {
    frames: number;
    by_kind: Record<FrameKind, number>;
    by_suitability: Record<Suitability, number>;
    canonical_screen_frames: number;
    canonical_control_frames: number;
  };
  flows: IndexedFlow[];
  frames: IndexedFrame[];
  screens: ScreenCatalogEntry[];
  vocabulary: VocabularyEntry[];
  /** Census L occurrences deliberately kept out of the vocabulary, by reason. */
  vocabulary_excluded: { symbol_only: number; variable_only: number; input_value: number };
  review_items: ReviewItemLink[];
  coverage: FlowCoverage[];
}

// ─── validation ──────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const strOrNull = (v: unknown) => v === null || isStr(v);
const HEX64 = /^[0-9a-f]{64}$/;

function checkStep(v: unknown, where: string, errs: string[]): void {
  if (!isObj(v)) { errs.push(`${where}: object required`); return; }
  if (!isStr(v.id) || !v.id) errs.push(`${where}.id: required`);
  if (!isNum(v.order)) errs.push(`${where}.order: number required`);
  if (!['setup', 'steps', 'teardown'].includes(v.phase as string)) errs.push(`${where}.phase: invalid`);
  if (!isStr(v.action)) errs.push(`${where}.action: required`);
  if (!strOrNull(v.label)) errs.push(`${where}.label: string or null`);
  if (!isBool(v.optional) || !isBool(v.required)) errs.push(`${where}.optional/required: boolean required`);
  if (v.required === true && (v.optional === true || v.phase !== 'steps')) errs.push(`${where}.required: only a non-optional steps-phase step is required`);
  if (!['ok', 'failed', 'skipped'].includes(v.status as string)) errs.push(`${where}.status: invalid`);
  if (!strOrNull(v.expect_screen)) errs.push(`${where}.expect_screen: string or null`);
}

function checkFrame(f: unknown, where: string, errs: string[], ids: Set<string>, paths: Set<string>): void {
  if (!isObj(f)) { errs.push(`${where}: object required`); return; }
  if (!isStr(f.frame_id) || !f.frame_id) errs.push(`${where}.frame_id: required`);
  else if (ids.has(f.frame_id)) errs.push(`${where}.frame_id: duplicate`);
  else ids.add(f.frame_id);
  if (!FRAME_KINDS.includes(f.kind as FrameKind)) errs.push(`${where}.kind: invalid`);
  const file = f.file as Obj;
  if (!isObj(file) || !isStr(file.path) || !isStr(file.png_sha256) || !HEX64.test(file.png_sha256) || !isNum(file.bytes) || !isNum(file.width) || !isNum(file.height)) {
    errs.push(`${where}.file: {path, png_sha256 (hex), bytes, width, height} required`);
  } else if (paths.has(file.path)) errs.push(`${where}.file.path: indexed twice`);
  else paths.add(file.path);
  const p = f.provenance as Obj;
  if (!isObj(p) || !isStr(p.run_id) || !['step-evidence', 'flow-run', 'none'].includes(p.source as string)) errs.push(`${where}.provenance: run_id and source required`);
  else {
    if (p.source === 'step-evidence' && (!isStr(p.evidence_file) || !isStr(p.evidence_sha256) || !isStr(p.evidence_pointer))) errs.push(`${where}.provenance: step-evidence frames need evidence_file, evidence_sha256 and evidence_pointer`);
    if (p.source === 'flow-run' && (!isStr(p.flow_run_file) || !isNum(p.flow_run_step_index))) errs.push(`${where}.provenance: flow-run frames need flow_run_file and flow_run_step_index`);
  }
  if (f.kind !== 'unreferenced') {
    if (!isStr(f.flow)) errs.push(`${where}.flow: required for a referenced frame`);
    checkStep(f.step, `${where}.step`, errs);
  }
  if (!EVIDENCE_PURPOSES.includes(f.purpose as EvidencePurpose)) errs.push(`${where}.purpose: invalid`);
  if (!['canonical', 'supporting', 'excluded'].includes(f.suitability as string)) errs.push(`${where}.suitability: invalid`);
  const exclusions = f.exclusions as unknown[];
  const notes = f.notes as unknown[];
  if (!Array.isArray(exclusions) || !exclusions.every((c) => (EXCLUSION_CODES as readonly string[]).includes(c as string))) errs.push(`${where}.exclusions: known codes only`);
  if (!Array.isArray(notes) || !notes.every((c) => (NOTE_CODES as readonly string[]).includes(c as string))) errs.push(`${where}.notes: known codes only`);
  if (Array.isArray(exclusions)) {
    if (exclusions.length && f.suitability !== 'excluded') errs.push(`${where}.suitability: a frame with exclusions must be excluded`);
    if (!exclusions.length && f.suitability === 'excluded') errs.push(`${where}.suitability: excluded without an exclusion code`);
  }
  if ((f.suitability === 'canonical') !== (f.canonical_role !== null)) errs.push(`${where}.canonical_role: set exactly when suitability is canonical`);
  if (f.canonical_role !== null && !['screen-state', 'control-location'].includes(f.canonical_role as string)) errs.push(`${where}.canonical_role: invalid`);
  if (!isObj(f.screen) || !strOrNull((f.screen as Obj).name)) errs.push(`${where}.screen: required`);
  if (!isObj(f.privacy) || !isBool((f.privacy as Obj).paired_census)) errs.push(`${where}.privacy: required`);
  if (!Array.isArray(f.label_ids) || !(f.label_ids as unknown[]).every(isStr)) errs.push(`${where}.label_ids: string array required`);
  if (!strOrNull(f.same_state_as) || !strOrNull(f.duplicate_of)) errs.push(`${where}.same_state_as/duplicate_of: string or null`);
}

/** Structural validation of an Evidence Index document. Returns errors; empty = valid. */
export function validateEvidenceIndex(doc: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(doc)) return ['index: must be a JSON object'];
  if (doc.schema !== EVIDENCE_INDEX_SCHEMA_VERSION) errs.push(`schema: expected ${EVIDENCE_INDEX_SCHEMA_VERSION}`);
  if (doc.kind !== 'evidence-index') errs.push('kind: expected "evidence-index"');
  if (!isStr(doc.run_id) || !doc.run_id) errs.push('run_id: required');
  const eng = doc.engagement as Obj;
  if (!isObj(eng) || eng.experience !== 'NO_EXPERIENCE' || !isStr(eng.basis)) errs.push('engagement.experience: must be NO_EXPERIENCE with a basis');
  if (!Array.isArray(doc.required_flows) || !(doc.required_flows as unknown[]).every(isStr)) errs.push('required_flows: string array required');

  const ids = new Set<string>();
  const paths = new Set<string>();
  if (!Array.isArray(doc.frames)) errs.push('frames: array required');
  else (doc.frames as unknown[]).forEach((f, i) => checkFrame(f, `frames[${i}]`, errs, ids, paths));

  const vocabIds = new Set<string>();
  if (!Array.isArray(doc.vocabulary)) errs.push('vocabulary: array required');
  else (doc.vocabulary as unknown[]).forEach((v, i) => {
    const where = `vocabulary[${i}]`;
    if (!isObj(v) || !isStr(v.id) || !isStr(v.text) || !v.text || !Array.isArray(v.variables) || !isBool(v.fixed_wording)) { errs.push(`${where}: {id, text, variables, fixed_wording} required`); return; }
    if (vocabIds.has(v.id)) errs.push(`${where}.id: duplicate`);
    vocabIds.add(v.id);
    // Only human-reviewed allowlist copy ("your 4-digit PIN") may keep a digit; anything else is a live value.
    if (/\d/.test(v.text) && !(Array.isArray(v.rules) && v.rules.includes('label-allowlist'))) errs.push(`${where}.text: a digit survived — live numbers must be placeholders`);
    if (v.fixed_wording && (v.variables as unknown[]).length) errs.push(`${where}.fixed_wording: a text with variables is not fixed wording`);
  });
  if (Array.isArray(doc.frames)) (doc.frames as Obj[]).forEach((f, i) => {
    for (const id of (isObj(f) && Array.isArray(f.label_ids) ? f.label_ids : []) as string[]) {
      if (!vocabIds.has(id)) errs.push(`frames[${i}].label_ids: unknown vocabulary id ${id}`);
    }
    for (const k of ['same_state_as', 'duplicate_of'] as const) {
      if (isObj(f) && isStr(f[k]) && !ids.has(f[k] as string)) errs.push(`frames[${i}].${k}: unknown frame id`);
    }
  });

  if (!Array.isArray(doc.flows)) errs.push('flows: array required');
  else (doc.flows as unknown[]).forEach((fl, i) => {
    const where = `flows[${i}]`;
    if (!isObj(fl) || !isStr(fl.flow) || !Array.isArray(fl.steps)) { errs.push(`${where}: {flow, steps} required`); return; }
    (fl.steps as unknown[]).forEach((s, j) => {
      checkStep(s, `${where}.steps[${j}]`, errs);
      if (!isObj(s)) return;
      for (const id of (Array.isArray(s.frame_ids) ? s.frame_ids : []) as string[]) if (!ids.has(id)) errs.push(`${where}.steps[${j}].frame_ids: unknown frame id`);
      for (const k of ['canonical_screen_frame', 'canonical_control_frame'] as const) {
        if (isStr(s[k]) && !ids.has(s[k] as string)) errs.push(`${where}.steps[${j}].${k}: unknown frame id`);
      }
    });
  });

  if (!Array.isArray(doc.coverage)) errs.push('coverage: array required');
  if (!Array.isArray(doc.screens)) errs.push('screens: array required');
  if (!Array.isArray(doc.review_items)) errs.push('review_items: array required');
  else (doc.review_items as unknown[]).forEach((r, i) => {
    if (!isObj(r) || !isStr(r.id) || !['open', 'resolved'].includes(r.status as string) || !Array.isArray(r.texts)) errs.push(`review_items[${i}]: {id, status, texts} required`);
  });
  return errs;
}
