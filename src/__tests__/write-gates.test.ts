/**
 * Dummy-account write gates — every interlock gets a test.
 *
 *   validation   real logins never write; a dummy write flow must declare
 *                writes: true, tag what it creates, tear it down, and type
 *                synthetic contact data only
 *   run time     WRITE_MODE, write-allowed host, configured fingerprint
 *   identity     the tenant read off the page must match EXACTLY
 *   executor     a write step without clearance is refused; teardown acts
 *                only while the run tag is on screen
 *   messaging    a write flow that sends messages is skipped unless muted
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import type { Browser } from '@playwright/test';
import { useSampleApp } from './helpers/sample-app';
import { FIXTURE_ORIGIN, serveFixture } from './fixtures/evidence-app';

useSampleApp({});
process.env.STEP_TIMEOUT_MS = '4000';

/* eslint-disable @typescript-eslint/no-var-requires */
const { chromium } = require('@playwright/test') as typeof import('@playwright/test');
const gates = require('../write-gates') as typeof import('../write-gates');
const { validateFlow, resolveCapture } = require('../flow-loader') as typeof import('../flow-loader');
const { executeFlow } = require('../flow-executor') as typeof import('../flow-executor');
const { profile, paths } = require('../env') as typeof import('../env');
const { loadDevicesConfig } = require('../devices') as typeof import('../devices');
/* eslint-enable @typescript-eslint/no-var-requires */

import type { Flow, FlowStep, RoutesMap } from '../types';

const routesMap: RoutesMap = { orders: { flows: [], source_paths: ['x'] } };

function writeFlow(over: Partial<Flow> = {}, steps?: FlowStep[]): Flow {
  return {
    schema_version: 2,
    module: 'orders',
    flow: 'create-order',
    title: 'Create an order',
    auth: 'dummy',
    writes: true,
    steps: steps ?? [
      { id: '010-open', action: 'goto', value: '/orders/new' },
      { id: '020-name', action: 'type', selector: '[data-testid="order-name"]', value: 'Order {{RUN_TAG}}', run_tag: true },
      { id: '030-email', action: 'type', selector: '[data-testid="order-email"]', value: 'buyer@example.com', run_tag: false },
      { id: '040-phone', action: 'type', selector: '[data-testid="order-phone"]', value: '+1 555 0100', run_tag: false },
      { id: '050-save', action: 'click', selector: '[data-testid="order-save"]', creates_data: true },
    ],
    teardown: [
      { id: '900-delete', action: 'click', selector: '[data-testid="order-delete"]' },
    ],
    ...over,
  };
}
const errs = (f: Flow) => validateFlow(f, 'orders.create-order.yaml', routesMap);

// ─── validation ──────────────────────────────────────────────────────────────

test('a complete dummy write flow validates', () => {
  assert.deepEqual(errs(writeFlow()), []);
});

test('a real login may never write — the flow is refused whatever else it declares', () => {
  for (const auth of ['admin', 'staff', undefined]) {
    const e = errs(writeFlow({ auth }));
    assert.ok(e.some((m) => /Real logins are permanently READ-ONLY/.test(m)), `auth ${auth}`);
  }
});

test('a write step without "writes: true" is refused', () => {
  assert.ok(errs(writeFlow({ writes: undefined })).some((m) => /does not declare "writes: true"/.test(m)));
});

test('a write flow must tear down, and must tag what it creates with {{RUN_TAG}}', () => {
  assert.ok(errs(writeFlow({ teardown: [] })).some((m) => /no "teardown"/.test(m)));
  const untagged = writeFlow();
  untagged.steps[1] = { ...untagged.steps[1], value: 'Order 42' };
  assert.ok(errs(untagged).some((m) => /must contain \{\{RUN_TAG\}\}/.test(m)));
});

