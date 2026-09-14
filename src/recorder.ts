/**
 * Recorder — walk a scenario once by hand, get a structured action log.
 *
 * Deliberately NOT `playwright codegen`: that emits code, and its selector
 * engine discards the element metadata (role, accessible name, testid,
 * bounding box, overlay state) that the converter needs to pick a selector,
 * derive an id, and decide a capture mode.
 *
 * The recorder OBSERVES. It never clicks, types, or scrolls anything itself.
 * Authentication runs to completion *before* the listeners are installed, so
 * nothing src/login.ts does can appear in the log.
 *
 * Mechanics (verified against a fixture before this was written):
 *   · `exposeBinding` is registered before `addInitScript`, so the binding is
 *     already present when the init script runs — no event queue needed.
 *   · A capture-phase `scroll` listener on `document` does catch non-bubbling
 *     element scrolls, with the correct target and scrollTop.
 *   · The init script re-installs itself across navigations.
 *
 * Usage: npm run record -- --flow students.add-student
 */
import * as fs from 'fs';
import * as path from 'path';
import { Browser, BrowserContext, Page } from '@playwright/test';
import { env, paths, assertTargetEnvironment } from './env';
import { writeJson, ensureDir, relPosix } from './fsx';
import { log } from './logger';
import { launchBrowser } from './browser';
import { getAuthenticatedContext } from './login';
import { DOM_PROBE_SOURCE } from './dom-probe';
import {
  RECORDER_VERSION,
  Recording,
  RecordedEvent,
  OverlayState,
  SampleEnd,
} from './recording-types';

// ─── "after" sampling (amendment B) ──────────────────────────────────────────
// A fixed delay is a correctness bug, not a tuning choice: a slow route
// transition on TEST reads back as url_after === url_before, the assertion is
// silently dropped, and the flow looks correct while asserting nothing. So we
// poll until the value stops moving, and record how the poll ended.
const AFTER_POLL_MS = 100;
const AFTER_STABLE_MS = 300;
const AFTER_WATCH_MS = 5_000;

/**
 * Watching a value go quiet cannot distinguish "nothing will change" from "the
 * change has not started yet" — a route transition that begins at 1.5s looks
 * identical to no transition at all for the first 1.5s. So the poll never exits
 * early on stability *before* it has seen a change; it only exits early once a
 * change has been observed and then settled, or once the user interacts again.
 *
 * Navigations get a second, exact mechanism on top: framenavigated fires
 * whenever the route actually moves, however late, and is attributed back to
 * the interaction that is still pending. That covers transitions slower than
 * the watch window entirely.
 */

// ─── Redaction (amendment C) ─────────────────────────────────────────────────
// recordings/ is committed, so an unredacted add-student recording would carry
// a real name and a guardian phone number into git history permanently.
// Over-redaction costs one TODO to fill in; under-redaction cannot be undone.
const REDACTED_INPUT_TYPES = new Set(['password', 'tel', 'email']);
const EMAIL_SHAPE = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;
const TEN_DIGITS = /\d{10}/;

export function redactValue(
  value: string | null,
  inputType: string | null,
): { value: string | null; redacted: boolean; reason: string | null } {
  if (value === null || value === '') return { value, redacted: false, reason: null };

  if (inputType && REDACTED_INPUT_TYPES.has(inputType)) {
    return { value: null, redacted: true, reason: `input[type=${inputType}]` };
  }
  if (env.admin.pin && value === env.admin.pin) {
    return { value: null, redacted: true, reason: 'matches SIGNIN_PIN' };
  }
  if (env.staff.pin && value === env.staff.pin) {
    return { value: null, redacted: true, reason: 'matches STAFF_PIN' };
  }
  if (env.admin.mobile && value.replace(/\D/g, '').includes(env.admin.mobile)) {
    return { value: null, redacted: true, reason: 'matches SIGNIN_MOBILE' };
  }
  if (env.staff.mobile && value.replace(/\D/g, '').includes(env.staff.mobile)) {
    return { value: null, redacted: true, reason: 'matches STAFF_MOBILE' };
  }
  if (EMAIL_SHAPE.test(value)) {
    return { value: null, redacted: true, reason: 'email shape' };
  }
  if (TEN_DIGITS.test(value)) {
    return { value: null, redacted: true, reason: 'ten-digit number' };
  }
  return { value, redacted: false, reason: null };
}

// ─── In-page listeners ───────────────────────────────────────────────────────

