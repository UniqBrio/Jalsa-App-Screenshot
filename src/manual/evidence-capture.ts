/**
 * Evidence capture (C1) — the before/after hooks the flow executor calls in
 * evidence mode, and nothing else. Normal capture never constructs a sink.
 *
 * For each step in the `steps` phase:
 *   before  URL + visual state. For interactions and scrolls additionally: the
 *           target scrolled into view (only where Playwright's own action would
 *           scroll it), the stability gate, then — back to back, with no action
 *           between — a viewport frame, the target's element evidence, the
 *           control inventory and the text census.
 *   after   the same readings after the step settled and its assertions ran,
 *           the visual-state diff, the DOM hash (computed, never compared), and
 *           the step's assertions and input as evidence.
 *
 * Output lives ONLY under evidence/<run_id>/. The evidence hooks never throw
 * into the flow: a reading that fails is recorded in `evidence_errors` and the
 * step's own outcome is left exactly as the executor decided it.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Page } from '@playwright/test';
import { redactSecrets, identifierValues, secretValues, type IdentifierValue } from '../env';
import { DUMMY_IDENTITY } from '../profile';
import { ensureDir, writeJson, writeText } from '../fsx';
import { waitForStable } from '../stability';
import { domHash } from '../fingerprint';
import { readVisualState, diffVisualState, unknownVisualState, type VisualState } from '../visual-state';
import type { Flow, FlowRun, FlowStep, KnownRoute, RunSummary, StepResult } from '../types';
import type { DeviceProfile } from '../devices';
import { censusProbeSource, type ClassifyRules, type PageArgs } from './census-probe';
import type { PiiConfig } from './pii-config';
import {
  inputEvidence,
  pngSize,
  safeLiterals,
  sanitizeError,
  sanitizeUrl,
  sanitizeVisualState,
  selectorKind,
  sha256File,
} from './evidence-sanitize';
import {
  EVIDENCE_SCHEMA_VERSION,
  type AssertionEvidence,
  type CensusEntry,
  type DataClass,
  type ElementEvidence,
  type EvidenceFlowSummary,
  type EvidenceRunSummary,
  type FrameRef,
  type InventoryItem,
  type PhaseEvidence,
  type StepEvidence,
} from './evidence-types';

/** Actions whose target gets a before-frame and element evidence. */
export const PRE_FRAME_ACTIONS = new Set([
  'click', 'tap', 'type', 'fill', 'select', 'check', 'uncheck', 'hover', 'press', 'swipe',
  'scrollTo', 'scrollUntilVisible', 'scroll',
]);
/** The subset Playwright's own action would scroll into view anyway — scrolling first changes nothing it would not. */
export const PRE_SCROLL_ACTIONS = new Set(['click', 'tap', 'type', 'fill', 'select', 'check', 'uncheck', 'hover', 'swipe']);

export interface EvidenceSinkOptions {
  runId: string;
  /** Absolute evidence/<run_id> directory. */
  root: string;
  knownRoutes: KnownRoute[];
  pii: PiiConfig;
  /** Device profiles this run captures on; each contributes its own expected density. */
  devices: DeviceProfile[];
  /** The app profile's phone shape (pii.phonePattern). Absent: no phone rule. */
  phonePattern?: string | null;
  /** Defaults to the .env values; tests pass synthetic ones. */
  identifiers?: IdentifierValue[];
  secrets?: string[];
  maxCensus?: number;
  maxInventory?: number;
}

export interface PreState {
  rawVisual: VisualState;
  url: string;
  frame: FrameRef | null;
  census: CensusEntry[];
  censusTruncated: boolean;
  inventory: InventoryItem[];
  target: Omit<ElementEvidence, 'sensitive'> | null;
  targetReason: string | null;
  errors: string[];
}

export class EvidenceSink {
  readonly root: string;
  private readonly key = crypto.randomBytes(32).toString('hex');
  private readonly identifiers: IdentifierValue[];
  private readonly secrets: string[];
  private readonly flows = new Map<string, EvidenceFlowSummary>();
  private readonly censusByClass: Record<DataClass, number> = { S: 0, I: 0, P: 0, O: 0, L: 0, U: 0 };
  private readonly labels = new Map<string, Map<string, number>>();
  private readonly observedDpr = new Set<number>();

  constructor(private readonly opts: EvidenceSinkOptions) {
    this.root = opts.root;
    this.identifiers = opts.identifiers ?? identifierValues();
    this.secrets = opts.secrets ?? secretValues();
  }

