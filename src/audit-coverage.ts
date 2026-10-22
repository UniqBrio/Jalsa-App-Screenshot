/**
 * The coverage audit across one app or every registered app.
 *
 *   npm run audit:coverage -- --app all
 *   npm run audit:coverage -- --app my-app
 *   npm run audit:coverage -- --app my-app --evidence     (coverage from recorded runs)
 *
 * For each app, in order — each step reads only that app's profile and source:
 *
 *   1. config     app.config.json, login adapter, source block, routes.map.json,
 *                 known_routes.json, coverage exceptions and backlog all parse
 *   2. inventory  the app's clone is found, is the right repository, and the scan
 *                 read files (a scan that read nothing is BLOCKED, never PASS)
 *   3. test ids   every interactive element is exercised, excepted, or on the backlog
 *   4. pages      every page is registered, still exists, and is visited
 *   5. flows      `npm run validate` for the app (schema, selectors, write rules, host gate)
 *   6. summary    reports/audit-summary.{json,md}; the Markdown is appended to the
 *                 GitHub job summary when $GITHUB_STEP_SUMMARY is set
 *
 * Exit code: 2 if any app is misconfigured, else 1 if any FAILED, else 3 if any
 * was BLOCKED (could not run), else 0. Nothing here accepts a baseline, writes
 * an exception, touches an app repo, or opens a browser — integration mode is a
 * capture run (`npm run capture`) followed by this audit with --evidence.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ROOT, resetAppContext, currentApp } from './env';
import { listProfiles } from './profile';
import { createLoginAdapter } from './login-adapters';
import { writeJson, writeText } from './fsx';
import { log } from './logger';
import { auditCurrentApp, EXIT, reportPath, reportsDir, type AppAuditResult } from './coverage/audit-app';
import { renderText, renderMarkdown } from './coverage/render';
import { loadExceptions, loadBacklog } from './coverage/exceptions';
import { validate } from './validate';
import type { CoverageReport } from './coverage/engine';

type StepVerdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIPPED';
interface Step { name: string; verdict: StepVerdict; detail: string }
interface AppSummary { app: string; verdict: 'PASS' | 'FAIL' | 'BLOCKED' | 'CONFIG'; steps: Step[]; blocking: number; report: string | null }


function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

/** Registered apps: every profile folder except the template. */
export function registeredApps(): string[] {
  return listProfiles(ROOT).filter((id) => !id.startsWith('_'));
}

/**
 * Selects one app for env.ts. `--app` is removed from argv first, because
 * argv outranks APP in app selection and would pin every iteration to "all".
 */
function selectApp(id: string): void {
  const argv = process.argv;
  for (let i = argv.length - 1; i >= 0; i--) {
    if (argv[i] === '--app') argv.splice(i, 2);
    else if (argv[i].startsWith('--app=')) argv.splice(i, 1);
  }
  process.env.APP = id;
  resetAppContext();
}

/** Runs fn with console output captured, so validate()'s log lands in the report, not the summary. */
function captured<T>(fn: () => T): { value: T; lines: string[] } {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const grab = (...a: unknown[]) => lines.push(a.map(String).join(' '));
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  try {
    return { value: fn(), lines };
  } finally {
    Object.assign(console, orig);
  }
}

function configStep(id: string): Step {
  const problems: string[] = [];
  try {
    const { profile } = currentApp();
    problems.push(...createLoginAdapter(profile).configErrors().map((e) => `app.config.json: ${e}`));
    if (!profile.source) problems.push('app.config.json has no "source" block (coverage has nothing to read)');
    const routesFile = path.join(profile.dir, 'config', 'routes.map.json');
    const modules = fs.existsSync(routesFile)
      ? Object.keys(JSON.parse(fs.readFileSync(routesFile, 'utf8'))).filter((m) => !m.startsWith('$'))
      : [];
    problems.push(...loadExceptions(profile.dir, id, modules).errors, ...loadBacklog(profile.dir, id).errors);
  } catch (err) {
    problems.push((err as Error).message);
  }
  return { name: 'config', verdict: problems.length ? 'FAIL' : 'PASS', detail: problems.join(' · ') || 'profile, source block, inventories, exceptions and backlog parse' };
}

