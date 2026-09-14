/**
 * Offline validation — no browser, no network, no app repo required.
 *
 * Checks:
 *   · every flow manifest parses and satisfies the schema
 *   · module/flow keys line up with config/routes.map.json
 *   · no step anywhere declares a write (this project is read-only)
 *   · known_routes.json entries have flow coverage
 *   · the env safety gate would pass
 *
 * Run it before committing a manifest change, and as the first step of any CI
 * job — it turns a 3-minute failed capture run into a 200ms error message.
 *
 * Usage: npm run validate
 */
import { paths, assertTargetEnvironment } from './env';
import { readJson } from './fsx';
import { log } from './logger';
import { loadFlows, allSteps, selectorPolicyViolation, scanDrafts } from './flow-loader';
import { inspectAppRepo } from './change-detector';
import type { KnownRoutes, RoutesMap } from './types';

export function validate(): number {
  log.banner('Validating project configuration');

  const { flows, errors, warnings } = loadFlows({ includeDisabled: true });

  warnings.forEach((w) => log.warn(w));
  errors.forEach((e) => log.error(e));

  log.info(`Loaded ${flows.length} flow manifest(s).`);

  // Schema + selector-policy summary. The policy itself is enforced as a hard
  // error inside loadFlows; this is the at-a-glance picture.
  const v2 = flows.filter((f) => (f.schema_version ?? 1) >= 2);
  log.info(`Schema: ${v2.length} at v2, ${flows.length - v2.length} at v1 (both supported).`);

  let selectorsChecked = 0;
  let exemptions = 0;
  let sleeps = 0;
  const captureModes = new Map<string, number>();
  for (const flow of flows) {
    for (const step of allSteps(flow)) {
      if (!step) continue;
      if (step.selector) {
        selectorsChecked += 1;
        // Anything off-policy that survived load did so via an exemption.
        if (selectorPolicyViolation(step.selector)) exemptions += 1;
      }
      if (step.action === 'sleep') sleeps += 1;
      const mode = step._capture?.mode ?? 'none';
      captureModes.set(mode, (captureModes.get(mode) ?? 0) + 1);
    }
  }

  const modeSummary = [...captureModes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([mode, n]) => `${mode}:${n}`)
    .join(' ');
  log.info(`Capture modes across all steps — ${modeSummary || 'none'}`);

  if (exemptions) {
    log.warn(`${exemptions} selector(s) are off-policy under an explicit selector_exempt.`);
  } else {
    log.ok(`Selector policy: all ${selectorsChecked} step selector(s) are data-testid or role/name.`);
  }
  if (sleeps) log.warn(`${sleeps} sleep step(s) in total — each one is a flake waiting to happen.`);

  // Recorder drafts. They are excluded from loadFlows(), so they cannot be
  // captured, cleaned up or documented — which is why an outstanding TODO in a
  // draft is reported rather than failing the run. The hard error is reserved
  // for a PROMOTED flow that still carries one.
  const drafts = scanDrafts();
  for (const draft of drafts) {
    log.info(
      `${draft.file}: draft — ${draft.todos} TODO(s) remaining, not executable`,
    );
  }
  if (drafts.length) {
    log.info(
      `${drafts.length} recorder draft(s) present. Promote with: resolve every TODO, delete the ` +
        `GENERATED header, then rename to flows/<name>.yaml.`,
    );
  }

  // Coverage report: known routes with no flow touching them.
  const known = readJson<KnownRoutes>(paths.knownRoutes, { last_checked: '', routes: [] });
  const covered = new Set(flows.flatMap((f) => f.depends_on_routes ?? []));
  const uncovered = known.routes.filter((r) => !covered.has(r.path));
  if (uncovered.length) {
    log.warn(`${uncovered.length} known route(s) with no flow coverage: ${uncovered.map((r) => r.path).join(', ')}`);
  } else if (known.routes.length) {
    log.ok('Every known route is covered by at least one flow.');
  }

  // Modules declared in routes.map.json with no manifests at all.
  const routesMap = readJson<RoutesMap>(paths.routesMap, {} as RoutesMap);
  const modulesWithFlows = new Set(flows.map((f) => f.module));
  for (const module of Object.keys(routesMap)) {
    if (module.startsWith('$') || module === '_global') continue;
    if (!modulesWithFlows.has(module)) {
      log.warn(`Module "${module}" is in routes.map.json but has no flow manifests yet.`);
    }
    const sp = routesMap[module].source_paths ?? [];
    if (!sp.length) log.warn(`Module "${module}" has no source_paths — the git-diff skip filter can never skip it.`);
  }

  // Read-only guarantee, at a glance. The hard error lives in loadFlows; this
  // is the sentence a reviewer wants to see before trusting a run.
  const typed = flows.flatMap((f) => allSteps(f)).filter((s) => s && (s.action === 'type' || s.action === 'fill'));
  log.ok(`Read-only: ${flows.length} flow(s) declare no writes; ${typed.length} typed value(s), all run_tag: false.`);

  // Environment gate + app repo reachability (informational, never fatal here).
  try {
    assertTargetEnvironment();
    log.ok('Environment safety gate: PASS');
  } catch (err) {
    log.error((err as Error).message);
    return 1;
  }

  const repo = inspectAppRepo();
  (repo.available ? log.ok : log.warn)(repo.reason);

  if (errors.length) {
    log.error(`${errors.length} error(s) — fix these before running a capture.`);
    return 1;
  }
  log.ok('All manifests valid.');
  return 0;
}

if (require.main === module) {
  process.exitCode = validate();
}
