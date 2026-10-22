/**
 * Test-id and page coverage for ONE app — static, offline, no browser.
 *
 *   npm run coverage -- --app <id>                    the check (exit 0 PASS · 1 FAIL · 2 CONFIG · 3 BLOCKED)
 *   npm run coverage -- --app <id> --evidence         count coverage from recorded runs, not manifests
 *   npm run coverage -- --app <id> --evidence --run <run-id>
 *   npm run coverage -- --app <id> --source <path>    audit this clone of the app repo
 *   npm run coverage -- --app <id> --json <file>      where the JSON report goes (default reports/<id>/coverage.json)
 *   npm run coverage -- --app <id> --verbose          list backlog, exceptions, unresolved ids, non-page files
 *
 * Explicit, human-invoked maintenance (never part of a normal run):
 *
 *   --register-routes   append pages found in the source but missing from known_routes.json
 *                       (adds only; review the diff — then give each page a flow)
 *   --init-baseline     create the adoption backlog from what is uncovered TODAY; refuses
 *                       when one exists, because the backlog may never grow
 *   --shrink-baseline   remove backlog entries that are now covered or gone; never adds
 *
 * Exceptions (config/coverage-exceptions.json) are only ever written by a
 * person. Nothing here creates or edits one.
 */
import * as fs from 'fs';
import * as path from 'path';
import { paths, currentApp } from './env';
import { writeJson, readJson } from './fsx';
import { log } from './logger';
import { auditCurrentApp, EXIT, reportPath, type AppAuditResult } from './coverage/audit-app';
import { renderText } from './coverage/render';
import { backlogCandidates } from './coverage/engine';
import { loadBacklog, writeBacklog, backlogPath } from './coverage/exceptions';
import { routeLabel } from './coverage/route-scan';
import type { KnownRoutes } from './types';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}
const flag = (name: string) => process.argv.includes(name);

function printProblems(r: AppAuditResult): void {
  const head = r.verdict === 'CONFIG' ? 'CONFIGURATION ERROR' : 'BLOCKED — the check did not run';
  log.error(`${r.app}: ${head}`);
  for (const p of r.problems) log.error(`  ${p}`);
}

function registerRoutes(r: AppAuditResult): number {
  const added = r.report?.routes.newUnregistered ?? [];
  if (!added.length) {
    log.ok('known_routes.json already lists every page in the source.');
    return 0;
  }
  const file = paths.knownRoutes;
  const known = readJson<KnownRoutes & Record<string, unknown>>(file, { last_checked: '', routes: [] });
  known.routes = known.routes ?? [];
  for (const p of added) {
    known.routes.push({ path: p.path, label: routeLabel(p.path), tab: false, module: p.module, source: p.files[0] });
    log.ok(`registered ${p.path} (${p.module}) — ${p.files[0]}`);
  }
  writeJson(file, known);
  log.warn(`${added.length} page(s) added to apps/${r.app}/config/known_routes.json. Review the labels and modules, then give each a flow.`);
  return 0;
}

function initBaseline(): number {
  const appId = currentApp().profile.id;
  if (fs.existsSync(backlogPath(paths.app))) {
    log.error(
      `apps/${appId}/config/coverage-baseline.json already exists. The adoption backlog is taken once and may only shrink — ` +
        `use --shrink-baseline. A new uncovered element needs a flow, or a reasoned entry in coverage-exceptions.json.`,
    );
    return 1;
  }
  const r = auditCurrentApp({ ignoreBacklog: true, sourcePath: arg('--source') });
  if (!r.report) {
    printProblems(r);
    return EXIT[r.verdict];
  }
  const c = backlogCandidates(r.report);
  writeBacklog(paths.app, { app: appId, created: new Date().toISOString().slice(0, 10), testids: c.testids, routes: c.routes });
  log.warn(
    `Adoption backlog written: ${c.testids.length} test id(s), ${c.routes.length} page(s) → apps/${appId}/config/coverage-baseline.json. ` +
      `This records DEBT, not approval: every report lists it, and it can only shrink. Commit it as its own reviewed change.`,
  );
  return 0;
}

function shrinkBaseline(): number {
  const appId = currentApp().profile.id;
  const { file, errors } = loadBacklog(paths.app, appId);
  if (!file) {
    log.error(`apps/${appId}/config/coverage-baseline.json does not exist — nothing to shrink.`);
    return 1;
  }
  if (errors.length) {
    errors.forEach((e) => log.error(e));
    return 1;
  }
  const r = auditCurrentApp({ sourcePath: arg('--source') });
  if (!r.report) {
    printProblems(r);
    return EXIT[r.verdict];
  }
  const gone = new Set(r.report.backlog.resolved.map((x) => x.entry));
  const testids = file.testids.filter((k) => !gone.has(`testid:${k}`));
  const routes = file.routes.filter((k) => !gone.has(`route:${k}`));
  const removed = file.testids.length - testids.length + (file.routes.length - routes.length);
  writeBacklog(paths.app, { ...file, testids, routes });
  for (const x of r.report.backlog.resolved) log.ok(`removed ${x.entry} — ${x.why}`);
  log.ok(`Backlog shrank by ${removed}: ${testids.length} test id(s), ${routes.length} page(s) remain.`);
  return 0;
}

export function main(): number {
  const mutating = ['--register-routes', '--init-baseline', '--shrink-baseline'].filter(flag);
  if (mutating.length > 1) {
    log.error(`Use one of ${mutating.join(', ')} at a time.`);
    return 2;
  }
  if ((process.argv.includes('--app') && arg('--app') === 'all') || process.env.APP === 'all') {
    log.error('coverage checks one app. For every app use: npm run audit:coverage -- --app all');
    return 2;
  }
  if (flag('--init-baseline')) return guard(initBaseline);
  if (flag('--shrink-baseline')) return guard(shrinkBaseline);

  const r = guard(() => auditCurrentApp({ sourcePath: arg('--source'), evidence: flag('--evidence'), run: arg('--run') }));
  if (typeof r === 'number') return r;
  if (!r.report) {
    printProblems(r);
    return EXIT[r.verdict];
  }
  if (flag('--register-routes')) return registerRoutes(r);

  console.log(renderText(r.report, { verbose: flag('--verbose') }));
  const out = arg('--json') ? path.resolve(arg('--json')!) : reportPath(r.app);
  writeJson(out, r.report);
  log.info(`JSON report: ${path.relative(process.cwd(), out) || out}`);
  return EXIT[r.verdict];
}

/** A broken profile is a configuration error with a message, never a stack trace. */
function guard<T>(fn: () => T): T | number {
  try {
    return fn();
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main() as number;
}
