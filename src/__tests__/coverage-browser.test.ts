/**
 * The two browser-side pieces the coverage work added, against pages served
 * offline by request interception (https://fixture.test — nothing reaches a
 * network, every value is synthetic):
 *
 *   · the executor records the data-testid of what each EXERCISING step really
 *     pressed (target_testid) and the path it landed on (url_after) — the run
 *     evidence `coverage --evidence` counts;
 *   · the pin-only login adapter signs in on a keypad, per-account path, and
 *     reports a wrong PIN with the page's own sentence.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium, type Browser, type BrowserContext, type Route } from '@playwright/test';
import { useSampleApp } from './helpers/sample-app';

/* eslint-disable @typescript-eslint/no-var-requires */
const { executeFlow } = require('../flow-executor') as typeof import('../flow-executor');
const { normaliseFlow } = require('../flow-loader') as typeof import('../flow-loader');
const { loadDevicesConfig } = require('../devices') as typeof import('../devices');
const { createLoginAdapter } = require('../login-adapters') as typeof import('../login-adapters');
const prof = require('../profile') as typeof import('../profile');
const envMod = require('../env') as typeof import('../env');
/* eslint-enable @typescript-eslint/no-var-requires */

import type { Flow } from '../types';

const ORIGIN = 'https://fixture.test';
const RECORD = '6f1c2a9e-1111-4a3b-9c2d-0000000000aa';
let browser: Browser;
const tmp: string[] = [];
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => {
  await browser?.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

const page = (body: string, script = '') =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}<script>${script}</script></body></html>`;

async function served(pages: (url: URL, cookie: string) => string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: ORIGIN });
  await ctx.route('**/*', (route: Route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    return route.fulfill({ status: 200, contentType: 'text/html', body: pages(url, route.request().headers().cookie ?? '') });
  });
  return ctx;
}

// ─── run evidence ────────────────────────────────────────────────────────────

test('the executor records what each exercising step pressed, and where it landed', async () => {
  useSampleApp({});
  const ctx = await served((u) =>
    u.pathname === '/next'
      ? page(`<button data-testid="row-${RECORD}" onclick="location.href='/course/${RECORD}'">A row</button>`)
      : u.pathname.startsWith('/course/')
      ? page('<h1 data-testid="course-title">Course</h1>')
      : page(`<button data-testid="home-go" onclick="location.href='/next'">Go on</button>
              <button onclick="void 0">No id</button>
              <a data-testid="home-help" href="#">Help</a>`));
  const flow = {
    schema_version: 2, module: 'zzfixture', flow: 'evidence', title: 'Evidence',
    steps: [
      { id: '010-home', action: 'goto', value: '/' },
      { id: '020-hover', action: 'hover', selector: '[data-testid="home-help"]' },
      { id: '030-noid', action: 'click', selector: 'role=button[name="No id"]' },
      { id: '040-go', action: 'click', selector: 'role=button[name="Go on"]' },
      { id: '050-row', action: 'click', selector: 'role=button[name="A row"]' },
    ],
  } as unknown as Flow;
  normaliseFlow(flow);
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-exec-'));
  tmp.push(runDir);
  let run;
  try {
    run = await executeFlow(ctx, flow, {
      runId: 'cov-test', runDir, runTag: 'T', device: loadDevicesConfig().devices[0], appGitSha: null, baseline: {}, reason: 'test',
    });
  } finally {
    await ctx.close();
  }
  assert.deepEqual(run.steps.map((s) => s.status), ['ok', 'ok', 'ok', 'ok', 'ok'], JSON.stringify(run.errors));
  const s = Object.fromEntries(run.steps.map((x) => [x.id, x]));
  assert.equal(s['040-go'].target_testid, 'home-go', 'a role selector resolved to the test id it pressed');
  assert.equal(s['040-go'].url_after, '/next');
  assert.equal(s['030-noid'].target_testid, null, 'an element without a test id is recorded as such');
  assert.equal(s['020-hover'].target_testid, undefined, 'hover locates; it is not probed as an exercise');
  assert.equal(s['010-home'].url_after, '/');
  // A record id is personal data in a manifest: the family and the route pattern are all coverage needs.
  assert.equal(s['050-row'].target_testid, 'row-*');
  assert.equal(s['050-row'].url_after, '/course/[id]');
  assert.ok(!JSON.stringify(run).includes(RECORD), 'the record id reached the run manifest');
});

// ─── pin-only sign-in ────────────────────────────────────────────────────────

const OWNER_PIN = '4826';

function keypad(u: URL, cookie: string): string {
  if (u.pathname !== '/owner') return page('<p>Wrong surface</p>');
  if (cookie.includes('owner=1')) return page('<main data-testid="console">Owner console</main>');
  const keys = '1234567890'.split('').map((d) => `<button data-testid="key-${d}">${d}</button>`).join('');
  return page(
    `<label for="pin" style="position:absolute;width:1px;height:1px;overflow:hidden">PIN</label>
     <input id="pin" data-testid="pin" type="password" style="position:absolute;width:1px;height:1px;opacity:0">${keys}
     <p data-testid="pin-error" id="err"></p>`,
    `var v = '';
     document.querySelectorAll('[data-testid^="key-"]').forEach(function (b) {
       b.onclick = function () {
         v += b.textContent;
         if (v.length === 4) {
           if (v === '${OWNER_PIN}') { document.cookie = 'owner=1'; location.reload(); }
           else { document.getElementById('err').textContent = 'That PIN did not work.'; v = ''; }
         }
       };
     });`,
  );
}

function pinOnlyApp(pin: string, patch: (cfg: any) => void = () => undefined): void {
  useSampleApp({ OWNER_PIN: pin }, (cfg) => {
    cfg.loginAdapter = {
      type: 'pin-only',
      selectors: { pin: '[data-testid="pin"]', key: '[data-testid="key-{digit}"]', signedIn: '[data-testid="console"]', error: '[data-testid="pin-error"]' },
      options: { loginPath: '/staff', pinDigits: 4 },
    };
    cfg.accounts = { owner: { secretEnv: 'OWNER_PIN', loginPath: '/owner' } };
    cfg.defaultAccount = 'owner';
    delete cfg.dummyAccount;
    cfg.extraEnvVars = [];
    patch(cfg);
  });
}

test('pin-only: no login variable, a keypad, the account’s own path — signs in and recognises the session', async () => {
  pinOnlyApp(OWNER_PIN);
  const adapter = createLoginAdapter(envMod.profile);
  assert.deepEqual(adapter.configErrors(), []);
  assert.equal(adapter.preflight('owner', envMod.env.accounts.owner), null);
  const ctx = await served(keypad);
  try {
    const p = await ctx.newPage();
    await adapter.authenticate(p, 'owner', envMod.env.accounts.owner);
    assert.ok(await p.locator('[data-testid="console"]').isVisible());
    assert.equal(await adapter.isAuthenticated(await ctx.newPage(), 'owner'), true, 'the saved session is recognised at /owner, not the adapter default /staff');
  } finally {
    await ctx.close();
  }
});

test('pin-only: a wrong PIN fails with the page’s own sentence and never quotes the PIN', async () => {
  pinOnlyApp('1111');
  const ctx = await served(keypad);
  try {
    const p = await ctx.newPage();
    await assert.rejects(
      createLoginAdapter(envMod.profile).authenticate(p, 'owner', envMod.env.accounts.owner),
      (err: Error) => /did not complete[\s\S]*That PIN did not work/.test(err.message) && !err.message.includes('1111'),
    );
  } finally {
    await ctx.close();
  }
});

test('pin-only configuration: a login variable, a key template without {digit}, a short PIN are each refused', () => {
  pinOnlyApp('12', (cfg) => {
    cfg.accounts.owner.userEnv = 'OWNER_NAME';
    cfg.loginAdapter.selectors.key = '[data-testid="key"]';
  });
  const a = createLoginAdapter(envMod.profile);
  const errs = a.configErrors().join('\n');
  assert.match(errs, /accounts\.owner\.userEnv: a pin-only sign-in has no login/);
  assert.match(errs, /selectors\.key: must contain \{digit\}/);
  assert.match(a.preflight('owner', envMod.env.accounts.owner) ?? '', /OWNER_PIN is not set[\s\S]*4 digits/);
  // Every other adapter still requires the login variable.
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'apps', 'sample-app', 'app.config.json'), 'utf8'));
  delete raw.accounts.admin.userEnv;
  assert.throws(() => prof.parseProfile(raw, 'sample-app', '/tmp/sample-app'), /accounts\.admin\.userEnv: an UPPER_SNAKE/);
  assert.throws(() => prof.parseProfile({ ...raw, accounts: { admin: { userEnv: 'A', secretEnv: 'B' } } }, 'all', '/tmp/all'), /"all" is reserved/);
});
