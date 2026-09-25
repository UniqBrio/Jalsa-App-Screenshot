/**
 * Orchestrator — the entry point for `npm run capture`.
 *
 * Order of operations:
 *   1. Safety gate (RosiFit host only)      — env.ts
 *   2. Load + validate every flow manifest  — flow-loader.ts  (fails fast)
 *   3. Inspect the app repo, compute diff   — change-detector.ts
 *   4. Authenticate once per identity       — login.ts
 *   5. Execute the flows that need running  — flow-executor.ts
 *   6. Persist baseline + last-run state
 *   7. Prune old runs/                      — retention policy
 *   8. Write the run summary
 *
 * There is no cleanup step. This project is READ-ONLY against the live app:
 * validate refuses any flow that declares a write, so there is never
 * anything to sweep.
 *
 * Flags:
 *   --force              run every flow, ignoring the git-diff skip filter
 *   --module <name>      restrict to one module (repeatable)
 *   --flow <mod/flow>    restrict to one flow (repeatable)
 *   --dry-run            plan only: no browser, no writes to the app
 *   --update-baseline    accept the current DOM as the new fingerprint baseline
 *   --headed             run with a visible browser (overrides HEADLESS)
 *   --evidence           user-manual evidence run (npm run capture:evidence): every
 *                        selected flow runs, all output goes to evidence/<run_id>/,
 *                        and screenshots/, runs/, the fingerprint baseline and
 *                        last-run state are never written or pruned
 */
import * as path from 'path';
import { Browser, BrowserContext } from '@playwright/test';
import { env, paths, appHost, assertTargetEnvironment } from './env';
import { readJson, writeJson, relPosix } from './fsx';
import { log } from './logger';
import { loadFlows } from './flow-loader';
import { launchBrowser, newContext } from './browser';
import { loadDevicesConfig, resolveDevices, devicesForFlow, type DeviceProfile } from './devices';
import { getAuthenticatedContext, authPreflight, Identity } from './login';
import { executeFlow } from './flow-executor';
import { loadBaseline, saveBaseline } from './fingerprint';
import { ChangeDetector, inspectAppRepo, loadLastRun, saveLastRun } from './change-detector';
import { pruneRuns } from './prune-runs';
import { EvidenceSink, evidenceDirInUse } from './manual/evidence-capture';
import { loadPiiConfig } from './manual/pii-config';
import { evidenceRoutes } from './manual/evidence-sanitize';
import type { Flow, FlowRun, KnownRoutes, RunSummary } from './types';

interface Args {
  force: boolean;
  dryRun: boolean;
  updateBaseline: boolean;
  headed: boolean;
  evidence: boolean;
  modules: string[];
  flows: string[];
  /** --device <id>, repeatable. Empty means "ask, or fall back to the configured default". */
  devices: string[];
  allDevices: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { force: false, dryRun: false, updateBaseline: false, headed: false, evidence: false, modules: [], flows: [], devices: [], allDevices: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--force': a.force = true; break;
      case '--evidence': a.evidence = true; break;
      case '--dry-run': a.dryRun = true; break;
      case '--update-baseline': a.updateBaseline = true; break;
      case '--headed': a.headed = true; break;
      case '--no-cleanup': log.warn('--no-cleanup is meaningless here — this project never writes, so it never cleans up.'); break;
      case '--module': a.modules.push(argv[++i]); break;
      case '--flow': a.flows.push(argv[++i]); break;
      case '--device': a.devices.push(argv[++i]); break;
      case '--all-devices': a.allDevices = true; break;
      default:
        if (argv[i].startsWith('--')) log.warn(`Unknown flag ${argv[i]} — ignored.`);
    }
  }
  return a;
}

function makeRunId(): string {
  // 2026-08-10T01-30-00Z — filesystem-safe and sorts correctly.
  return new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
}

/** The identity a flow signs in as. `none` means a fresh signed-out context. */
function identityOf(flow: Flow): Identity | 'none' {
  return flow.auth ?? 'admin';
}

