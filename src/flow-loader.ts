/**
 * Loads, normalises and validates flow manifests.
 *
 * Validation is strict and happens before a browser launches — a typo'd action
 * or a module missing from routes.map.json should cost you a second, not a
 * half-finished capture run with a corrupted baseline.
 *
 * Two schema versions coexist. v1 manifests (no `schema_version`) keep working
 * untouched; the loader normalises them into the v2 shape the executor reads,
 * so there is exactly one code path downstream.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { paths, envInterpolationVars, profile } from './env';
import { DUMMY_IDENTITY, NO_AUTH } from './profile';
import { isWriteFlow, isWriteStep, syntheticDataProblems } from './write-gates';
import { readJson, listFiles, relPosix } from './fsx';
import { GENERATED_HEADER, TODO_SELECTOR } from './recording-types';
import type {
  Flow,
  FlowStep,
  StepAction,
  StepPhase,
  RoutesMap,
  CaptureSpec,
  ScenarioClass,
} from './types';

const V2_ACTIONS: StepAction[] = [
  'goto', 'click', 'type', 'select', 'check', 'uncheck',
  'scrollTo', 'scrollUntilVisible', 'waitFor', 'expect', 'hover',
  'goBack', 'setViewport', 'swipe', 'tap', 'sleep',
];
/** Retained from v1. Not deprecated — `press` and `scroll` are load-bearing today. */
const V1_ACTIONS: StepAction[] = ['fill', 'press', 'scroll', 'wait', 'snapshot'];
const VALID_ACTIONS: StepAction[] = [...V2_ACTIONS, ...V1_ACTIONS];

const NEEDS_SELECTOR: StepAction[] = [
  'click', 'type', 'fill', 'select', 'check', 'uncheck', 'hover',
  'scrollUntilVisible', 'waitFor', 'expect', 'swipe', 'tap',
];

const SWIPE_DIRECTIONS = ['left', 'right', 'up', 'down'];
const NEEDS_VALUE: StepAction[] = ['goto', 'type', 'fill', 'select'];

const SCENARIO_CLASSES: ScenarioClass[] = [
  'happy', 'validation', 'duplicate', 'empty', 'permission', 'offline',
];

const STEP_ID_RE = /^[0-9]{2,3}-[a-z0-9-]+$/;

/**
 * Recorder drafts. These are NEVER loaded as executable flows — not by the
 * runner, not by doc-generator, not by discovery. loadFlows()
 * is the single choke point all four go through, so excluding them here is the
 * whole safety property: a draft full of TODOs cannot run, so it cannot write
 * anything anywhere.
 */
const DRAFT_SUFFIX_RE = /\.generated\.(ya?ml)$/i;

export function isDraftFile(file: string): boolean {
  return DRAFT_SUFFIX_RE.test(file);
}

export interface RawGateFinding {
  line: number;
  token: string;
  text: string;
}

/**
 * Scans raw file text BEFORE YAML parsing, so an unfinished draft that was
 * promoted produces the TODO error rather than a confusing cascade of
 * downstream schema errors.
 */
export function rawTextGate(raw: string): RawGateFinding[] {
  const findings: RawGateFinding[] = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const at = i + 1;
    const text = line.trim();
    if (text === GENERATED_HEADER) {
      findings.push({ line: at, token: 'GENERATED header', text });
    }
    if (line.includes(TODO_SELECTOR)) {
      findings.push({ line: at, token: TODO_SELECTOR, text });
    }
    // \bTODO\b does not match TODO_SELECTOR: "_" is a word character, so there
    // is no boundary after TODO there.
    if (/\bTODO\b/.test(line)) {
      findings.push({ line: at, token: 'TODO', text });
    }
  });
  return findings;
}

export interface DraftReport {
  file: string;
  todos: number;
}

/** Recorder drafts sitting in flows/, for validate's summary block. */
export function scanDrafts(): DraftReport[] {
  return listFiles(paths.flows, ['.yaml', '.yml'])
    .filter((f) => isDraftFile(f))
    .map((f) => ({
      file: relPosix(paths.root, f),
      todos: rawTextGate(fs.readFileSync(f, 'utf8')).length,
    }));
}

export interface LoadResult {
  flows: Flow[];
  errors: string[];
  warnings: string[];
}

// ─── Selector policy ─────────────────────────────────────────────────────────

