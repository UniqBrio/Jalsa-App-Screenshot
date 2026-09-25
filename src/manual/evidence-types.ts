/**
 * The on-disk shape of `evidence/<run_id>/…` — the contract between evidence
 * capture (C1) and every later manual stage.
 *
 * Privacy is part of the schema, not a filter applied afterwards: raw text may
 * only exist on an entry whose class is `L` (application label). Everything
 * else is stored as {class, rule, length, sha256}, where sha256 is an HMAC under
 * a per-run key that is never persisted — equal texts compare equal within the
 * run, but a digest cannot be dictionary-matched back to a member's name.
 */
import type { StepAction, StepPhase, StepStatus } from '../types';

// 2: every step evidence names the device profile it was captured on.
export const EVIDENCE_SCHEMA_VERSION = 2;

/**
 * S secret · I operator identifier · P member/customer personal data ·
 * O organisation data · L application label · U unclassified.
 */
export type DataClass = 'S' | 'I' | 'P' | 'O' | 'L' | 'U';
export const DATA_CLASSES: DataClass[] = ['S', 'I', 'P', 'O', 'L', 'U'];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ClassifiedText {
  class: DataClass;
  /** Which classification rule decided the class — makes every verdict auditable. */
  rule: string;
  length: number;
  /** Run-scoped HMAC-SHA256, hex. Empty text hashes to ''. */
  sha256: string;
  /** Present ONLY when class === 'L'. */
  text?: string;
}

export type CensusSource = 'text' | 'value' | 'placeholder';

/** One rendered run of text (or an input's value/placeholder) in the viewport. */
export interface CensusEntry extends ClassifiedText {
  source: CensusSource;
  box: Box;
  region_id: string | null;
  testid_family: string | null;
}

export interface FrameRef {
  /** Relative to the evidence run directory, POSIX separators. */
  path: string;
  kind: 'pre' | 'post';
  mode: 'viewport';
  /** PNG pixels, read from the IHDR chunk. */
  image: { width: number; height: number };
  /** CSS pixels. */
  viewport: { width: number; height: number };
  /** image.width / viewport.width — measured, not assumed. */
  dpr: number;
  scroll: { x: number; y: number; containers: Array<{ key: string; top: number }> };
  origin: null;
  png_sha256: string;
  stable: boolean;
  stability_reason: string;
  masked: string[];
}

export type SelectorKind = 'testid' | 'testid-prefix' | 'role' | 'role-regex' | 'chain' | 'exempt' | 'other';
export type InViewport = 'full' | 'partial' | 'none';

export interface ElementCore {
  /** Static test id only; an id-suffixed one is reduced to its family. */
  testid: string | null;
  testid_family: string | null;
  role: string;
  tag: string;
  input_type: string | null;
  name: ClassifiedText;
  name_source: string;
  visible_text: ClassifiedText;
  box: Box | null;
  in_viewport: InViewport;
  /** Stable key (test id family or role/tag) of what sits on top of the element, if anything. */
  occluded_by: string | null;
  occlusion: { points: number; clear: number };
  enabled: boolean;
  region_id: string | null;
}

export interface InventoryItem extends ElementCore {
  ref: string;
}

export interface ElementEvidence extends ElementCore {
  ref: string;
  selector: string;
  selector_kind: SelectorKind;
  match_count: number;
  list_instance: boolean;
  sensitive: null | { kind: 'credential' | 'identifier' | 'personal'; var?: string };
}

export interface SanitizedUrl {
  /** Route pattern, e.g. /member/[id]. */
  pattern: string;
  /** HMAC of the concrete pathname, so two URLs can be compared without storing ids. */
  path_sha256: string;
  query: Array<{ key: string; value: string | null; value_sha256: string | null }>;
  /** The route has a dynamic segment — the screen is about one record. */
  record_screen: boolean;
}

export interface SanitizedVisualState {
  route: SanitizedUrl;
  overlays: string[];
  scroll_tops: string[];
  visible_keys: string[];
  lists: string[];
  errors: Array<{ key: string; sha256: string; length: number }>;
  toasts: Array<{ key: string; sha256: string; length: number }>;
  active_tab: string;
  loading: string[];
  disabled: string[];
}

export interface InputEvidence extends ClassifiedText {
  /** The manifest's redaction token, when the value is a secret or identifier. */
  token: string | null;
}

export interface AssertionEvidence {
  kind: string;
  detail: string;
  /** true when the step passed; null when the step failed (which check failed is not attributable). */
  passed: boolean | null;
}

export interface PhaseEvidence {
  url: SanitizedUrl;
  visual: SanitizedVisualState;
  frame: FrameRef | null;
  census: CensusEntry[];
  census_truncated: boolean;
  inventory: InventoryItem[];
}

export interface StepEvidence {
  schema: number;
  run_id: string;
  /** Device profile id — the top folder of this run's output. */
  device: string;
  module: string;
  flow: string;
  step_id: string;
  phase: StepPhase;
  action: StepAction;
  input: InputEvidence | null;
  target: ElementEvidence | null;
  /** Why target is null (e.g. not an interaction, element not found). */
  target_reason: string | null;
  before: PhaseEvidence;
  after: PhaseEvidence & { dom_hash: string | null };
  signals: string[];
  assertions: AssertionEvidence[];
  status: StepStatus;
  error: string | null;
  evidence_errors: string[];
  captured_at: string;
}

export interface EvidenceFlowSummary {
  device: string;
  module: string;
  flow: string;
  status: string;
  steps: number;
  pre_frames: number;
  post_frames: number;
  targets: number;
  failed_steps: string[];
  evidence_errors: number;
  /**
   * Captured signed in as the dummy account (synthetic data in a test tenant).
   * The evidence check reports email/phone shapes in its files as warnings
   * instead of errors. Credentials stay errors everywhere.
   */
  dummy?: boolean;
}

