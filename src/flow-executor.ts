/**
 * Executes one flow manifest: setup, then steps, then teardown. Screenshots
 * every step that asks for it, fingerprints the DOM, runs assertions, writes
 * flow-run.json.
 *
 * Deliberately NOT agentic. Every decision here is deterministic — that is what
 * makes day-over-day change detection meaningful (BUILD_PLAN §1).
 *
 * Failure messages always name the flow, the step id and the selector. A bare
 * `locator.waitFor: Timeout` tells you nothing at 7am.
 */
import * as fs from 'fs';
import * as path from 'path';
import { BrowserContext, Page, Locator } from '@playwright/test';
import { env, paths, interpolate, redactSecrets } from './env';
import { writeJson, relPosix } from './fsx';
import { log } from './logger';
import { settle, DEFAULT_SETTLE_MS } from './browser';
import { dismissInterstitials } from './interstitials';
import { waitForStable } from './stability';
import { capture, captureFailure } from './screenshot';
import { domHash, fingerprintKey, compareFingerprint, updateFingerprint } from './fingerprint';
import { readVisualState, diffVisualState, unknownVisualState, VisualState } from './visual-state';
import { allSteps } from './flow-loader';
import type {
  Flow,
  FlowStep,
  FlowRun,
  StepResult,
  StepAction,
  StepAssert,
  StepPhase,
  Fingerprints,
  FlowStatus,
  CaptureSpec,
} from './types';
import { VIEWPORT_PRESETS } from './types';

export interface ExecuteOptions {
  runId: string;
  appGitSha: string | null;
  baseline: Fingerprints;
  /** Why the runner decided to execute this flow — recorded in the manifest. */
  reason: string;
  /** Don't touch the browser; emit a plan-only run manifest. */
  dryRun?: boolean;
  /** Rewrite the baseline entry for every step captured this run. */
  updateBaseline?: boolean;
}

/** Names the flow, step and selector on every failure. */
function stepError(flow: Flow, step: FlowStep, selector: string | null, message: string): string {
  const where = `[${flow.module}/${flow.flow}] step ${step.id} (${step.action})`;
  const sel = selector ? ` selector=${selector}` : '';
  return `${where}${sel}: ${message}`;
}

export async function executeFlow(
  context: BrowserContext,
  flow: Flow,
  opts: ExecuteOptions,
): Promise<FlowRun> {
  const startedAt = new Date();
  // RUN_TAG is kept for schema compatibility with the recorder's drafts; no
  // promoted flow may write, so nothing ever carries it into the app.
  const runTag = `SCRSHOT_${opts.runId}_`;
  const vars: Record<string, string> = {
    ...(flow.vars ?? {}),
    RUN_ID: opts.runId,
    RUN_TAG: runTag,
  };

  const run: FlowRun = {
    module: flow.module,
    flow: flow.flow,
    run_id: opts.runId,
    app_git_sha: opts.appGitSha,
    status: 'unchanged',
    reason: opts.reason,
    started_at: startedAt.toISOString(),
    duration_ms: 0,
    steps: [],
    screenshots: [],
    errors: [],
  };

  if (opts.dryRun) {
    run.status = 'skipped';
    run.reason = `${opts.reason} (dry-run: not executed)`;
    run.steps = allSteps(flow).map((s) => ({
      id: s.id,
      action: s.action,
      phase: s._phase ?? 'steps',
      selector: s.selector ? redactSecrets(interpolate(s.selector, vars)) : null,
      input: s.value !== undefined ? redactSecrets(interpolate(String(s.value), vars)) : null,
      result: 'dry-run',
      status: 'skipped' as const,
      next_screen: s.expect_screen ?? null,
      screenshot_path: null,
      screenshot_paths: [],
      capture_mode: s._capture?.mode ?? null,
      visual_signals: null,
      capture_skipped_reason: null,
      dom_hash: null,
      fingerprint: null,
      duration_ms: 0,
    }));
    writeRunManifest(run, true);
    return run;
  }

  // Clear last run's failure screenshots so a fixed step doesn't leave a
  // misleading `*.failed.png` sitting in the repo forever.
  clearFailureScreenshots(flow.module, flow.flow);

  const page = await context.newPage();
  const state: RunState = { anyChanged: false, anyNew: false };

  try {
    const setupOk = await runPhase(page, flow, flow.setup ?? [], 'setup', run, vars, opts, state);
    if (setupOk) {
      await runPhase(page, flow, flow.steps, 'steps', run, vars, opts, state);
    }
  } finally {
    // Teardown always runs — including after a failure. Its failures are
    // recorded but never change the flow's status: the captures already
    // happened, and losing them to a cleanup hiccup helps nobody.
    try {
      await runPhase(page, flow, flow.teardown ?? [], 'teardown', run, vars, opts, state);
    } catch (err) {
      run.errors.push(`teardown: ${(err as Error).message.split('\n')[0]}`);
    }
    await page.close().catch(() => undefined);
  }

  if (run.status !== 'failed') {
    run.status = resolveStatus(state.anyChanged, state.anyNew);
  }
  run.duration_ms = Date.now() - startedAt.getTime();
  writeRunManifest(run);
  return run;
}