function testidStep(r: CoverageReport): Step {
  const t = r.testids;
  const bad = t.newUncovered.length + t.staleReferences.length + r.backlog.resolved.filter((x) => x.entry.startsWith('testid:')).length +
    r.exceptions.unneeded.filter((u) => !u.exception.startsWith('route:')).length + r.exceptions.expired.filter((x) => !x.route).length;
  return {
    name: 'test ids',
    verdict: bad ? 'FAIL' : 'PASS',
    detail: `${t.covered}/${t.required} exercised (${t.coveragePercent}%) · NEW ${t.newUncovered.length} · stale refs ${t.staleReferences.length} · backlog ${t.existingUncovered.length} · excepted ${t.excepted.length}`,
  };
}

function pagesStep(r: CoverageReport): Step {
  const ro = r.routes;
  if (ro.strategy === 'none') return { name: 'pages', verdict: 'SKIPPED', detail: 'source.routes.strategy is "none" — declared, not assumed' };
  const bad = ro.newUnregistered.length + ro.removed.length + ro.newUncovered.length + ro.unmatchedVisits.length +
    r.backlog.resolved.filter((x) => x.entry.startsWith('route:')).length + r.exceptions.unneeded.filter((u) => u.exception.startsWith('route:')).length +
    r.exceptions.expired.filter((x) => x.route).length;
  return {
    name: 'pages',
    verdict: bad ? 'FAIL' : 'PASS',
    detail: `${ro.covered}/${ro.pages} visited · NEW unregistered ${ro.newUnregistered.length} · removed ${ro.removed.length} · NEW uncovered ${ro.newUncovered.length} · backlog ${ro.existingUncovered.length}`,
  };
}

function auditOne(id: string, opts: { evidence: boolean; run?: string; verbose: boolean }): AppSummary {
  selectApp(id);
  log.banner(`audit:coverage — ${id}`);
  const steps: Step[] = [];

  const config = configStep(id);
  steps.push(config);
  // A profile that does not even parse: nothing else can run against it.
  if (!profileLoads()) {
    log.error(`${id}: ${config.detail}`);
    return { app: id, verdict: 'CONFIG', steps, blocking: 0, report: null };
  }
  if (config.verdict === 'FAIL') log.error(`${id}: ${config.detail}`);

  const res: AppAuditResult = auditCurrentApp({ evidence: opts.evidence, run: opts.run });
  if (!res.report) {
    const v: StepVerdict = res.verdict === 'CONFIG' ? 'FAIL' : 'BLOCKED';
    steps.push({ name: 'inventory', verdict: v, detail: res.problems.join(' · ') });
    for (const p of res.problems) (v === 'BLOCKED' ? log.warn : log.error)(`${id}: ${p}`);
    const flows = flowStep();
    steps.push(flows);
    const verdict = res.verdict === 'CONFIG' || config.verdict === 'FAIL' ? 'CONFIG' : 'BLOCKED';
    return { app: id, verdict, steps, blocking: 0, report: null };
  }

  const r = res.report;
  steps.push({
    name: 'inventory',
    verdict: 'PASS',
    detail: `${r.testids.inventory.filesParsed} files · ${r.testids.inventory.ids} test ids · ${r.routes.discovered} routes · ${r.source?.repository}@${r.source?.commit?.slice(0, 10) ?? '?'}`,
  });
  steps.push(testidStep(r));
  steps.push(pagesStep(r));
  const flows = flowStep();
  steps.push(flows);

  console.log(renderText(r, { verbose: opts.verbose }));
  const file = reportPath(id);
  writeJson(file, r);

  const failed = config.verdict === 'FAIL' || r.verdict === 'FAIL' || flows.verdict === 'FAIL';
  return { app: id, verdict: config.verdict === 'FAIL' ? 'CONFIG' : failed ? 'FAIL' : 'PASS', steps, blocking: r.blocking.length, report: file };
}