/** `[data-testid="x"]`, with the usual attribute operators and {{VAR}} inside. */
const TESTID_TERM = /^\[data-testid([~^*$|]?=)("[^"]*"|'[^']*')(\s+i)?\]$/;
/** Playwright role engine: `role=button[name="Save"]`. */
const ROLE_TERM = /^role=[a-zA-Z]+(\[[^\]]*\])*$/;

/**
 * Splits a selector into descendant terms, ignoring whitespace inside quotes
 * and brackets — `role=button[name="Save Draft"]` is one term, not two.
 */
export function splitTerms(selector: string): string[] {
  const terms: string[] = [];
  let buf = '';
  let depth = 0;
  let quote: string | null = null;

  for (const ch of selector) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (buf) { terms.push(buf); buf = ''; }
      continue;
    }
    buf += ch;
  }
  if (buf) terms.push(buf);
  return terms;
}

/**
 * Returns a human reason if the selector is outside policy, or null if it is
 * allowed. Allowlist, not denylist: only data-testid attributes and Playwright
 * role/name selectors get through, so the flakiest forms can't creep back in
 * under a shape the denylist didn't anticipate.
 */
export function selectorPolicyViolation(selector: string): string | null {
  const terms = splitTerms(selector);
  if (!terms.length) return 'empty selector';

  const allAllowed = terms.every((t) => TESTID_TERM.test(t) || ROLE_TERM.test(t));
  if (allAllowed) return null;

  if (/:nth-child|:nth-of-type|:nth-last|>>\s*nth=/.test(selector)) {
    return 'positional (nth) selector — breaks the moment a row is inserted';
  }
  if (/(^|[\s>~+])\.[A-Za-z_-]/.test(selector) || /[A-Za-z\])"']\.[A-Za-z_-]/.test(selector)) {
    return 'CSS class chain — utility classes churn on every restyle';
  }
  if (/:has-text|(^|\s)text=/.test(selector)) {
    return 'text-matching selector — use role=<role>[name="..."] instead';
  }
  return 'not an allowed selector form — use [data-testid="..."] or role=<role>[name="..."]';
}

// ─── Normalisation ───────────────────────────────────────────────────────────

/** Every step across all three blocks, in execution order. */
export function allSteps(flow: Flow): FlowStep[] {
  return [...(flow.setup ?? []), ...(flow.steps ?? []), ...(flow.teardown ?? [])];
}

/**
 * Resolves `screenshot:` into a CaptureSpec.
 *
 * v1: `true` -> viewport, `true` + `full_page` -> full, `false`/absent -> none.
 * v2: 'viewport' | 'full' | 'auto' | 'element:<selector>' | false.
 *
 * setup and teardown default to no capture — they are plumbing, not
 * documentation — but an explicit mode there is still honoured.
 */
export function resolveCapture(step: FlowStep, phase: StepPhase): CaptureSpec | string {
  const raw = step.screenshot;

  // Absent means no capture everywhere — including `steps`, where a flow author
  // opts in per step rather than opting out.
  if (raw === undefined || raw === null) return { mode: 'none' };
  if (raw === false) return { mode: 'none' };
  if (raw === true) return step.full_page ? { mode: 'full' } : { mode: 'viewport' };

  if (typeof raw !== 'string') return `screenshot must be true, false, or a mode string`;

  const value = raw.trim();
  if (value === 'false' || value === 'none') return { mode: 'none' };
  if (value === 'viewport') return { mode: 'viewport' };
  if (value === 'full') return { mode: 'full' };
  if (value === 'auto') return { mode: 'auto' };
  if (value.startsWith('element:')) {
    const selector = value.slice('element:'.length).trim();
    if (!selector) return 'screenshot "element:" needs a selector after the colon';
    return { mode: 'element', selector };
  }
  return `unknown screenshot mode "${value}" — use viewport | full | auto | element:<selector> | false`;
}

/** Tags every step with its phase and resolved capture spec. Idempotent. */
export function normaliseFlow(flow: Flow): void {
  const tag = (steps: FlowStep[] | undefined, phase: StepPhase) => {
    for (const step of steps ?? []) {
      if (!step || typeof step !== 'object') continue;
      step._phase = phase;
      const spec = resolveCapture(step, phase);
      step._capture = typeof spec === 'string' ? { mode: 'none' } : spec;
    }
  };
  tag(flow.setup, 'setup');
  tag(flow.steps, 'steps');
  tag(flow.teardown, 'teardown');
}

