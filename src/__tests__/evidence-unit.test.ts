/**
 * C1 evidence capture — everything that can be tested without a browser:
 * classification rules and their order, the sanitizers that reduce raw browser
 * readings, the PII config loader, the evidence schema validator, and the
 * evidence:check acceptance checker against positive and negative fixtures.
 *
 * All personal-looking values are synthetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import zlib from 'zlib';

import { useSampleApp } from './helpers/sample-app';

useSampleApp({ SIGNIN_MOBILE: '9000048261', SIGNIN_PIN: '4826' });

/* eslint-disable @typescript-eslint/no-var-requires */
const probe = require('../manual/census-probe') as typeof import('../manual/census-probe');
const san = require('../manual/evidence-sanitize') as typeof import('../manual/evidence-sanitize');
const cfg = require('../manual/pii-config') as typeof import('../manual/pii-config');
const types = require('../manual/evidence-types') as typeof import('../manual/evidence-types');
const check = require('../manual/evidence-check') as typeof import('../manual/evidence-check');
const runner = require('../runner') as typeof import('../runner');
/* eslint-enable @typescript-eslint/no-var-requires */

import type { ClassifyInput, ClassifyRules } from '../manual/census-probe';
import type { Flow, FlowStep, KnownRoute } from '../types';
import type { VisualState } from '../visual-state';

/** A sample market's phone shape. It is an app setting (profile pii.phonePattern), never a core rule. */
const INDIA_PHONE = String.raw`(?<![0-9])(?:\+?91[\s-]*)?[6-9][0-9]{4}[\s-]?[0-9]{5}(?![0-9])`;
const RULES: ClassifyRules = {
  identifiers: [{ name: 'SIGNIN_MOBILE', digits: '9000048261' }],
  secrets: ['4826'],
  safe_literals: ['a', 'Backspace'],
  label_texts: ['continue', 'welcome a new member', 'attendance'],
  phone_pattern: INDIA_PHONE,
};
const plain = (text: string, over: Partial<ClassifyInput> = {}): ClassifyInput => ({
  text, source: 'text', region: null, control_static_testid: false, record_screen: false, ...over,
});
const cls = (input: ClassifyInput) => probe.classifyTextRun(input, RULES);
const KEY = 'unit-test-key';
const ROUTES: KnownRoute[] = [
  { path: '/', label: 'Sign in / Overview' },
  { path: '/courses', label: 'Attendance' },
  { path: '/course/[id]', label: 'Course detail' },
  { path: '/member/[id]', label: 'Member detail' },
  { path: '/member/edit', label: 'Member form' },
];

// ─── normaliseTestid ─────────────────────────────────────────────────────────

test('normaliseTestid reduces id suffixes to a family and keeps static ids', () => {
  assert.deepEqual(probe.normaliseTestid('courses-open-6f1c2a9e-1111-4a3b-9c2d-000000000001'), { family: 'courses-open-*', static: false });
  assert.deepEqual(probe.normaliseTestid('course-day-2026-09-14'), { family: 'course-day-*', static: false });
  assert.deepEqual(probe.normaliseTestid('course-member-42'), { family: 'course-member-*', static: false });
  assert.deepEqual(probe.normaliseTestid('row-k3j9x0p2qa'), { family: 'row-*', static: false });
  assert.deepEqual(probe.normaliseTestid('nav-tab-attendance'), { family: 'nav-tab-attendance', static: true });
  assert.deepEqual(probe.normaliseTestid('home-period-this-week'), { family: 'home-period-this-week', static: true });
  assert.deepEqual(probe.normaliseTestid('overviewsections'), { family: 'overviewsections', static: true });
});

// ─── classifyTextRun: each rule ──────────────────────────────────────────────

test('S: password inputs and PIN values are secrets', () => {
  assert.equal(cls(plain('abcd', { source: 'value', input_type: 'password' })).class, 'S');
  assert.deepEqual(cls(plain('4826', { source: 'value' })), { class: 'S', rule: 'secret-value' });
  assert.equal(cls(plain('code 4826 sent')).class, 'S');
  assert.notEqual(cls(plain('148260 members')).class, 'S', 'a PIN inside a longer number is not the PIN');
});

