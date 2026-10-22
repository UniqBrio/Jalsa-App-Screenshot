/**
 * The coverage commands end to end, against two synthetic fixture apps — a
 * Next.js App Router shop and an Expo Router club — each with its own profile,
 * flows, inventory, exceptions and backlog (fixtures/coverage/).
 *
 * Every test works on a fresh temporary copy of the profiles AND the sources,
 * outside any git work tree, so it can add a button or delete a page without
 * touching the fixtures, and so no real app's profile or source is ever read.
 * The CLIs run as child processes where the exit code or the CI summary is
 * what is being proven.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync, execFileSync } from 'child_process';

/* eslint-disable @typescript-eslint/no-var-requires */
const envMod = require('../env') as typeof import('../env');
const { auditCurrentApp } = require('../coverage/audit-app') as typeof import('../coverage/audit-app');
const { scanRoutes } = require('../coverage/route-scan') as typeof import('../coverage/route-scan');
const { listSourceFiles, readSourceFile } = require('../coverage/source-root') as typeof import('../coverage/source-root');
const { validate } = require('../validate') as typeof import('../validate');
const { registeredApps } = require('../audit-coverage') as typeof import('../audit-coverage');
/* eslint-enable @typescript-eslint/no-var-requires */

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'coverage');
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

interface Workspace { dir: string; apps: string; next: string; expo: string; reports: string; env: Record<string, string> }

function workspace(): Workspace {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-ws-')));
  made.push(dir);
  const ws = { dir, apps: path.join(dir, 'apps'), next: path.join(dir, 'next-src'), expo: path.join(dir, 'expo-src'), reports: path.join(dir, 'reports') };
  fs.cpSync(path.join(FIXTURES, 'apps'), ws.apps, { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'next-src'), ws.next, { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'expo-src'), ws.expo, { recursive: true });
  return { ...ws, env: { APPS_DIR: ws.apps, REPORTS_DIR: ws.reports, APP_REPO_PATH_FX_NEXT: ws.next, APP_REPO_PATH_FX_EXPO: ws.expo } };
}

/** Selects an app in THIS process, the way the CLIs do. */
function select(ws: Workspace, app: string, extra: Record<string, string | undefined> = {}): void {
  for (const k of Object.keys(process.env)) if (k.startsWith('APP_REPO_PATH')) delete process.env[k];
  Object.assign(process.env, ws.env, { APP: app });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  envMod.resetAppContext();
}

function audit(ws: Workspace, app: string, extra: Record<string, string | undefined> = {}) {
  select(ws, app, extra);
  return auditCurrentApp();
}