// ─── Variable references ─────────────────────────────────────────────────────

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function varsIn(step: FlowStep): string[] {
  const strings: Array<string | undefined> = [
    step.selector,
    step.value === undefined ? undefined : String(step.value),
    ...(Array.isArray(step.mask) ? step.mask : []),
    step.assert?.text_contains,
    step.assert?.text_not_contains,
    step.assert?.selector_visible,
    step.assert?.selector_hidden,
    step.assert?.url_contains,
    step.assert?.count?.selector,
    typeof step.expect === 'object' && step.expect && 'text' in step.expect
      ? step.expect.text
      : undefined,
    typeof step.screenshot === 'string' ? step.screenshot : undefined,
  ];

  const found: string[] = [];
  for (const s of strings) {
    if (!s) continue;
    for (const m of s.matchAll(VAR_RE)) found.push(m[1]);
  }
  return found;
}

/** Selectors a step exposes to the policy check. */
function selectorsIn(step: FlowStep): Array<{ field: string; value: string }> {
  const out: Array<{ field: string; value: string }> = [];
  // TODO_SELECTOR is reported by the raw-text gate. Reporting it here as well
  // would give two errors for one problem, and the less useful one first.
  if (step.selector && step.selector !== TODO_SELECTOR) {
    out.push({ field: 'selector', value: step.selector });
  }
  if (step.assert?.selector_visible) {
    out.push({ field: 'assert.selector_visible', value: step.assert.selector_visible });
  }
  if (step.assert?.selector_hidden) {
    out.push({ field: 'assert.selector_hidden', value: step.assert.selector_hidden });
  }
  if (step.assert?.count?.selector) {
    out.push({ field: 'assert.count.selector', value: step.assert.count.selector });
  }
  if (Array.isArray(step.mask)) {
    step.mask.forEach((m, i) => {
      if (typeof m === 'string') out.push({ field: `mask[${i}]`, value: m });
    });
  }
  if (step._capture?.mode === 'element') {
    out.push({ field: 'screenshot element:', value: step._capture.selector });
  }
  return out;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** Device ids from config/devices.json, or [] when it cannot be read (reported separately). */
function knownDeviceIds(): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadDevicesConfig } = require('./devices') as typeof import('./devices');
    return loadDevicesConfig().devices.map((d) => d.id);
  } catch {
    return [];
  }
}