interface RunState {
  anyChanged: boolean;
  anyNew: boolean;
}

/** Returns false if a non-optional step failed and the flow should stop. */
async function runPhase(
  page: Page,
  flow: Flow,
  steps: FlowStep[],
  phase: StepPhase,
  run: FlowRun,
  vars: Record<string, string>,
  opts: ExecuteOptions,
  state: RunState,
): Promise<boolean> {
  for (const step of steps) {
    const t0 = Date.now();
    const selector = step.selector ? interpolate(step.selector, vars) : null;
    // `element:<selector>` captures may reference {{VARS}} exactly like a step
    // selector does, so the spec has to be interpolated too — otherwise the
    // literal "{{TEST_STUDENT_ID}}" reaches Playwright and matches nothing.
    const rawSpec: CaptureSpec = step._capture ?? { mode: 'none' };
    const spec: CaptureSpec =
      rawSpec.mode === 'element'
        ? { mode: 'element', selector: interpolate(rawSpec.selector, vars) }
        : rawSpec;

    // Run manifests are committed. The PIN of a live account must never be
    // written into one, so every recorded string passes through redactSecrets.
    const result: StepResult = {
      id: step.id,
      action: step.action,
      phase,
      selector: selector ? redactSecrets(selector) : null,
      input: step.value !== undefined ? redactSecrets(interpolate(String(step.value), vars)) : null,
      result: '',
      status: 'ok',
      next_screen: step.expect_screen ?? null,
      screenshot_path: null,
      screenshot_paths: [],
      capture_mode: spec.mode,
      visual_signals: null,
      capture_skipped_reason: null,
      dom_hash: null,
      fingerprint: null,
      duration_ms: 0,
    };

    const mask = (step.mask ?? []).map((m) => interpolate(m, vars));
    const settleMs = step.settle_ms ?? flow.settle_ms ?? DEFAULT_SETTLE_MS;

    try {
      // `auto` needs a stable "before" reading, so settle first — comparing a
      // settled state against an unsettled one manufactures phantom changes.
      let before: VisualState | null = null;
      if (spec.mode === 'auto') {
        await settle(page, 0);
        before = await readVisualState(page).catch(() => unknownVisualState());
      }

      result.result = redactSecrets(await performAction(page, flow, step, selector, vars));
      await settle(page, settleMs);
      await runAssertions(page, flow, step, selector, vars);

      let shouldCapture = spec.mode !== 'none';
      if (spec.mode === 'auto') {
        const after = await readVisualState(page).catch(() => unknownVisualState());
        const diff = diffVisualState(before ?? unknownVisualState(), after);
        result.visual_signals = diff.fired;
        shouldCapture = diff.changed;
        if (!diff.changed) {
          result.capture_skipped_reason = `no visible state change (${diff.report})`;
          log.skip(
            `[${flow.module}/${flow.flow}] ${step.id} (${step.action}) — screenshot: auto, ` +
              `no visible state change (${diff.report})`,
          );
        }
      }

      if (shouldCapture) {
        // Never capture a loading state: wait for network quiet, no
        // spinners/skeletons, and a DOM that stops changing. If it never
        // settles, still capture — but flagged and named `.loading.png`.
        const stability = await waitForStable(page);
        if (!stability.stable) {
          result.unstable = true;
          log.warn(`[${flow.module}/${flow.flow}] ${step.id} captured UNSTABLE — ${stability.reason} (→ .loading.png)`);
        }
        const files = await capture(page, {
          module: flow.module,
          flow: flow.flow,
          stepId: step.id,
          spec,
          mask,
          unstable: result.unstable,
        });
        result.screenshot_paths = files;
        result.screenshot_path = files[0] ?? null;
        run.screenshots.push(...files);

        if (files.length) {
          const hash = await domHash(page, mask);
          const key = fingerprintKey(flow.module, flow.flow, step.id);
          const verdict = compareFingerprint(opts.baseline, key, hash);
          result.dom_hash = hash;
          result.fingerprint = verdict;
          if (verdict === 'changed') state.anyChanged = true;
          if (verdict === 'new') state.anyNew = true;
          if (opts.updateBaseline || verdict === 'new') {
            updateFingerprint(opts.baseline, key, hash, mask);
          }
        }
      }

      log.step(
        `${step.id} ${result.result}` +
          (result.fingerprint ? ` [dom:${result.fingerprint}]` : '') +
          (result.screenshot_paths.length > 1 ? ` [${result.screenshot_paths.length} shots]` : ''),
      );
    } catch (err) {
      const message = redactSecrets((err as Error).message.split('\n')[0]);
      const described = redactSecrets(stepError(flow, step, selector, message));
      result.status = 'failed';
      result.error = described;
      result.result = 'failed';

      // Always try to capture the failure state — it's the most useful
      // screenshot there is. Same mask as the step asked for, so content the
      // author flagged as sensitive isn't captured unmasked just because the
      // step happened to fail.
      result.screenshot_path = await captureFailure(page, {
        module: flow.module,
        flow: flow.flow,
        stepId: step.id,
        mask,
      });
      if (result.screenshot_path) result.screenshot_paths = [result.screenshot_path];

      const optional = step.optional || phase === 'teardown';
      if (optional) {
        log.warn(`${described} (${phase === 'teardown' ? 'teardown' : 'optional'}, continuing)`);
        result.status = 'skipped';
        run.errors.push(`[${phase === 'teardown' ? 'teardown' : 'optional'}] ${described}`);
      } else {
        log.error(described);
        run.errors.push(described);
        result.duration_ms = Date.now() - t0;
        run.steps.push(result);
        run.status = 'failed';
        return false;
      }
    }

    result.duration_ms = Date.now() - t0;
    run.steps.push(result);
  }
  return true;
}