const RECORDER_SOURCE = String.raw`
(() => {
  if (window.__ubRecorderInstalled) return;
  window.__ubRecorderInstalled = true;

  const send = (p) => { try { window.__ubRecord(p); } catch (e) { /* context torn down */ } };
  const probe = () => window.__ubProbe;

  const base = (type, el) => ({
    type: type,
    ts: new Date().toISOString(),
    url_before: location.pathname + location.search,
    overlay_before: probe().overlay(),
    element: el && el.nodeType === 1 ? probe().describe(el) : null,
  });

  const INTERACTIVE = 'a,button,[role],[data-testid],input,select,textarea,summary,label,li,tr';

  document.addEventListener('click', (e) => {
    let el = e.target;
    if (el && el.nodeType === 1 && !el.getAttribute('data-testid') && el.closest) {
      el = el.closest(INTERACTIVE) || el;
    }
    send(Object.assign(base('click', el), { value: null, input_type: null, scroll: null }));
  }, true);

  // Debounced per element: raw input fires per keystroke, and a step wants the
  // value the field ended up with, not twelve prefixes of it.
  const inputTimers = new WeakMap();
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el || el.nodeType !== 1 || !('value' in el)) return;
    // A <select> fires input AND change; a checkbox likewise. The change
    // listener owns those, or we would emit a bogus type step beside the
    // select step for the same interaction.
    const tag = el.tagName.toLowerCase();
    const inputType = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'select' || inputType === 'checkbox' || inputType === 'radio') return;
    const prev = inputTimers.get(el);
    if (prev) clearTimeout(prev);
    inputTimers.set(el, setTimeout(() => {
      inputTimers.delete(el);
      const type = (el.getAttribute('type') || '').toLowerCase() || null;
      send(Object.assign(base('input', el), {
        value: el.value == null ? null : String(el.value),
        input_type: type,
        scroll: null,
      }));
    }, 300));
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    // Text inputs are already covered by the input listener; a change event for
    // them would just duplicate the step.
    if (tag !== 'select' && type !== 'checkbox' && type !== 'radio') return;
    send(Object.assign(base('change', el), {
      value: tag === 'select' ? String(el.value == null ? '' : el.value) : String(!!el.checked),
      input_type: type || null,
      scroll: null,
    }));
  }, true);

  // Throttled per target. scroll does not bubble, but a capture-phase listener
  // on document still receives it.
  const scrollTimers = new WeakMap();
  let windowScrollTimer = null;
  const flushScroll = (target) => {
    const s = probe().scrollOf(target);
    if (!s) return;
    const el = target && target.nodeType === 1 ? target : null;
    send(Object.assign(base('scroll', el), { value: null, input_type: null, scroll: s }));
  };
  document.addEventListener('scroll', (e) => {
    const target = e.target;
    if (target === document || target === window || target === document.documentElement) {
      if (windowScrollTimer) clearTimeout(windowScrollTimer);
      windowScrollTimer = setTimeout(() => { windowScrollTimer = null; flushScroll(document); }, 120);
      return;
    }
    if (!target || target.nodeType !== 1) return;
    const prev = scrollTimers.get(target);
    if (prev) clearTimeout(prev);
    scrollTimers.set(target, setTimeout(() => { scrollTimers.delete(target); flushScroll(target); }, 120));
  }, true);
})();
`;

// ─── Node side ───────────────────────────────────────────────────────────────

interface RawPayload {
  type: RecordedEvent['type'];
  ts: string;
  url_before: string;
  overlay_before: OverlayState;
  element: RecordedEvent['element'];
  value: string | null;
  input_type: string | null;
  scroll: RecordedEvent['scroll'];
}

interface Sample {
  url: string;
  overlay: OverlayState;
}

const CLOSED_OVERLAY: OverlayState = { open: false, key: null, selector: null };

export interface RecorderOptions {
  flow: string;
  module: string;
  identity: string;
  startUrl: string;
  viewport: { width: number; height: number };
}

export interface RecorderHandle {
  attach(page: Page): void;
  /** Waits for every in-flight "after" sample, then returns the recording. */
  finish(stoppedBy: Recording['stopped_by']): Promise<Recording>;
  eventCount(): number;
}

