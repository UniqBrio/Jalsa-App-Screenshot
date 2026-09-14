/**
 * Accept the most recent run's DOM hashes as the new fingerprint baseline.
 *
 * Use this after you have LOOKED at the changed screenshots and confirmed the
 * change is intended. Accepting blindly turns change detection into noise —
 * that is the whole failure mode this project exists to avoid.
 *
 * Usage:
 *   npm run baseline:accept                       # latest run, all changed steps
 *   npm run baseline:accept -- --module attendance
 *   npm run baseline:accept -- --date 2026-08-10
 */
import * as fs from 'fs';
import * as path from 'path';
import { paths } from './env';
import { readJson, listFiles } from './fsx';
import { log } from './logger';
import { loadBaseline, saveBaseline, fingerprintKey, updateFingerprint } from './fingerprint';
import type { FlowRun } from './types';

function latestRunDate(): string | null {
  if (!fs.existsSync(paths.runs)) return null;
  const days = fs
    .readdirSync(paths.runs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort();
  return days.length ? days[days.length - 1] : null;
}

function run(): void {
  const argv = process.argv.slice(2);
  const dIdx = argv.indexOf('--date');
  const mIdx = argv.indexOf('--module');
  const date = dIdx >= 0 ? argv[dIdx + 1] : latestRunDate();
  const moduleFilter = mIdx >= 0 ? argv[mIdx + 1] : null;

  if (!date) { log.warn('No run history found.'); return; }

  const dir = path.join(paths.runs, date);
  const runs = listFiles(dir, ['.flow-run.json'])
    .map((f) => readJson<FlowRun>(f, null as unknown as FlowRun))
    .filter(Boolean)
    .filter((r) => !moduleFilter || r.module === moduleFilter);

  const baseline = loadBaseline();
  let accepted = 0;

  for (const r of runs) {
    for (const step of r.steps) {
      if (!step.dom_hash || step.fingerprint === 'unchanged') continue;
      const key = fingerprintKey(r.module, r.flow, step.id);
      const prev = baseline[key];
      updateFingerprint(baseline, key, step.dom_hash, prev?.masked_selectors ?? []);
      accepted++;
      log.ok(`accepted ${key} (${step.fingerprint})`);
    }
  }

  saveBaseline(baseline);
  log.banner(`Baseline updated — ${accepted} fingerprint(s) accepted from runs/${date}`);
}

if (require.main === module) run();
