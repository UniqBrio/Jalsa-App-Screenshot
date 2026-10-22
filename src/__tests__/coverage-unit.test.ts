/**
 * The coverage rules, one at a time, on in-memory sources and flows — no
 * filesystem app, no browser. Every id, path and app here is synthetic.
 *
 * What "covered" means is the whole point of the check, so the cases pin it
 * down from both sides: an exercising step covers; a locating step, a mention
 * in a description, a disabled flow, a draft, a hover, an ancestor in a chain
 * or an ambiguous prefix does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ts from 'typescript';

/* eslint-disable @typescript-eslint/no-var-requires */
const { scanTestIds, resolveIdExpression, patternToRegExp } = require('../coverage/testid-scan') as typeof import('../coverage/testid-scan');
const { DEFAULT_HANDLER_PROPS, DEFAULT_INTERACTIVE_ELEMENTS, parseSourceConfig } = require('../coverage/source-config') as typeof import('../coverage/source-config');
const { flowUsages, parseSelector, pathOf } = require('../coverage/flow-usage') as typeof import('../coverage/flow-usage');
const { compare } = require('../coverage/engine') as typeof import('../coverage/engine');
const { routeKey, matchRoute, nextConfigRedirects } = require('../coverage/route-scan') as typeof import('../coverage/route-scan');
const { loadExceptions, loadBacklog } = require('../coverage/exceptions') as typeof import('../coverage/exceptions');
const { loadRunEvidence } = require('../coverage/run-evidence') as typeof import('../coverage/run-evidence');
const { normaliseFlow } = require('../flow-loader') as typeof import('../flow-loader');
const { repoSlug, repoPathEnvName, listSourceFiles } = require('../coverage/source-root') as typeof import('../coverage/source-root');
/* eslint-enable @typescript-eslint/no-var-requires */

import type { Flow } from '../types';
import type { RouteScan } from '../coverage/route-scan';

const RULES = { elements: DEFAULT_INTERACTIVE_ELEMENTS, handlerProps: DEFAULT_HANDLER_PROPS };

function scan(files: Record<string, string>, attributes = ['data-testid', 'testID', 'testId']) {
  return scanTestIds({ root: '/virtual', files: Object.keys(files), attributes, interactive: RULES, read: (f) => files[f] });
}