/** Runs a CLI (src/coverage.ts or src/audit-coverage.ts) in a child process. */
function cli(ws: Workspace, script: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('APP_REPO_PATH') && k !== 'APP') env[k] = v;
  const r = spawnSync(process.execPath, ['-r', 'ts-node/register', path.join(ROOT, 'src', script), ...args], {
    cwd: ROOT,
    env: { ...env, ...ws.env, ...extraEnv, TS_NODE_TRANSPILE_ONLY: 'true' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const keys = (items: Array<{ key: string }>) => items.map((i) => i.key).sort();
const hash = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const MENU = (ws: Workspace) => path.join(ws.next, 'web/src/app/(shop)/menu/page.tsx');

// ─── the fixture's own baseline ──────────────────────────────────────────────

test('2/5 · the fixture shop passes: covered ids, an approved exception and backlog debt, each reported as such', () => {
  const ws = workspace();
  const r = audit(ws, 'fx-next');
  assert.equal(r.verdict, 'PASS', r.report?.blocking.join('\n') ?? r.problems.join('\n'));
  const t = r.report!.testids;
  assert.deepEqual(keys(t.coveredIds), ['home-menu', 'menu-add', 'menu-item-*', 'menu-row-special', 'order-close']);
  assert.deepEqual(keys(t.excepted), ['menu-delete']);
  assert.equal(t.excepted[0].reason, 'Deletes a dish; real accounts are read-only and may never press it.');
  assert.deepEqual(keys(t.existingUncovered), ['hidden-ping']);
  assert.deepEqual(t.newUncovered, []);
  const ro = r.report!.routes;
  assert.deepEqual(ro.coveredRoutes.map((x) => x.path).sort(), ['/', '/docs/[...slug]', '/menu', '/orders/[id]']);
  assert.deepEqual(ro.excepted.map((x) => x.path), ['/help/[[...topic]]']);
  assert.deepEqual(ro.existingUncovered.map((x) => x.path), ['/hidden']);
  assert.deepEqual(ro.unverifiable.map((x) => x.path), ['/?tab=promo']);
});

// ─── test ids ────────────────────────────────────────────────────────────────

test('1 · a new interactive element in the source fails the audit, by module, with file and line', () => {
  const ws = workspace();
  const src = fs.readFileSync(MENU(ws), 'utf8').replace('<h1', '<button data-testid="menu-share" onClick={() => undefined}>Share</button>\n      <h1');
  write(MENU(ws), src);
  const r = audit(ws, 'fx-next');
  assert.equal(r.verdict, 'FAIL');
  const item = r.report!.testids.newUncovered.find((i) => i.key === 'menu-share');
  assert.ok(item, JSON.stringify(r.report!.testids.newUncovered));
  assert.equal(item!.module, 'shop');
  assert.equal(item!.file, 'web/src/app/(shop)/menu/page.tsx');
  assert.equal(item!.line, 6);
});

test('3 · the same element passes once an executable flow exercises it', () => {
  const ws = workspace();
  write(MENU(ws), fs.readFileSync(MENU(ws), 'utf8').replace('<h1', '<button data-testid="menu-share" onClick={() => undefined}>Share</button>\n      <h1'));
  const flowFile = path.join(ws.apps, 'fx-next', 'flows', 'shop.menu.yaml');
  fs.appendFileSync(flowFile, `  - id: 060-share\n    action: click\n    selector: '[data-testid="menu-share"]'\n`);
  const r = audit(ws, 'fx-next');
  assert.equal(r.verdict, 'PASS', r.report!.blocking.join('\n'));
  assert.deepEqual(r.report!.testids.coveredIds.find((i) => i.key === 'menu-share')!.exercisedBy, ['shop/menu#060-share']);
});

test('4 · named in a waitFor, a description, a disabled flow and a draft — still not covered', () => {
  const ws = workspace();
  // Withdraw the exception: menu-delete must now stand on what the flows do.
  write(path.join(ws.apps, 'fx-next', 'config', 'coverage-exceptions.json'), JSON.stringify({
    app: 'fx-next',
    exceptions: [{ route: '/help/[[...topic]]', reason: 'Static help text, rendered from markdown; nothing to operate.' }],
  }));
  const r = audit(ws, 'fx-next');
  const del = r.report!.testids.newUncovered.find((i) => i.key === 'menu-delete');
  assert.ok(del, 'menu-delete is NEW uncovered');
  assert.deepEqual(del!.locatedBy, ['shop/menu#030-delete-visible']);
  assert.equal(del!.exercisedBy, undefined, 'the disabled flow and the draft that press it are not executable');
  assert.equal(r.verdict, 'FAIL');
});

test('7 · a source id deleted while a flow still presses it is reported as a stale reference', () => {
  const ws = workspace();
  write(path.join(ws.next, 'web/src/app/orders/[id]/page.tsx'), 'export default function Order() { return <p>Closed</p>; }\n');
  const r = audit(ws, 'fx-next');
  assert.equal(r.verdict, 'FAIL');
  assert.deepEqual(r.report!.testids.staleReferences.map((s) => `${s.flow}#${s.step}`), ['orders/order#020-close']);
});

// ─── exceptions and the backlog cannot be used to hide a new element ────────

test('6 · a broad pattern cannot pre-approve ids nobody has written yet', () => {
  const ws = workspace();
  write(MENU(ws), fs.readFileSync(MENU(ws), 'utf8').replace('<h1', '<button data-testid="menu-share" onClick={() => undefined}>Share</button>\n      <h1'));
  const excFile = path.join(ws.apps, 'fx-next', 'config', 'coverage-exceptions.json');
  const exc = JSON.parse(fs.readFileSync(excFile, 'utf8'));
  exc.exceptions.push({ pattern: '*-share', reason: 'Any share button anywhere, now or later.' });
  exc.exceptions.push({ pattern: 'menu-*', reason: 'Everything on the menu screen, now or later.' });
  write(excFile, JSON.stringify(exc));
  const r = audit(ws, 'fx-next');
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.report!.testids.newUncovered.some((i) => i.key === 'menu-share'), 'the new element is still NEW');
  assert.ok(r.report!.exceptions.errors.some((e) => e.includes('"*-share" is too broad')));
  assert.ok(r.report!.exceptions.unneeded.some((u) => u.exception === 'pattern:menu-*' && u.why.includes('no test-id family "menu-*"')));
});

test('6 · a normal run never writes an exception or a backlog entry; --init-baseline refuses to grow an existing backlog', () => {
  const ws = workspace();
  write(MENU(ws), fs.readFileSync(MENU(ws), 'utf8').replace('<h1', '<button data-testid="menu-share" onClick={() => undefined}>Share</button>\n      <h1'));
  const cfg = path.join(ws.apps, 'fx-next', 'config');
  const before = { exc: hash(path.join(cfg, 'coverage-exceptions.json')), bl: hash(path.join(cfg, 'coverage-baseline.json')), known: hash(path.join(cfg, 'known_routes.json')) };

  const normal = cli(ws, 'coverage.ts', ['--app', 'fx-next']);
  assert.equal(normal.code, 1, normal.out);
  const init = cli(ws, 'coverage.ts', ['--app', 'fx-next', '--init-baseline']);
  assert.equal(init.code, 1, init.out);
  assert.match(init.out, /already exists[\s\S]*may only shrink/);
  const shrink = cli(ws, 'coverage.ts', ['--app', 'fx-next', '--shrink-baseline']);
  assert.equal(shrink.code, 0, shrink.out);

  assert.equal(hash(path.join(cfg, 'coverage-exceptions.json')), before.exc, 'exceptions untouched');
  assert.equal(hash(path.join(cfg, 'known_routes.json')), before.known, 'inventory untouched');
  const bl = JSON.parse(fs.readFileSync(path.join(cfg, 'coverage-baseline.json'), 'utf8'));
  assert.ok(!bl.testids.includes('menu-share'), '--shrink-baseline never adds');
  assert.equal(audit(ws, 'fx-next').verdict, 'FAIL', 'the new element still fails after every maintenance command');
});

test('--shrink-baseline removes exactly the entries that became covered, and --init-baseline takes a first backlog', () => {
  const ws = workspace();
  fs.appendFileSync(path.join(ws.apps, 'fx-next', 'flows', 'home.home.yaml'),
    `  - id: 030-hidden\n    action: goto\n    value: /hidden\n  - id: 040-ping\n    action: click\n    selector: '[data-testid="hidden-ping"]'\n`);
  const blFile = path.join(ws.apps, 'fx-next', 'config', 'coverage-baseline.json');
  assert.equal(audit(ws, 'fx-next').verdict, 'FAIL', 'covered-but-still-listed backlog entries fail');
  assert.equal(cli(ws, 'coverage.ts', ['--app', 'fx-next', '--shrink-baseline']).code, 0);
  const bl = JSON.parse(fs.readFileSync(blFile, 'utf8'));
  assert.deepEqual([bl.testids, bl.routes], [[], []]);
  assert.equal(audit(ws, 'fx-next').verdict, 'PASS');

  fs.rmSync(blFile);
  write(MENU(ws), fs.readFileSync(MENU(ws), 'utf8').replace('<h1', '<button data-testid="menu-share" onClick={() => undefined}>Share</button>\n      <h1'));
  const init = cli(ws, 'coverage.ts', ['--app', 'fx-next', '--init-baseline']);
  assert.equal(init.code, 0, init.out);
  assert.match(init.out, /DEBT, not approval/);
  assert.deepEqual(JSON.parse(fs.readFileSync(blFile, 'utf8')).testids, ['menu-share']);
});

// ─── pages ───────────────────────────────────────────────────────────────────

test('8 · a new page is found with no navigation link to it — unregistered and unvisited', () => {
  const ws = workspace();
  write(path.join(ws.next, 'web/src/app/secret/page.tsx'), 'export default function Secret() { return <p>Nobody links here</p>; }\n');
  const r = audit(ws, 'fx-next');
  assert.equal(r.verdict, 'FAIL');
  assert.deepEqual(r.report!.routes.newUnregistered.map((x) => x.path), ['/secret']);
  assert.deepEqual(r.report!.routes.newUncovered.map((x) => x.path), ['/secret']);

  const reg = cli(ws, 'coverage.ts', ['--app', 'fx-next', '--register-routes']);
  assert.equal(reg.code, 0, reg.out);
  const known = JSON.parse(fs.readFileSync(path.join(ws.apps, 'fx-next', 'config', 'known_routes.json'), 'utf8'));
  assert.ok(known.routes.some((x: { path: string; source: string }) => x.path === '/secret' && x.source === 'web/src/app/secret/page.tsx'));
  const after2 = audit(ws, 'fx-next');
  assert.deepEqual(after2.report!.routes.newUnregistered, [], 'registered now');
  assert.deepEqual(after2.report!.routes.newUncovered.map((x) => x.path), ['/secret'], 'registering is not covering');
});

test('9 · a page removed from the source is reported, and so is the flow that still navigates to it', () => {
  const ws = workspace();
  fs.rmSync(path.join(ws.next, 'web/src/app/docs'), { recursive: true });
  const r = audit(ws, 'fx-next');
  assert.equal(r.verdict, 'FAIL');
  assert.deepEqual(r.report!.routes.removed.map((x) => x.path), ['/docs/[...slug]']);
  assert.deepEqual(r.report!.routes.unmatchedVisits.map((v) => `${v.flow}#${v.step}`), ['docs/docs#010-open']);
});

test('10 · Next.js App Router: groups, dynamic, catch-all, optional catch-all, private, slots, intercepts, APIs, redirects', () => {
  const ws = workspace();
  const files = listSourceFiles(ws.next, ['web/src/app/**/*', 'web/next.config.ts'], []);
  const rs = scanRoutes({ strategy: 'nextjs-app', appDir: 'web/src/app', nextConfig: 'web/next.config.ts' }, files, (f) => readSourceFile(ws.next, f));
  assert.deepEqual(rs.routes.map((r) => `${r.path}:${r.kind}`), [
    '/:page', '/docs/[...slug]:page', '/help/[[...topic]]:page', '/hidden:page',
    '/legacy/[id]:redirect', '/menu:page', '/old:redirect', '/orders/[id]:page',
  ]);
  assert.deepEqual(rs.ignored.map((i) => i.file), ['web/src/app/_internal/page.tsx']);
  assert.deepEqual(rs.unclassifiable.map((i) => i.file).sort(), ['web/src/app/(.)photo/page.tsx', 'web/src/app/@modal/page.tsx']);
  assert.ok(!rs.routes.some((r) => r.path.startsWith('/api')), 'route.ts is an API, not a page');
});

test('10 · Expo Router: groups, index, dynamic, platform variants, specials, APIs, non-screens, redirects, duplicates', () => {
  const ws = workspace();
  write(path.join(ws.expo, 'app/index.tsx'), "import { Text } from 'react-native';\nexport default function Start() { return <Text>start</Text>; }\n");
  const files = listSourceFiles(ws.expo, ['app/**/*'], []);
  const rs = scanRoutes({ strategy: 'expo-router', appDir: 'app', nextConfig: '' }, files, (f) => readSourceFile(ws.expo, f));
  assert.deepEqual(rs.routes.map((r) => `${r.path}:${r.kind}:${r.files.length}`), ['/:page:2', '/course/[id]:page:1', '/legacy:redirect:1', '/settings:page:2']);
  assert.deepEqual(rs.duplicates.map((d) => d.path), ['/'], '(tabs)/index and index both claim /; settings.web is a variant, not a duplicate');
  const why = Object.fromEntries(rs.ignored.map((i) => [i.file, i.why]));
  for (const f of ['app/_layout.tsx', 'app/(tabs)/_layout.tsx', 'app/+not-found.tsx', 'app/+html.tsx', 'app/api/ping+api.ts', 'app/lib/client.ts', 'app/util.ts']) {
    assert.ok(why[f], `${f} is not a page`);
  }
});

// ─── configuration ───────────────────────────────────────────────────────────

test('11 · an invalid profile is a configuration error (exit 2) with every problem named', () => {
  const ws = workspace();
  const file = path.join(ws.apps, 'fx-next', 'app.config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.source.routes.strategy = 'gatsby';
  cfg.source.include = ['../../other-app/**'];
  write(file, JSON.stringify(cfg));
  const r = cli(ws, 'coverage.ts', ['--app', 'fx-next']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /source\.routes\.strategy: one of nextjs-app \| expo-router \| none/);
  assert.match(r.out, /must be relative to the app repo root/);
  const a = cli(ws, 'audit-coverage.ts', ['--app', 'fx-next']);
  assert.equal(a.code, 2, a.out);
});

test('11 · a missing clone or a scan that reads nothing is BLOCKED (exit 3), never a pass', () => {
  const ws = workspace();
  const missing = cli(ws, 'coverage.ts', ['--app', 'fx-next'], { APP_REPO_PATH_FX_NEXT: '' });
  assert.equal(missing.code, 3, missing.out);
  assert.match(missing.out, /APP_REPO_PATH_FX_NEXT=<path>/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-empty-'));
  made.push(empty);
  fs.mkdirSync(path.join(empty, 'web', 'src', 'app'), { recursive: true });
  const nothing = cli(ws, 'coverage.ts', ['--app', 'fx-next'], { APP_REPO_PATH_FX_NEXT: empty });
  assert.equal(nothing.code, 3, nothing.out);
  assert.match(nothing.out, /parsed 0 files[\s\S]*not a pass/);
});

// ─── one app never reads another ─────────────────────────────────────────────

test('12 · a clone of another repository is refused, whatever variable points at it', () => {
  const ws = workspace();
  execFileSync('git', ['init', '-q', ws.next]);
  execFileSync('git', ['-C', ws.next, 'remote', 'add', 'origin', 'https://github.com/fixture-org/fixture-club.git']);
  const r = audit(ws, 'fx-next');
  assert.equal(r.verdict, 'BLOCKED');
  assert.match(r.problems[0], /clone of fixture-org\/fixture-club, but apps\/fx-next audits fixture-org\/fixture-shop/);
  execFileSync('git', ['-C', ws.next, 'remote', 'set-url', 'origin', 'git@github.com:Fixture-Org/Fixture-Shop.git']);
  const ok = audit(ws, 'fx-next');
  assert.equal(ok.verdict, 'PASS', ok.problems.join('\n'));
  assert.equal(ok.report!.source!.identity, 'verified');
});

test('12 · each app reads only its own variable and its own tree; a bare shell APP_REPO_PATH is never used', () => {
  const ws = workspace();
  const shared = audit(ws, 'fx-next', { APP_REPO_PATH_FX_NEXT: undefined, APP_REPO_PATH: ws.next });
  assert.equal(shared.verdict, 'BLOCKED', 'a shell APP_REPO_PATH would aim every app at one tree');
  const next = audit(ws, 'fx-next');
  const expo = audit(ws, 'fx-expo');
  assert.equal(next.report!.source!.root, ws.next);
  assert.equal(expo.report!.source!.root, ws.expo);
  const sites = (r: typeof next) => [...r.report!.testids.coveredIds, ...r.report!.testids.newUncovered, ...r.report!.testids.existingUncovered, ...r.report!.testids.excepted].map((i) => i.file);
  assert.ok(sites(next).every((f) => f.startsWith('web/')), 'fx-next saw only its own files');
  assert.ok(sites(expo).every((f) => f.startsWith('app/') || f.startsWith('src/')), 'fx-expo saw only its own files');
  assert.ok(!sites(expo).some((f) => f.startsWith('web/')));
});

// ─── a future app ────────────────────────────────────────────────────────────

test('13 · a new app is onboarded by configuration alone — a profile folder and a variable', () => {
  const ws = workspace();
  fs.cpSync(path.join(ws.apps, 'fx-expo'), path.join(ws.apps, 'fx-future'), { recursive: true });
  const future = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-future-')));
  made.push(future);
  fs.cpSync(ws.expo, future, { recursive: true });
  select(ws, 'fx-future', { APP_REPO_PATH_FX_FUTURE: future });
  assert.ok(registeredApps().includes('fx-future'));
  assert.ok(!registeredApps().includes('_template'));
  const r = auditCurrentApp();
  assert.ok(r.report, r.problems.join('\n'));
  assert.equal(r.report!.app, 'fx-future');
  assert.equal(r.report!.routes.strategy, 'expo-router');
  assert.ok(r.report!.testids.required > 0);
});

// ─── CI ──────────────────────────────────────────────────────────────────────

test('14 · audit:coverage --app all: exit 1 on a failing app, a job summary, and a JSON summary per app', () => {
  const ws = workspace();
  const summary = path.join(ws.dir, 'step-summary.md');
  const r = cli(ws, 'audit-coverage.ts', ['--app', 'all'], { GITHUB_STEP_SUMMARY: summary });
  assert.equal(r.code, 1, r.out);
  const md = fs.readFileSync(summary, 'utf8');
  assert.match(md, /\| `fx-next` \| ✅ PASS/);
  assert.match(md, /\| `fx-expo` \| ❌ FAIL/);
  assert.match(md, /blocking finding/);
  const json = JSON.parse(fs.readFileSync(path.join(ws.reports, 'audit-summary.json'), 'utf8'));
  assert.deepEqual(json.apps.map((a: { app: string; verdict: string }) => `${a.app}:${a.verdict}`), ['fx-expo:FAIL', 'fx-next:PASS']);
  assert.ok(fs.existsSync(path.join(ws.reports, 'fx-next', 'coverage.json')));
  assert.equal(cli(ws, 'audit-coverage.ts', ['--app', 'fx-next']).code, 0);
  const blocked = cli(ws, 'audit-coverage.ts', ['--app', 'fx-next'], { APP_REPO_PATH_FX_NEXT: '' });
  assert.equal(blocked.code, 3, 'a check that did not run is BLOCKED, never green');
  assert.doesNotMatch(r.out + blocked.out, /ADMIN_PASSWORD=|OWNER_PIN=/, 'no environment is printed');
});

// ─── existing behaviour ──────────────────────────────────────────────────────

test('15 · validate still passes for the fixture apps; drafts and disabled flows stay out of execution', () => {
  const ws = workspace();
  select(ws, 'fx-next');
  const out: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => out.push(a.join(' '));
  let code: number;
  try {
    code = validate();
  } finally {
    console.log = orig;
  }
  assert.equal(code, 0, out.join('\n'));
  assert.ok(out.some((l) => l.includes('Loaded 5 flow manifest(s)')), 'the disabled flow is loaded by validate; the draft is not');
});