export async function installRecorder(
  context: BrowserContext,
  opts: RecorderOptions,
): Promise<RecorderHandle> {
  const events: RecordedEvent[] = [];
  const startedAt = Date.now();
  let seqCounter = 0;
  /**
   * Bumped only by real user interactions. A navigation is an *effect* of the
   * event being sampled, not a new interaction, so it must not cut that
   * event's poll short — doing so would read back the pre-navigation URL and
   * silently drop the assertion.
   */
  let latestInteractionSeq = 0;
  let page: Page | null = null;
  /** Serialises after-sampling so concurrent evaluates can't stampede. */
  let queue: Promise<unknown> = Promise.resolve();

  const readNow = async (p: Page): Promise<Sample> => {
    try {
      const url = new URL(p.url());
      const overlay = (await p.evaluate(() => {
        const probe = (window as unknown as { __ubProbe?: { overlay(): OverlayState } }).__ubProbe;
        return probe ? probe.overlay() : { open: false, key: null, selector: null };
      })) as OverlayState;
      return { url: url.pathname + url.search, overlay };
    } catch {
      // Page closed or navigating — keep whatever we can still read.
      return { url: safeUrlPath(p), overlay: CLOSED_OVERLAY };
    }
  };

  const same = (a: Sample, b: Sample): boolean =>
    a.url === b.url && a.overlay.open === b.overlay.open && a.overlay.key === b.overlay.key;

  const sampleAfter = async (
    seq: number,
    p: Page,
    /** The event's own pre-interaction values, captured in-page at dispatch. */
    baseline: Sample,
  ): Promise<{ sample: Sample; ended_by: SampleEnd; settled: boolean; waited_ms: number }> => {
    const started = Date.now();
    let last = await readNow(p);
    let stableSince = Date.now();
    // Compared against the values as they were BEFORE the interaction, not a
    // fresh read taken after it. A transition fast enough to complete before
    // the first poll would otherwise be baked into the baseline and read back
    // as "nothing happened".
    let sawChange = !same(last, baseline);
    let endedBy: SampleEnd = 'no-change';

    while (Date.now() - started < AFTER_WATCH_MS) {
      // The next interaction legitimately closes this event's observation
      // window — that is not a timeout, it is the user moving on.
      if (latestInteractionSeq > seq) { endedBy = 'next-event'; break; }

      if (sawChange && Date.now() - stableSince >= AFTER_STABLE_MS) {
        endedBy = 'stable';
        break;
      }

      await delay(AFTER_POLL_MS);
      const now = await readNow(p);
      if (!same(now, last)) {
        last = now;
        stableSince = Date.now();
        if (!same(now, baseline)) sawChange = true;
      }
    }

    // Ran the whole window with something still moving: genuinely suspect.
    if (endedBy === 'no-change' && sawChange) endedBy = 'timeout';

    return {
      sample: last,
      ended_by: endedBy,
      settled: endedBy !== 'timeout',
      waited_ms: Date.now() - started,
    };
  };

  // Order matters and is load-bearing: the binding must exist before the init
  // script that calls it is installed.
  await context.exposeBinding('__ubRecord', async (_source, raw: RawPayload) => {
    const seq = ++seqCounter;
    latestInteractionSeq = seq;
    const t_ms = Date.now() - startedAt;

    const { value, redacted, reason } = redactValue(raw.value ?? null, raw.input_type ?? null);

    const event: RecordedEvent = {
      seq,
      t_ms,
      ts: raw.ts,
      type: raw.type,
      url_before: raw.url_before,
      url_after: raw.url_before,
      overlay_before: raw.overlay_before ?? CLOSED_OVERLAY,
      overlay_after: raw.overlay_before ?? CLOSED_OVERLAY,
      after_sample: { ended_by: 'stable', settled: true, waited_ms: 0 },
      element: raw.element ?? null,
      scroll: raw.scroll ?? null,
      value,
      value_redacted: redacted,
      redaction_reason: reason,
    };
    events.push(event);

    const target = page;
    if (!target) return;
    queue = queue.then(async () => {
      // A role selector can't be uniqueness-checked with querySelectorAll, so
      // it is checked here. The converter refuses to emit one that wasn't.
      if (event.element && event.element.role_selector && !event.element.testid) {
        event.element.role_selector_unique = await target
          .locator(event.element.role_selector)
          .count()
          .then((n) => n === 1)
          .catch(() => false);
      }
      const result = await sampleAfter(seq, target, {
        url: event.url_before,
        overlay: event.overlay_before,
      }).catch(() => null);
      if (!result) return;
      event.url_after = result.sample.url;
      event.overlay_after = result.sample.overlay;
      event.after_sample = {
        ended_by: result.ended_by,
        settled: result.settled,
        waited_ms: result.waited_ms,
      };
      if (result.ended_by === 'timeout') {
        log.warn(
          `event ${seq} (${raw.type}): url/overlay started changing and never settled within ` +
            `${result.waited_ms}ms — recorded as unsettled so the conversion can surface it`,
        );
      }
    });
  });

  await context.addInitScript({ content: DOM_PROBE_SOURCE + '\n' + RECORDER_SOURCE });

  return {
    attach(p: Page) {
      page = p;
      p.on('framenavigated', (frame) => {
        if (frame !== p.mainFrame()) return;
        const url = safeUrlPath(p);

        // Attribute the navigation to the interaction still awaiting its
        // result. A navigation that lands after the watch window closed — or
        // after the poll gave up — is still that interaction's doing, unless
        // the user has since done something else.
        const pending = events
          .filter((e) => e.type !== 'navigation' && e.seq === latestInteractionSeq)
          .pop();
        if (pending && pending.url_after !== url) {
          pending.url_after = url;
          pending.after_sample = {
            ended_by: 'navigation',
            settled: true,
            waited_ms: Date.now() - startedAt - pending.t_ms,
          };
        }

        const seq = ++seqCounter;
        events.push({
          seq,
          t_ms: Date.now() - startedAt,
          ts: new Date().toISOString(),
          type: 'navigation',
          url_before: url,
          url_after: url,
          overlay_before: CLOSED_OVERLAY,
          overlay_after: CLOSED_OVERLAY,
          after_sample: { ended_by: 'stable', settled: true, waited_ms: 0 },
          element: null,
          scroll: null,
          value: null,
          value_redacted: false,
          redaction_reason: null,
        });
      });
    },

    eventCount: () => events.length,

    async finish(stoppedBy) {
      await queue.catch(() => undefined);
      events.sort((a, b) => a.seq - b.seq);
      return {
        recorder_version: RECORDER_VERSION,
        flow: opts.flow,
        module: opts.module,
        recorded_at: new Date(startedAt).toISOString(),
        app_url: env.appUrl,
        identity: opts.identity,
        viewport: opts.viewport,
        start_url: opts.startUrl,
        stopped_by: stoppedBy,
        redacted_values: events.filter((e) => e.value_redacted).length,
        events,
      };
    },
  };
}

