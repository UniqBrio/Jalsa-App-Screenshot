/**
 * One app's coverage audit, end to end — for whichever app env.ts has selected.
 *
 *   config  → the profile parses and has a `source` block; exceptions, backlog,
 *             routes.map.json and known_routes.json parse
 *   source  → the clone is found and is the right repository (source-root.ts)
 *   scan    → test ids and pages, read from that clone only
 *   flows   → the app's executable manifests (drafts and disabled flows excluded)
 *   compare → engine.ts
 *
 * No browser is launched. The app repo is only read.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { currentApp, paths, ROOT } from '../env';
import { loadFlows } from '../flow-loader';
import { matchesAny } from '../change-detector';
import { resolveSourceRoot, listSourceFiles, readSourceFile, SourceUnavailable } from './source-root';
import { scanTestIds } from './testid-scan';
import { scanRoutes, routeGlobs } from './route-scan';
import { flowUsages } from './flow-usage';
import { loadExceptions, loadBacklog } from './exceptions';
import { loadRunEvidence } from './run-evidence';
import { compare, type CoverageReport } from './engine';
import type { AppProfile } from '../profile';
import type { KnownRoutes, RoutesMap } from '../types';

export type AppVerdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'CONFIG';

/** 0 PASS · 1 FAIL · 2 CONFIG (misconfigured) · 3 BLOCKED (could not run — never a pass). */
export const EXIT: Record<AppVerdict, number> = { PASS: 0, FAIL: 1, CONFIG: 2, BLOCKED: 3 };

/** reports/ (gitignored), or REPORTS_DIR — tests and CI can point it elsewhere. */
export function reportsDir(): string {
  return process.env.REPORTS_DIR ? path.resolve(process.env.REPORTS_DIR) : path.join(ROOT, 'reports');
}

export function reportPath(appId: string): string {
  return path.join(reportsDir(), appId, 'coverage.json');
}

export interface AppAuditResult {
  app: string;
  verdict: AppVerdict;
  /** Why the check could not run (BLOCKED) or what is misconfigured (CONFIG). */
  problems: string[];
  report: CoverageReport | null;
}

export interface AppAuditOptions {
  sourcePath?: string;
  /** Count coverage from recorded runs instead of manifests. */
  evidence?: boolean;
  /** With evidence: only this run id. */
  run?: string;
  /** Ignore the adoption backlog (used to compute a fresh one). */
  ignoreBacklog?: boolean;
}

function readJsonStrict<T>(file: string, rel: string, fallback: T, errors: string[]): T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    errors.push(`${rel}: not valid JSON — ${(err as Error).message}`);
    return fallback;
  }
}

/** Structural checks on the two inventories, so the comparison never reads garbage. */
export function inventoryErrors(appId: string, routesMap: unknown, known: unknown): string[] {
  const e: string[] = [];
  if (routesMap && (typeof routesMap !== 'object' || Array.isArray(routesMap))) e.push(`apps/${appId}/config/routes.map.json: must be an object of modules`);
  else {
    for (const [m, v] of Object.entries((routesMap ?? {}) as Record<string, any>)) {
      if (m.startsWith('$')) continue;
      if (!v || !Array.isArray(v.source_paths) || !Array.isArray(v.flows)) e.push(`apps/${appId}/config/routes.map.json: module "${m}" needs "flows" and "source_paths" arrays`);
    }
  }
  const k = known as KnownRoutes | null;
  if (k && (!Array.isArray(k.routes) || !k.routes.every((r) => r && typeof r.path === 'string' && r.path.startsWith('/')))) {
    e.push(`apps/${appId}/config/known_routes.json: "routes" must be an array of { "path": "/…" }`);
  } else if (k) {
    k.routes.forEach((r, i) => {
      if (r.kind !== undefined && r.kind !== 'page' && r.kind !== 'virtual') e.push(`apps/${appId}/config/known_routes.json: routes[${i}].kind must be "page" or "virtual"`);
    });
  }
  return e;
}