test('I: the operator mobile in any spacing, and a ≥5-digit fragment of it', () => {
  assert.deepEqual(cls(plain('+91 90000 48261')), { class: 'I', rule: 'identifier:SIGNIN_MOBILE' });
  assert.equal(cls(plain('9000048261', { source: 'value' })).class, 'I');
  assert.deepEqual(cls(plain('+91 90000')), { class: 'I', rule: 'identifier-fragment:SIGNIN_MOBILE' });
  assert.notEqual(cls(plain('1053 members')).class, 'I');
});

test('P: email and phone shapes, even outside any region', () => {
  assert.deepEqual(cls(plain('someone.synthetic@example.com')), { class: 'P', rule: 'email-pattern' });
  assert.equal(cls(plain('someone.syn…@exa…')).class, 'P', 'a truncated email is still an email');
  assert.deepEqual(cls(plain('Call 81234 56789')), { class: 'P', rule: 'phone-pattern' });
});

test('region class wins over every label rule', () => {
  const region = { id: 'member-rows', class: 'P' as const };
  assert.deepEqual(cls(plain('Continue', { region })), { class: 'P', rule: 'region:member-rows' });
  assert.equal(cls(plain('Synthetic Person', { region, control_static_testid: true })).class, 'P');
  assert.equal(cls(plain('Sample Org', { region: { id: 'org-header', class: 'O' } })).class, 'O');
});

test('identifier and pattern rules win over a region', () => {
  const region = { id: 'org-header', class: 'O' as const };
  assert.equal(cls(plain('+91 90000 48261', { region })).class, 'I');
  assert.equal(cls(plain('someone.synthetic@example.com', { region })).class, 'P');
});

test('input values: flow literals are L, anything else typed or prefilled is P', () => {
  assert.deepEqual(cls(plain('a', { source: 'value' })), { class: 'L', rule: 'safe-literal' });
  assert.deepEqual(cls(plain('Synthetic Person', { source: 'value' })), { class: 'P', rule: 'input-value' });
});

test('L: placeholders, the label allowlist, symbol-only text, static controls off record screens', () => {
  assert.deepEqual(cls(plain('e.g. Synthetic Example', { source: 'placeholder' })), { class: 'L', rule: 'placeholder' });
  assert.deepEqual(cls(plain('Search', { source: 'name', name_source: 'placeholder' })), { class: 'L', rule: 'placeholder' });
  assert.deepEqual(cls(plain('  Welcome   a new MEMBER ')), { class: 'L', rule: 'label-allowlist' });
  assert.deepEqual(cls(plain('* · →')), { class: 'L', rule: 'symbol-only' });
  assert.deepEqual(cls(plain('Add member', { control_static_testid: true })), { class: 'L', rule: 'static-control' });
});

test('U: static-control text on a record screen, and anything without a label source', () => {
  assert.deepEqual(cls(plain('Close', { control_static_testid: true, record_screen: true })), { class: 'U', rule: 'unclassified' });
  assert.equal(cls(plain('Synthetic Person')).class, 'U', 'a heading-like name with no label source stays unclassified');
  assert.equal(cls(plain('1053 members · 1 branches')).class, 'U');
});

// ─── sanitizers ──────────────────────────────────────────────────────────────

test('routePattern prefers known patterns and masks id-like segments otherwise', () => {
  assert.equal(san.routePattern('/member/6f1c2a9e-1111-4a3b-9c2d-000000000001', ROUTES), '/member/[id]');
  assert.equal(san.routePattern('/member/edit', ROUTES), '/member/edit');
  assert.equal(san.routePattern('/courses/', ROUTES), '/courses');
  assert.equal(san.routePattern('/unknown/12345/tab', ROUTES), '/unknown/[id]/tab');
});

test('sanitizeUrl keeps route-shaped query values, hashes the rest, never stores the concrete path', () => {
  const u = san.sanitizeUrl('https://x.test/member/6f1c2a9e-1111-4a3b-9c2d-000000000001?from=/courses&q=Synthetic%20Person', ROUTES, KEY);
  assert.equal(u.pattern, '/member/[id]');
  assert.equal(u.record_screen, true);
  assert.deepEqual(u.query[0], { key: 'from', value: '/courses', value_sha256: null });
  assert.equal(u.query[1].value, null);
  assert.match(u.query[1].value_sha256 ?? '', /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(u), /6f1c2a9e|Synthetic/);
});