function flow(module: string, name: string, steps: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Flow {
  const f = { schema_version: 2, module, flow: name, title: name, steps, ...extra } as unknown as Flow;
  normaliseFlow(f);
  f._sourcePath = `flows/${module}.${name}.yaml`;
  return f;
}

const NO_ROUTES: RouteScan = { strategy: 'none', filesConsidered: 0, routes: [], ignored: [], unclassifiable: [], duplicates: [] };

function run(files: Record<string, string>, flows: Flow[], over: Partial<Parameters<typeof compare>[0]> = {}) {
  const usage = flowUsages(flows);
  return compare({
    appId: 'unit',
    appName: 'Unit',
    today: '2026-10-22',
    mode: 'static',
    source: null,
    scan: scan(files),
    routeScan: NO_ROUTES,
    staticUsage: usage,
    coverageUsage: usage,
    flowsExecutable: flows.length,
    flowErrors: [],
    routesMap: { shop: { flows: [], source_paths: ['shop/**'] } },
    knownRoutes: { last_checked: '', routes: [] },
    exceptions: { app: 'unit', exceptions: [] },
    exceptionErrors: [],
    backlog: null,
    backlogErrors: [],
    ...over,
  });
}

const MENU = {
  'shop/Menu.tsx': `
    export default function Menu({ dishes }) {
      return (<section>
        <h1 data-testid="menu-title">Menu</h1>
        <button data-testid="menu-add" onClick={add}>Add</button>
        <button data-testid="menu-delete" onClick={del}>Delete</button>
        {dishes.map((d) => <button key={d.id} data-testid={\`menu-item-\${d.id}\`} onClick={pick}>{d.name}</button>)}
      </section>);
    }`,
};
const keys = (items: Array<{ key: string }>) => items.map((i) => i.key).sort();

// ─── the scanner ─────────────────────────────────────────────────────────────

test('ids resolve statically: literals, templates, branches and concatenation; forwarded props do not', () => {
  const expr = (s: string) => {
    const sf = ts.createSourceFile('x.ts', `const x = ${s};`, ts.ScriptTarget.Latest, true);
    return ((sf.statements[0] as ts.VariableStatement).declarationList.declarations[0].initializer)!;
  };
  assert.deepEqual(resolveIdExpression(expr(`'a-b'`)).values, ['a-b']);
  assert.deepEqual(resolveIdExpression(expr('`row-${id}-edit`')).values, ['row-*-edit']);
  assert.deepEqual(resolveIdExpression(expr(`on ? 'tab-on' : 'tab-off'`)).values, ['tab-on', 'tab-off']);
  assert.deepEqual(resolveIdExpression(expr(`'card-' + id`)).values, ['card-*']);
  assert.deepEqual(resolveIdExpression(expr(`testID ?? 'fallback'`)).values, ['fallback']);
  assert.deepEqual(resolveIdExpression(expr('testID')).values, []);
  assert.ok(patternToRegExp('row-*-edit').test('row-42-edit') && !patternToRegExp('row-*-edit').test('row--edit'));
});

test('an element is interactive by what it is, by a handler it carries, or by its role — otherwise it is display', () => {
  const s = scan({
    'a.tsx': `<>
      <Pressable testID="p-el" />
      <View testID="v-handler" onPress={go} />
      <div data-testid="d-role" role="button" />
      <div data-testid="d-display" />
      <View testID="v-undefined" onPress={undefined} />
    </>`,
  });
  const why = (k: string) => s.entries.get(k)!.sites[0].why;
  assert.equal(why('p-el'), 'element');
  assert.equal(why('v-handler'), 'handler:onPress');
  assert.equal(why('d-role'), 'role:button');
  assert.equal(why('d-display'), 'display');
  assert.equal(why('v-undefined'), 'display', 'onPress={undefined} is no handler');
});

test('asChild: the child id reaches the DOM, so the parent id is shadowed and owes nothing', () => {
  const s = scan({ 'a.tsx': `<Button data-testid="home-back" asChild><Link data-testid="home-back-link" href="/">Back</Link></Button>` });
  assert.equal(s.entries.get('home-back')!.interactive, false);
  assert.equal(s.entries.get('home-back')!.sites[0].shadowedBy, 'home-back-link');
  assert.equal(s.entries.get('home-back-link')!.interactive, true);
});

test('ids handed to inner controls are inventoried: prefix props, named sub-id props, helpers, forwarding components, config objects', () => {
  const s = scan({
    'Tabs.tsx': `<Tabs testIDPrefix="member-tab" onChange={set} />`,
    'Dialog.tsx': `<FormDialog confirmTestID="dialog-ok" titleTestID="dialog-title" />`,
    'Header.tsx': `
      export default function Header() {
        const action = (testID: string) => <Pressable testID={testID} onPress={go} />;
        return <>{action('header-add')}{action('header-search')}</>;
      }`,
    'Row.tsx': `export function Row({ testID }) { return <Pressable testID={testID} onPress={go} />; }`,
    'List.tsx': `<Row testID="list-row-first" />`,
    'Panel.tsx': `<Panel dismiss={{ testID: 'panel-dismiss', onPress: close }} />`,
  });
  assert.equal(s.entries.get('member-tab*')?.kind, 'pattern');
  assert.equal(s.entries.get('member-tab*')?.interactive, true);
  assert.equal(s.entries.get('dialog-ok')?.interactive, true, 'a confirm button');
  assert.equal(s.entries.get('dialog-title')?.interactive, false, 'a title is display');
  assert.equal(s.entries.get('header-add')?.interactive, true);
  assert.equal(s.entries.get('header-search')?.interactive, true);
  assert.equal(s.entries.get('list-row-first')?.interactive, true, 'Row forwards testID to a Pressable');
  assert.equal(s.entries.get('panel-dismiss')?.interactive, true);
  assert.equal(s.unresolved.length, 0, 'forwarded ids are resolved at their call sites, not left unresolved');
});

test('a scan that cannot parse says so instead of pretending the file is clean', () => {
  const s = scan({ 'bad.tsx': `<button data-testid="ok" onClick={go}>` + ' {{{', 'x.vue': '<template/>' });
  assert.equal(s.parseErrors.length, 1);
  assert.deepEqual(s.unsupported, ['x.vue']);
  assert.ok(s.entries.has('ok'), 'the parser recovers and still reads what it can');
  const r = run({ 'shop/bad.tsx': `<button data-testid="ok" onClick={go}>` + ' {{{' }, []);
  assert.ok(r.blocking.some((b) => b.startsWith('PARSE error in shop/bad.tsx')), 'a file it could not fully read fails the check');
});

// ─── what counts as coverage ─────────────────────────────────────────────────

test('1 · a NEW interactive id with no flow fails, with its file and line', () => {
  const r = run(MENU, []);
  assert.equal(r.verdict, 'FAIL');
  assert.deepEqual(keys(r.testids.newUncovered), ['menu-add', 'menu-delete', 'menu-item-*']);
  const add = r.testids.newUncovered.find((i) => i.key === 'menu-add')!;
  assert.equal(add.file, 'shop/Menu.tsx');
  assert.equal(add.line, 5);
  assert.equal(add.module, 'shop');
  assert.ok(r.blocking.some((b) => b.includes('"menu-add"') && b.includes('shop/Menu.tsx:5')));
  assert.ok(!r.testids.newUncovered.some((i) => i.key === 'menu-title'), 'a heading owes no flow');
});

test('2/3 · an id an executable flow exercises is covered, and names the step that did it', () => {
  const f = flow('shop', 'menu', [
    { id: '010-add', action: 'click', selector: '[data-testid="menu-add"]' },
    { id: '020-dish', action: 'click', selector: '[data-testid^="menu-item-"]' },
    { id: '030-delete', action: 'tap', selector: '[data-testid="menu-delete"]' },
  ]);
  const r = run(MENU, [f]);
  assert.equal(r.verdict, 'PASS', r.blocking.join('\n'));
  assert.deepEqual(keys(r.testids.coveredIds), ['menu-add', 'menu-delete', 'menu-item-*']);
  assert.deepEqual(r.testids.coveredIds.find((i) => i.key === 'menu-add')!.exercisedBy, ['shop/menu#010-add']);
});

test('4 · locating is not exercising: waitFor, assertions, masks, hover, scrolls and ancestors never cover', () => {
  const f = flow('shop', 'menu', [
    { id: '010-wait', action: 'waitFor', selector: '[data-testid="menu-add"]' },
    { id: '020-hover', action: 'hover', selector: '[data-testid="menu-delete"]' },
    { id: '030-scroll', action: 'scrollUntilVisible', selector: '[data-testid^="menu-item-"]' },
    { id: '040-assert', action: 'goto', value: '/menu', assert: { selector_visible: '[data-testid="menu-add"]' } },
    // menu-title scopes the press; the press lands on menu-delete's SIBLING chain target only.
    { id: '050-chain', action: 'click', selector: '[data-testid="menu-delete"] [data-testid="menu-title"]' },
  ]);
  const r = run(MENU, [f]);
  assert.deepEqual(keys(r.testids.newUncovered), ['menu-add', 'menu-delete', 'menu-item-*']);
  const add = r.testids.newUncovered.find((i) => i.key === 'menu-add')!;
  assert.deepEqual(add.locatedBy, ['shop/menu#010-wait', 'shop/menu#040-assert']);
  assert.equal(add.exercisedBy, undefined);
});

test('4 · an id mentioned in a description or depends_on_routes is not a usage at all', () => {
  const f = flow('shop', 'menu', [{ id: '010-open', action: 'goto', value: '/menu' }], {
    description: 'Never presses [data-testid="menu-delete"]',
    depends_on_routes: ['/menu'],
  });
  const r = run(MENU, [f]);
  assert.ok(r.testids.newUncovered.some((i) => i.key === 'menu-delete' && !i.locatedBy));
});

test('a prefix selector over several literal ids is ambiguous and covers none of them', () => {
  const files = { 'shop/Bar.tsx': `<><button data-testid="bar-save" onClick={a} /><button data-testid="bar-send" onClick={b} /></>` };
  const r = run(files, [flow('shop', 'bar', [{ id: '010-press', action: 'click', selector: '[data-testid^="bar-s"]' }])]);
  assert.deepEqual(keys(r.testids.newUncovered), ['bar-save', 'bar-send']);
  assert.deepEqual(r.testids.ambiguous[0].candidates?.sort(), ['bar-save', 'bar-send']);
});

test('a {{VAR}} id selects one member of a dynamic family; a role selector is reported for run evidence', () => {
  const f = flow('shop', 'menu', [
    { id: '010-dish', action: 'click', selector: '[data-testid="menu-item-{{DISH}}"]' },
    { id: '020-add', action: 'click', selector: 'role=button[name="Add"]' },
  ], { vars: { DISH: 'd1' } });
  const r = run(MENU, [f]);
  assert.ok(r.testids.coveredIds.some((i) => i.key === 'menu-item-*'));
  assert.ok(r.testids.newUncovered.some((i) => i.key === 'menu-add'), 'a role selector does not map to a test id statically');
  assert.equal(r.testids.roleSelectors.length, 1);
});

test('optional-only coverage is flagged as conditional', () => {
  const r = run(MENU, [flow('shop', 'menu', [{ id: '010-add', action: 'click', selector: '[data-testid="menu-add"]', optional: true }])]);
  assert.equal(r.testids.coveredIds.find((i) => i.key === 'menu-add')!.conditional, true);
});

test('derived ids: a press on `${testId}-confirm` covers the call site that passed the prefix', () => {
  const files = {
    'shop/Confirm.tsx': `export function Confirm({ testId, onYes }) { return <button data-testid={\`\${testId}-confirm\`} onClick={onYes} />; }`,
    'shop/Use.tsx': `<Confirm testId="menu-wipe" onYes={wipe} />`,
  };
  const r = run(files, [flow('shop', 'wipe', [{ id: '010-yes', action: 'click', selector: '[data-testid="menu-wipe-confirm"]' }])]);
  assert.ok(r.testids.coveredIds.some((i) => i.key === 'menu-wipe'), JSON.stringify(r.testids.newUncovered));
  assert.equal(r.testids.staleReferences.length, 0);
});

test('7 · a flow naming an id the source no longer has is a STALE reference and fails', () => {
  const r = run(MENU, [flow('shop', 'menu', [{ id: '010-gone', action: 'click', selector: '[data-testid="menu-export"]' }])]);
  assert.equal(r.testids.staleReferences.length, 1);
  assert.ok(r.blocking.some((b) => b.startsWith('STALE flow reference [data-testid="menu-export"]')));
});

test('an id assembled outside JSX (a plain string) is neither stale nor counted', () => {
  const files = { ...MENU, 'shop/ids.ts': `export const EXPORT_ID = 'menu-export';` };
  const r = run(files, [flow('shop', 'menu', [{ id: '010-x', action: 'click', selector: '[data-testid="menu-export"]' }])]);
  assert.equal(r.testids.staleReferences.length, 0);
  assert.equal(r.testids.indirectReferences.length, 1);
});

// ─── exceptions and the backlog ──────────────────────────────────────────────

test('5 · an approved exception keeps one element out of the flows without failing, and is listed', () => {
  const r = run(MENU, [flow('shop', 'menu', [
    { id: '010-add', action: 'click', selector: '[data-testid="menu-add"]' },
    { id: '020-dish', action: 'click', selector: '[data-testid^="menu-item-"]' },
  ])], { exceptions: { app: 'unit', exceptions: [{ testid: 'menu-delete', reason: 'Deletes a dish; real accounts are read-only.' }] } });
  assert.equal(r.verdict, 'PASS', r.blocking.join('\n'));
  assert.deepEqual(keys(r.testids.excepted), ['menu-delete']);
  assert.equal(r.exceptions.outstanding[0].status, 'active');
});

test('6 · an exception approves exactly what it names — never a new, different id', () => {
  const r = run(MENU, [], { exceptions: { app: 'unit', exceptions: [{ testid: 'menu-delete-old', reason: 'An older delete button that was removed.' }] } });
  assert.ok(r.testids.newUncovered.some((i) => i.key === 'menu-delete'));
  assert.ok(r.exceptions.unneeded.some((u) => u.exception === 'testid:menu-delete-old'), 'an exception for nothing is itself a finding');
});

test('an exception or backlog entry that is no longer needed fails until it is removed — the lists only shrink', () => {
  const f = flow('shop', 'menu', [{ id: '010-del', action: 'click', selector: '[data-testid="menu-delete"]' }]);
  const r = run(MENU, [f], {
    exceptions: { app: 'unit', exceptions: [{ testid: 'menu-delete', reason: 'Deletes a dish; real accounts are read-only.' }] },
    backlog: { app: 'unit', created: '2026-10-01', testids: ['menu-add', 'menu-gone'], routes: [] },
  });
  assert.ok(r.blocking.some((b) => b.startsWith('UNNEEDED exception testid:menu-delete')));
  assert.deepEqual(r.backlog.resolved.map((x) => x.entry), ['testid:menu-gone']);
  assert.ok(r.testids.existingUncovered.some((i) => i.key === 'menu-add'), 'backlog debt is listed, not failed');
});

test('an expired exception fails', () => {
  const r = run(MENU, [], { exceptions: { app: 'unit', exceptions: [{ testid: 'menu-delete', reason: 'Deletes a dish; real accounts are read-only.', expires: '2026-01-01' }] } });
  assert.ok(r.blocking.some((b) => b.startsWith('EXPIRED exception testid:menu-delete')));
});

function tmpApp(files: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-unit-'));
  fs.mkdirSync(path.join(dir, 'config'));
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'config', f), typeof v === 'string' ? v : JSON.stringify(v));
  return dir;
}