function resolveStatus(anyChanged: boolean, anyNew: boolean): FlowStatus {
  if (anyChanged) return 'changed';
  if (anyNew) return 'new';
  return 'unchanged';
}

/** Actions that tap/type into the page and can be blocked by an interstitial. */
const INTERACTIVE_ACTIONS = new Set<StepAction>([
  'click', 'type', 'fill', 'select', 'check', 'uncheck', 'hover', 'press', 'swipe', 'tap',
]);

async function performAction(
  page: Page,
  flow: Flow,
  step: FlowStep,
  selector: string | null,
  vars: Record<string, string>,
): Promise<string> {
  const val = step.value !== undefined ? interpolate(String(step.value), vars) : undefined;
  const loc: Locator | null = selector ? page.locator(selector).first() : null;

  // Clear any nudge modal that would intercept the tap, right before every
  // interactive action. Noise removal only — see interstitials.ts.
  if (INTERACTIVE_ACTIONS.has(step.action)) {
    await dismissInterstitials(page).catch(() => undefined);
  }

  switch (step.action) {
    case 'goto':
      await page.goto(val!, { waitUntil: 'domcontentloaded' });
      await dismissInterstitials(page).catch(() => undefined);
      return `navigated to ${val}`;

    case 'click':
      await loc!.waitFor({ state: 'visible' });
      await loc!.click();
      return 'clicked';

    // `type` dispatches real per-character key events. Some controlled inputs
    // key their internal state off keydown rather than the DOM value, so
    // fill() can look right on screen without arming the submit button.
    case 'type':
      await loc!.waitFor({ state: 'visible' });
      await loc!.fill('');
      await loc!.pressSequentially(val!);
      return `typed "${truncate(val!)}"`;

    // `fill` is the one-shot path: faster, no key events. Retained from v1.
    case 'fill':
      await loc!.waitFor({ state: 'visible' });
      await loc!.fill('');
      await loc!.fill(val!);
      return `filled "${truncate(val!)}"`;

    case 'select':
      await loc!.waitFor({ state: 'visible' });
      try {
        await loc!.selectOption({ value: val! });
      } catch {
        await loc!.selectOption({ label: val! });
      }
      return `selected "${truncate(val!)}"`;

    case 'check':
      await loc!.check();
      return 'checked';

    case 'uncheck':
      await loc!.uncheck();
      return 'unchecked';

    case 'press':
      if (loc) { await loc.press(val ?? 'Enter'); } else { await page.keyboard.press(val ?? 'Enter'); }
      return `pressed ${val ?? 'Enter'}`;

    case 'hover':
      await loc!.hover();
      return 'hovered';

    case 'scrollTo':
      if (loc) {
        await loc.scrollIntoViewIfNeeded();
        return 'scrolled element into view';
      }
      await page.evaluate((where: string) => {
        window.scrollTo(0, where === 'bottom' ? document.body.scrollHeight : 0);
      }, step.position ?? 'top');
      return `scrolled to ${step.position ?? 'top'}`;

    case 'scrollUntilVisible':
      return scrollUntilVisible(page, selector!, step.max_scrolls ?? 10);

    case 'waitFor': {
      const state = step.state ?? 'visible';
      await loc!.waitFor({ state });
      return `waited for ${state}`;
    }

    case 'expect':
      return runExpect(page, step, selector!, vars);

    case 'goBack':
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await dismissInterstitials(page).catch(() => undefined);
      return `went back to ${page.url()}`;

    case 'setViewport': {
      const preset = VIEWPORT_PRESETS[step.preset ?? 'desktop'];
      await page.setViewportSize(preset);
      return `viewport set to ${step.preset} (${preset.width}x${preset.height})`;
    }

    case 'swipe':
      return touchSwipe(page, loc!, step);

    // A real finger tap, dispatched as trusted touch input at the element's
    // centre. Use it where `click` is correct in principle but Playwright's
    // actionability model blocks it — the welcome screen's "Go to Dashboard"
    // is a live <button> wrapped in a `div[aria-disabled="true"]`, so
    // Playwright inherits the ARIA disabled state and refuses to click, while
    // a phone user taps it perfectly well. It is also simply the truer gesture
    // on a touch PWA. Actionability is NOT skipped wholesale: the element must
    // still be visible and have a box before we aim at it.
    case 'tap': {
      await loc!.waitFor({ state: 'visible' });
      await loc!.scrollIntoViewIfNeeded();
      const tbox = await loc!.boundingBox();
      if (!tbox) throw new Error('tap target has no bounding box');
      await page.touchscreen.tap(tbox.x + tbox.width / 2, tbox.y + tbox.height / 2);
      return 'tapped';
    }

    case 'sleep':
      await page.waitForTimeout(Number(val ?? 1000));
      return `slept ${val ?? 1000}ms — ${step.reason ?? 'no reason given'}`;

    // ── retained v1 ──────────────────────────────────────────────────────────
    case 'scroll':
      if (loc) {
        await loc.scrollIntoViewIfNeeded();
        return 'scrolled element into view';
      }
      await page.evaluate((px: number) => window.scrollBy(0, px), Number(val ?? 500));
      return `scrolled ${val ?? 500}px`;

    case 'wait':
      if (loc) { await loc.waitFor({ state: 'visible' }); return 'waited for selector'; }
      await page.waitForTimeout(Number(val ?? 1000));
      return `waited ${val ?? 1000}ms`;

    case 'snapshot':
      return 'snapshot';

    default: {
      const never: never = step.action;
      throw new Error(`Unhandled action: ${never}`);
    }
  }
}