test('write flows type synthetic contact data only', () => {
  const real = writeFlow();
  real.steps[2] = { ...real.steps[2], value: 'someone@gmail.com' };
  real.steps[3] = { ...real.steps[3], value: '+1 415 867 5309' };
  const e = errs(real);
  assert.ok(e.some((m) => /someone@gmail.com" is not on a reserved domain/.test(m)));
  assert.ok(e.some((m) => /is not an obviously fake number/.test(m)));
});

test('synthetic data rules', () => {
  assert.deepEqual(gates.syntheticDataProblems('a@example.com b@x.example.org c@test.test d@shop.example'), []);
  assert.equal(gates.syntheticDataProblems('real@company.com').length, 1);
  assert.equal(gates.isSyntheticPhone('+1 (555) 010-0199'), true);
  assert.equal(gates.isSyntheticPhone('9999999999'), true);
  assert.equal(gates.isSyntheticPhone('+44 20 7946 0000'), false);
  assert.equal(gates.isSyntheticPhone('+44 20 7946 0000', ['442079460000']), true);
  assert.deepEqual(gates.syntheticDataProblems('{{DUMMY_MOBILE}} {{RUN_TAG}}'), [], 'placeholders are not literals');
});

// ─── run-time gates ──────────────────────────────────────────────────────────

const ctx = (over: Partial<import('../write-gates').WriteGateContext> = {}) => ({
  writeMode: 'dummy' as const,
  host: 'fixture.test',
  writeAllowedHosts: ['fixture.test'],
  profile: {
    id: 'sample-app',
    dataIsolation: profile.dataIsolation,
    outboundKillSwitch: profile.outboundKillSwitch,
    dummyAccount: { ...profile.dummyAccount!, fingerprint: { ...profile.dummyAccount!.fingerprint } },
  },
  ...over,
});

test('all static gates hold → no problems', () => {
  assert.deepEqual(gates.staticWriteGateProblems(writeFlow(), ctx()), []);
});

test('each static gate on its own blocks the write', () => {
  assert.match(gates.staticWriteGateProblems(writeFlow(), ctx({ writeMode: 'off' })).join(), /WRITE_MODE is not "dummy"/);
  assert.match(gates.staticWriteGateProblems(writeFlow({ writes: false }), ctx()).join(), /does not declare "writes: true"/);
  assert.match(gates.staticWriteGateProblems(writeFlow({ auth: 'admin' }), ctx()).join(), /only "auth: dummy" may write/);
  assert.match(gates.staticWriteGateProblems(writeFlow(), ctx({ host: 'prod.example.com' })).join(), /not in writeAllowedHosts/);
  const noFp = ctx();
  noFp.profile.dummyAccount!.fingerprint.tenantName = '';
  assert.match(gates.staticWriteGateProblems(writeFlow(), noFp).join(), /needs both tenantId and tenantName/);
});

test('the tenant must match exactly — id and name', () => {
  const want = { tenantId: 'sample-tenant-0001', tenantName: 'Sample Org (test)' };
  assert.deepEqual(gates.compareTenant(want, { tenantId: 'sample-tenant-0001', tenantName: '  Sample Org  (test) ' }), []);
  assert.match(gates.compareTenant(want, { tenantId: 'sample-tenant-0002', tenantName: 'Sample Org (test)' }).join(), /tenant id "sample-tenant-0002" is not the dummy tenant/);
  assert.match(gates.compareTenant(want, { tenantId: 'sample-tenant-0001', tenantName: 'Sample Org' }).join(), /tenant name "Sample Org" is not/);
  assert.match(gates.compareTenant(want, { tenantId: null, tenantName: 'Sample Org (test)' }).join(), /could not read the tenant id/);
  assert.match(gates.compareTenant({ tenantId: '', tenantName: 'x' }, { tenantId: '', tenantName: 'x' }).join(), /incomplete/);
});

test('a write flow that messages people is skipped unless the dummy tenant is muted', () => {
  const sends = writeFlow({ sends_messages: ['email', 'whatsapp'] });
  assert.match(gates.messagingBlock(sends, { dummyAccount: { ...profile.dummyAccount!, messagingSuppressed: false } })!, /sends email\/whatsapp/);
  assert.equal(gates.messagingBlock(sends, { dummyAccount: { ...profile.dummyAccount!, messagingSuppressed: true } }), null);
  assert.equal(gates.messagingBlock(writeFlow(), { dummyAccount: profile.dummyAccount }), null);
});

// ─── browser: identity probe and executor refusals ───────────────────────────

let browser: Browser;
const DEVICE = loadDevicesConfig().devices.find((d) => d.id === 'Mobile')!;
const RUN_ID = '1999-02-02T00-00-00Z';
const runDir = path.join(paths.runs, RUN_ID);

before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => {
  await browser?.close();
  fs.rmSync(runDir, { recursive: true, force: true });
});

async function page(html: string) {
  const context = await browser.newContext();
  const p = await context.newPage();
  await p.setContent(html);
  return { p, close: () => context.close() };
}

test('verifyDummyIdentity reads the tenant off the page and compares it', async () => {
  const ok = await page('<header data-testid="shell-org" data-tenant-id="sample-tenant-0001">Sample Org (test)</header>');
  try {
    assert.deepEqual(await gates.verifyDummyIdentity(ok.p, profile), { ok: true, problems: [] });
  } finally { await ok.close(); }

  const real = await page('<header data-testid="shell-org" data-tenant-id="real-tenant-7">Real Org</header>');
  try {
    const r = await gates.verifyDummyIdentity(real.p, profile);
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 2);
    assert.throws(() => { throw new gates.DummyIdentityError(r.problems); }, /DUMMY IDENTITY CHECK FAILED — aborting before any flow acts/);
  } finally { await real.close(); }
});

function captured(steps: FlowStep[]): FlowStep[] {
  for (const s of steps) {
    const spec = resolveCapture(s, s._phase ?? 'steps');
    if (typeof spec === 'string') throw new Error(spec);
    s._capture = spec;
  }
  return steps;
}

