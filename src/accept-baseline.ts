/**
 * Accept the most recent run's DOM hashes as the new fingerprint baseline.
 *
 * Use this after you have LOOKED at the changed screenshots and confirmed the
 * change is intended. Accepting blindly turns change detection into noise —
 * that is the whole failure mode this project exists to avoid.
 *
 * Usage:
 *   npm run baseline:accept -- --app <id>                       # latest run, all changed steps
 *   npm run baseline:accept -- --app <id> --module <module>
 *   npm run baseline:accept -- --app <id> --device Laptop
 *   npm run baseline:accept -- --app <id> --run 2026-08-10T01-30-00Z
 *   npm run baseline:accept -- --app <id> --date 2026-08-10     # latest run that day
 */
import * as fs from 'fs';
import * as path from 'path';
import { env, paths } from './env';
import { readJson, listFiles } from './fsx';
import { log } from './logger';
import { loadBaseline, saveBaseline, fingerprintKey, updateFingerprint } from './fingerprint';
import { pickRun } from './prune-runs';
import type { FlowRun } from './types';

function run(): void {
  const argv = process.argv.slice(2);
  const val = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const runId = pickRun({ run: val('--run'), date: val('--date') });
  const moduleFilter = val('--module');
  const deviceFilter = val('--device');

  if (!runId) { log.warn(`No matching run under runs/${env.appId}/.`); return; }

  const runDir = path.join(paths.runs, runId);
  // runs/<app>/<run-id>/<Device>/<module>-<flow>.flow-run.json
  const deviceDirs = fs.existsSync(runDir)
    ? fs.readdirSync(runDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(runDir, e.name))
    : [];
  const runs = deviceDirs
    .flatMap((d) => listFiles(d, ['.flow-run.json']))
    .map((f) => readJson<FlowRun>(f, null as unknown as FlowRun))
    .filter(Boolean)
    .filter((r) => !moduleFilter || r.module === moduleFilter)
    .filter((r) => !deviceFilter || r.device.toLowerCase() === deviceFilter.toLowerCase());

  const baseline = loadBaseline();
  let accepted = 0;

  for (const r of runs) {
    for (const step of r.steps) {
      if (!step.dom_hash || step.fingerprint === 'unchanged') continue;
      const key = fingerprintKey(r.device, r.module, r.flow, step.id);
      const prev = baseline[key];
      updateFingerprint(baseline, key, step.dom_hash, prev?.masked_selectors ?? []);
      accepted++;
      log.ok(`accepted ${key} (${step.fingerprint})`);
    }
  }

  saveBaseline(baseline);
  log.banner(`Baseline updated — ${accepted} fingerprint(s) accepted from runs/${env.appId}/${runId}`);
}

if (require.main === module) run();
