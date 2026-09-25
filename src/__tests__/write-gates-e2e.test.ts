/**
 * The four write interlocks, end to end: the real runner (a child process)
 * against a tiny local app that COUNTS every write request it receives.
 *
 *   control   all four gates hold      → the write happens, teardown deletes it
 *   gate 1    WRITE_MODE is not dummy   → flow skipped, zero writes
 *   gate 2    flow lacks writes/dummy   → refused by validation, zero writes
 *   gate 3    tenant fingerprint wrong  → run aborted before the first action
 *   gate 4    host not write-allowed    → run aborted before the first action
 *
 * The control case matters: it proves the harness CAN write, so a zero in the
 * other cases is the gate, not a broken fixture. Everything is synthetic and
 * local (http://127.0.0.1); nothing reaches a network.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { AddressInfo } from 'net';
import { FIXTURE_APPS_DIR } from './helpers/sample-app';

const ROOT = path.resolve(__dirname, '..', '..');
const TENANT = { id: 'sample-tenant-0001', name: 'Sample Org (test)' };

// ─── the local app ───────────────────────────────────────────────────────────

interface AppState { tenantId: string; orders: string[]; writes: number; deletes: number }
const state: AppState = { tenantId: TENANT.id, orders: [], writes: 0, deletes: 0 };

const page = (body: string, script = '') =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}<script>${script}</script></body></html>`;
const shell = (body: string) =>
  `<header data-testid="shell-org" data-tenant-id="${state.tenantId}">${TENANT.name}</header>${body}`;

let server: http.Server;
let origin = '';

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', origin);
  const html = (b: string) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); };
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST' && url.pathname === '/api/orders') {
      state.writes += 1;
      state.orders.push(JSON.parse(body).name);
      res.writeHead(201); res.end(); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/orders/delete') {
      state.deletes += 1;
      state.orders = state.orders.filter((o) => o !== JSON.parse(body).name);
      res.writeHead(204); res.end(); return;
    }
    switch (url.pathname) {
      case '/':
        return html(page(
          `<input data-testid="signin-phone"><button data-testid="signin-continue" onclick="location.href='/pin'">Continue</button>`));
      case '/pin':
        return html(page(`<input data-testid="signin-pin">`,
          `document.querySelector('input').addEventListener('input', function (e) { if (e.target.value.length === 4) location.href = '/home'; });`));
      case '/home':
        return html(page(shell('<h1>Home</h1>')));
      case '/orders/new':
        return html(page(shell(`<input data-testid="order-name"><button data-testid="order-save">Save</button>`),
          `document.querySelector('[data-testid=order-save]').onclick = function () {
             fetch('/api/orders', { method: 'POST', body: JSON.stringify({ name: document.querySelector('[data-testid=order-name]').value }) })
               .then(function () { location.href = '/orders'; });
           };`));
      case '/orders':
        return html(page(shell(state.orders.map((o) =>
          `<div><span>${o}</span><button data-testid="order-delete" data-name="${o}">Delete</button></div>`).join('')),
          `document.querySelectorAll('[data-testid=order-delete]').forEach(function (b) { b.onclick = function () {
             fetch('/api/orders/delete', { method: 'POST', body: JSON.stringify({ name: b.getAttribute('data-name') }) })
               .then(function () { location.reload(); });
           }; });`));
      default:
        res.writeHead(404); res.end();
    }
  });
}

// ─── the profile and flow ────────────────────────────────────────────────────

const WRITE_FLOW = `schema_version: 2
module: orders
flow: create-order
title: Create an order
auth: dummy
writes: true
steps:
  - id: 010-new
    action: goto
    value: /orders/new
  - id: 020-name
    action: type
    selector: '[data-testid="order-name"]'
    value: "Order {{RUN_TAG}}"
    run_tag: true
  - id: 030-save
    action: click
    selector: '[data-testid="order-save"]'
    creates_data: true
    screenshot: viewport
    settle_ms: 600
teardown:
  - id: 900-list
    action: goto
    value: /orders
  - id: 910-delete
    action: click
    selector: '[data-testid="order-delete"]'
    settle_ms: 600
`;

const made: string[] = [];

function makeApp(o: { writeAllowedHosts?: string[]; flow?: string } = {}): string {
  const apps = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-apps-'));
  made.push(apps);
  const dir = path.join(apps, 'sample-app');
  fs.cpSync(path.join(FIXTURE_APPS_DIR, 'sample-app'), dir, { recursive: true });
  const cfgFile = path.join(dir, 'app.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.baseUrl = origin;
  cfg.allowedHosts = ['127.0.0.1'];
  cfg.writeAllowedHosts = o.writeAllowedHosts ?? ['127.0.0.1'];
  cfg.loginAdapter.options.loginPath = '/';
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const routes = { orders: { flows: ['create-order'], source_paths: ['x'] } };
  fs.writeFileSync(path.join(dir, 'config', 'routes.map.json'), JSON.stringify(routes));
  fs.writeFileSync(path.join(dir, 'config', 'known_routes.json'), JSON.stringify({ last_checked: '', routes: [] }));
  fs.writeFileSync(path.join(dir, 'flows', 'orders.create-order.yaml'), o.flow ?? WRITE_FLOW);
  // Synthetic dummy credentials, in the app's own .env.
  fs.writeFileSync(path.join(dir, '.env'), 'DUMMY_MOBILE=9000011111\nDUMMY_PIN=2468\n');
  return apps;
}

function runCapture(apps: string, env: Record<string, string>): { code: number; out: string } {
  const r = spawnSync(process.execPath, ['-r', 'ts-node/register', 'src/runner.ts', '--app', 'sample-app', '--device', 'Mobile', '--force'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, APPS_DIR: apps, APP: 'sample-app', HEADLESS: 'true', STEP_TIMEOUT_MS: '5000', RUNS_RETENTION_DAYS: '0', ...env },
    timeout: 180_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
}

function reset(tenantId = TENANT.id): void {
  state.tenantId = tenantId;
  state.orders = [];
  state.writes = 0;
  state.deletes = 0;
}

before(async () => {
  server = http.createServer(handle);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'runs', 'sample-app'), { recursive: true, force: true });
});

// ─── cases ───────────────────────────────────────────────────────────────────

test('control: with every gate holding, the write happens and teardown deletes only the tagged record', () => {
  reset();
  const { code, out } = runCapture(makeApp(), { WRITE_MODE: 'dummy' });
  assert.equal(code, 0, out);
  assert.equal(state.writes, 1, 'the harness can write — so a zero below is the gate');
  assert.equal(state.deletes, 1, 'teardown removed the tagged record');
  assert.deepEqual(state.orders, []);
  assert.match(out, /dummy identity verified/);
});

test('gate 1 — WRITE_MODE not "dummy": the write flow is skipped, nothing is written', () => {
  for (const mode of ['', 'off', 'yes']) {
    reset();
    const { code, out } = runCapture(makeApp(), { WRITE_MODE: mode });
    assert.equal(code, 0, out);
    assert.match(out, /writes data and WRITE_MODE is not "dummy"/);
    assert.equal(state.writes, 0, `WRITE_MODE="${mode}"`);
  }
});

test('gate 2 — a flow without writes: true, or not auth: dummy, is refused before a browser opens', () => {
  const variants = {
    'no writes: true': WRITE_FLOW.replace('writes: true\n', ''),
    'auth: admin': WRITE_FLOW.replace('auth: dummy', 'auth: admin'),
  };
  for (const [label, flow] of Object.entries(variants)) {
    reset();
    const { code, out } = runCapture(makeApp({ flow }), { WRITE_MODE: 'dummy' });
    assert.equal(code, 1, `${label}: ${out}`);
    assert.match(out, /refusing to run/, label);
    assert.equal(state.writes, 0, label);
  }
});

test('gate 3 — the signed-in tenant is not the dummy tenant: the run aborts before the first action', () => {
  reset('real-tenant-7');
  const { code, out } = runCapture(makeApp(), { WRITE_MODE: 'dummy' });
  assert.equal(code, 1, out);
  assert.match(out, /DUMMY IDENTITY CHECK FAILED/);
  assert.match(out, /Run ABORTED/);
  assert.doesNotMatch(out, /010-new navigated/, 'no flow step ran');
  assert.equal(state.writes, 0);
});

test('gate 4 — the host is not in writeAllowedHosts: the run aborts before the first action', () => {
  reset();
  const { code, out } = runCapture(makeApp({ writeAllowedHosts: [] }), { WRITE_MODE: 'dummy' });
  assert.equal(code, 1, out);
  assert.match(out, /WRITE GATES FAILED/);
  assert.match(out, /not in writeAllowedHosts/);
  assert.equal(state.writes, 0);
});