test('11 · the exceptions file is validated strictly — every malformed entry is reported', () => {
  const dir = tmpApp({
    'coverage-exceptions.json': {
      app: 'other-app',
      exceptions: [
        { testid: 'a-b', reason: 'TODO' },
        { pattern: '*-delete', reason: 'Every delete button, everywhere.' },
        { pattern: 'ab*', reason: 'Too short to be a family of anything.' },
        { testid: 'x', route: '/x', reason: 'Names two things at once, which is ambiguous.' },
        { testid: 'menu-*', reason: 'A wildcard dressed as one exact id.' },
        { testid: 'c-d', reason: 'A valid reason that is long enough.', module: 'nope', expires: '31-12-2026', colour: 'red' },
        { testid: 'e-f', reason: 'Listed twice, which is a duplicate.' },
        { testid: 'e-f', reason: 'Listed twice, which is a duplicate.' },
        { reason: 'Names nothing at all, so applies to nothing.' },
      ],
    },
  });
  const { errors } = loadExceptions(dir, 'unit', ['shop']);
  const has = (re: RegExp) => assert.ok(errors.some((e) => re.test(e)), `expected ${re} in:\n${errors.join('\n')}`);
  has(/"app" is "other-app" — must be "unit"/);
  has(/exceptions\[0\]\.reason: "TODO" is not a reason/);
  has(/exceptions\[1\]\.pattern: "\*-delete" is too broad/);
  has(/exceptions\[2\]\.pattern: "ab\*" is too broad/);
  has(/exceptions\[3\]: name exactly ONE/);
  has(/exceptions\[4\]\.testid: an exact id/);
  has(/exceptions\[5\]\.module: "nope"/);
  has(/exceptions\[5\]\.expires: an ISO date/);
  has(/exceptions\[5\]\.colour: unknown key/);
  has(/exceptions\[7\]: duplicate/);
  has(/exceptions\[8\]: name exactly ONE/);
  assert.deepEqual(loadExceptions(tmpApp({ 'coverage-exceptions.json': '{ nope' }), 'unit', []).errors.length, 1);
  const backlogErrors = loadBacklog(tmpApp({ 'coverage-baseline.json': { app: 'unit', created: 'yesterday', testids: ['a', 'a'], routes: [] } }), 'unit').errors.join('\n');
  assert.match(backlogErrors, /"created" must be the ISO date/);
  assert.match(backlogErrors, /lists a more than once/);
});