/**
 * One authenticated context per identity, created on first use and shared by
 * every flow that needs it. `none` flows get their own throwaway context each
 * time: the sign-in journey must start signed OUT, and a session it creates
 * must not leak into the next signed-out flow (or into the admin context).
 */
class Contexts {
  // A context carries its viewport and user agent, so it is per identity AND per
  // device. The saved storageState is shared: a session is not per device.
  private shared = new Map<string, BrowserContext>();
  constructor(private browser: Browser) {}

  async for(flow: Flow, device: DeviceProfile): Promise<{ context: BrowserContext; ephemeral: boolean }> {
    const identity = identityOf(flow);
    if (identity === 'none') return { context: await newContext(this.browser, undefined, device), ephemeral: true };
    const key = `${identity}@${device.id}`;
    let ctx = this.shared.get(key);
    if (!ctx) {
      ctx = await getAuthenticatedContext(this.browser, identity, device);
      this.shared.set(key, ctx);
    }
    return { context: ctx, ephemeral: false };
  }

  async closeAll(): Promise<void> {
    for (const ctx of this.shared.values()) await ctx.close().catch(() => undefined);
    this.shared.clear();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.headed) process.env.HEADLESS = 'false';

  const runId = makeRunId();
  const startedAt = new Date();

  log.banner(`RosiFit ${args.evidence ? 'EVIDENCE' : 'screenshot'} capture — run ${runId}`);

  if (args.evidence && (args.dryRun || args.updateBaseline)) {
    log.error('--evidence cannot be combined with --dry-run or --update-baseline: an evidence run never touches the baseline.');
    return 1;
  }

  // ── 1. Safety gate ─────────────────────────────────────────────────────────
  assertTargetEnvironment();
  log.ok(`Target: ${env.appUrl}  (read-only)`);

  // ── 2. Flow manifests ──────────────────────────────────────────────────────
  let selectedDevices: DeviceProfile[];
  try {
    selectedDevices = await resolveDevices(loadDevicesConfig(), {
      requested: args.devices,
      all: args.allDevices,
      env: process.env.DEVICES,
    });
  } catch (err) {
    log.error((err as Error).message);
    return 1;
  }
  log.ok(`Devices: ${selectedDevices.map((d) => `${d.id} (${d.viewport.width}x${d.viewport.height} @${d.dpr}x)`).join(' · ')}`);

  const { flows: allFlows, errors, warnings } = loadFlows();
  warnings.forEach((w) => log.warn(w));
  if (errors.length) {
    log.error(`${errors.length} flow manifest error(s) — refusing to run:`);
    errors.forEach((e) => log.error(`  ${e}`));
    return 1;
  }

  let flows = allFlows;
  if (args.modules.length) flows = flows.filter((f) => args.modules.includes(f.module));
  if (args.flows.length) flows = flows.filter((f) => args.flows.includes(`${f.module}/${f.flow}`));

  // An identity whose credentials are missing takes its flows out of the run
  // with a reason, rather than failing them one by one at sign-in.
  const unavailable = new Map<Identity, string>();
  for (const identity of ['admin', 'staff'] as Identity[]) {
    const problem = authPreflight(identity);
    if (problem && flows.some((f) => identityOf(f) === identity)) unavailable.set(identity, problem);
  }
  const skippedForAuth = flows.filter((f) => unavailable.has(identityOf(f) as Identity));
  skippedForAuth.forEach((f) => log.skip(`${f.module}/${f.flow} — ${unavailable.get(identityOf(f) as Identity)}`));
  flows = flows.filter((f) => !unavailable.has(identityOf(f) as Identity));

  if (!flows.length) {
    log.warn('No flows selected. Nothing to do.');
    return 0;
  }
  log.ok(`${flows.length} flow(s) selected out of ${allFlows.length} loaded.`);