function gitHead(root: string): string | null {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function auditCurrentApp(opts: AppAuditOptions = {}): AppAuditResult {
  let profile: AppProfile;
  try {
    profile = currentApp().profile;
  } catch (err) {
    return { app: process.env.APP ?? '?', verdict: 'CONFIG', problems: [(err as Error).message], report: null };
  }
  const id = profile.id;
  const configErrors: string[] = [];
  const routesMap = readJsonStrict<RoutesMap>(paths.routesMap, `apps/${id}/config/routes.map.json`, {} as RoutesMap, configErrors);
  const knownRoutes = readJsonStrict<KnownRoutes>(paths.knownRoutes, `apps/${id}/config/known_routes.json`, { last_checked: '', routes: [] }, configErrors);
  configErrors.push(...inventoryErrors(id, routesMap, knownRoutes));
  if (configErrors.length) return { app: id, verdict: 'CONFIG', problems: configErrors, report: null };

  if (!profile.source) {
    return {
      app: id,
      verdict: 'BLOCKED',
      problems: [`apps/${id}/app.config.json has no "source" block — coverage and page checks have nothing to read. See apps/_template/app.config.json.`],
      report: null,
    };
  }

  let src;
  try {
    src = resolveSourceRoot(profile, opts.sourcePath);
  } catch (err) {
    if (err instanceof SourceUnavailable) return { app: id, verdict: 'BLOCKED', problems: [err.message], report: null };
    throw err;
  }

  const cfg = profile.source;
  const routeFileGlobs = routeGlobs(cfg.routes);
  const allFiles = listSourceFiles(src.root, [...cfg.include, ...routeFileGlobs], cfg.exclude);
  const scanFiles = allFiles.filter((f) => matchesAny(f, cfg.include));
  const read = (rel: string) => readSourceFile(src!.root, rel);
  const scan = scanTestIds({ root: src.root, files: scanFiles, attributes: cfg.testIdAttributes, interactive: cfg.interactive, read });
  const routeScan = scanRoutes(cfg.routes, allFiles, read);

  // A scan that read nothing looks exactly like a clean app. It is not a pass.
  const blocked: string[] = [];
  if (scan.filesParsed === 0) {
    blocked.push(`the test-id scan parsed 0 files under ${src.root} — source.include (${cfg.include.join(', ')}) matches nothing. A scan that read nothing is not a pass.`);
  }
  if (cfg.routes.strategy !== 'none' && routeScan.filesConsidered === 0) {
    blocked.push(`the page scan found no route files under ${cfg.routes.appDir}/ — check source.routes.appDir.`);
  }
  if (blocked.length) return { app: id, verdict: 'BLOCKED', problems: blocked, report: null };

  const { flows, errors: flowErrors } = loadFlows();
  const staticUsage = flowUsages(flows);
  let coverageUsage = staticUsage;
  let evidence: { withEvidence: number; withoutEvidence: string[]; runs: string[] } | undefined;
  if (opts.evidence) {
    const ev = loadRunEvidence(path.join(ROOT, 'runs', id), flows, opts.run);
    coverageUsage = ev.usage;
    evidence = { withEvidence: ev.withEvidence, withoutEvidence: ev.withoutEvidence, runs: ev.runs };
  }

  const modules = Object.keys(routesMap).filter((m) => !m.startsWith('$'));
  const exc = loadExceptions(profile.dir, id, modules);
  const bl = opts.ignoreBacklog ? { file: null, errors: [] } : loadBacklog(profile.dir, id);

  const report = compare({
    appId: id,
    appName: profile.appName,
    today: new Date().toISOString().slice(0, 10),
    mode: opts.evidence ? 'run-evidence' : 'static',
    source: { repository: cfg.repository, root: src.root, origin: src.origin, identity: src.identity, commit: gitHead(src.root), notes: src.notes },
    scan,
    routeScan,
    staticUsage,
    coverageUsage,
    flowsExecutable: flows.length,
    flowErrors,
    evidence,
    routesMap,
    knownRoutes,
    exceptions: exc.file,
    exceptionErrors: exc.errors,
    backlog: bl.file,
    backlogErrors: bl.errors,
  });
  if (evidence && evidence.withoutEvidence.length) {
    report.notes.push(`${evidence.withoutEvidence.length} flow(s) have no recorded run, so contribute no coverage in evidence mode: ${evidence.withoutEvidence.join(', ')}`);
  }
  if (!evidence && flows.length === 0) report.notes.push('No executable flows yet — every interactive element and page is uncovered.');
  return { app: id, verdict: report.verdict, problems: [], report };
}