test('11 · the source block of a profile is validated strictly', () => {
  const e: string[] = [];
  parseSourceConfig({ repository: 'not a repo', include: [], routes: { strategy: 'gatsby' }, extra: 1 }, e);
  assert.ok(e.some((x) => x.startsWith('source.repository')));
  assert.ok(e.some((x) => x.startsWith('source.include')));
  assert.ok(e.some((x) => x.startsWith('source.routes.strategy')));
  assert.ok(e.some((x) => x.startsWith('source.extra: unknown key')));
  const e2: string[] = [];
  parseSourceConfig({ repository: 'o/r', include: ['../other-app/**'] }, e2);
  assert.ok(e2.some((x) => x.includes('relative to the app repo root')), 'a scan may not reach outside its repo');
  assert.ok(e2.some((x) => x.startsWith('source.routes: required')), 'no router must be said, not assumed');
});

// ─── routes ──────────────────────────────────────────────────────────────────

test('10 · route matching: static beats dynamic, catch-alls take the rest, param names do not matter', () => {
  const routes = ['/', '/course/edit', '/course/[id]', '/docs/[...slug]', '/help/[[...topic]]'].map((p) => ({ path: p, kind: 'page' as const, files: [] }));
  const m = (p: string) => matchRoute(p, routes)?.path ?? null;
  assert.equal(m('/course/edit'), '/course/edit');
  assert.equal(m('/course/42'), '/course/[id]');
  assert.equal(m('/course/*'), '/course/[id]', 'a {{VAR}} segment is a value, so the dynamic route wins');
  assert.equal(m('/docs'), null, '[...slug] needs at least one segment');
  assert.equal(m('/docs/a/b'), '/docs/[...slug]');
  assert.equal(m('/help'), '/help/[[...topic]]');
  assert.equal(m('/help/x/y'), '/help/[[...topic]]');
  assert.equal(m('/nowhere'), null);
  assert.equal(routeKey('/orders/[orderId]'), routeKey('/orders/[id]'));
  assert.equal(routeKey('/orders/:id'), routeKey('/orders/[id]'));
  assert.notEqual(routeKey('/docs/[...a]'), routeKey('/docs/[a]'));
  assert.deepEqual(nextConfigRedirects('n.ts', `export default { async redirects() { return [{ source: '/old/:id', destination: '/new/:id' }, { source: '/all/:p*', destination: '/' }]; } }`), ['/old/[id]', '/all/[[...p]]']);
  assert.equal(pathOf('{{APP_URL}}/menu?x=1#y'), '/menu');
  assert.equal(pathOf('/course/{{ID}}/'), '/course/*');
  assert.equal(pathOf('menu'), null);
});

