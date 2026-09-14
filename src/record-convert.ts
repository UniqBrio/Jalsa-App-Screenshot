/**
 * Converter — recording JSON to a schema v2 draft manifest.
 *
 * Deterministic and total: the same recording always produces the same YAML,
 * byte for byte. No LLM is involved anywhere in this path, which is what makes
 * `npm run record:diff` meaningful — a difference in the output means the app
 * moved, not that a model felt differently today.
 *
 * `convertRecording` is a pure function so the CLI, the tests and the worked
 * example all exercise exactly the same code.
 *
 * What it refuses to guess:
 *   · which typed value creates a record  -> every `type` step gets run_tag: TODO
 *   · how to undo what the flow created   -> a single TODO teardown entry
 *   · a selector for an element with no test id and no unique role/name
 *                                          -> the literal TODO_SELECTOR
 * `npm run validate` turns all three into hard errors once the file is promoted.
 *
 * Usage: npm run record:convert -- --flow students.add-student
 */
import * as fs from 'fs';
import * as path from 'path';
import { paths } from './env';
import { readJson, writeText, relPosix } from './fsx';
import { log } from './logger';
import { GENERATED_HEADER, TODO_SELECTOR } from './recording-types';
import type { Recording, RecordedEvent, RecordedElement } from './recording-types';

export { GENERATED_HEADER, TODO_SELECTOR };

// ─── Intermediate step shape ─────────────────────────────────────────────────

interface DraftStep {
  action: string;
  idBase: string;
  label: string;
  selector?: string;
  value?: string;
  screenshot?: string;
  assertUrl?: string;
  runTag?: boolean | 'TODO';
  maxScrolls?: number;
  position?: string;
  expect?: string;
  /** Comment lines emitted immediately above the step. */
  comments: string[];
}

export interface ConvertStats {
  events: number;
  steps: number;
  todo_selectors: number;
  run_tag_todos: number;
  redacted_values: number;
  unsettled_samples: number;
  scroll_runs_collapsed: number;
  dialog_captures: number;
}