  // Evidence mode: its own output directory and PII config, set up before any
  // browser opens so a bad config fails in milliseconds.
  let sink: EvidenceSink | undefined;
  if (args.evidence) {
    const root = path.join(paths.evidence, runId);
    if (evidenceDirInUse(root)) {
      log.error(`Evidence directory ${relPosix(paths.root, root)} already has content — refusing to mix runs.`);
      return 1;
    }
    sink = new EvidenceSink({
      runId,
      root,
      knownRoutes: evidenceRoutes(readJson<KnownRoutes>(paths.knownRoutes, { last_checked: '', routes: [] }).routes, allFlows),
      pii: loadPiiConfig(),
      devices: selectedDevices,
    });
    log.ok(`Evidence mode → ${relPosix(paths.root, root)} (screenshots/, runs/ and fingerprints/ are not written)`);
  }


  // ── 3. Change detection ────────────────────────────────────────────────────
  const repo = inspectAppRepo();
  (repo.available ? log.ok : log.warn)(repo.reason);
  const lastRun = loadLastRun();
  // Evidence runs need every selected flow, whatever the skip filter thinks.
  const detector = new ChangeDetector(repo, lastRun, args.force || args.evidence);
  log.info(`Skip filter: ${detector.diffSummary}`);

  const decisions = flows.map((flow) => {
    const d = detector.decide(flow);
    if (!d.run && detector.hasNeverRun(flow)) {
      return { flow, run: true, reason: 'first run for this flow — establishing a baseline' };
    }
    return { flow, ...d };
  });

  const toRun = decisions.filter((d) => d.run);
  const skipped = decisions.filter((d) => !d.run);
  skipped.forEach((d) => log.skip(`${d.flow.module}/${d.flow.flow} — ${d.reason}`));

  if (!toRun.length) {
    log.ok('Nothing changed. No flows needed to run — that is the skip filter doing its job.');
  }

  // ── 4-5. Execute ───────────────────────────────────────────────────────────
  const baseline = loadBaseline();
  const results: FlowRun[] = [];

  if (toRun.length) {
    const browser = args.dryRun ? null : await launchBrowser();
    const contexts = browser ? new Contexts(browser) : null;
    try {
      for (const device of selectedDevices) {
        for (const { flow, reason } of toRun) {
          // A flow may declare which form factors it makes sense on.
          if (!devicesForFlow([device], flow.devices).length) {
            log.skip(`${device.id} · ${flow.module}/${flow.flow} — not declared for this device (devices: ${(flow.devices ?? []).join(', ')})`);
            continue;
          }
          log.banner(`${device.id} · ${flow.module}/${flow.flow}`);
          log.info(`Reason: ${reason}`);
          let ephemeral: BrowserContext | null = null;
          try {
            let context: BrowserContext | null = null;
            if (contexts) {
              const got = await contexts.for(flow, device);
              context = got.context;
              if (got.ephemeral) ephemeral = got.context;
            }
            const run = await executeFlow(context!, flow, {
              runId,
              device,
              appGitSha: repo.headSha,
              baseline,
              reason,
              dryRun: args.dryRun,
              updateBaseline: args.updateBaseline,
              evidence: sink,
            });
            results.push(run);
            const icon = run.status === 'failed' ? log.error : run.status === 'changed' ? log.warn : log.ok;
            icon(`${device.id} · ${flow.module}/${flow.flow} → ${run.status} (${run.screenshots.length} screenshot(s), ${run.duration_ms}ms)`);
          } catch (err) {
            log.error(`${device.id} · ${flow.module}/${flow.flow} crashed: ${(err as Error).message}`);
            results.push({
              module: flow.module, flow: flow.flow, device: device.id, run_id: runId, app_git_sha: repo.headSha,
              status: 'failed', reason, started_at: new Date().toISOString(), duration_ms: 0,
              steps: [], screenshots: [], errors: [(err as Error).message],
            });
          } finally {
            await ephemeral?.close().catch(() => undefined);
          }
        }
      }
    } finally {
      await contexts?.closeAll();
      await browser?.close();
    }
  }