  private rules(flow: Flow): ClassifyRules {
    return {
      identifiers: this.identifiers,
      secrets: this.secrets,
      safe_literals: safeLiterals(flow),
      label_texts: this.opts.pii.label_texts,
      phone_pattern: this.opts.phonePattern ?? undefined,
    };
  }

  private pageArgs(flow: Flow, url: string): PageArgs {
    return {
      hmacKey: this.key,
      rules: this.rules(flow),
      regions: this.opts.pii.data_regions,
      recordScreen: sanitizeUrl(url, this.opts.knownRoutes, this.key).record_screen,
      maxCensus: this.opts.maxCensus ?? 1500,
      maxInventory: this.opts.maxInventory ?? 150,
    };
  }

  /** Executor screenshots for one device: evidence/<run>/<Device>/screenshots/<module>/<flow>/… */
  screenshotsRoot(device: string): string {
    return path.join(this.root, device, 'screenshots');
  }

  private stepDir(device: DeviceProfile, flow: Flow): string {
    return path.join(this.root, device.id, flow.module, flow.flow);
  }

  private async install(page: Page): Promise<void> {
    await page.evaluate(censusProbeSource());
  }

  private async frame(page: Page, device: DeviceProfile, flow: Flow, step: FlowStep, kind: 'pre' | 'post', mask: string[], stable: { stable: boolean; reason: string }): Promise<FrameRef> {
    const abs = path.join(this.stepDir(device, flow), `${step.id}.${kind}.png`);
    ensureDir(path.dirname(abs));
    const buf = await page.screenshot({
      path: abs,
      fullPage: false,
      animations: 'disabled',
      caret: 'hide',
      mask: mask.map((m) => page.locator(m)),
      maskColor: '#7f7f7f',
    });
    const image = pngSize(buf);
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const dpr = viewport.width ? Math.round((image.width / viewport.width) * 1000) / 1000 : 0;
    this.observedDpr.add(dpr);
    const scroll = await page.evaluate('window.__ubCensus.scroll()') as FrameRef['scroll'];
    return {
      path: path.relative(this.root, abs).split(path.sep).join('/'),
      kind,
      mode: 'viewport',
      image,
      viewport,
      dpr,
      scroll,
      origin: null,
      png_sha256: sha256File(buf),
      stable: stable.stable,
      stability_reason: stable.reason,
      masked: mask,
    };
  }

  private async readings(page: Page, flow: Flow) {
    const args = this.pageArgs(flow, page.url());
    const census = (await page.evaluate((a) => (window as any).__ubCensus.census(a), args)) as { entries: CensusEntry[]; truncated: boolean };
    const inventory = (await page.evaluate((a) => (window as any).__ubCensus.inventory(a), args)) as InventoryItem[];
    return { census, inventory };
  }

  private err(e: unknown, authored: string[]): string {
    return sanitizeError((e as Error)?.message ?? String(e), authored, this.key);
  }

  /** Called before the executor performs the step's action. Never throws. */
  async before(page: Page, device: DeviceProfile, flow: Flow, step: FlowStep, selector: string | null, mask: string[]): Promise<PreState> {
    const authored = [selector ?? '', step.id];
    const state: PreState = {
      rawVisual: unknownVisualState(),
      url: page.url(),
      frame: null,
      census: [],
      censusTruncated: false,
      inventory: [],
      target: null,
      targetReason: selector ? null : 'no selector',
      errors: [],
    };
    state.rawVisual = await readVisualState(page).catch(() => unknownVisualState());

    if (!PRE_FRAME_ACTIONS.has(step.action)) {
      state.targetReason = 'not an interaction';
      return state;
    }

    try {
      const loc = selector ? page.locator(selector).first() : null;
      if (loc) {
        await loc.waitFor({ state: 'attached' }).catch(() => undefined);
        if (PRE_SCROLL_ACTIONS.has(step.action)) {
          await loc.waitFor({ state: 'visible' }).catch(() => undefined);
          await loc.scrollIntoViewIfNeeded().catch(() => undefined);
        }
      }
      const stable = await waitForStable(page);
      state.rawVisual = await readVisualState(page).catch(() => state.rawVisual);
      state.url = page.url();
      await this.install(page);

      // Back to back: frame, then the element geometry and text read against that same frame.
      state.frame = await this.frame(page, device, flow, step, 'pre', mask, stable);
      if (loc && selector) {
        const args = this.pageArgs(flow, state.url);
        const count = await page.locator(selector).count();
        const described = count > 0
          ? await loc.evaluate((el, a) => (window as any).__ubCensus.describe(el, a), args).catch((e) => {
              state.errors.push(`describe: ${this.err(e, authored)}`);
              return null;
            })
          : null;
        if (described) {
          const kind = selectorKind(selector, step);
          state.target = {
            ...described,
            ref: `${flow.module}/${flow.flow}/${step.id}#target`,
            selector: redactSecrets(selector),
            selector_kind: kind,
            match_count: count,
            list_instance: count > 1 || kind === 'testid-prefix' || kind === 'role-regex',
          };
        } else if (!state.targetReason) {
          state.targetReason = count === 0 ? 'selector matched no element before the action' : 'element could not be described';
        }
      }
      const r = await this.readings(page, flow);
      state.census = r.census.entries;
      state.censusTruncated = r.census.truncated;
      state.inventory = r.inventory;
    } catch (e) {
      state.errors.push(`before: ${this.err(e, authored)}`);
      if (!state.target && !state.targetReason) state.targetReason = 'evidence reading failed';
    }
    return state;
  }