function safeUrlPath(p: Page): string {
  try {
    const u = new URL(p.url());
    return u.pathname + u.search;
  } catch {
    return '/';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function recordingPathFor(flow: string): string {
  return path.join(paths.recordings, `${flow}.json`);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(`--${name}`);
const val = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

async function main(): Promise<void> {
  const flow = val('flow', '');
  if (!flow) {
    throw new Error('Usage: npm run record -- --flow <module>.<flow>   (e.g. students.add-student)');
  }
  if (!/^[a-z0-9-]+\.[a-z0-9-]+$/.test(flow)) {
    throw new Error(`--flow "${flow}" must be <module>.<flow> in kebab-case, e.g. students.add-student`);
  }
  const module = flow.split('.')[0];

  assertTargetEnvironment();

  const out = recordingPathFor(flow);
  if (fs.existsSync(out) && !has('force')) {
    throw new Error(
      `${relPosix(paths.root, out)} already exists. Re-run with --force to replace it. ` +
        `A stray re-record must not silently discard a good recording.`,
    );
  }

  const startUrl = val('start', '/');
  const headless = has('headless');

  log.banner(`Recording ${flow}`);
  log.info(`Start URL ......... ${startUrl}`);
  log.info(`Output ............ ${relPosix(paths.root, out)}`);
  log.info('The recorder only observes — it never clicks, types or scrolls for you.');
  log.info('Close the browser window when you are done (Ctrl-C also works).');

  const browser: Browser = await launchBrowser({ headless });

  let stoppedBy: Recording['stopped_by'] = 'context-closed';
  try {
    // Authenticate FIRST. Anything src/login.ts does on a stale session must
    // not end up in the recording, so listeners go on afterwards.
    const context = await getAuthenticatedContext(browser, 'admin');
    log.ok('Authenticated. Installing listeners — recording starts now.');

    const recorder = await installRecorder(context, {
      flow,
      module,
      identity: 'admin',
      startUrl,
      viewport: { width: env.browser.width, height: env.browser.height },
    });

    const page = await context.newPage();
    recorder.attach(page);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (why: Recording['stopped_by']) => {
        if (done) return;
        done = true;
        stoppedBy = why;
        resolve();
      };
      page.on('close', () => finish('context-closed'));
      context.on('close', () => finish('context-closed'));
      process.once('SIGINT', () => finish('sigint'));
    });

    const recording = await recorder.finish(stoppedBy);
    ensureDir(paths.recordings);
    writeJson(out, recording);

    log.banner('Recording complete');
    log.info(`Events ............ ${recording.events.length}`);
    log.info(`Redacted values ... ${recording.redacted_values}`);
    log.info(`Stopped by ........ ${recording.stopped_by}`);
    log.ok(`Wrote ${relPosix(paths.root, out)}`);
    log.info(`Next: npm run record:convert -- --flow ${flow}`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

if (require.main === module) {
  main().catch((err) => {
    log.error((err as Error).message);
    process.exitCode = 1;
  });
}