  // ── 6. Persist state ───────────────────────────────────────────────────────
  if (!args.dryRun && !args.evidence) {
    saveBaseline(baseline);

    const anyFailed = results.some((r) => r.status === 'failed');
    if (!anyFailed && repo.headSha) {
      lastRun.last_successful_run_id = runId;
      lastRun.last_successful_app_git_sha = repo.headSha;
    } else if (anyFailed) {
      log.warn('At least one flow failed — NOT advancing the last-successful sha, so the next run re-checks these modules.');
    }
    for (const r of results) {
      const key = `${r.module}/${r.flow}`;
      // One device failing keeps the whole flow due for re-capture.
      const allDevicesOk = results.filter((x) => `${x.module}/${x.flow}` === key).every((x) => x.status !== 'failed');
      if (allDevicesOk && repo.headSha) lastRun.per_flow_sha[key] = repo.headSha;
    }
    saveLastRun(lastRun);
  }

  // ── 7. Retention ───────────────────────────────────────────────────────────
  if (!args.dryRun && !args.evidence && env.runsRetentionDays > 0) {
    const pruned = pruneRuns(env.runsRetentionDays);
    if (pruned.length) log.info(`Pruned ${pruned.length} run folder(s) older than ${env.runsRetentionDays} days.`);
  }

  // ── 8. Summary ─────────────────────────────────────────────────────────────
  const finishedAt = new Date();
  const summary: RunSummary = {
    run_id: runId,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    app_git_sha: repo.headSha,
    app_repo_available: repo.available,
    env: { app_url: env.appUrl, app_host: appHost() },
    devices: selectedDevices.map((d) => d.id),
    totals: {
      flows_total: flows.length * selectedDevices.length,
      flows_run: results.length,
      flows_skipped: skipped.length + skippedForAuth.length,
      flows_failed: results.filter((r) => r.status === 'failed').length,
      flows_changed: results.filter((r) => r.status === 'changed' || r.status === 'new').length,
      screenshots: results.reduce((n, r) => n + r.screenshots.length, 0),
    },
    flows: results.map((r) => ({ module: r.module, flow: r.flow, device: r.device, status: r.status, reason: r.reason, duration_ms: r.duration_ms })),
  };

  // Dry-run summaries land alongside the per-flow dry-run manifests, never
  // overwriting a real run's summary.
  const summaryPath = sink
    ? path.join(sink.root, 'run-summary.json')
    : args.dryRun
      ? path.join(paths.runs, runId.slice(0, 10), '.dry-run', 'run-summary.json')
      : path.join(paths.runs, runId.slice(0, 10), 'run-summary.json');
  if (sink) {
    const ev = sink.finish(summary);
    log.info(`  evidence:    ${ev.flows.reduce((n, f) => n + f.pre_frames + f.post_frames, 0)} frame(s), census ${JSON.stringify(ev.census_by_class)}`);
    log.info(`  review:      ${relPosix(paths.root, path.join(sink.root, ev.label_review_file))}`);
    log.info(`  next:        npm run evidence:check -- --run ${runId}`);
  } else {
    writeJson(summaryPath, summary);
  }

  log.banner('Run summary');
  log.info(`  flows:       ${summary.totals.flows_run} run · ${summary.totals.flows_skipped} skipped · ${summary.totals.flows_failed} failed`);
  log.info(`  changed:     ${summary.totals.flows_changed}`);
  log.info(`  screenshots: ${summary.totals.screenshots}`);
  log.info(`  summary:     ${relPosix(paths.root, summaryPath)}`);

  if (summary.totals.flows_changed > 0 && !args.evidence) {
    log.warn(`${summary.totals.flows_changed} module(s) changed — run \`npm run docs\` to regenerate their documentation.`);
  }

  return summary.totals.flows_failed > 0 ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      log.error((err as Error).message);
      process.exitCode = 1;
    });
}