export function validateFlow(flow: Flow, rel: string, routesMap: RoutesMap): string[] {
  const e: string[] = [];
  const at = (msg: string) => `${rel}: ${msg}`;

  if (!flow || typeof flow !== 'object') return [at('not a YAML object.')];
  if (!flow.module || typeof flow.module !== 'string') e.push(at('missing required field "module".'));
  if (!flow.flow || typeof flow.flow !== 'string') e.push(at('missing required field "flow".'));
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
    e.push(at('missing or empty "steps".'));
    return e;
  }

  const version = flow.schema_version ?? 1;
  if (version !== 1 && version !== 2) {
    e.push(at(`schema_version ${version} is not supported — use 1 or 2.`));
  }
  if (version >= 2 && !flow.title) {
    e.push(at('schema_version 2 requires a "title" — a short human name for the flow.'));
  }

  const identities = [...Object.keys(profile.accounts), NO_AUTH];
  if (flow.auth !== undefined && !identities.includes(flow.auth)) {
    e.push(at(`auth "${flow.auth}" is not one of ${identities.join(' | ')} (the accounts in app.config.json, or none).`));
  }
  if (flow.writes !== undefined && typeof flow.writes !== 'boolean') e.push(at('"writes" must be true or false.'));
  if (flow.sends_messages !== undefined) {
    const channels = ['email', 'sms', 'whatsapp', 'push'];
    if (!Array.isArray(flow.sends_messages) || !flow.sends_messages.every((c) => channels.includes(c))) {
      e.push(at(`"sends_messages" must be a list of ${channels.join(' | ')}.`));
    }
  }
  if (flow.scenario_class && !SCENARIO_CLASSES.includes(flow.scenario_class)) {
    e.push(
      at(`scenario_class "${flow.scenario_class}" is not one of ${SCENARIO_CLASSES.join(' | ')}.`),
    );
  }
  if (flow.tags !== undefined && !Array.isArray(flow.tags)) {
    e.push(at('"tags" must be a list.'));
  }
  if (flow.devices !== undefined) {
    if (!Array.isArray(flow.devices) || !flow.devices.length || !flow.devices.every((d) => typeof d === 'string' && d)) {
      e.push(at('"devices" must be a non-empty list of device ids from config/devices.json.'));
    } else {
      const known = knownDeviceIds();
      // An empty list means the config could not be read; the dedicated config check reports that.
      const unknown = known.length ? flow.devices.filter((d) => !known.some((k) => k.toLowerCase() === d.toLowerCase())) : [];
      if (unknown.length) {
        e.push(at(`"devices" names ${unknown.map((u) => `"${u}"`).join(', ')}, which config/devices.json does not define (${known.join(', ')}).`));
      }
    }
  }
  if (flow.settle_ms !== undefined && typeof flow.settle_ms !== 'number') {
    e.push(at('"settle_ms" must be a number of milliseconds.'));
  }
  for (const block of ['setup', 'teardown'] as const) {
    const value = flow[block];
    if (value !== undefined && !Array.isArray(value)) {
      e.push(at(`"${block}" must be a list of steps.`));
      return e;
    }
  }
  if (flow.module && !routesMap[flow.module]) {
    e.push(
      at(`module "${flow.module}" is not in config/routes.map.json — ` +
        `add it (with source_paths) or the git-diff skip filter can't reason about this flow.`),
    );
  }

  normaliseFlow(flow);

  // Variables a flow may reference. Anything else means either a typo or a
  // dependency on another flow's data, and flows must be independently runnable.
  const knownVars = new Set([
    ...Object.keys(envInterpolationVars()),
    ...Object.keys(flow.vars ?? {}),
    'RUN_ID',
    'RUN_TAG',
  ]);

  const ids = new Set<string>();
  for (const step of allSteps(flow)) {
    e.push(...validateStep(step, flow, rel, version, ids, knownVars));
  }

  const steps = allSteps(flow).filter((s) => s && typeof s === 'object');
  for (const s of steps) {
    if (s.optional_reason === undefined) continue;
    if (typeof s.optional_reason !== 'string' || !s.optional_reason.trim()) {
      e.push(at(`step "${s.id}": optional_reason must be a non-empty string.`));
    } else if (s.optional !== true) {
      e.push(at(`step "${s.id}": optional_reason only means something with optional: true.`));
    }
  }

  // READ-ONLY unless dummy. A real login is permanently read-only: a flow that
  // declares a write is refused before a browser ever opens, unless it is an
  // explicit dummy write flow — and even then write-gates.ts re-checks at run
  // time (WRITE_MODE, host, the signed-in tenant).
  if (isWriteFlow(flow)) e.push(...validateWriteFlow(flow, steps, rel));
  if ((flow as { cleanup?: unknown }).cleanup !== undefined) {
    e.push(
      at('has a "cleanup" block — there is no such block. A dummy write flow removes what it ' +
        'created in "teardown"; a read-only flow has nothing to clean up.'),
    );
  }

  return e;
}

/**
 * The contract of a dummy write flow, checked offline. The run-time half
 * (WRITE_MODE, write-allowed host, verified tenant) lives in write-gates.ts.
 */
function validateWriteFlow(flow: Flow, steps: FlowStep[], rel: string): string[] {
  const e: string[] = [];
  const at = (msg: string) => `${rel}: ${msg}`;
  const writes = steps.filter(isWriteStep);

  if (flow.auth !== DUMMY_IDENTITY) {
    e.push(
      at(`declares ${writes.length || 'a'} data-writing step(s)${writes.length ? ` (${writes.map((s) => s.id).join(', ')})` : ''} ` +
        `but signs in as "${flow.auth ?? profile.defaultAccount}". Real logins are permanently READ-ONLY — ` +
        `only "auth: ${DUMMY_IDENTITY}" (the dummy account in its own test tenant) may write. Remove the step, ` +
        `or set run_tag: false if the value only searches or filters.`),
    );
    return e;
  }
  if (flow.writes !== true) {
    e.push(at(`writes data (${writes.map((s) => s.id).join(', ')}) but does not declare "writes: true" at the top.`));
  }
  if (!profile.dummyAccount) {
    e.push(at(`is a dummy write flow, but apps/${profile.id}/app.config.json has no "dummyAccount" section.`));
  }
  if (!(flow.teardown ?? []).length) {
    e.push(at('is a write flow with no "teardown" — it must delete the records it tagged with {{RUN_TAG}}.'));
  }
  const tagged = steps.filter((s) => s.run_tag === true);
  for (const s of tagged) {
    if (!String(s.value ?? '').includes('{{RUN_TAG}}')) {
      e.push(at(`${s._phase ?? 'steps'}[${s.id}]: run_tag: true, so its value must contain {{RUN_TAG}} — every created record carries the run id.`));
    }
  }
  if (!tagged.length) {
    e.push(at('writes data but no step types a value with run_tag: true — nothing it creates could be found by run id.'));
  }
  // Synthetic contact data only: every literal this flow types or declares.
  const phones = profile.dummyAccount?.syntheticPhones ?? [];
  const literals: Array<{ where: string; value: string }> = [
    ...steps
      .filter((s) => s.action === 'type' || s.action === 'fill')
      .map((s) => ({ where: `${s._phase ?? 'steps'}[${s.id}]`, value: String(s.value ?? '') })),
    ...Object.entries(flow.vars ?? {}).map(([k, v]) => ({ where: `vars.${k}`, value: String(v) })),
  ];
  for (const { where, value } of literals) {
    for (const problem of syntheticDataProblems(value, phones)) e.push(at(`${where}: ${problem}`));
  }
  return e;
}