test('sanitizeVisualState strips labels and page text from every key', () => {
  const raw: VisualState = {
    route: '/course/6f1c2a9e-1111-4a3b-9c2d-000000000001',
    overlays: ['testid:member-form', 'role:dialog/Synthetic Person'],
    scrollTops: ['window:0', 'role:list/Synthetic Person, active:120'],
    visibleKeys: ['testid:courses-open-6f1c2a9e-1111-4a3b-9c2d-000000000001', 'testid:courses-open-6f1c2a9e-1111-4a3b-9c2d-000000000002'],
    lists: ['role:list/Synthetic Person:12'],
    errors: ['testid:field-error-name:Name for Synthetic Person is required'],
    toasts: ['role:status/Saved someone.synthetic@example.com'],
    activeTab: 'role:tab/Attendance',
    loading: [],
    disabled: ['testid:signin-continue'],
  };
  const s = san.sanitizeVisualState(raw, ROUTES, KEY);
  const json = JSON.stringify(s);
  assert.doesNotMatch(json, /Synthetic|example\.com|6f1c2a9e|Attendance/);
  assert.equal(s.route.pattern, '/course/[id]');
  assert.deepEqual(s.visible_keys, ['testid:courses-open-*']);
  assert.match(s.lists[0], /^role:list\/#[0-9a-f]{12}:12$/);
  assert.equal(s.scroll_tops[0], 'window:0');
  assert.equal(s.errors[0].key, 'testid:field-error-name');
  assert.deepEqual(s.disabled, ['testid:signin-continue']);
});

test('selectorKind classifies every selector shape the policy allows', () => {
  const st = (over: Partial<FlowStep> = {}): FlowStep => ({ id: '010-x', action: 'click', ...over });
  assert.equal(san.selectorKind('[data-testid="signin-continue"]', st()), 'testid');
  assert.equal(san.selectorKind('[data-testid^="courses-open-"]', st()), 'testid-prefix');
  assert.equal(san.selectorKind('role=button[name="Add"]', st()), 'role');
  assert.equal(san.selectorKind('role=button[name=/ expected, /]', st()), 'role-regex');
  assert.equal(san.selectorKind('[data-testid="row-1"] [data-testid="btn-edit"]', st()), 'chain');
  assert.equal(san.selectorKind('#legacy', st({ selector_exempt: 'reason' })), 'exempt');
});

test('safeLiterals collects only literal, run_tag:false typed values and pressed keys', () => {
  const flow = {
    module: 'm', flow: 'f', steps: [
      { id: '010', action: 'type', value: 'a', run_tag: false },
      { id: '020', action: 'type', value: '{{SIGNIN_MOBILE}}', run_tag: false },
      { id: '030', action: 'type', value: 'Synthetic Person', run_tag: 'TODO' },
      { id: '040', action: 'press', value: 'Backspace' },
    ],
  } as Flow;
  assert.deepEqual(san.safeLiterals(flow).sort(), ['Backspace', 'a']);
});

test('inputEvidence tokens credentials and identifiers and keeps only L text', () => {
  const step = (value: string, action: FlowStep['action'] = 'type'): FlowStep => ({ id: '010', action, value, run_tag: false });
  const pin = san.inputEvidence(step('{{SIGNIN_PIN}}'), {}, RULES, ROUTES, KEY);
  assert.equal(pin.input?.class, 'S');
  assert.equal(pin.input?.token, '«redacted»');
  assert.equal(pin.input?.text, undefined);
  assert.deepEqual(pin.sensitive, { kind: 'credential', var: 'SIGNIN_PIN' });

  const mobile = san.inputEvidence(step('{{SIGNIN_MOBILE}}'), {}, RULES, ROUTES, KEY);
  assert.equal(mobile.input?.class, 'I');
  assert.equal(mobile.input?.token, '«redacted:SIGNIN_MOBILE»');
  assert.deepEqual(mobile.sensitive, { kind: 'identifier', var: 'SIGNIN_MOBILE' });

  const partial = san.inputEvidence(step('{{PARTIAL}}'), { PARTIAL: '90000' }, RULES, ROUTES, KEY);
  assert.equal(partial.input?.class, 'I', 'a flow var holding part of the operator number is an identifier');
  assert.equal(partial.input?.text, undefined);

  const search = san.inputEvidence(step('a'), {}, RULES, ROUTES, KEY);
  assert.equal(search.input?.class, 'L');
  assert.equal(search.input?.text, 'a');

  const goto = san.inputEvidence(step('/members?from=/courses', 'goto'), {}, RULES, ROUTES, KEY);
  assert.equal(goto.input?.text, '/members');
});

test('sanitizeError masks quoted page text but keeps the authored selector and redaction tokens', () => {
  const msg = 'step 100 selector=[data-testid="member-close"]: expect text "Close" — element text is "Synthetic Person" typed "9000048261"';
  const out = san.sanitizeError(msg, ['[data-testid="member-close"]', 'Close'], KEY);
  assert.match(out, /\[data-testid="member-close"\]/);
  assert.match(out, /expect text "Close"/);
  assert.match(out, /typed "«redacted:SIGNIN_MOBILE»"/);
  assert.doesNotMatch(out, /Synthetic/);
});

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('pngSize reads IHDR and rejects non-PNGs', () => {
  assert.deepEqual(san.pngSize(png(780, 1687)), { width: 780, height: 1687 });
  assert.throws(() => san.pngSize(Buffer.from('not a png at all, definitely')), /not a PNG/);
});

// ─── PII config ──────────────────────────────────────────────────────────────

test('the Sample App pii-regions.json loads and normalises its labels', () => {
  const c = cfg.loadPiiConfig();
  assert.ok(c.data_regions.some((r) => r.id === 'member-rows'));
  assert.ok(c.label_texts.includes('welcome a new member'));
});

test('parsePiiConfig rejects regions that would silently match nothing', () => {
  const bad = (region: unknown) => () => cfg.parsePiiConfig({ data_regions: [region], label_texts: ['x'] });
  assert.throws(bad({ id: 'a', class: 'X', match: { testid: 't' } }), /class: must be P, O or I/);
  assert.throws(bad({ id: 'a', class: 'P', match: {} }), /needs testid, testid_family, or role \+ name_regex/);
  assert.throws(bad({ id: 'a', class: 'P', match: { testid_family: 'courses-open' } }), /must end in "-\*"/);
  assert.throws(bad({ id: 'a', class: 'P', match: { role: 'button' } }), /role and name_regex go together/);
  assert.throws(bad({ id: 'a', class: 'P', match: { role: 'button', name_regex: '(' } }), /invalid regular expression/);
  assert.throws(() => cfg.parsePiiConfig({ data_regions: [], label_texts: [''] }), /label_texts/);
});

// ─── schema validator + evidence:check ───────────────────────────────────────

const classified = (klass: string, extra: Record<string, unknown> = {}) => ({ class: klass, rule: 'r', length: 4, sha256: 'ab'.repeat(32), ...extra });

function phase(framePath: string | null) {
  return {
    url: { pattern: '/courses', path_sha256: 'cd'.repeat(32), query: [], record_screen: false },
    visual: {},
    frame: framePath
      ? { path: framePath, kind: 'pre', mode: 'viewport', image: { width: 780, height: 1687 }, viewport: { width: 390, height: 844 }, dpr: 2,
          scroll: { x: 0, y: 0, containers: [] }, origin: null, png_sha256: 'ef'.repeat(32), stable: true, stability_reason: 'settled', masked: [] }
      : null,
    census: [{ ...classified('L', { text: 'Continue' }), source: 'text', box: { x: 1, y: 2, w: 3, h: 4 }, region_id: null, testid_family: null }],
    census_truncated: false,
    inventory: [],
  };
}

function validDoc() {
  return {
    schema: 2, run_id: 'r', device: 'Mobile', module: 'zz', flow: 'fx', step_id: '030-continue', phase: 'steps', action: 'click',
    input: null,
    target: {
      ref: 'zz/fx/030-continue#target', selector: '[data-testid="signin-continue"]', selector_kind: 'testid', match_count: 1, list_instance: false,
      testid: 'signin-continue', testid_family: 'signin-continue', role: 'button', tag: 'button', input_type: null,
      name: classified('L', { text: 'Continue' }), name_source: 'text', visible_text: classified('L', { text: 'Continue' }),
      box: { x: 20, y: 700, w: 350, h: 50 }, in_viewport: 'full', occluded_by: null, occlusion: { points: 5, clear: 5 }, enabled: true,
      region_id: null, sensitive: null,
    },
    target_reason: null as string | null,
    before: phase('zz/fx/030-continue.pre.png'),
    after: { ...phase(null), dom_hash: 'sha256:' + '0'.repeat(64) },
    signals: ['route'], assertions: [], status: 'ok', error: null as string | null, evidence_errors: [] as string[], captured_at: '2026-09-14T00:00:00Z',
  };
}

test('validateStepEvidence accepts a well-formed document', () => {
  assert.deepEqual(types.validateStepEvidence(validDoc()), []);
});

test('validateStepEvidence rejects raw text on non-L entries and malformed parts', () => {
  const d1 = validDoc();
  (d1.target.name as Record<string, unknown>) = classified('P', { text: 'Synthetic Person' });
  assert.ok(types.validateStepEvidence(d1).some((e) => /target\.name\.text: raw text is only permitted on class L/.test(e)));

  const d2 = validDoc();
  (d2.before.census[0] as Record<string, unknown>) = { ...classified('U', { text: 'leak' }), source: 'text', box: { x: 0, y: 0, w: 1, h: 1 } };
  assert.ok(types.validateStepEvidence(d2).some((e) => /before\.census\[0\]\.text/.test(e)));

  const d3 = validDoc();
  (d3.before.census[0] as Record<string, unknown>).class = 'Z';
  assert.ok(types.validateStepEvidence(d3).some((e) => /class: must be one of/.test(e)));

  const d4 = validDoc();
  (d4 as Record<string, unknown>).target = null;
  assert.ok(types.validateStepEvidence(d4).some((e) => /target_reason: required/.test(e)));

  const d5 = validDoc();
  (d5.before.frame as Record<string, unknown>).dpr = 0;
  assert.ok(types.validateStepEvidence(d5).some((e) => /dpr: positive number required/.test(e)));
});

function writeRun(mutate?: (doc: ReturnType<typeof validDoc>, dir: string) => void, flowStatus = 'unchanged'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-check-'));
  const doc = validDoc();
  fs.mkdirSync(path.join(dir, 'zz', 'fx'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'zz', 'fx', '030-continue.pre.png'), png(780, 1687));
  mutate?.(doc, dir);
  fs.writeFileSync(path.join(dir, 'zz', 'fx', '030-continue.evidence.json'), JSON.stringify(doc, null, 2));
  fs.mkdirSync(path.join(dir, 'runs'));
  fs.writeFileSync(path.join(dir, 'runs', 'zz-fx.flow-run.json'), JSON.stringify({ module: 'zz', flow: 'fx', status: flowStatus, errors: flowStatus === 'failed' ? ['x'] : [] }));
  return dir;
}
const runCheck = (dir: string, requireFlows: string[] = ['zz/fx']) =>
  check.checkEvidenceRun({ runDir: dir, expectedDpr: 2, requireFlows, identifiers: RULES.identifiers, secrets: RULES.secrets, phonePattern: INDIA_PHONE });
const errorChecks = (r: ReturnType<typeof runCheck>) => r.findings.filter((f) => f.severity === 'error').map((f) => f.check);

test('evidence:check passes a clean run, and digests containing PIN digits are not false positives', () => {
  const dir = writeRun((doc) => { doc.after.dom_hash = 'sha256:' + 'a4826b'.repeat(10) + 'abcd'; });
  const r = runCheck(dir);
  assert.deepEqual(errorChecks(r), []);
  assert.equal(r.passed, true);
  assert.equal(r.steps, 1);
});

test('evidence:check fails on an email, a phone number, the identifier or the PIN anywhere in a file', () => {
  assert.ok(errorChecks(runCheck(writeRun((d) => { d.error = 'saw someone.synthetic@example.com'; }))).includes('privacy-email'));
  assert.ok(errorChecks(runCheck(writeRun((d) => { d.error = 'call 81234 56789'; }))).includes('privacy-phone'));
  assert.ok(errorChecks(runCheck(writeRun((d) => { d.error = 'typed 90000 48261'; }))).includes('privacy-identifier'));
  assert.ok(errorChecks(runCheck(writeRun((d) => { d.error = 'pin 4826 entered'; }))).includes('privacy-secret'));
  const txt = writeRun((_d, dir) => fs.writeFileSync(path.join(dir, 'label-review.txt'), 'someone.synthetic@example.com'));
  assert.ok(errorChecks(runCheck(txt)).includes('privacy-email'));
});

test('on a dummy flow, email/phone shapes are warnings — credentials stay errors', () => {
  const dummyCheck = (dir: string) =>
    check.checkEvidenceRun({ runDir: dir, expectedDpr: 2, requireFlows: ['zz/fx'], identifiers: RULES.identifiers, secrets: RULES.secrets, dummyFlows: ['zz/fx'], phonePattern: INDIA_PHONE });
  const email = dummyCheck(writeRun((d) => { d.error = 'saw someone.synthetic@example.com'; }));
  assert.equal(errorChecks(email).includes('privacy-email'), false);
  assert.ok(email.findings.some((f) => f.check === 'privacy-email' && f.severity === 'warn'), 'still reported');
  assert.equal(email.passed, true);
  assert.equal(errorChecks(dummyCheck(writeRun((d) => { d.error = 'call 81234 56789'; }))).includes('privacy-phone'), false);
  assert.ok(errorChecks(dummyCheck(writeRun((d) => { d.error = 'pin 4826 entered'; }))).includes('privacy-secret'));
  assert.ok(errorChecks(dummyCheck(writeRun((d) => { d.error = 'typed 90000 48261'; }))).includes('privacy-identifier'));
});

test('evidence:check fails on schema violations, missing or mismatched frames, and coverage gaps', () => {
  assert.ok(errorChecks(runCheck(writeRun((d) => { (d.target.name as Record<string, unknown>) = classified('P', { text: 'leak' }); }))).includes('schema'));
  assert.ok(errorChecks(runCheck(writeRun((_d, dir) => fs.rmSync(path.join(dir, 'zz', 'fx', '030-continue.pre.png'))))).includes('frame-missing'));
  assert.ok(errorChecks(runCheck(writeRun((d) => { d.before.frame!.image.height = 1688; }))).includes('frame-size'));
  assert.ok(errorChecks(runCheck(writeRun((d) => { d.before.frame!.dpr = 3; }))).includes('frame-dpr'));
  assert.ok(errorChecks(runCheck(writeRun((d) => { d.before.frame = null; }))).includes('coverage-frame'));
  assert.ok(errorChecks(runCheck(writeRun((d) => { (d as Record<string, unknown>).target = null; d.target_reason = 'gone'; }))).includes('coverage-target'));
});

test('evidence:check fails when a required flow failed or never ran', () => {
  assert.ok(errorChecks(runCheck(writeRun(undefined, 'failed'))).includes('required-flow'));
  assert.ok(errorChecks(runCheck(writeRun(), ['zz/fx', 'zz/missing'])).includes('required-flow'));
  assert.equal(check.checkEvidenceRun({ runDir: path.join(os.tmpdir(), 'no-such-evidence-run'), expectedDpr: 2 }).passed, false);
});

// ─── runner flag ─────────────────────────────────────────────────────────────

test('runner parses --evidence alongside flow selection, and it is off by default', () => {
  assert.equal(runner.parseArgs([]).evidence, false);
  const a = runner.parseArgs(['--evidence', '--flow', 'signin/sign-in-journey', '--flow', 'attendance/course-detail']);
  assert.equal(a.evidence, true);
  assert.deepEqual(a.flows, ['signin/sign-in-journey', 'attendance/course-detail']);
});
