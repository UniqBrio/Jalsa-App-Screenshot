/**
 * Schema v2: normalisation, the selector policy, and the rules that only apply
 * once a manifest opts in with `schema_version: 2`.
 *
 * The backward-compatibility cases matter as much as the new ones — the nine
 * shipped v1 manifests must keep loading untouched, so each v1 shape gets its
 * own test rather than being covered incidentally.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateFlow,
  flowWarnings,
  resolveCapture,
  selectorPolicyViolation,
  allSteps,
  rawTextGate,
  isDraftFile,
} from '../flow-loader';
import type { Flow, FlowStep, RoutesMap } from '../types';

const routesMap: RoutesMap = {
  enquiry: { flows: ['create-enquiry'], source_paths: ['app/enquiry/**'] },
};

function flowWith(steps: FlowStep[], overrides: Partial<Flow> = {}): Flow {
  return { module: 'enquiry', flow: 'create-enquiry', steps, ...overrides };
}
function v2(steps: FlowStep[], overrides: Partial<Flow> = {}): Flow {
  return flowWith(steps, { schema_version: 2, title: 'Create an enquiry', ...overrides });
}
const errorsFor = (flow: Flow) => validateFlow(flow, 'f.yaml', routesMap);

// ─── v1 capture normalisation ────────────────────────────────────────────────

test('v1 screenshot: true normalises to viewport', () => {
  const step: FlowStep = { id: '01-a', action: 'snapshot', screenshot: true };
  assert.deepEqual(resolveCapture(step, 'steps'), { mode: 'viewport' });
});

test('v1 screenshot: true + full_page normalises to full', () => {
  const step: FlowStep = { id: '01-a', action: 'snapshot', screenshot: true, full_page: true };
  assert.deepEqual(resolveCapture(step, 'steps'), { mode: 'full' });
});

test('v1 screenshot: false and an absent screenshot both mean no capture', () => {
  assert.deepEqual(resolveCapture({ id: '01-a', action: 'snapshot', screenshot: false }, 'steps'), {
    mode: 'none',
  });
  assert.deepEqual(resolveCapture({ id: '01-a', action: 'snapshot' }, 'steps'), { mode: 'none' });
});

// ─── v2 capture modes ────────────────────────────────────────────────────────

test('v2 capture modes resolve', () => {
  assert.deepEqual(resolveCapture({ id: '01-a', action: 'snapshot', screenshot: 'viewport' }, 'steps'), { mode: 'viewport' });
  assert.deepEqual(resolveCapture({ id: '01-a', action: 'snapshot', screenshot: 'full' }, 'steps'), { mode: 'full' });
  assert.deepEqual(resolveCapture({ id: '01-a', action: 'snapshot', screenshot: 'auto' }, 'steps'), { mode: 'auto' });
  assert.deepEqual(
    resolveCapture({ id: '01-a', action: 'snapshot', screenshot: 'element:[data-testid="x"]' }, 'steps'),
    { mode: 'element', selector: '[data-testid="x"]' },
  );
});

test('an unknown screenshot mode is rejected with the valid list', () => {
  const errors = errorsFor(v2([{ id: '010-a', action: 'snapshot', screenshot: 'giant' }]));
  assert.ok(errors.some((e) => e.includes('unknown screenshot mode "giant"')));
});

test('element: with nothing after the colon is rejected', () => {
  const errors = errorsFor(v2([{ id: '010-a', action: 'snapshot', screenshot: 'element:' }]));
  assert.ok(errors.some((e) => e.includes('needs a selector after the colon')));
});

// ─── Selector policy ─────────────────────────────────────────────────────────

test('data-testid and role selectors pass the policy', () => {
  assert.equal(selectorPolicyViolation('[data-testid="btn-save"]'), null);
  assert.equal(selectorPolicyViolation("[data-testid='btn-save']"), null);
  assert.equal(selectorPolicyViolation('[data-testid^="row-"]'), null);
  assert.equal(selectorPolicyViolation('role=button[name="Save"]'), null);
});

test('a role selector whose name contains spaces is one term, not two', () => {
  assert.equal(selectorPolicyViolation('role=button[name="Save Draft Now"]'), null);
});

test('a descendant chain passes when every term is on policy', () => {
  assert.equal(
    selectorPolicyViolation('[data-testid="student-row-1"] [data-testid="btn-edit"]'),
    null,
  );
});

test('interpolated testid values pass the policy', () => {
  assert.equal(selectorPolicyViolation('[data-testid="course-member-{{FIXED_MEMBER_ID}}"]'), null);
});

test('class chains are rejected as class chains', () => {
  assert.match(String(selectorPolicyViolation('.card .title')), /class chain/);
  assert.match(String(selectorPolicyViolation('div.card')), /class chain/);
});

test('nth selectors are rejected as positional', () => {
  assert.match(String(selectorPolicyViolation('ul li:nth-child(3)')), /positional/);
  assert.match(String(selectorPolicyViolation('[data-testid="list"] >> nth=2')), /positional/);
});

test('text selectors are rejected and point at the role alternative', () => {
  assert.match(String(selectorPolicyViolation('text=Save')), /role=/);
  assert.match(String(selectorPolicyViolation('button:has-text("Save")')), /role=/);
});

test('id and name selectors are rejected — the allowlist is deliberate', () => {
  assert.ok(selectorPolicyViolation('#submit'));
  assert.ok(selectorPolicyViolation('input[name="mobile"]'));
});

test('an off-policy selector fails validation and names the step and selector', () => {
  const errors = errorsFor(v2([{ id: '010-a', action: 'click', selector: '.btn-primary' }]));
  const hit = errors.find((e) => e.includes('violates the selector policy'));
  assert.ok(hit, 'expected a policy error');
  assert.match(String(hit), /010-a/);
  assert.match(String(hit), /\.btn-primary/);
});

test('the policy also covers assert selectors and masks', () => {
  const errors = errorsFor(
    v2([
      {
        id: '010-a',
        action: 'snapshot',
        mask: ['.volatile-timestamp'],
        assert: { selector_visible: 'div:nth-child(2)' },
      },
    ]),
  );
  assert.ok(errors.some((e) => e.includes('mask[0]')));
  assert.ok(errors.some((e) => e.includes('assert.selector_visible')));
});

test('selector_exempt downgrades the error to a standing warning', () => {
  const flow = v2([
    { id: '010-a', action: 'click', selector: '.btn-primary', selector_exempt: 'no test id yet' },
  ]);
  assert.deepEqual(errorsFor(flow), []);
  const warnings = flowWarnings(flow, 'f.yaml');
  assert.ok(warnings.some((w) => w.includes('EXEMPT') && w.includes('no test id yet')));
});

// ─── Variable references ─────────────────────────────────────────────────────

test('env vars, flow vars and RUN_TAG are all accepted', () => {
  const errors = errorsFor(
    v2(
      [
        { id: '010-a', action: 'type', selector: '[data-testid="n"]', value: '{{RUN_TAG}}x', run_tag: false },
        { id: '020-b', action: 'click', selector: '[data-testid="row-{{FIXED_MEMBER_ID}}"]' },
        { id: '030-c', action: 'click', selector: '[data-testid="row-{{ROW_INDEX}}"]' },
      ],
      {
        vars: { ROW_INDEX: '0' },
      },
    ),
  );
  assert.deepEqual(errors, []);
});

test('an unknown variable is rejected as a cross-flow dependency', () => {
  const errors = errorsFor(
    v2([{ id: '010-a', action: 'click', selector: '[data-testid="row-{{LEFTOVER_ID}}"]' }]),
  );
  const hit = errors.find((e) => e.includes('LEFTOVER_ID'));
  assert.ok(hit);
  assert.match(String(hit), /independently runnable/);
});

// ─── v2-only rules ───────────────────────────────────────────────────────────

test('schema_version 2 requires a title', () => {
  const flow = flowWith([{ id: '010-a', action: 'snapshot' }], { schema_version: 2 });
  assert.ok(errorsFor(flow).some((e) => e.includes('requires a "title"')));
});

test('sleep needs a reason in v2 but not in v1', () => {
  const withoutReason: FlowStep = { id: '010-a', action: 'sleep', value: 500 };
  assert.ok(errorsFor(v2([withoutReason])).some((e) => e.includes('sleep requires a "reason"')));
  assert.deepEqual(
    errorsFor(flowWith([{ id: '01-a', action: 'sleep', value: 500 }])).filter((e) => e.includes('reason')),
    [],
  );
});

test('sleep always warns, reason or not', () => {
  const flow = v2([{ id: '010-a', action: 'sleep', value: 500, reason: 'third-party widget' }]);
  assert.deepEqual(errorsFor(flow), []);
  assert.ok(flowWarnings(flow, 'f.yaml').some((w) => w.includes('uses sleep')));
});

test('an unsupported schema_version is rejected', () => {
  assert.ok(
    errorsFor(flowWith([{ id: '01-a', action: 'snapshot' }], { schema_version: 3 })).some((e) =>
      e.includes('schema_version 3 is not supported'),
    ),
  );
});

// ─── Step ids ────────────────────────────────────────────────────────────────

test('three-digit step ids are accepted so states can be inserted later', () => {
  assert.deepEqual(errorsFor(v2([{ id: '010-open-form', action: 'snapshot' }])), []);
});

test('ids must be unique across setup, steps and teardown', () => {
  const flow = v2([{ id: '010-a', action: 'snapshot' }], {
    setup: [{ id: '010-a', action: 'goto', value: '/enquiry' }],
  });
  assert.ok(errorsFor(flow).some((e) => e.includes('duplicate step id')));
});

// ─── New action requirements ─────────────────────────────────────────────────

test('scrollTo needs either a selector or a position', () => {
  assert.ok(errorsFor(v2([{ id: '010-a', action: 'scrollTo' }])).some((e) => e.includes('position: top | bottom')));
  assert.deepEqual(errorsFor(v2([{ id: '010-a', action: 'scrollTo', position: 'bottom' }])), []);
});

test('setViewport needs a valid preset', () => {
  assert.ok(errorsFor(v2([{ id: '010-a', action: 'setViewport' }])).some((e) => e.includes('requires "preset')));
  assert.ok(
    errorsFor(v2([{ id: '010-a', action: 'setViewport', preset: 'watch' as never }])).some((e) =>
      e.includes('is not one of mobile | tablet | desktop'),
    ),
  );
});

test('waitFor rejects an unknown state', () => {
  const errors = errorsFor(
    v2([{ id: '010-a', action: 'waitFor', selector: '[data-testid="x"]', state: 'gone' as never }]),
  );
  assert.ok(errors.some((e) => e.includes('visible | hidden | attached')));
});

// ─── swipe (v2) ──────────────────────────────────────────────────────────────

test('a well-formed swipe validates clean', () => {
  const errors = errorsFor(
    v2([{ id: '010-a', action: 'swipe', selector: '[data-testid="row"]', direction: 'right', distance: 180, duration: 250 }]),
  );
  assert.deepEqual(errors, []);
});

test('swipe without a direction is rejected', () => {
  const errors = errorsFor(v2([{ id: '010-a', action: 'swipe', selector: '[data-testid="row"]' }]));
  assert.ok(errors.some((e) => e.includes('swipe requires "direction')));
});

test('swipe rejects an unknown direction', () => {
  const errors = errorsFor(
    v2([{ id: '010-a', action: 'swipe', selector: '[data-testid="row"]', direction: 'sideways' as never }]),
  );
  assert.ok(errors.some((e) => e.includes('is not one of left | right | up | down')));
});

test('swipe requires a selector like any other targeted action', () => {
  const errors = errorsFor(v2([{ id: '010-a', action: 'swipe', direction: 'left' }]));
  assert.ok(errors.some((e) => e.includes('requires a "selector"')));
});

test('swipe rejects a non-positive distance or duration', () => {
  assert.ok(
    errorsFor(v2([{ id: '010-a', action: 'swipe', selector: '[data-testid="r"]', direction: 'left', distance: 0 }]))
      .some((e) => e.includes('distance" must be a positive number')),
  );
  assert.ok(
    errorsFor(v2([{ id: '010-a', action: 'swipe', selector: '[data-testid="r"]', direction: 'left', duration: -5 }]))
      .some((e) => e.includes('duration" must be a positive number')),
  );
});

test('scrollUntilVisible rejects a non-positive max_scrolls', () => {
  const errors = errorsFor(
    v2([{ id: '010-a', action: 'scrollUntilVisible', selector: '[data-testid="x"]', max_scrolls: 0 }]),
  );
  assert.ok(errors.some((e) => e.includes('max_scrolls must be a positive number')));
});

test('type and scrollUntilVisible both require a selector', () => {
  assert.ok(errorsFor(v2([{ id: '010-a', action: 'type', value: 'x' }])).some((e) => e.includes('requires a "selector"')));
  assert.ok(
    errorsFor(v2([{ id: '010-a', action: 'scrollUntilVisible' }])).some((e) => e.includes('requires a "selector"')),
  );
});

// ─── expect ──────────────────────────────────────────────────────────────────

test('expect accepts the four bare states', () => {
  for (const state of ['visible', 'hidden', 'enabled', 'disabled'] as const) {
    assert.deepEqual(
      errorsFor(v2([{ id: '010-a', action: 'expect', selector: '[data-testid="x"]', expect: state }])),
      [],
      `expect: ${state} should be valid`,
    );
  }
});

test('expect accepts text and count conditions', () => {
  assert.deepEqual(
    errorsFor(v2([{ id: '010-a', action: 'expect', selector: '[data-testid="x"]', expect: { text: 'Saved' } }])),
    [],
  );
  assert.deepEqual(
    errorsFor(v2([{ id: '010-a', action: 'expect', selector: '[data-testid="x"]', expect: { count: { min: 1 } } }])),
    [],
  );
});

test('expect rejects an unknown condition and an empty count', () => {
  assert.ok(
    errorsFor(
      v2([{ id: '010-a', action: 'expect', selector: '[data-testid="x"]', expect: 'sparkly' as never }]),
    ).some((e) => e.includes('is not one of visible')),
  );
  assert.ok(
    errorsFor(
      v2([{ id: '010-a', action: 'expect', selector: '[data-testid="x"]', expect: { count: {} } }]),
    ).some((e) => e.includes('needs at least one of min or max')),
  );
});

test('expect without a condition is rejected', () => {
  const errors = errorsFor(v2([{ id: '010-a', action: 'expect', selector: '[data-testid="x"]' }]));
  assert.ok(errors.some((e) => e.includes('requires an "expect" condition')));
});

// ─── setup / teardown ────────────────────────────────────────────────────────

test('setup and teardown steps are validated with the same rules as steps', () => {
  const flow = v2([{ id: '010-a', action: 'snapshot' }], {
    setup: [{ id: '005-bad', action: 'click', selector: '.nope' }],
    teardown: [{ id: '900-bad', action: 'goto', value: 'no-leading-slash' }],
  });
  const errors = errorsFor(flow);
  assert.ok(errors.some((e) => e.includes('setup[005-bad]')));
  assert.ok(errors.some((e) => e.includes('teardown[900-bad]')));
});

test('setup and teardown default to no capture, but an explicit mode is honoured', () => {
  assert.deepEqual(resolveCapture({ id: '005-a', action: 'goto', value: '/x' }, 'setup'), { mode: 'none' });
  assert.deepEqual(resolveCapture({ id: '005-a', action: 'goto', value: '/x', screenshot: 'viewport' }, 'setup'), {
    mode: 'viewport',
  });
});

test('allSteps returns setup, steps and teardown in execution order', () => {
  const flow = v2([{ id: '010-b', action: 'snapshot' }], {
    setup: [{ id: '005-a', action: 'snapshot' }],
    teardown: [{ id: '900-c', action: 'snapshot' }],
  });
  assert.deepEqual(allSteps(flow).map((s) => s.id), ['005-a', '010-b', '900-c']);
});

test('a non-list setup block is rejected rather than crashing the loader', () => {
  const flow = v2([{ id: '010-a', action: 'snapshot' }], { setup: 'nope' as never });
  assert.ok(errorsFor(flow).some((e) => e.includes('"setup" must be a list of steps')));
});

// ─── Flow metadata ───────────────────────────────────────────────────────────

test('an unknown scenario_class is rejected with the valid list', () => {
  const errors = errorsFor(v2([{ id: '010-a', action: 'snapshot' }], { scenario_class: 'chaos' as never }));
  assert.ok(errors.some((e) => e.includes('happy | validation | duplicate | empty | permission | offline')));
});

test('every documented scenario_class is accepted', () => {
  for (const cls of ['happy', 'validation', 'duplicate', 'empty', 'permission', 'offline'] as const) {
    assert.deepEqual(errorsFor(v2([{ id: '010-a', action: 'snapshot' }], { scenario_class: cls })), []);
  }
});

test('tags must be a list and settle_ms a number', () => {
  assert.ok(errorsFor(v2([{ id: '010-a', action: 'snapshot' }], { tags: 'forms' as never })).some((e) => e.includes('"tags" must be a list')));
  assert.ok(
    errorsFor(v2([{ id: '010-a', action: 'snapshot' }], { settle_ms: 'slow' as never })).some((e) =>
      e.includes('"settle_ms" must be a number'),
    ),
  );
});

// ─── run_tag and the read-only rule ──────────────────────────────────────────

test('a type step without run_tag is rejected, in v1 and v2 alike', () => {
  const v2errors = errorsFor(v2([{ id: '010-a', action: 'type', selector: '[data-testid="n"]', value: 'x' }]));
  assert.ok(v2errors.some((e) => e.includes('requires run_tag')));
  const v1errors = errorsFor(flowWith([{ id: '01-a', action: 'fill', selector: '[data-testid="n"]', value: 'x' }]));
  assert.ok(v1errors.some((e) => e.includes('requires run_tag')));
});

test('run_tag: true is rejected on a real-account flow — real logins never write', () => {
  const errors = errorsFor(
    v2([{ id: '010-a', action: 'type', selector: '[data-testid="n"]', value: '{{RUN_TAG}}x', run_tag: true }]),
  );
  assert.ok(errors.some((e) => e.includes('READ-ONLY') && e.includes('010-a')));
});

test('run_tag on a non-text step is rejected', () => {
  const errors = errorsFor(
    v2([{ id: '010-a', action: 'click', selector: '[data-testid="n"]', run_tag: false }]),
  );
  assert.ok(errors.some((e) => e.includes('only applies to "type" and "fill"')));
});

test('run_tag: false is accepted', () => {
  const errors = errorsFor(
    v2([{ id: '010-a', action: 'type', selector: '[data-testid="n"]', value: 'a', run_tag: false }]),
  );
  assert.deepEqual(errors, []);
});

test('creates_data: true is a hard error, in any block', () => {
  const errors = errorsFor(
    v2([{ id: '010-a', action: 'click', selector: '[data-testid="n"]' }], {
      teardown: [{ id: '900-z', action: 'click', selector: '[data-testid="n"]', creates_data: true }],
    }),
  );
  assert.ok(errors.some((e) => e.includes('READ-ONLY') && e.includes('900-z')));
});

test('a leftover cleanup block from an older engine is rejected', () => {
  const flow = v2([{ id: '010-a', action: 'click', selector: '[data-testid="n"]' }]) as unknown as Record<string, unknown>;
  flow.cleanup = { tag_prefix: 'SCRSHOT_', tables: ['members'], delete_after_run: true };
  const errors = errorsFor(flow as never);
  assert.ok(errors.some((e) => e.includes('"cleanup" block')));
});

// ─── the raw-text gate and draft exclusion ───────────────────────────────────

test('rawTextGate flags the GENERATED header, TODO_SELECTOR and bare TODO with line numbers', () => {
  const findings = rawTextGate(
    '# GENERATED — review before use\nmodule: x\nselector: TODO_SELECTOR\nrun_tag: TODO\n',
  );
  assert.deepEqual(
    findings.map((f) => [f.line, f.token]),
    [
      [1, 'GENERATED header'],
      [3, 'TODO_SELECTOR'],
      [4, 'TODO'],
    ],
  );
});

test('rawTextGate does not double-count TODO inside TODO_SELECTOR', () => {
  const findings = rawTextGate("selector: 'TODO_SELECTOR'\n");
  assert.deepEqual(findings.map((f) => f.token), ['TODO_SELECTOR']);
});

test('a clean promoted flow passes the raw gate', () => {
  assert.deepEqual(rawTextGate('module: students\nflow: add-student\n'), []);
});

test('isDraftFile matches only the .generated suffix', () => {
  assert.equal(isDraftFile('flows/students.add-student.generated.yaml'), true);
  assert.equal(isDraftFile('flows/students.add-student.generated.yml'), true);
  assert.equal(isDraftFile('flows/students.add-student.yaml'), false);
  assert.equal(isDraftFile('flows/generated.yaml'), false);
});