// ─── source fencing helpers ──────────────────────────────────────────────────

test('12 · repository identity is read from any GitHub remote form; repo paths are per app', () => {
  assert.equal(repoSlug('https://github.com/Example-Org/Shop-App.git'), 'example-org/shop-app');
  assert.equal(repoSlug('git@github.com:Example-Org/Club.git'), 'example-org/club');
  assert.equal(repoSlug('http://local_proxy@127.0.0.1:1234/git/Example-Org/Club'), null);
  assert.equal(repoPathEnvName('my-app'), 'APP_REPO_PATH_MY_APP');
});

test('12 · the file walk never follows a symlink out of the app root', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-outside-'));
  fs.writeFileSync(path.join(outside, 'Secret.tsx'), '<button data-testid="other-app-button" />');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cov-root-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'Own.tsx'), '<button data-testid="own" />');
  fs.symlinkSync(path.join(outside, 'Secret.tsx'), path.join(root, 'src', 'Linked.tsx'));
  assert.deepEqual(listSourceFiles(root, ['src/**/*.tsx'], []), ['src/Own.tsx']);
});

// ─── run evidence ────────────────────────────────────────────────────────────

test('run evidence counts what a run actually pressed — and nothing from flows that did not run', () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-runs-'));
  const write = (runId: string, device: string, m: Record<string, unknown>) => {
    fs.mkdirSync(path.join(runs, runId, device), { recursive: true });
    fs.writeFileSync(path.join(runs, runId, device, `${m.module}-${m.flow}.flow-run.json`), JSON.stringify(m));
  };
  const step = (id: string, action: string, extra: Record<string, unknown>) => ({ id, action, phase: 'steps', status: 'ok', ...extra });
  write('2026-10-01T00-00-00Z', 'Mobile', {
    module: 'shop', flow: 'menu', device: 'Mobile', status: 'unchanged',
    steps: [
      step('010-add', 'click', { selector: 'role=button[name="Add"]', target_testid: 'menu-add', url_after: '/menu' }),
      step('020-delete', 'click', { selector: '[data-testid="menu-delete"]', status: 'failed' }),
      step('030-dish', 'click', { selector: '[data-testid="menu-item-d1"]' }),
    ],
  });
  // A later run SKIPPED the flow: the earlier evidence still stands.
  write('2026-10-02T00-00-00Z', 'Mobile', { module: 'shop', flow: 'menu', device: 'Mobile', status: 'skipped', steps: [] });
  const flows = [flow('shop', 'menu', [{ id: '010-add', action: 'click', selector: 'role=button[name="Add"]' }]), flow('shop', 'other', [{ id: '010-x', action: 'click', selector: '[data-testid="menu-delete"]' }])];
  const ev = loadRunEvidence(runs, flows);
  assert.equal(ev.withEvidence, 1);
  assert.deepEqual(ev.withoutEvidence, ['shop/other'], 'a flow with no run contributes nothing, its manifest is not taken on trust');
  const r = run(MENU, flows, { mode: 'run-evidence', coverageUsage: ev.usage });
  assert.deepEqual(keys(r.testids.coveredIds), ['menu-add', 'menu-item-*'], 'the role selector resolved to the element it hit; the failed step counts for nothing');
  assert.ok(r.testids.newUncovered.some((i) => i.key === 'menu-delete'));
});

test('parseSelector splits descendant chains and recognises each selector form', () => {
  const t = parseSelector('[data-testid="a"] role=button[name="Save Draft"]');
  assert.equal(t.length, 2);
  assert.equal(t[0].kind, 'testid');
  assert.equal(t[1].kind, 'role');
  const v = parseSelector('[data-testid^="row-{{ID}}-"]')[0];
  assert.ok(v.kind === 'testid' && v.op === '^=' && v.value === 'row-*-' && v.hasVars);
});
