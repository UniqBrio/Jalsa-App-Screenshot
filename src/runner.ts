/**
 * Orchestrator — the entry point for `npm run capture`.
 *
 * The target app is chosen with --app <id> or APP=<id> (apps/<id>/); there is
 * no default. Output goes to runs/<app-id>/<run-id>/<Device>/….
 *
 * Order of operations:
 *   1. Safety gate (profile's allowedHosts)   — env.ts
 *   2. Load + validate every flow manifest    — flow-loader.ts  (fails fast)
 *   3. Write gates for dummy write flows      — write-gates.ts  (aborts on mismatch)
 *   4. Inspect the app repo, compute diff     — change-detector.ts
 *   5. Authenticate once per identity; the dummy tenant is verified before
 *      the first flow acts                    — login.ts
 *   6. Execute the flows that need running    — flow-executor.ts
 *   7. Persist baseline + last-run state
 *   8. Prune old runs                         — retention policy
 *   9. Write the run summary
 *
 * Real accounts are READ-ONLY: validate refuses a write in any flow that is
 * not an explicit dummy write flow, and those run only when every write gate
 * holds. A dummy write flow's own teardown removes what it tagged.
 *
 * Flags:
 *   --app <id>           the app profile to capture (or APP=<id>)
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
import * as fs from 'fs';
import * as path from 'path';
import { Browser, BrowserContext } from '@playwright/test';
import { env, paths, profile, appHost, assertTargetEnvironment, envWarnings, isDummyIdentity } from './env';
import { readJson, writeJson, relPosix } from './fsx';
import { log } from './logger';
import { loadFlows } from './flow-loader';
import { launchBrowser, newContext } from './browser';
import { loadDevicesConfig, resolveDevices, devicesForFlow, type DeviceProfile } from './devices';
import { getAuthenticatedContext, authPreflight, Identity } from './login';
import { isWriteFlow, messagingBlock, sendStepBlock, sendSteps, staticWriteGateProblems, DummyIdentityError } from './write-gates';
import { NO_AUTH } from './profile';
import { executeFlow } from './flow-executor';
import { loadBaseline, saveBaseline } from './fingerprint';
import { ChangeDetector, inspectAppRepo, loadLastRun, saveLastRun } from './change-detector';
import { pruneRuns } from './prune-runs';
import { EvidenceSink, evidenceDirInUse } from './manual/evidence-capture';
import { loadPiiConfig } from './manual/pii-config';
import { evidenceRoutes } from './manual/evidence-sanitize';
import type { Flow, FlowRun, KnownRoutes, RunSummary } from './types';

/** Extra attempts for a read-only flow that failed, and the pause before each. */
const FLOW_RETRIES = 2;
const RETRY_PAUSE_MS = 20_000;

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
      case '--app': i++; break; // read by env.ts (selectedAppId)
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

/** Run-scoped marker carried by every record a dummy write flow creates. */
export function runTagFor(runId: string): string {
  return `SCRSHOT_${runId}_`;
}

