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
 */
import * as path from 'path';
import { Browser, BrowserContext } from '@playwright/test';
import { env, paths, appHost, assertTargetEnvironment } from './env';
import { writeJson, relPosix } from './fsx';
import { log } from './logger';
import { loadFlows } from './flow-loader';
import { launchBrowser, newContext } from './browser';
import { getAuthenticatedContext, authPreflight, Identity } from './login';
import { executeFlow } from './flow-executor';
import { loadBaseline, saveBaseline } from './fingerprint';
import { ChangeDetector, inspectAppRepo, loadLastRun, saveLastRun } from './change-detector';
import { pruneRuns } from './prune-runs';
import type { Flow, FlowRun, RunSummary } from './types';

interface Args {
  force: boolean;
  dryRun: boolean;
  updateBaseline: boolean;
  headed: boolean;
  modules: string[];
  flows: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = { force: false, dryRun: false, updateBaseline: false, headed: false, modules: [], flows: [] };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--force': a.force = true; break;
      case '--dry-run': a.dryRun = true; break;
      case '--update-baseline': a.updateBaseline = true; break;
      case '--headed': a.headed = true; break;
      case '--no-cleanup': log.warn('--no-cleanup is meaningless here — this project never writes, so it never cleans up.'); break;
      case '--module': a.modules.push(argv[++i]); break;
      case '--flow': a.flows.push(argv[++i]); break;
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
  private shared = new Map<Identity, BrowserContext>();
  constructor(private browser: Browser) {}

  async for(flow: Flow): Promise<{ context: BrowserContext; ephemeral: boolean }> {
    const identity = identityOf(flow);
    if (identity === 'none') return { context: await newContext(this.browser), ephemeral: true };
    let ctx = this.shared.get(identity);
    if (!ctx) {
      ctx = await getAuthenticatedContext(this.browser, identity);
      this.shared.set(identity, ctx);
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

  log.banner(`RosiFit screenshot capture — run ${runId}`);

  // ── 1. Safety gate ─────────────────────────────────────────────────────────
  assertTargetEnvironment();
  log.ok(`Target: ${env.appUrl}  (read-only)`);

  // ── 2. Flow manifests ──────────────────────────────────────────────────────
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

  // ── 3. Change detection ────────────────────────────────────────────────────
  const repo = inspectAppRepo();
  (repo.available ? log.ok : log.warn)(repo.reason);
  const lastRun = loadLastRun();
  const detector = new ChangeDetector(repo, lastRun, args.force);
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
      for (const { flow, reason } of toRun) {
        log.banner(`${flow.module}/${flow.flow}`);
        log.info(`Reason: ${reason}`);
        let ephemeral: BrowserContext | null = null;
        try {
          let context: BrowserContext | null = null;
          if (contexts) {
            const got = await contexts.for(flow);
            context = got.context;
            if (got.ephemeral) ephemeral = got.context;
          }
          const run = await executeFlow(context!, flow, {
            runId,
            appGitSha: repo.headSha,
            baseline,
            reason,
            dryRun: args.dryRun,
            updateBaseline: args.updateBaseline,
          });
          results.push(run);
          const icon = run.status === 'failed' ? log.error : run.status === 'changed' ? log.warn : log.ok;
          icon(`${flow.module}/${flow.flow} → ${run.status} (${run.screenshots.length} screenshot(s), ${run.duration_ms}ms)`);
        } catch (err) {
          log.error(`${flow.module}/${flow.flow} crashed: ${(err as Error).message}`);
          results.push({
            module: flow.module, flow: flow.flow, run_id: runId, app_git_sha: repo.headSha,
            status: 'failed', reason, started_at: new Date().toISOString(), duration_ms: 0,
            steps: [], screenshots: [], errors: [(err as Error).message],
          });
        } finally {
          await ephemeral?.close().catch(() => undefined);
        }
      }
    } finally {
      await contexts?.closeAll();
      await browser?.close();
    }
  }

  // ── 6. Persist state ───────────────────────────────────────────────────────
  if (!args.dryRun) {
    saveBaseline(baseline);

    const anyFailed = results.some((r) => r.status === 'failed');
    if (!anyFailed && repo.headSha) {
      lastRun.last_successful_run_id = runId;
      lastRun.last_successful_app_git_sha = repo.headSha;
    } else if (anyFailed) {
      log.warn('At least one flow failed — NOT advancing the last-successful sha, so the next run re-checks these modules.');
    }
    for (const r of results) {
      if (r.status !== 'failed' && repo.headSha) lastRun.per_flow_sha[`${r.module}/${r.flow}`] = repo.headSha;
    }
    saveLastRun(lastRun);
  }

  // ── 7. Retention ───────────────────────────────────────────────────────────
  if (!args.dryRun && env.runsRetentionDays > 0) {
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
    totals: {
      flows_total: flows.length,
      flows_run: results.length,
      flows_skipped: skipped.length + skippedForAuth.length,
      flows_failed: results.filter((r) => r.status === 'failed').length,
      flows_changed: results.filter((r) => r.status === 'changed' || r.status === 'new').length,
      screenshots: results.reduce((n, r) => n + r.screenshots.length, 0),
    },
    flows: results.map((r) => ({ module: r.module, flow: r.flow, status: r.status, reason: r.reason, duration_ms: r.duration_ms })),
  };

  // Dry-run summaries land alongside the per-flow dry-run manifests, never
  // overwriting a real run's summary.
  const summaryPath = args.dryRun
    ? path.join(paths.runs, runId.slice(0, 10), '.dry-run', 'run-summary.json')
    : path.join(paths.runs, runId.slice(0, 10), 'run-summary.json');
  writeJson(summaryPath, summary);

  log.banner('Run summary');
  log.info(`  flows:       ${summary.totals.flows_run} run · ${summary.totals.flows_skipped} skipped · ${summary.totals.flows_failed} failed`);
  log.info(`  changed:     ${summary.totals.flows_changed}`);
  log.info(`  screenshots: ${summary.totals.screenshots}`);
  log.info(`  summary:     ${relPosix(paths.root, summaryPath)}`);

  if (summary.totals.flows_changed > 0) {
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
