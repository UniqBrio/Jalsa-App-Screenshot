/**
 * The converter is the piece that has to be trusted without a browser: it turns
 * an observation log into a manifest a human will review once and then run every
 * night. These cover the mapping table case by case, plus the three things it
 * must refuse to guess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertRecording, resolveSelector, slug } from '../record-convert';
import { GENERATED_HEADER, TODO_SELECTOR } from '../recording-types';
import type {
  Recording,
  RecordedEvent,
  RecordedElement,
  OverlayState,
} from '../recording-types';

// ─── builders ────────────────────────────────────────────────────────────────

const CLOSED: OverlayState = { open: false, key: null, selector: null };
const openOverlay = (testid: string): OverlayState => ({
  open: true,
  key: `testid:${testid}`,
  selector: `[data-testid="${testid}"]`,
});

function el(over: Partial<RecordedElement> = {}): RecordedElement {
  return {
    testid: null,
    role: 'button',
    name: 'Add Student',
    tag: 'button',
    input_type: null,
    box: { x: 10, y: 20, w: 100, h: 30 },
    in_viewport: true,
    selector_candidates: [],
    role_selector: null,
    role_selector_unique: null,
    ...over,
  };
}

let seq = 0;
function ev(over: Partial<RecordedEvent> = {}): RecordedEvent {
  seq += 1;
  return {
    seq,
    t_ms: seq * 100,
    ts: '2026-08-19T00:00:00.000Z',
    type: 'click',
    url_before: '/students',
    url_after: '/students',
    overlay_before: CLOSED,
    overlay_after: CLOSED,
    after_sample: { ended_by: 'stable', settled: true, waited_ms: 300 },
    element: el(),
    scroll: null,
    value: null,
    value_redacted: false,
    redaction_reason: null,
    ...over,
  };
}

function rec(events: RecordedEvent[], over: Partial<Recording> = {}): Recording {
  seq = 0;
  return {
    recorder_version: 1,
    flow: 'students.add-student',
    module: 'students',
    recorded_at: '2026-08-19T00:00:00.000Z',
    app_url: 'https://rosi-fit.vercel.app',
    identity: 'admin',
    viewport: { width: 1280, height: 900 },
    start_url: '/students',
    stopped_by: 'api',
    redacted_values: events.filter((e) => e.value_redacted).length,
    events,
    ...over,
  };
}

const scrollEv = (top: number) =>
  ev({
    type: 'scroll',
    element: el({ testid: 'dialog-body', role: 'generic', name: 'body' }),
    scroll: {
      target_key: 'testid:dialog-body',
      selector: '[data-testid="dialog-body"]',
      top,
      left: 0,
      scroll_height: 900,
      client_height: 220,
      is_window: false,
    },
  });

// ─── selector resolution ─────────────────────────────────────────────────────

test('a test id always wins', () => {
  const r = resolveSelector(el({ testid: 'btn-add-student', role_selector: 'role=button[name="Add Student"]' }));
  assert.equal(r.selector, '[data-testid="btn-add-student"]');
  assert.equal(r.todo, false);
});

test('a role selector is used only when it was verified unique', () => {
  const unique = resolveSelector(
    el({ role_selector: 'role=button[name="Add Student"]', role_selector_unique: true }),
  );
  assert.equal(unique.selector, 'role=button[name="Add Student"]');
  assert.equal(unique.todo, false);
});

test('a role selector that matched more than one element becomes TODO_SELECTOR', () => {
  const r = resolveSelector(
    el({ role_selector: 'role=button[name="Options"]', role_selector_unique: false }),
  );
  assert.equal(r.selector, TODO_SELECTOR);
  assert.equal(r.todo, true);
  assert.match(String(r.hint), /matched more than one element/);
});

test('no test id and no role selector becomes TODO_SELECTOR with a locating hint', () => {
  const r = resolveSelector(el({ role: 'generic', name: '', box: { x: 5, y: 6, w: 7, h: 8 } }));
  assert.equal(r.selector, TODO_SELECTOR);
  assert.match(String(r.hint), /x=5 y=6 w=7 h=8/);
});

test('the converter never emits a class chain or an nth selector', () => {
  const { yaml } = convertRecording(rec([ev({ element: el({ testid: 'btn-add-student' }) })]));
  assert.ok(!/selector: '\./.test(yaml));
  assert.ok(!/nth-child|nth-of-type/.test(yaml));
});

// ─── scroll collapsing ───────────────────────────────────────────────────────

test('a scroll run collapses into scrollUntilVisible targeting the NEXT click', () => {
  const { yaml, stats } = convertRecording(
    rec([
      scrollEv(120),
      scrollEv(240),
      scrollEv(360),
      ev({ element: el({ testid: 'btn-save-student', name: 'Save Student' }) }),
    ]),
  );
  assert.equal(stats.scroll_runs_collapsed, 1);
  assert.match(yaml, /action: scrollUntilVisible/);
  // The target is the button that was clicked, NOT the container that scrolled.
  assert.match(yaml, /action: scrollUntilVisible\n {4}selector: '\[data-testid="btn-save-student"\]'/);
  assert.ok(!yaml.includes(`selector: '[data-testid="dialog-body"]'`));
  assert.match(yaml, /3 scroll event\(s\) collapsed/);
  assert.match(yaml, /max_scrolls: 10/);
});

test('a collapsed scroll step captures full', () => {
  const { yaml } = convertRecording(
    rec([scrollEv(120), ev({ element: el({ testid: 'btn-save-student', name: 'Save Student' }) })]),
  );
  const block = yaml.split('- id: ').find((b) => b.includes('scrollUntilVisible')) ?? '';
  assert.match(block, /screenshot: 'full'/);
});

test('a trailing scroll run with no following click becomes scrollTo', () => {
  const { yaml, stats } = convertRecording(rec([scrollEv(100), scrollEv(400)]));
  assert.equal(stats.scroll_runs_collapsed, 0);
  assert.match(yaml, /action: scrollTo/);
  assert.match(yaml, /position: bottom/);
});

test('a trailing scroll run that went upwards records position: top', () => {
  const { yaml } = convertRecording(rec([scrollEv(400), scrollEv(100)]));
  assert.match(yaml, /position: top/);
});

test('a scroll run followed by typing is not attached to the type step', () => {
  const { yaml } = convertRecording(
    rec([
      scrollEv(120),
      ev({ type: 'input', element: el({ testid: 'input-name', role: 'textbox', name: 'Name', tag: 'input' }), value: 'x' }),
    ]),
  );
  assert.match(yaml, /action: scrollTo/);
  assert.ok(!yaml.includes('scrollUntilVisible'));
});

// ─── dialogs ─────────────────────────────────────────────────────────────────

test('a click that opens a dialog captures element: and is followed by an expect', () => {
  const { yaml, stats } = convertRecording(
    rec([
      ev({
        element: el({ testid: 'btn-add-student' }),
        overlay_before: CLOSED,
        overlay_after: openOverlay('modal-add-student'),
      }),
    ]),
  );
  assert.equal(stats.dialog_captures, 1);
  assert.match(yaml, /screenshot: 'element:\[data-testid="modal-add-student"\]'/);
  assert.match(yaml, /action: expect\n {4}selector: '\[data-testid="modal-add-student"\]'\n {4}expect: visible/);
});

test('a dialog with no test id falls back to full and warns', () => {
  const { yaml, warnings, stats } = convertRecording(
    rec([
      ev({
        element: el({ testid: 'btn-add-student' }),
        overlay_before: CLOSED,
        overlay_after: { open: true, key: 'role:dialog/Add', selector: null },
      }),
    ]),
  );
  assert.equal(stats.dialog_captures, 0);
  assert.match(yaml, /screenshot: 'full'/);
  assert.ok(!yaml.includes('action: expect'));
  assert.ok(warnings.some((w) => w.includes('no ')));
});

test('a dialog that was already open produces no element: capture', () => {
  const { stats } = convertRecording(
    rec([
      ev({
        element: el({ testid: 'btn-inside' }),
        overlay_before: openOverlay('modal-add-student'),
        overlay_after: openOverlay('modal-add-student'),
      }),
    ]),
  );
  assert.equal(stats.dialog_captures, 0);
});

// ─── route changes ───────────────────────────────────────────────────────────

test('a path change emits assert.url_contains on the causing step', () => {
  const { yaml } = convertRecording(
    rec([ev({ element: el({ testid: 'btn-save' }), url_before: '/students', url_after: '/students/8f3c' })]),
  );
  assert.match(yaml, /assert:\n {6}url_contains: '\/students\/8f3c'/);
});

test('a query-only change keeps the query, since the path alone would assert nothing', () => {
  const { yaml } = convertRecording(
    rec([ev({ element: el({ testid: 'btn-save' }), url_before: '/students', url_after: '/students?added=1' })]),
  );
  assert.match(yaml, /url_contains: '\/students\?added=1'/);
});

test('no route change means no assert', () => {
  const { yaml } = convertRecording(rec([ev({ element: el({ testid: 'btn-x' }) })]));
  assert.ok(!yaml.includes('url_contains'));
});

test('an unsettled after-sample is surfaced as a comment and a warning', () => {
  const { yaml, warnings, stats } = convertRecording(
    rec([
      ev({
        element: el({ testid: 'btn-save' }),
        after_sample: { ended_by: 'timeout', settled: false, waited_ms: 5000 },
      }),
    ]),
  );
  assert.equal(stats.unsettled_samples, 1);
  assert.match(yaml, /WARNING: url\/overlay never settled/);
  assert.ok(warnings.some((w) => w.includes('after-sample timed out')));
});

// ─── what it refuses to guess ────────────────────────────────────────────────

test('every type step carries run_tag: TODO', () => {
  const { yaml, stats } = convertRecording(
    rec([
      ev({ type: 'input', element: el({ testid: 'input-name', role: 'textbox', tag: 'input', name: 'Name' }), value: 'Aarav' }),
      ev({ type: 'input', element: el({ testid: 'input-city', role: 'textbox', tag: 'input', name: 'City' }), value: 'Erode' }),
    ]),
  );
  assert.equal(stats.run_tag_todos, 2);
  assert.equal(yaml.match(/run_tag: TODO/g)?.length, 2);
});

test('a redacted value becomes a TODO rather than a plausible-looking guess', () => {
  const { yaml } = convertRecording(
    rec([
      ev({
        type: 'input',
        element: el({ testid: 'input-guardian', role: 'textbox', tag: 'input', name: 'Guardian mobile' }),
        value: null,
        value_redacted: true,
        redaction_reason: 'input[type=tel]',
      }),
    ]),
  );
  assert.match(yaml, /value: 'TODO — redacted \(input\[type=tel\]\)/);
});

test('a teardown TODO is always emitted', () => {
  const { yaml } = convertRecording(rec([ev({ element: el({ testid: 'btn-x' }) })]));
  assert.match(yaml, /teardown:/);
  assert.match(yaml, /999-todo-teardown/);
  assert.match(yaml, /TODO — describe how this flow returns to where it started/);
});

test('the generated header is the first line', () => {
  const { yaml } = convertRecording(rec([ev({ element: el({ testid: 'btn-x' }) })]));
  assert.equal(yaml.split('\n')[0], GENERATED_HEADER);
});

// ─── ids, labels, numbering ──────────────────────────────────────────────────

test('ids come from the accessible name plus the role, numbered in tens', () => {
  const { yaml } = convertRecording(
    rec([
      ev({ element: el({ testid: 'btn-add-student', name: 'Add Student', role: 'button' }) }),
      ev({ element: el({ testid: 'btn-save', name: 'Save Student', role: 'button' }) }),
    ]),
  );
  assert.match(yaml, /- id: 010-add-student-button/);
  assert.match(yaml, /- id: 020-save-student-button/);
});

test('labels read as instructions, by action', () => {
  const { yaml } = convertRecording(
    rec([
      ev({ element: el({ testid: 'btn-add-student', name: 'Add Student' }) }),
      ev({ type: 'input', element: el({ testid: 'input-name', role: 'textbox', tag: 'input', name: 'Student name' }), value: 'x' }),
      ev({ type: 'change', element: el({ testid: 'sel-course', role: 'combobox', tag: 'select', name: 'Course' }), value: 'silambam' }),
    ]),
  );
  assert.match(yaml, /label: 'Tap Add Student'/);
  assert.match(yaml, /label: 'Enter Student name'/);
  assert.match(yaml, /label: 'Select Course'/);
});

test('repeated ids are disambiguated rather than colliding', () => {
  const { yaml } = convertRecording(
    rec([
      ev({ element: el({ testid: 'btn-a', name: 'Options' }) }),
      ev({ element: el({ testid: 'btn-b', name: 'Options' }) }),
    ]),
  );
  assert.match(yaml, /- id: 010-options-button\n/);
  assert.match(yaml, /- id: 020-options-button\n/);
});

test('setup always establishes the flow start point', () => {
  const { yaml } = convertRecording(rec([ev({ element: el({ testid: 'btn-x' }) })], { start_url: '/students' }));
  assert.match(yaml, /setup:\n {2}- id: 005-open-students\n {4}action: goto\n {4}value: '\/students'/);
});

// ─── checkboxes and selects ──────────────────────────────────────────────────

test('a ticked checkbox becomes check, an unticked one uncheck', () => {
  const on = convertRecording(
    rec([ev({ type: 'change', element: el({ testid: 'cb', role: 'checkbox', tag: 'input', input_type: 'checkbox', name: 'Active' }), value: 'true' })]),
  ).yaml;
  const off = convertRecording(
    rec([ev({ type: 'change', element: el({ testid: 'cb', role: 'checkbox', tag: 'input', input_type: 'checkbox', name: 'Active' }), value: 'false' })]),
  ).yaml;
  assert.match(on, /action: check/);
  assert.match(off, /action: uncheck/);
});

// ─── determinism ─────────────────────────────────────────────────────────────

test('the same recording converts byte-for-byte identically', () => {
  const events = [
    ev({ element: el({ testid: 'btn-add-student' }), overlay_after: openOverlay('modal-add-student') }),
    scrollEv(120),
    ev({ element: el({ testid: 'btn-save-student', name: 'Save Student' }) }),
  ];
  const a = convertRecording(rec([...events])).yaml;
  const b = convertRecording(rec([...events])).yaml;
  assert.equal(a, b);
});

test('navigation events do not become steps of their own', () => {
  const { stats } = convertRecording(
    rec([ev({ type: 'navigation', element: null }), ev({ element: el({ testid: 'btn-x' }) })]),
  );
  assert.equal(stats.steps, 1);
});

test('slug is kebab-case and bounded', () => {
  assert.equal(slug('Add Student!'), 'add-student');
  assert.equal(slug('  Guardian   Mobile  '), 'guardian-mobile');
  assert.ok(slug('x'.repeat(80)).length <= 40);
});