/**
 * Scrolls the dominant scroll container — an open dialog's scroller if there is
 * one, otherwise the page — until the selector is inside the viewport.
 */
async function scrollUntilVisible(page: Page, selector: string, maxScrolls: number): Promise<string> {
  const loc = page.locator(selector).first();

  for (let i = 0; i <= maxScrolls; i++) {
    const inView = await loc
      .evaluate((el: Element) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
      })
      .catch(() => false);
    if (inView) return `visible after ${i} scroll(s)`;

    const scrolled = await page.evaluate(() => {
      const canScrollMore = (el: Element): boolean => {
        const st = getComputedStyle(el);
        return (
          /(auto|scroll)/.test(st.overflowY) &&
          el.scrollHeight > el.clientHeight + 8 &&
          el.scrollTop + el.clientHeight < el.scrollHeight - 2
        );
      };
      const scrollers = Array.from(document.querySelectorAll('body *')).filter(canScrollMore);
      // A scroller inside an open dialog wins: that is what the user is looking at.
      const inDialog = scrollers.find((el) => el.closest('[role="dialog"], [role="alertdialog"]'));
      const target =
        inDialog ??
        scrollers.sort((a, b) => b.clientHeight - a.clientHeight)[0] ??
        null;

      if (target) {
        target.scrollTop += Math.max(80, target.clientHeight * 0.8);
        return true;
      }
      if (window.scrollY + window.innerHeight < document.body.scrollHeight - 2) {
        window.scrollBy(0, window.innerHeight * 0.8);
        return true;
      }
      return false;
    });

    if (!scrolled) {
      throw new Error(
        `scrollUntilVisible gave up after ${i} scroll(s) — nothing left to scroll and the ` +
          `element is still not in the viewport`,
      );
    }
    await settle(page, 150);
  }

  throw new Error(`scrollUntilVisible exhausted max_scrolls (${maxScrolls}) without the element entering the viewport`);
}