async function execute(flow: Flow, writeAllowed: boolean) {
  const context = await browser.newContext({ baseURL: FIXTURE_ORIGIN });
  context.setDefaultTimeout(4000);
  await serveFixture(context);
  try {
    return await executeFlow(context, flow, {
      runId: RUN_ID, runDir, runTag: `SCRSHOT_${RUN_ID}_`, writeAllowed, device: DEVICE,
      appGitSha: null, baseline: {}, reason: 'test',
    });
  } finally {
    await context.close();
  }
}

test('the executor refuses a write step that did not pass the write gates', async () => {
  const flow = writeFlow({}, captured([
    { id: '010-open', action: 'goto', value: '/' },
    { id: '020-name', action: 'type', selector: '[data-testid="signin-phone"]', value: 'x {{RUN_TAG}}', run_tag: true },
  ]));
  flow.teardown = [];
  const run = await execute(flow, false);
  assert.equal(run.status, 'failed');
  assert.match(run.errors.join(), /refused: this step writes data/);
  assert.equal(run.write_mode, undefined);
});

test('teardown acts only while the run tag is on screen', async () => {
  const flow = writeFlow({}, captured([{ id: '010-open', action: 'goto', value: '/' }]));
  flow.teardown = captured([{ id: '900-delete', action: 'click', selector: '[data-testid="signin-continue"]', _phase: 'teardown' }]);
  const run = await execute(flow, true);
  assert.equal(run.write_mode, 'dummy');
  const td = run.steps.find((s) => s.id === '900-delete')!;
  assert.equal(td.status, 'skipped');
  assert.match(td.error ?? '', /teardown refused: the run tag .* is not on screen/);
});


// ─── isolation and kill-switch gates ─────────────────────────────────────────

test('dataIsolation "none" refuses every write, however well the other gates hold', () => {
  const problems = gates.staticWriteGateProblems(writeFlow(), ctx({
    profile: { ...ctx().profile, dataIsolation: 'none' },
  }));
  assert.match(problems.join(), /dataIsolation "none"/);
  // A login is not isolation: this is exactly the single-tenant case.
  assert.equal(gates.staticWriteGateProblems(writeFlow(), ctx({
    profile: { ...ctx().profile, dataIsolation: 'separate-tenant' },
  })).length, 0);
});

test('a missing outboundKillSwitch attestation refuses every write', () => {
  const problems = gates.staticWriteGateProblems(writeFlow(), ctx({
    profile: { ...ctx().profile, outboundKillSwitch: null },
  }));
  assert.match(problems.join(), /no outboundKillSwitch attestation/);
});

test('both new gates are independent of the original four', () => {
  // Everything else perfect, each new gate alone still blocks.
  for (const over of [
    { dataIsolation: 'none' as const, outboundKillSwitch: profile.outboundKillSwitch },
    { dataIsolation: profile.dataIsolation, outboundKillSwitch: null },
  ]) {
    const problems = gates.staticWriteGateProblems(writeFlow(), ctx({ profile: { ...ctx().profile, ...over } }));
    assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  }
});

test('a step that confirms a send is blocked without an attestation — dummy mode included', () => {
  const sendStep = { id: '040-confirm-send', action: 'click' as const, selector: '[data-testid="send-confirm"]', sends: true };
  const noAttestation = { id: 'sample-app', outboundKillSwitch: null };
  const attested = { id: 'sample-app', outboundKillSwitch: profile.outboundKillSwitch };

  assert.match(String(gates.sendStepBlock(sendStep, noAttestation)), /confirms an outbound message/);
  assert.equal(gates.sendStepBlock(sendStep, attested), null);
  // A step that does not confirm a send is never blocked by this gate.
  assert.equal(gates.sendStepBlock({ id: '010-open', action: 'click' as const }, noAttestation), null);
});

test('sendSteps finds send confirmations in every phase of a flow', () => {
  const flow = {
    module: 'm', flow: 'f', steps: [{ id: '010', action: 'click' as const }, { id: '020', action: 'click' as const, sends: true }],
    setup: [{ id: '005', action: 'goto' as const, sends: true }],
    teardown: [{ id: '090', action: 'click' as const }],
  } as unknown as import('../types').Flow;
  assert.deepEqual(gates.sendSteps(flow).map((s) => s.id), ['005', '020']);
});

test('synthetic contact data is hygiene, not a safety control', () => {
  // A reserved-domain address is still an address the app will try to send to;
  // only the provider kill switch stops delivery. Both gates exist, separately.
  const flow = writeFlow();
  assert.deepEqual(gates.syntheticDataProblems('someone@example.com'), [], 'reserved domain passes hygiene');
  const problems = gates.staticWriteGateProblems(flow, ctx({ profile: { ...ctx().profile, outboundKillSwitch: null } }));
  assert.match(problems.join(), /outboundKillSwitch/, 'hygiene passing does not satisfy the kill-switch gate');
});