/** The identity a flow signs in as. `none` means a fresh signed-out context. */
function identityOf(flow: Flow): Identity {
  return flow.auth ?? profile.defaultAccount;
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
    if (identity === NO_AUTH) return { context: await newContext(this.browser, undefined, device), ephemeral: true };
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

  // Resolves the app profile first: no app selected is an error, never a default.
  const appId = profile.id;
  log.banner(`${args.evidence ? 'EVIDENCE' : 'Screenshot'} capture of the target app "${appId}" — run ${runId}`);
  envWarnings().forEach((w) => log.warn(w));

  if (args.evidence && (args.dryRun || args.updateBaseline)) {
    log.error('--evidence cannot be combined with --dry-run or --update-baseline: an evidence run never touches the baseline.');
    return 1;
  }

  // ── 1. Safety gate ─────────────────────────────────────────────────────────
  assertTargetEnvironment();
  log.ok(`Target: ${env.appName} at ${env.appUrl}  (write mode: ${env.writeMode === 'dummy' ? 'DUMMY — dummy write flows may write' : 'off — read-only'})`);

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
  for (const identity of new Set(flows.map(identityOf))) {
    if (identity === NO_AUTH) continue;
    const problem = authPreflight(identity);
    if (problem) unavailable.set(identity, problem);
  }
  const skippedForAuth = flows.filter((f) => unavailable.has(identityOf(f)));
  skippedForAuth.forEach((f) => log.skip(`${f.module}/${f.flow} — ${unavailable.get(identityOf(f))}`));
  flows = flows.filter((f) => !unavailable.has(identityOf(f)));

  // ── Write gates ────────────────────────────────────────────────────────────
  // WRITE_MODE off: write flows are simply not run. On: every gate must hold
  // for every selected write flow, or nothing runs at all.
  const flagged: RunSummary['flagged'] = [];
  const skippedForWrites: Flow[] = [];

  // A step that CONFIRMS an outbound message is refused unless someone has
  // attested the provider-level kill switch — in every mode, dummy included.
  // Data isolation keeps records apart; it does not stop a message leaving.
  for (const f of flows) {
    for (const step of sendSteps(f)) {
      const why = sendStepBlock(step, profile);
      if (!why) continue;
      log.warn(`FLAGGED ${f.module}/${f.flow} — ${why}`);
      flagged.push({ module: f.module, flow: f.flow, reason: why });
      skippedForWrites.push(f);
      break;
    }
  }

  const writeFlows = flows.filter((f) => isWriteFlow(f) && !skippedForWrites.includes(f));
  if (writeFlows.length && env.writeMode !== 'dummy') {
    for (const f of writeFlows) {
      log.skip(`${f.module}/${f.flow} — writes data and WRITE_MODE is not "dummy"`);
      skippedForWrites.push(f);
    }
  } else if (writeFlows.length) {
    for (const f of writeFlows) {
      const why = messagingBlock(f, profile);
      if (why) {
        log.warn(`FLAGGED ${f.module}/${f.flow} — ${why}`);
        flagged.push({ module: f.module, flow: f.flow, reason: why });
        skippedForWrites.push(f);
      }
    }
    const problems = writeFlows
      .filter((f) => !skippedForWrites.includes(f))
      .flatMap((f) => staticWriteGateProblems(f, { writeMode: env.writeMode, host: appHost(), writeAllowedHosts: env.writeAllowedHosts, profile }));
    if (problems.length) {
      log.error(`WRITE GATES FAILED — aborting before any action:`);
      problems.forEach((p) => log.error(`  ${p}`));
      return 1;
    }
  }
  flows = flows.filter((f) => !skippedForWrites.includes(f));

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
      phonePattern: profile.pii.phonePattern,
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

  const runTag = runTagFor(runId);
  // Real runs: runs/<app>/<run-id>/. Dry runs land apart, so they can never be
  // mistaken for (or overwrite) a real capture.
  const runDir = args.dryRun ? path.join(paths.runs, '.dry-run', runId) : path.join(paths.runs, runId);
  let aborted: string | null = null;

  if (toRun.length) {
    const browser = args.dryRun ? null : await launchBrowser();
    const contexts = browser ? new Contexts(browser) : null;
    try {
      // The dummy tenant is verified BEFORE the first flow acts: sign in as the
      // dummy account on the first device now, so a mismatch aborts a run that
      // has not touched anything yet. Later devices re-verify on their own
      // context; a mismatch there stops the run too.
      const dummyFlow = toRun.find((d) => isDummyIdentity(identityOf(d.flow)));
      if (contexts && dummyFlow) {
        const first = selectedDevices.find((d) => devicesForFlow([d], dummyFlow.flow.devices).length);
        if (first) {
          log.info('Verifying the dummy account before any flow runs…');
          await contexts.for(dummyFlow.flow, first);
        }
      }

      outer: for (const device of selectedDevices) {
        for (const { flow, reason } of toRun) {
          // A flow may declare which form factors it makes sense on.
          if (!devicesForFlow([device], flow.devices).length) {
            log.skip(`${device.id} · ${flow.module}/${flow.flow} — not declared for this device (devices: ${(flow.devices ?? []).join(', ')})`);
            continue;
          }
          log.banner(`${device.id} · ${flow.module}/${flow.flow}`);
          log.info(`Reason: ${reason}`);
          // A read-only flow that fails is retried after a pause: a database that
          // did not answer for a few seconds is not a finding, and a retry leaves
          // the run with real screenshots instead of a `.failed.png` of an outage.
          // The failed attempt's shots are removed so they never mix with the
          // retry's. A write flow, or an evidence run, is never retried.
          const retries = isWriteFlow(flow) || args.evidence || args.dryRun ? 0 : FLOW_RETRIES;
          for (let attempt = 0; attempt <= retries; attempt++) {
            if (attempt > 0) {
              log.warn(`${device.id} · ${flow.module}/${flow.flow} — retry ${attempt}/${retries} in ${RETRY_PAUSE_MS / 1000}s`);
              results.pop();
              fs.rmSync(path.join(runDir, device.id, flow.module, flow.flow), { recursive: true, force: true });
              await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
            }
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
                runDir,
                runTag,
                // Reaching here means every write gate held (static ones above,
                // the tenant check when the dummy context was created).
                writeAllowed: isWriteFlow(flow) && env.writeMode === 'dummy' && isDummyIdentity(identityOf(flow)),
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
              if (err instanceof DummyIdentityError) {
                aborted = err.message;
                log.error(err.message);
                break outer;
              }
              log.error(`${device.id} · ${flow.module}/${flow.flow} crashed: ${(err as Error).message}`);
              results.push({
                module: flow.module, flow: flow.flow, device: device.id, run_id: runId, app_git_sha: repo.headSha,
                status: 'failed', reason, started_at: new Date().toISOString(), duration_ms: 0,
                steps: [], screenshots: [], errors: [(err as Error).message],
              });
            } finally {
              await ephemeral?.close().catch(() => undefined);
            }
            if (results[results.length - 1]?.status !== 'failed') break;
          }
        }
      }
    } catch (err) {
      if (!(err instanceof DummyIdentityError)) throw err;
      aborted = err.message;
      log.error(err.message);
    } finally {
      await contexts?.closeAll();
      await browser?.close();
    }
  }
  if (aborted) {
    log.error('Run ABORTED by the dummy identity check. Baseline and last-run state were not touched.');
    return 1;
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
    app_id: appId,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    app_git_sha: repo.headSha,
    app_repo_available: repo.available,
    env: { app_url: env.appUrl, app_host: appHost() },
    write_mode: writeFlows.length && env.writeMode === 'dummy' ? 'dummy' : 'off',
    run_tag: runTag,
    devices: selectedDevices.map((d) => d.id),
    totals: {
      flows_total: flows.length * selectedDevices.length,
      flows_run: results.length,
      flows_skipped: skipped.length + skippedForAuth.length + skippedForWrites.length,
      flows_failed: results.filter((r) => r.status === 'failed').length,
      flows_changed: results.filter((r) => r.status === 'changed' || r.status === 'new').length,
      screenshots: results.reduce((n, r) => n + r.screenshots.length, 0),
    },
    flows: results.map((r) => ({ module: r.module, flow: r.flow, device: r.device, status: r.status, reason: r.reason, duration_ms: r.duration_ms })),
    flagged,
    // Optional steps that did not run, with the manifest's reason: known
    // limitations, listed apart from failures so they do not read as one.
    expected_skips: results.flatMap((r) =>
      r.steps
        .filter((st) => st.status === 'skipped' && st.skip_reason)
        .map((st) => ({ device: r.device, module: r.module, flow: r.flow, step: st.id, reason: st.skip_reason as string })),
    ),
  };

  const summaryPath = sink ? path.join(sink.root, 'run-summary.json') : path.join(runDir, 'run-summary.json');
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
  if (flagged.length) log.warn(`  flagged:     ${flagged.length} flow(s) skipped for safety — see "flagged" in the summary`);
  if (summary.expected_skips.length) {
    log.info(`  expected:    ${summary.expected_skips.length} optional step(s) skipped for a stated reason (not failures):`);
    for (const k of summary.expected_skips) log.info(`                 ${k.device} · ${k.module}/${k.flow} ${k.step} — ${k.reason}`);
  }
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