function validateStep(
  step: FlowStep,
  flow: Flow,
  rel: string,
  version: number,
  ids: Set<string>,
  knownVars: Set<string>,
): string[] {
  const e: string[] = [];
  const phase = step?._phase ?? 'steps';
  const where = `${rel}: ${phase}[${step?.id ?? '?'}]`;

  if (!step || typeof step !== 'object') return [`${rel}: ${phase} contains a step that is not a mapping.`];
  if (!step.id) { e.push(`${where}: missing "id".`); return e; }
  if (!STEP_ID_RE.test(step.id)) {
    e.push(`${where}: id must match NN-kebab-case or NNN-kebab-case (e.g. "010-open-attendance").`);
  }
  // setup, steps and teardown share one screenshot filename namespace.
  if (ids.has(step.id)) e.push(`${where}: duplicate step id (ids must be unique across setup, steps and teardown).`);
  ids.add(step.id);

  if (!VALID_ACTIONS.includes(step.action)) {
    e.push(`${where}: unknown action "${step.action}". Valid: ${VALID_ACTIONS.join(', ')}.`);
    return e;
  }

  if (NEEDS_SELECTOR.includes(step.action) && !step.selector) {
    e.push(`${where}: action "${step.action}" requires a "selector".`);
  }
  if (NEEDS_VALUE.includes(step.action) && (step.value === undefined || step.value === '')) {
    e.push(`${where}: action "${step.action}" requires a "value".`);
  }
  if (step.action === 'goto' && typeof step.value === 'string' && !step.value.startsWith('/')) {
    e.push(`${where}: goto value must be a path starting with "/" (relative to TEST_APP_URL).`);
  }
  if (step.action === 'scrollTo' && !step.selector && !step.position) {
    e.push(`${where}: scrollTo needs either a "selector" or "position: top | bottom".`);
  }
  if (step.position && !['top', 'bottom'].includes(step.position)) {
    e.push(`${where}: position "${step.position}" is not one of top | bottom.`);
  }
  if (step.action === 'waitFor' && step.state && !['visible', 'hidden', 'attached'].includes(step.state)) {
    e.push(`${where}: state "${step.state}" is not one of visible | hidden | attached.`);
  }
  if (step.action === 'scrollUntilVisible' && step.max_scrolls !== undefined) {
    if (typeof step.max_scrolls !== 'number' || step.max_scrolls < 1) {
      e.push(`${where}: max_scrolls must be a positive number (default 10).`);
    }
  }
  if (step.action === 'setViewport') {
    if (!step.preset) e.push(`${where}: setViewport requires "preset: mobile | tablet | desktop".`);
    else if (!['mobile', 'tablet', 'desktop'].includes(step.preset)) {
      e.push(`${where}: preset "${step.preset}" is not one of mobile | tablet | desktop.`);
    }
  }
  if (step.action === 'swipe') {
    if (!step.direction) {
      e.push(`${where}: swipe requires "direction: left | right | up | down".`);
    } else if (!SWIPE_DIRECTIONS.includes(step.direction)) {
      e.push(`${where}: direction "${step.direction}" is not one of ${SWIPE_DIRECTIONS.join(' | ')}.`);
    }
    if (step.distance !== undefined && (typeof step.distance !== 'number' || step.distance <= 0)) {
      e.push(`${where}: swipe "distance" must be a positive number of px (default 200).`);
    }
    if (step.duration !== undefined && (typeof step.duration !== 'number' || step.duration <= 0)) {
      e.push(`${where}: swipe "duration" must be a positive number of ms (default 300).`);
    }
  }
  if (step.action === 'sleep') {
    if (step.value === undefined || step.value === '') {
      e.push(`${where}: sleep requires a "value" in milliseconds.`);
    }
    if (version >= 2 && !step.reason) {
      e.push(
        `${where}: sleep requires a "reason". A fixed wait is a last resort — ` +
          `prefer waitFor, expect, or a larger settle_ms.`,
      );
    }
  }
  if (step.action === 'expect') e.push(...validateExpect(step, where));

  if (step.mask && !Array.isArray(step.mask)) {
    e.push(`${where}: "mask" must be a list of selectors.`);
  }

  // run_tag: which typed values create records. The recorder's converter cannot
  // know, so it emits TODO; a human resolving it to true/false is what lets
  // validate enforce the write contract instead of hoping for it.
  const isTextEntry = step.action === 'type' || step.action === 'fill';
  if (step.run_tag !== undefined) {
    if (!isTextEntry) {
      e.push(`${where}: run_tag only applies to "type" and "fill" steps, not "${step.action}".`);
    } else if (step.run_tag !== true && step.run_tag !== false && step.run_tag !== 'TODO') {
      e.push(`${where}: run_tag must be true, false, or TODO — got ${JSON.stringify(step.run_tag)}.`);
    }
  } else if (isTextEntry) {
    e.push(
      `${where}: "${step.action}" requires run_tag — false for a search, a filter or a sign-in ` +
        `field; true (with {{RUN_TAG}} in the value) only in a dummy write flow. Answering the ` +
        `question explicitly is what keeps a write from slipping in unnoticed.`,
    );
  }

  const capture = resolveCapture(step, phase);
  if (typeof capture === 'string') e.push(`${where}: ${capture}`);

  // Selector policy.
  for (const { field, value } of selectorsIn(step)) {
    const violation = selectorPolicyViolation(value);
    if (!violation) continue;
    if (step.selector_exempt) continue; // downgraded to a warning, see flowWarnings
    e.push(
      `${where}: ${field} "${value}" violates the selector policy — ${violation}. ` +
        `Allowed: [data-testid="..."] or role=<role>[name="..."]. ` +
        `If this control genuinely has neither, set selector_exempt with a reason.`,
    );
  }

  // Unknown variables.
  for (const name of varsIn(step)) {
    if (knownVars.has(name)) continue;
    e.push(
      `${where}: references {{${name}}}, which is not an env var, not in this flow's "vars", ` +
        `and not RUN_ID/RUN_TAG. Flows must be independently runnable — they may not depend on ` +
        `data left behind by another flow.`,
    );
  }

  return e;
}