/** Steps a swipe is broken into. Enough that RNGH sees a gesture, not a tap. */
const SWIPE_STEPS = 16;

/**
 * Swipes across an element as a REAL touch sequence: touchStart, N touchMove,
 * touchEnd, delivered through CDP `Input.dispatchTouchEvent`.
 *
 * Why not the obvious alternatives (all measured against the live attendance
 * roster on 2026-08-21):
 *   - `page.touchscreen` only exposes `tap()`. There is no drag.
 *   - Synthetic `new TouchEvent(...)` + `dispatchEvent` is IGNORED. The rows
 *     are React Native Gesture Handler targets (`touch-action: none`); RNGH's
 *     web backend does not react to the untrusted events.
 *   - A mouse drag does work, but it is a mouse: it exercises a different code
 *     path from the one a phone user hits, so it is not what we want to certify.
 *
 * CDP dispatches TRUSTED touch input into the renderer — the same events a real
 * finger produces — which is what actually moves the roster. The intermediate
 * moves are spaced in real time: a single start->end jump is classified as a tap.
 */
async function touchSwipe(page: Page, loc: Locator, step: FlowStep): Promise<string> {
  await loc.waitFor({ state: 'visible' });
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (!box) throw new Error('swipe target has no bounding box');

  const dist = step.distance ?? 200;
  const dur = step.duration ?? 300;
  const dir = step.direction!;
  const dx = dir === 'left' ? -dist : dir === 'right' ? dist : 0;
  const dy = dir === 'up' ? -dist : dir === 'down' ? dist : 0;

  // Start from the edge the gesture travels away from, inset far enough to stay
  // off the rounded corner, so the full distance stays over the element.
  const inset = 20;
  const x0 = dir === 'right' ? box.x + inset : dir === 'left' ? box.x + box.width - inset : box.x + box.width / 2;
  const y0 = dir === 'down' ? box.y + inset : dir === 'up' ? box.y + box.height - inset : box.y + box.height / 2;

  const cdp = await page.context().newCDPSession(page);
  const at = (x: number, y: number) => [{ x, y, radiusX: 11, radiusY: 11, force: 1, id: 1 }];
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(x0, y0) });
    for (let i = 1; i <= SWIPE_STEPS; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: at(x0 + (dx * i) / SWIPE_STEPS, y0 + (dy * i) / SWIPE_STEPS),
      });
      await page.waitForTimeout(Math.max(1, Math.round(dur / SWIPE_STEPS)));
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
  return `swiped ${dir} ${dist}px over ${dur}ms (touch, ${SWIPE_STEPS} moves)`;
}