function profileLoads(): boolean {
  try {
    currentApp();
    return true;
  } catch {
    return false;
  }
}

function flowStep(): Step {
  const { value, lines } = captured(() => {
    try {
      return validate();
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
  });
  const errors = lines.filter((l) => / ✗ /.test(l)).map((l) => l.replace(/^\[[0-9:]+\] ✗ /, ''));
  for (const e of errors) log.error(`validate: ${e}`);
  return { name: 'flows', verdict: value === 0 ? 'PASS' : 'FAIL', detail: value === 0 ? 'npm run validate: all manifests valid' : errors.slice(0, 5).join(' · ') || 'npm run validate failed' };
}

function summaryMarkdown(rows: AppSummary[], reports: CoverageReport[]): string {
  const icon = (v: string) => ({ PASS: '✅', FAIL: '❌', BLOCKED: '⛔', CONFIG: '⚙️', SKIPPED: '➖' } as Record<string, string>)[v] ?? v;
  const out = ['## Coverage audit', '', '| app | verdict | config | inventory | test ids | pages | flows |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const s = (n: string) => r.steps.find((x) => x.name === n)?.verdict ?? 'SKIPPED';
    out.push(`| \`${r.app}\` | ${icon(r.verdict)} ${r.verdict} | ${icon(s('config'))} | ${icon(s('inventory'))} | ${icon(s('test ids'))} | ${icon(s('pages'))} | ${icon(s('flows'))} |`);
  }
  for (const r of rows.filter((x) => x.verdict === 'BLOCKED' || x.verdict === 'CONFIG')) {
    out.push('', `**${r.app} — ${r.verdict}:** ${r.steps.filter((s) => s.verdict !== 'PASS').map((s) => `${s.name}: ${s.detail}`).join(' · ')}`);
  }
  for (const rep of reports) out.push('', renderMarkdown(rep));
  return out.join('\n') + '\n';
}

export function main(): number {
  const which = arg('--app') ?? process.env.APP;
  const evidence = process.argv.includes('--evidence');
  const verbose = process.argv.includes('--verbose');
  const run = arg('--run');
  const apps = registeredApps();
  if (!which) {
    log.error(`Pass --app <app-id> or --app all. Registered: ${apps.join(', ') || '(none)'}`);
    return 2;
  }
  const targets = which === 'all' ? apps : [which];
  if (!targets.length) {
    log.error('No apps registered under apps/ (copy apps/_template to apps/<app-id>).');
    return 2;
  }

  const rows: AppSummary[] = [];
  const reports: CoverageReport[] = [];
  for (const id of targets) {
    const row = auditOne(id, { evidence, run, verbose });
    rows.push(row);
    if (row.report) reports.push(JSON.parse(fs.readFileSync(row.report, 'utf8')) as CoverageReport);
  }

  console.log('\n' + '═'.repeat(78));
  console.log(' AUDIT SUMMARY');
  for (const r of rows) {
    console.log(`  ${r.verdict.padEnd(8)} ${r.app}${r.blocking ? ` — ${r.blocking} blocking finding(s)` : ''}`);
    for (const s of r.steps) console.log(`      ${s.verdict.padEnd(8)} ${s.name.padEnd(10)} ${s.detail}`);
  }
  console.log('═'.repeat(78));

  const summary = { generatedAt: new Date().toISOString(), mode: evidence ? 'run-evidence' : 'static', apps: rows };
  writeJson(path.join(reportsDir(), 'audit-summary.json'), summary);
  const md = summaryMarkdown(rows, reports);
  writeText(path.join(reportsDir(), 'audit-summary.md'), md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  log.info(`Reports: ${path.relative(process.cwd(), reportsDir()) || '.'}/audit-summary.{json,md} and <app>/coverage.json`);

  const has = (v: AppSummary['verdict']) => rows.some((r) => r.verdict === v);
  return has('CONFIG') ? EXIT.CONFIG : has('FAIL') ? EXIT.FAIL : has('BLOCKED') ? EXIT.BLOCKED : EXIT.PASS;
}

if (require.main === module) {
  process.exitCode = main();
}