function validateExpect(step: FlowStep, where: string): string[] {
  const value = step.expect;
  if (value === undefined) {
    return [`${where}: action "expect" requires an "expect" condition.`];
  }
  if (typeof value === 'string') {
    if (!['visible', 'hidden', 'enabled', 'disabled'].includes(value)) {
      return [`${where}: expect "${value}" is not one of visible | hidden | enabled | disabled | {text} | {count}.`];
    }
    return [];
  }
  if (typeof value === 'object' && value !== null) {
    if ('text' in value) {
      return typeof value.text === 'string' ? [] : [`${where}: expect.text must be a string.`];
    }
    if ('count' in value) {
      const c = value.count;
      if (!c || typeof c !== 'object') return [`${where}: expect.count must be an object with min and/or max.`];
      if (c.min === undefined && c.max === undefined) {
        return [`${where}: expect.count needs at least one of min or max.`];
      }
      return [];
    }
  }
  return [`${where}: expect must be visible | hidden | enabled | disabled, or {text: ...} / {count: {...}}.`];
}

/** Non-fatal observations. Kept separate so validateFlow stays errors-only. */
export function flowWarnings(flow: Flow, rel: string): string[] {
  const w: string[] = [];
  const at = (msg: string) => `${rel}: ${msg}`;

  for (const step of allSteps(flow)) {
    if (!step || typeof step !== 'object') continue;

    if (step.selector_exempt) {
      const offenders = selectorsIn(step)
        .filter((s) => selectorPolicyViolation(s.value))
        .map((s) => s.value);
      w.push(
        at(`${step._phase ?? 'steps'}[${step.id}]: selector policy EXEMPT — "${step.selector_exempt}". ` +
          `Off-policy selector(s): ${offenders.join(', ') || '(none — the exemption is unused)'}. ` +
          `Raise a data-testid against the app repo and drop the exemption.`),
      );
    }

    if (step.action === 'sleep') {
      w.push(
        at(`${step._phase ?? 'steps'}[${step.id}]: uses sleep (${step.value}ms) — ` +
          `${step.reason ?? 'no reason given'}. Fixed waits are the flakiest thing in a flow; ` +
          `prefer waitFor or expect.`),
      );
    }
  }

  return w;
}