  /** Called once the executor has decided the step's outcome (ok, skipped or failed). Never throws. */
  async after(page: Page, device: DeviceProfile, flow: Flow, step: FlowStep, result: StepResult, pre: PreState, mask: string[], vars: Record<string, string>): Promise<void> {
    const authored = [step.selector ?? '', result.selector ?? '', step.id, ...safeLiterals(flow)];
    const errors = [...pre.errors];
    const empty = (url: string): PhaseEvidence => ({
      url: sanitizeUrl(url, this.opts.knownRoutes, this.key),
      visual: sanitizeVisualState(unknownVisualState(), this.opts.knownRoutes, this.key),
      frame: null,
      census: [],
      census_truncated: false,
      inventory: [],
    });

    let after: PhaseEvidence & { dom_hash: string | null } = { ...empty(page.url()), dom_hash: null };
    let rawAfter: VisualState = unknownVisualState();
    try {
      const stable = page.isClosed() ? { stable: false, reason: 'page closed' } : await waitForStable(page);
      rawAfter = await readVisualState(page).catch(() => unknownVisualState());
      await this.install(page);
      const frame = await this.frame(page, device, flow, step, 'post', mask, stable);
      const r = await this.readings(page, flow);
      after = {
        url: sanitizeUrl(page.url(), this.opts.knownRoutes, this.key),
        visual: sanitizeVisualState(rawAfter, this.opts.knownRoutes, this.key),
        frame,
        census: r.census.entries,
        census_truncated: r.census.truncated,
        inventory: r.inventory,
        dom_hash: await domHash(page, mask).catch(() => null),
      };
    } catch (e) {
      errors.push(`after: ${this.err(e, authored)}`);
    }

    const rules = this.rules(flow);
    const { input, sensitive } = inputEvidence(step, vars, rules, this.opts.knownRoutes, this.key);
    const target: ElementEvidence | null = pre.target ? { ...pre.target, sensitive } : null;

    const doc: StepEvidence = {
      schema: EVIDENCE_SCHEMA_VERSION,
      run_id: this.opts.runId,
      device: device.id,
      module: flow.module,
      flow: flow.flow,
      step_id: step.id,
      phase: result.phase,
      action: step.action,
      input,
      target,
      target_reason: target ? null : pre.targetReason ?? 'no target',
      before: {
        url: sanitizeUrl(pre.url, this.opts.knownRoutes, this.key),
        visual: sanitizeVisualState(pre.rawVisual, this.opts.knownRoutes, this.key),
        frame: pre.frame,
        census: pre.census,
        census_truncated: pre.censusTruncated,
        inventory: pre.inventory,
      },
      after,
      signals: diffVisualState(pre.rawVisual, rawAfter).fired,
      assertions: assertionsOf(step, result),
      status: result.status,
      error: result.error ? sanitizeError(result.error, authored, this.key) : null,
      evidence_errors: errors,
      captured_at: new Date().toISOString(),
    };

    writeJson(path.join(this.stepDir(device, flow), `${step.id}.evidence.json`), doc);
    this.tally(device, flow, doc);
  }