async function runExpect(
  page: Page,
  step: FlowStep,
  selector: string,
  vars: Record<string, string>,
): Promise<string> {
  const cond = step.expect!;
  const loc = page.locator(selector).first();

  if (cond === 'visible') {
    await loc.waitFor({ state: 'visible' });
    return 'expect visible: ok';
  }
  if (cond === 'hidden') {
    await loc.waitFor({ state: 'hidden' });
    return 'expect hidden: ok';
  }
  if (cond === 'enabled') {
    const ok = await loc.isEnabled().catch(() => false);
    if (!ok) throw new Error('expect enabled — element is disabled or missing');
    return 'expect enabled: ok';
  }
  if (cond === 'disabled') {
    const ok = await loc.isDisabled().catch(() => false);
    if (!ok) throw new Error('expect disabled — element is enabled or missing');
    return 'expect disabled: ok';
  }
  if (typeof cond === 'object' && 'text' in cond) {
    const want = interpolate(cond.text, vars);
    const actual = (await loc.innerText().catch(() => '')) || '';
    if (!actual.includes(want)) {
      throw new Error(`expect text "${want}" — element text is "${truncate(actual, 80)}"`);
    }
    return `expect text "${truncate(want)}": ok`;
  }
  if (typeof cond === 'object' && 'count' in cond) {
    const n = await page.locator(selector).count();
    const { min, max } = cond.count;
    if (min !== undefined && n < min) throw new Error(`expect count min ${min} — got ${n}`);
    if (max !== undefined && n > max) throw new Error(`expect count max ${max} — got ${n}`);
    return `expect count ${n}: ok`;
  }

  throw new Error(`unsupported expect condition ${JSON.stringify(cond)}`);
}

async function runAssertions(
  page: Page,
  flow: Flow,
  step: FlowStep,
  selector: string | null,
  vars: Record<string, string>,
): Promise<void> {
  const a: StepAssert | undefined = step.assert;
  if (!a) return;

  if (a.url_contains) {
    const want = interpolate(a.url_contains, vars);
    if (!page.url().includes(want)) {
      throw new Error(`assert url_contains "${want}" — actual URL is ${page.url()}`);
    }
  }
  if (a.selector_visible) {
    const sel = interpolate(a.selector_visible, vars);
    await page.locator(sel).first().waitFor({ state: 'visible' })
      .catch(() => { throw new Error(`assert selector_visible "${sel}" — not visible`); });
  }
  if (a.selector_hidden) {
    const sel = interpolate(a.selector_hidden, vars);
    const visible = await page.locator(sel).first().isVisible().catch(() => false);
    if (visible) throw new Error(`assert selector_hidden "${sel}" — element is visible`);
  }
  if (a.text_contains || a.text_not_contains) {
    const body = (await page.locator('body').innerText().catch(() => '')) || '';
    if (a.text_contains) {
      const want = interpolate(a.text_contains, vars);
      if (!body.includes(want)) throw new Error(`assert text_contains "${want}" — not found on page`);
    }
    if (a.text_not_contains) {
      const nope = interpolate(a.text_not_contains, vars);
      if (body.includes(nope)) throw new Error(`assert text_not_contains "${nope}" — found on page`);
    }
  }
  if (a.count) {
    const sel = interpolate(a.count.selector, vars);
    const n = await page.locator(sel).count();
    if (a.count.min !== undefined && n < a.count.min) {
      throw new Error(`assert count min ${a.count.min} for "${sel}" — got ${n}`);
    }
    if (a.count.max !== undefined && n > a.count.max) {
      throw new Error(`assert count max ${a.count.max} for "${sel}" — got ${n}`);
    }
  }
}

function clearFailureScreenshots(module: string, flow: string): void {
  const dir = path.join(paths.screenshots, module, flow);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.failed.png')) fs.rmSync(path.join(dir, f), { force: true });
  }
}

function writeRunManifest(run: FlowRun, dryRun = false): void {
  const day = run.run_id.slice(0, 10);
  // Dry-run manifests land in a distinct subfolder so they can never be
  // mistaken for (or silently overwrite) a real capture run's history.
  const file = dryRun
    ? path.join(paths.runs, day, '.dry-run', `${run.module}-${run.flow}.flow-run.json`)
    : path.join(paths.runs, day, `${run.module}-${run.flow}.flow-run.json`);
  writeJson(file, run);
  log.step(`run manifest → ${relPosix(paths.root, file)}`);
}

function truncate(s: string, n = 40): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