// ─── Loading ─────────────────────────────────────────────────────────────────

export function loadFlows(opts: { includeDisabled?: boolean } = {}): LoadResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const flows: Flow[] = [];

  const routesMap = readJson<RoutesMap>(paths.routesMap, {} as RoutesMap);
  const files = listFiles(paths.flows, ['.yaml', '.yml']).filter((f) => !isDraftFile(f));

  if (!files.length) {
    warnings.push(`No flow manifests found in ${relPosix(paths.root, paths.flows)}/`);
  }

  const seen = new Set<string>();

  for (const file of files) {
    const rel = relPosix(paths.root, file);
    const raw = fs.readFileSync(file, 'utf8');

    // Raw-text gate, before YAML parsing. This file is promoted (drafts were
    // filtered out above), so an unresolved marker is a hard error.
    const gate = rawTextGate(raw);
    if (gate.length) {
      for (const finding of gate) {
        errors.push(
          `${rel}:${finding.line}: unresolved "${finding.token}" in a promoted flow — ` +
            `${finding.text.slice(0, 100)}`,
        );
      }
      errors.push(
        `${rel}: this looks like an unfinished recorder draft. Resolve every TODO_SELECTOR, ` +
          `set run_tag: false on each type step (or delete the step if it writes), write a real ` +
          `teardown, and delete the GENERATED header before promoting it. A flow that looks ` +
          `complete but writes to a real account is worse than one that refuses to run.`,
      );
      continue;
    }

    let doc: unknown;
    try {
      doc = yaml.load(raw);
    } catch (err) {
      errors.push(`${rel}: YAML parse error — ${(err as Error).message}`);
      continue;
    }

    const flow = doc as Flow;
    const fileErrors = validateFlow(flow, rel, routesMap);
    if (fileErrors.length) {
      errors.push(...fileErrors);
      continue;
    }

    const key = `${flow.module}/${flow.flow}`;
    if (seen.has(key)) {
      errors.push(`${rel}: duplicate flow key "${key}" — module/flow pairs must be unique.`);
      continue;
    }
    seen.add(key);

    const expected = `${flow.module}.${flow.flow}`;
    const actual = path.basename(file).replace(/\.(ya?ml)$/i, '');
    if (expected !== actual) {
      warnings.push(`${rel}: filename should be "${expected}.yaml" to match module/flow.`);
    }

    if (flow.disabled && !opts.includeDisabled) {
      warnings.push(`${rel}: disabled — skipping.`);
      continue;
    }

    const account = profile.accounts[flow.auth ?? profile.defaultAccount];
    if (account?.optional) {
      warnings.push(
        `${rel}: auth "${flow.auth}" — runs only when ${[account.userEnv, account.secretEnv].filter(Boolean).join(' / ')} are set ` +
          `in apps/${profile.id}/.env; skipped otherwise.`,
      );
    }

    warnings.push(...flowWarnings(flow, rel));

    flow._sourcePath = rel;
    flows.push(flow);
  }

  for (const [module, entry] of Object.entries(routesMap)) {
    if (module.startsWith('$') || module === '_global') continue;
    for (const flowName of entry.flows ?? []) {
      if (!seen.has(`${module}/${flowName}`)) {
        warnings.push(
          `routes.map.json declares "${module}/${flowName}" but no manifest exists for it yet.`,
        );
      }
    }
  }

  flows.sort((a, b) => `${a.module}/${a.flow}`.localeCompare(`${b.module}/${b.flow}`));
  return { flows, errors, warnings };
}