export interface ConvertResult {
  yaml: string;
  warnings: string[];
  stats: ConvertStats;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function slug(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** YAML single-quoted scalar. Selectors are full of brackets and double quotes. */
function q(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function pathOnly(url: string): string {
  return (url || '/').split('?')[0] || '/';
}

interface ResolvedSelector {
  selector: string;
  todo: boolean;
  hint: string | null;
}

/**
 * testid, else a role/name selector that was verified unique at record time,
 * else TODO_SELECTOR. Never a CSS class chain, never a positional selector —
 * those are what the selector policy exists to keep out.
 */
export function resolveSelector(el: RecordedElement | null): ResolvedSelector {
  if (!el) {
    return { selector: TODO_SELECTOR, todo: true, hint: 'no element was captured for this event' };
  }
  if (el.testid) {
    return { selector: `[data-testid="${el.testid}"]`, todo: false, hint: null };
  }
  if (el.role_selector && el.role_selector_unique === true) {
    return { selector: el.role_selector, todo: false, hint: null };
  }

  const why = el.role_selector
    ? `role selector ${el.role_selector} matched ${el.role_selector_unique === false ? 'more than one element' : 'an unverified number of elements'}`
    : `no data-testid and no usable role/name (role=${el.role || '?'}, name=${el.name ? `"${el.name}"` : 'empty'})`;
  return {
    selector: TODO_SELECTOR,
    todo: true,
    hint: `${why}; observed <${el.tag}> at x=${el.box.x} y=${el.box.y} w=${el.box.w} h=${el.box.h}`,
  };
}

function nameFor(el: RecordedElement | null): string {
  if (!el) return 'the control';
  if (el.name) return el.name;
  if (el.testid) return el.testid.replace(/^(btn|input|nav|tab|card|open|link)-/, '').replace(/-/g, ' ');
  return `the ${el.tag}`;
}

function idBaseFor(el: RecordedElement | null): string {
  if (!el) return 'unnamed-element';
  const base = slug(el.name) || slug(el.testid ?? '') || `unnamed-${el.tag}`;
  const role = slug(el.role || el.tag);
  return role && role !== 'generic' ? `${base}-${role}` : base;
}

// ─── The conversion ──────────────────────────────────────────────────────────

export function convertRecording(rec: Recording): ConvertResult {
  const warnings: string[] = [];
  const stats: ConvertStats = {
    events: rec.events.length,
    steps: 0,
    todo_selectors: 0,
    run_tag_todos: 0,
    redacted_values: rec.redacted_values ?? 0,
    unsettled_samples: 0,
    scroll_runs_collapsed: 0,
    dialog_captures: 0,
  };

  const steps: DraftStep[] = [];
  const interactions = rec.events.filter((e) => e.type !== 'navigation');
  let scrollRun: RecordedEvent[] = [];

  const noteUnsettled = (ev: RecordedEvent, step: DraftStep): void => {
    if (ev.after_sample?.ended_by !== 'timeout') return;
    stats.unsettled_samples += 1;
    step.comments.push(
      `# WARNING: url/overlay never settled within ${ev.after_sample.waited_ms}ms after this event.`,
      `# A route change or dialog may have been missed — confirm the assertion below by hand.`,
    );
    warnings.push(
      `event ${ev.seq} (${ev.type}): after-sample timed out at ${ev.after_sample.waited_ms}ms — ` +
        `any route change or dialog open on this step may be missing from the draft`,
    );
  };

  const applyRouteAssert = (ev: RecordedEvent, step: DraftStep): void => {
    if (ev.url_before === ev.url_after) return;
    // Assert on the path when the path moved. When only the query moved, the
    // path alone would assert nothing, so keep the query — the reviewer can
    // trim it if that parameter turns out to be volatile.
    const pathChanged = pathOnly(ev.url_before) !== pathOnly(ev.url_after);
    step.assertUrl = pathChanged ? pathOnly(ev.url_after) : ev.url_after;
  };

  /**
   * A scroll run targets whatever gets clicked NEXT, not the container that was
   * scrolled. Replaying a pixel offset is wrong the moment the list length
   * changes; scrolling until the button is reachable is not.
   */
  const flushScrollRunBeforeClick = (click: RecordedEvent): void => {
    if (!scrollRun.length) return;
    const target = resolveSelector(click.element);
    if (target.todo) stats.todo_selectors += 1;

    const step: DraftStep = {
      action: 'scrollUntilVisible',
      idBase: `scroll-to-${slug(nameFor(click.element)) || 'target'}`,
      label: `Scroll to ${nameFor(click.element)}`,
      selector: target.selector,
      maxScrolls: 10,
      screenshot: 'full',
      comments: [
        `# ${scrollRun.length} scroll event(s) collapsed; recorded on ${scrollRun[0].scroll?.target_key ?? 'window'}.`,
      ],
    };
    if (target.hint) step.comments.push(`# TODO_SELECTOR: ${target.hint}`);
    steps.push(step);
    stats.scroll_runs_collapsed += 1;
    scrollRun = [];
  };

  const flushTrailingScrollRun = (): void => {
    if (!scrollRun.length) return;
    const first = scrollRun[0].scroll?.top ?? 0;
    const last = scrollRun[scrollRun.length - 1].scroll?.top ?? 0;
    const position = last >= first ? 'bottom' : 'top';
    steps.push({
      action: 'scrollTo',
      idBase: `scroll-to-${position}`,
      label: `Scroll to ${position}`,
      position,
      screenshot: 'full',
      comments: [
        `# ${scrollRun.length} scroll event(s), not followed by a click — recorded as a plain scroll.`,
      ],
    });
    scrollRun = [];
  };

  for (const ev of interactions) {
    if (ev.type === 'scroll') {
      scrollRun.push(ev);
      continue;
    }

    if (ev.type === 'click') {
      flushScrollRunBeforeClick(ev);

      const sel = resolveSelector(ev.element);
      if (sel.todo) stats.todo_selectors += 1;

      const step: DraftStep = {
        action: 'click',
        idBase: idBaseFor(ev.element),
        label: `Tap ${nameFor(ev.element)}`,
        selector: sel.selector,
        screenshot: 'viewport',
        comments: [],
      };
      if (sel.hint) step.comments.push(`# TODO_SELECTOR: ${sel.hint}`);

      // Screenshot precedence: a dialog opening wins over everything, because
      // the moment it appears is the state worth documenting.
      const opened = !ev.overlay_before.open && ev.overlay_after.open;
      if (opened) {
        if (ev.overlay_after.selector) {
          step.screenshot = `element:${ev.overlay_after.selector}`;
          stats.dialog_captures += 1;
        } else {
          step.screenshot = 'full';
          step.comments.push(
            `# A dialog opened here but carries no data-testid, so element: capture is not possible.`,
            `# Falling back to full. Raise a test id against the app repo.`,
          );
          warnings.push(
            `event ${ev.seq}: a dialog opened (${ev.overlay_after.key ?? 'unkeyed'}) but has no ` +
              `data-testid — captured as full instead of element:`,
          );
        }
      }

      applyRouteAssert(ev, step);
      noteUnsettled(ev, step);
      steps.push(step);

      // An assertion that the dialog is actually up, right after it opens.
      if (opened && ev.overlay_after.selector) {
        const dialogName = ev.overlay_after.key?.replace(/^testid:/, '') ?? 'dialog';
        steps.push({
          action: 'expect',
          idBase: `${slug(dialogName)}-visible`,
          label: `${nameFor(ev.element)} dialog is visible`,
          selector: ev.overlay_after.selector,
          expect: 'visible',
          comments: [],
        });
      }
      continue;
    }

    // input / change
    flushTrailingScrollRun();

    if (ev.type === 'input') {
      const sel = resolveSelector(ev.element);
      if (sel.todo) stats.todo_selectors += 1;
      const step: DraftStep = {
        action: 'type',
        idBase: idBaseFor(ev.element),
        label: `Enter ${nameFor(ev.element)}`,
        selector: sel.selector,
        value: ev.value_redacted
          ? `TODO — redacted (${ev.redaction_reason}); supply the value this step should type`
          : ev.value ?? '',
        // The converter cannot know whether this value creates a record.
        runTag: 'TODO',
        screenshot: 'viewport',
        comments: [],
      };
      stats.run_tag_todos += 1;
      if (sel.hint) step.comments.push(`# TODO_SELECTOR: ${sel.hint}`);
      applyRouteAssert(ev, step);
      noteUnsettled(ev, step);
      steps.push(step);
      continue;
    }

    if (ev.type === 'change') {
      const sel = resolveSelector(ev.element);
      if (sel.todo) stats.todo_selectors += 1;
      const isCheckbox = ev.element?.input_type === 'checkbox' || ev.element?.input_type === 'radio';
      const checked = ev.value === 'true';
      const step: DraftStep = {
        action: isCheckbox ? (checked ? 'check' : 'uncheck') : 'select',
        idBase: idBaseFor(ev.element),
        label: isCheckbox
          ? `${checked ? 'Tick' : 'Untick'} ${nameFor(ev.element)}`
          : `Select ${nameFor(ev.element)}`,
        selector: sel.selector,
        screenshot: 'viewport',
        comments: [],
      };
      if (!isCheckbox) step.value = ev.value ?? '';
      if (sel.hint) step.comments.push(`# TODO_SELECTOR: ${sel.hint}`);
      applyRouteAssert(ev, step);
      noteUnsettled(ev, step);
      steps.push(step);
    }
  }

  flushTrailingScrollRun();
  stats.steps = steps.length;

  // Numbering in tens, so a state can be inserted later without renumbering —
  // and renumbering is what silently orphans a fingerprint baseline key.
  const usedIds = new Set<string>();
  const numbered = steps.map((step, i) => {
    let n = (i + 1) * 10;
    if (n > 990) {
      n = 990 + (i + 1 - 99);
      if (n > 999) n = 999;
    }
    let base = step.idBase || 'step';
    let id = `${String(n).padStart(3, '0')}-${base}`;
    let dup = 2;
    while (usedIds.has(id)) {
      id = `${String(n).padStart(3, '0')}-${base}-${dup++}`;
    }
    usedIds.add(id);
    return { ...step, id };
  });

  if (steps.length > 98) {
    warnings.push(
      `${steps.length} steps: past 990 the tens convention runs out and ids fall back to ` +
        `increments of 1. Consider splitting this into more than one flow.`,
    );
  }

  const module = rec.module;
  const flowName = rec.flow.slice(module.length + 1);
  const title = flowName.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

  const out: string[] = [];
  out.push(GENERATED_HEADER);
  out.push(`# Recorded ${rec.recorded_at} against ${rec.app_url} as ${rec.identity}.`);
  out.push(`# ${rec.events.length} event(s) -> ${steps.length} step(s). Regenerate with:`);
  out.push(`#   npm run record:convert -- --flow ${rec.flow}`);
  out.push('#');
  out.push('# Before promoting this to ' + `flows/${rec.flow}.yaml` + ':');
  out.push('#   1. replace every TODO_SELECTOR with a real selector');
  out.push('#   2. set run_tag: false on every type step (a value that would CREATE a record means the step must go)');
  out.push('#   3. write a real teardown that returns the app to where the flow started (never a delete)');
  out.push('#   4. delete this GENERATED header');
  out.push('# validate refuses to load a promoted flow with any of those outstanding.');
  if (rec.redacted_values > 0) {
    out.push('#');
    out.push(`# ${rec.redacted_values} value(s) were redacted at record time and are TODO below.`);
  }
  out.push('');
  out.push('schema_version: 2');
  out.push(`module: ${module}`);
  out.push(`flow: ${flowName}`);
  out.push(`title: ${q(title)}`);
  out.push(`description: ${q(`Recorded walkthrough of ${title.toLowerCase()} — draft, not reviewed`)}`);
  out.push(`auth: ${rec.identity === 'staff' ? 'staff' : 'admin'}`);
  out.push('settle_ms: 350');
  out.push('');
  out.push('depends_on_routes:');
  const routes = Array.from(
    new Set(rec.events.flatMap((e) => [pathOnly(e.url_before), pathOnly(e.url_after)])),
  ).filter(Boolean).sort();
  for (const r of routes) out.push(`  - ${r}`);
  out.push('');

  // Setup establishes the flow's own starting point, so it does not depend on
  // whatever screen a previous flow happened to leave behind.
  out.push('setup:');
  out.push(`  - id: 005-open-${slug(pathOnly(rec.start_url)) || 'start'}`);
  out.push('    action: goto');
  out.push(`    value: ${q(pathOnly(rec.start_url))}`);
  out.push(`    label: ${q(`Open ${pathOnly(rec.start_url)}`)}`);
  out.push('');

  out.push('steps:');
  for (const step of numbered) {
    for (const c of step.comments) out.push(`  ${c}`);
    out.push(`  - id: ${step.id}`);
    out.push(`    action: ${step.action}`);
    if (step.selector !== undefined) out.push(`    selector: ${q(step.selector)}`);
    if (step.value !== undefined) out.push(`    value: ${q(step.value)}`);
    if (step.position !== undefined) out.push(`    position: ${step.position}`);
    if (step.maxScrolls !== undefined) out.push(`    max_scrolls: ${step.maxScrolls}`);
    if (step.expect !== undefined) out.push(`    expect: ${step.expect}`);
    out.push(`    label: ${q(step.label)}`);
    if (step.runTag !== undefined) out.push(`    run_tag: ${step.runTag}`);
    if (step.screenshot !== undefined) out.push(`    screenshot: ${q(step.screenshot)}`);
    if (step.assertUrl !== undefined) {
      out.push('    assert:');
      out.push(`      url_contains: ${q(step.assertUrl)}`);
    }
    out.push('');
  }

  out.push('teardown:');
  out.push('  # TODO — the converter cannot infer a correct teardown.');
  out.push('  # Replace this with the steps that return the app to where the flow');
  out.push('  # started (close the dialog, go back). A flow that CREATED something');
  out.push('  # cannot be promoted at all — this project is read-only against the');
  out.push('  # live app — so if the walkthrough wrote data, delete those steps.');
  out.push('  - id: 999-todo-teardown');
  out.push('    action: snapshot');
  out.push(`    label: ${q('TODO — describe how this flow returns to where it started')}`);
  out.push('');

  return { yaml: out.join('\n'), warnings, stats };
}

// ─── Paths ───────────────────────────────────────────────────────────────────

export function generatedPathFor(flow: string): string {
  return path.join(paths.flows, `${flow}.generated.yaml`);
}
export function promotedPathFor(flow: string): string {
  return path.join(paths.flows, `${flow}.yaml`);
}
export function recordingPathFor(flow: string): string {
  return path.join(paths.recordings, `${flow}.json`);
}

export function loadRecording(flow: string): Recording {
  const file = recordingPathFor(flow);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No recording at ${relPosix(paths.root, file)}. Record one first: npm run record -- --flow ${flow}`,
    );
  }
  return readJson<Recording>(file, null as unknown as Recording);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const val = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

function main(): void {
  const flow = val('flow', '');
  if (!flow) {
    throw new Error('Usage: npm run record:convert -- --flow <module>.<flow>');
  }

  const rec = loadRecording(flow);
  const { yaml, warnings, stats } = convertRecording(rec);

  const out = generatedPathFor(flow);
  const promoted = promotedPathFor(flow);

  writeText(out, yaml);

  log.banner(`Converted ${flow}`);
  log.info(`Events ................ ${stats.events}`);
  log.info(`Steps ................. ${stats.steps}`);
  log.info(`Scroll runs collapsed . ${stats.scroll_runs_collapsed}`);
  log.info(`Dialog element: shots . ${stats.dialog_captures}`);
  log.info(`TODO_SELECTOR ......... ${stats.todo_selectors}`);
  log.info(`run_tag: TODO ......... ${stats.run_tag_todos}`);
  log.info(`Redacted values ....... ${stats.redacted_values}`);
  if (stats.unsettled_samples) {
    log.warn(`Unsettled after-samples: ${stats.unsettled_samples} — see the WARNING comments in the draft.`);
  }
  warnings.forEach((w) => log.warn(w));

  log.ok(`Wrote ${relPosix(paths.root, out)}`);
  log.info('This is a DRAFT. It is excluded from loadFlows(), so it cannot be captured,');
  log.info('cleaned up or documented until you promote it by hand.');

  if (fs.existsSync(promoted)) {
    log.warn(
      `${relPosix(paths.root, promoted)} already exists and was NOT touched. ` +
        `Run "npm run record:diff -- --flow ${flow}" to see how the draft differs from it.`,
    );
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    log.error((err as Error).message);
    process.exitCode = 1;
  }
}