export interface EvidenceRunSummary {
  schema: number;
  run_id: string;
  hash_scope: 'run-hmac';
  /** Device ids captured in this run, and the density each one expects. */
  devices: Array<{ id: string; dpr: number }>;
  expected_dpr: number;
  observed_dpr: number[];
  flows: EvidenceFlowSummary[];
  census_by_class: Record<DataClass, number>;
  label_review_file: string;
}

// ─── validation ──────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function checkBox(v: unknown, where: string, errs: string[]): void {
  if (!isObj(v) || !['x', 'y', 'w', 'h'].every((k) => isNum(v[k]))) errs.push(`${where}: box must be {x,y,w,h} numbers`);
}

export function checkClassified(v: unknown, where: string, errs: string[]): void {
  if (!isObj(v)) { errs.push(`${where}: must be an object`); return; }
  if (!DATA_CLASSES.includes(v.class as DataClass)) errs.push(`${where}.class: must be one of ${DATA_CLASSES.join('/')}`);
  if (!isStr(v.rule) || !v.rule) errs.push(`${where}.rule: required`);
  if (!isNum(v.length)) errs.push(`${where}.length: number required`);
  if (!isStr(v.sha256)) errs.push(`${where}.sha256: string required`);
  if (v.class === 'L') {
    if (!isStr(v.text)) errs.push(`${where}.text: an L entry must carry its text`);
  } else if (v.text !== undefined) {
    errs.push(`${where}.text: raw text is only permitted on class L (found on class ${String(v.class)})`);
  }
}

function checkElementCore(v: Obj, where: string, errs: string[]): void {
  checkClassified(v.name, `${where}.name`, errs);
  checkClassified(v.visible_text, `${where}.visible_text`, errs);
  if (v.box !== null) checkBox(v.box, `${where}.box`, errs);
  if (!['full', 'partial', 'none'].includes(v.in_viewport as string)) errs.push(`${where}.in_viewport: invalid`);
  if (!isStr(v.role)) errs.push(`${where}.role: required`);
  if (typeof v.enabled !== 'boolean') errs.push(`${where}.enabled: boolean required`);
}

function checkFrame(v: unknown, where: string, errs: string[]): void {
  if (v === null) return;
  if (!isObj(v)) { errs.push(`${where}: must be an object or null`); return; }
  if (!isStr(v.path) || !v.path) errs.push(`${where}.path: required`);
  if (!['pre', 'post'].includes(v.kind as string)) errs.push(`${where}.kind: invalid`);
  const img = v.image as Obj | undefined;
  const vp = v.viewport as Obj | undefined;
  if (!isObj(img) || !isNum(img.width) || !isNum(img.height)) errs.push(`${where}.image: {width,height} required`);
  if (!isObj(vp) || !isNum(vp.width) || !isNum(vp.height)) errs.push(`${where}.viewport: {width,height} required`);
  if (!isNum(v.dpr) || (v.dpr as number) <= 0) errs.push(`${where}.dpr: positive number required`);
  if (!isStr(v.png_sha256)) errs.push(`${where}.png_sha256: required`);
  if (typeof v.stable !== 'boolean') errs.push(`${where}.stable: boolean required`);
}

function checkPhase(v: unknown, where: string, errs: string[]): void {
  if (!isObj(v)) { errs.push(`${where}: must be an object`); return; }
  if (!isObj(v.url) || !isStr((v.url as Obj).pattern)) errs.push(`${where}.url.pattern: required`);
  if (!isObj(v.visual)) errs.push(`${where}.visual: required`);
  checkFrame(v.frame, `${where}.frame`, errs);
  if (!Array.isArray(v.census)) errs.push(`${where}.census: array required`);
  else v.census.forEach((c, i) => {
    checkClassified(c, `${where}.census[${i}]`, errs);
    if (isObj(c)) checkBox(c.box, `${where}.census[${i}].box`, errs);
  });
  if (!Array.isArray(v.inventory)) errs.push(`${where}.inventory: array required`);
  else v.inventory.forEach((it, i) => {
    if (isObj(it)) checkElementCore(it, `${where}.inventory[${i}]`, errs);
    else errs.push(`${where}.inventory[${i}]: must be an object`);
  });
}

/** Structural + privacy validation of one step evidence document. Returns errors; empty = valid. */
export function validateStepEvidence(doc: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(doc)) return ['evidence: must be a JSON object'];
  if (doc.schema !== EVIDENCE_SCHEMA_VERSION) errs.push(`schema: expected ${EVIDENCE_SCHEMA_VERSION}`);
  for (const k of ['run_id', 'device', 'module', 'flow', 'step_id', 'phase', 'action', 'status', 'captured_at']) {
    if (!isStr(doc[k]) || !doc[k]) errs.push(`${k}: required`);
  }
  if (doc.input !== null) checkClassified(doc.input, 'input', errs);
  if (doc.target !== null) {
    if (!isObj(doc.target)) errs.push('target: must be an object or null');
    else {
      checkElementCore(doc.target, 'target', errs);
      if (!isStr(doc.target.selector)) errs.push('target.selector: required');
      if (!isNum(doc.target.match_count)) errs.push('target.match_count: number required');
    }
  } else if (!isStr(doc.target_reason)) {
    errs.push('target_reason: required when target is null');
  }
  checkPhase(doc.before, 'before', errs);
  checkPhase(doc.after, 'after', errs);
  if (!Array.isArray(doc.signals)) errs.push('signals: array required');
  if (!Array.isArray(doc.assertions)) errs.push('assertions: array required');
  if (!Array.isArray(doc.evidence_errors)) errs.push('evidence_errors: array required');
  return errs;
}