  private tally(device: DeviceProfile, flow: Flow, doc: StepEvidence): void {
    const k = `${device.id}/${flow.module}/${flow.flow}`;
    const s = this.flows.get(k) ?? {
      device: device.id, module: flow.module, flow: flow.flow, status: 'running', steps: 0, pre_frames: 0, post_frames: 0, targets: 0, failed_steps: [], evidence_errors: 0,
      ...(flow.auth === DUMMY_IDENTITY ? { dummy: true } : {}),
    };
    s.steps += 1;
    if (doc.before.frame) s.pre_frames += 1;
    if (doc.after.frame) s.post_frames += 1;
    if (doc.target) s.targets += 1;
    if (doc.status === 'failed') s.failed_steps.push(doc.step_id);
    s.evidence_errors += doc.evidence_errors.length;
    this.flows.set(k, s);

    const collect = (pattern: string, texts: Array<{ class: DataClass; text?: string }>) => {
      const bucket = this.labels.get(pattern) ?? new Map<string, number>();
      for (const t of texts) {
        if (t.class === 'L' && t.text) bucket.set(t.text, (bucket.get(t.text) ?? 0) + 1);
      }
      this.labels.set(pattern, bucket);
    };
    for (const phase of [doc.before, doc.after]) {
      for (const c of phase.census) this.censusByClass[c.class] += 1;
      collect(phase.url.pattern, [...phase.census, ...phase.inventory.flatMap((i) => [i.name, i.visible_text])]);
    }
    if (doc.target) collect(doc.before.url.pattern, [doc.target.name, doc.target.visible_text]);
  }

  /** The executor's normal flow-run manifest, written inside the evidence run instead of runs/. */
  writeFlowRun(run: FlowRun): void {
    writeJson(path.join(this.root, 'runs', run.device, `${run.module}-${run.flow}.flow-run.json`), run);
    const k = `${run.device}/${run.module}/${run.flow}`;
    const s = this.flows.get(k);
    if (s) s.status = run.status;
    else this.flows.set(k, {
      device: run.device, module: run.module, flow: run.flow, status: run.status, steps: 0, pre_frames: 0, post_frames: 0, targets: 0, failed_steps: [], evidence_errors: 0,
    });
  }

  /** Writes run-summary.json, evidence-summary.json and label-review.txt. */
  finish(summary: RunSummary): EvidenceRunSummary {
    writeJson(path.join(this.root, 'run-summary.json'), summary);

    const lines = [
      '# Every text classified L (application label) in this evidence run, by route pattern.',
      '# Review before C2: nothing here may be a person, an email, a phone number or record data.',
      '# Anything wrong → add a data_region (or remove the label) in the app\'s config/pii-regions.json and re-run.',
      '',
    ];
    for (const [pattern, bucket] of Array.from(this.labels.entries()).sort()) {
      if (!bucket.size) continue;
      lines.push(`## ${pattern}`);
      for (const [text, n] of Array.from(bucket.entries()).sort()) lines.push(`${String(n).padStart(4)}  ${JSON.stringify(text)}`);
      lines.push('');
    }
    writeText(path.join(this.root, 'label-review.txt'), lines.join('\n'));

    const out: EvidenceRunSummary = {
      schema: EVIDENCE_SCHEMA_VERSION,
      run_id: this.opts.runId,
      hash_scope: 'run-hmac',
      devices: this.opts.devices.map((d) => ({ id: d.id, dpr: d.dpr })),
      expected_dpr: this.opts.devices[0]?.dpr ?? 0,
      observed_dpr: Array.from(this.observedDpr).sort(),
      flows: Array.from(this.flows.values()),
      census_by_class: this.censusByClass,
      label_review_file: 'label-review.txt',
    };
    writeJson(path.join(this.root, 'evidence-summary.json'), out);
    return out;
  }
}

function assertionsOf(step: FlowStep, result: StepResult): AssertionEvidence[] {
  const passed = result.status === 'ok' ? true : null;
  const out: AssertionEvidence[] = [];
  const a = step.assert;
  if (a) {
    for (const [kind, v] of Object.entries(a)) {
      if (v === undefined) continue;
      out.push({ kind, detail: redactSecrets(typeof v === 'string' ? v : JSON.stringify(v)), passed });
    }
  }
  if (step.action === 'expect' && step.expect !== undefined) {
    out.push({ kind: 'expect', detail: redactSecrets(typeof step.expect === 'string' ? step.expect : JSON.stringify(step.expect)), passed });
  }
  if (step.action === 'waitFor') out.push({ kind: 'waitFor', detail: step.state ?? 'visible', passed });
  return out;
}

/** True when evidence/<run> exists and is not empty — the runner refuses to reuse a run directory. */
export function evidenceDirInUse(dir: string): boolean {
  return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
}
