/**
 * validateFlow is the single gate between a malformed manifest and either a
 * crash mid-run or a manifest that loads but behaves unexpectedly. Covers
 * each rule independently so a future change to one rule can't silently
 * loosen another.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFlow } from '../flow-loader';
import type { Flow, RoutesMap } from '../types';

const routesMap: RoutesMap = {
  attendance: { flows: ['mark-attendance'], source_paths: ['app/attendance/**'] },
};

function baseFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    module: 'attendance',
    flow: 'mark-attendance',
    steps: [{ id: '01-open', action: 'goto', value: '/attendance', screenshot: true }],
    ...overrides,
  };
}

test('a well-formed flow produces no errors', () => {
  assert.deepEqual(validateFlow(baseFlow(), 'f.yaml', routesMap), []);
});

test('missing module and flow fields are both reported', () => {
  const errors = validateFlow(baseFlow({ module: '', flow: '' }), 'f.yaml', routesMap);
  assert.ok(errors.some((e) => e.includes('missing required field "module"')));
  assert.ok(errors.some((e) => e.includes('missing required field "flow"')));
});

test('empty steps array is rejected', () => {
  const errors = validateFlow(baseFlow({ steps: [] }), 'f.yaml', routesMap);
  assert.ok(errors.some((e) => e.includes('missing or empty "steps"')));
});

test('step id must match NN-kebab-case', () => {
  const errors = validateFlow(
    baseFlow({ steps: [{ id: 'open-attendance', action: 'snapshot' }] }),
    'f.yaml',
    routesMap,
  );
  assert.ok(errors.some((e) => e.includes('NN-kebab-case')));
});

test('duplicate step ids are rejected', () => {
  const errors = validateFlow(
    baseFlow({
      steps: [
        { id: '01-a', action: 'snapshot' },
        { id: '01-a', action: 'snapshot' },
      ],
    }),
    'f.yaml',
    routesMap,
  );
  assert.ok(errors.some((e) => e.includes('duplicate step id')));
});

test('unknown action is rejected', () => {
  const errors = validateFlow(
    baseFlow({ steps: [{ id: '01-a', action: 'teleport' as never }] }),
    'f.yaml',
    routesMap,
  );
  assert.ok(errors.some((e) => e.includes('unknown action')));
});

test('click without a selector is rejected', () => {
  const errors = validateFlow(
    baseFlow({ steps: [{ id: '01-a', action: 'click' }] }),
    'f.yaml',
    routesMap,
  );
  assert.ok(errors.some((e) => e.includes('requires a "selector"')));
});

test('goto without a value is rejected', () => {
  const errors = validateFlow(
    baseFlow({ steps: [{ id: '01-a', action: 'goto' }] }),
    'f.yaml',
    routesMap,
  );
  assert.ok(errors.some((e) => e.includes('requires a "value"')));
});

test('goto value must start with a leading slash', () => {
  const errors = validateFlow(
    baseFlow({ steps: [{ id: '01-a', action: 'goto', value: 'attendance' }] }),
    'f.yaml',
    routesMap,
  );
  assert.ok(errors.some((e) => e.includes('must be a path starting with "/"')));
});

test('a module missing from routes.map.json is rejected', () => {
  const errors = validateFlow(baseFlow({ module: 'unknown-module' }), 'f.yaml', routesMap);
  assert.ok(errors.some((e) => e.includes('not in config/routes.map.json')));
});

test('an invalid auth value is rejected', () => {
  const errors = validateFlow(baseFlow({ auth: 'owner' as never }), 'f.yaml', routesMap);
  assert.ok(errors.some((e) => e.includes('is not one of admin | staff | dummy | none')));
});

test('mask must be an array, not a bare string', () => {
  const errors = validateFlow(
    baseFlow({
      steps: [{ id: '01-a', action: 'snapshot', mask: '[data-testid="x"]' as never }],
    }),
    'f.yaml',
    routesMap,
  );
  assert.ok(errors.some((e) => e.includes('"mask" must be a list of selectors')));
});
