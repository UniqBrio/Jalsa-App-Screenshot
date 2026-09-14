/**
 * Retention policy for runs/ — default 30 days (RUNS_RETENTION_DAYS).
 *
 * Only runs/ is pruned. screenshots/, fingerprints/ and docs/ are the current
 * state of the app and are never pruned — their history lives in git.
 *
 * Usage: npm run prune            (uses RUNS_RETENTION_DAYS)
 *        npm run prune -- 7       (override, in days)
 *        npm run prune -- 7 --dry
 */
import * as fs from 'fs';
import * as path from 'path';
import { env, paths } from './env';
import { log } from './logger';

export function pruneRuns(retentionDays: number, dryRun = false): string[] {
  if (retentionDays <= 0) return [];
  if (!fs.existsSync(paths.runs)) return [];

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];

  for (const entry of fs.readdirSync(paths.runs, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const day = Date.parse(`${entry.name}T23:59:59Z`);
    if (Number.isNaN(day) || day >= cutoff) continue;

    const dir = path.join(paths.runs, entry.name);
    if (dryRun) log.warn(`would remove runs/${entry.name}`);
    else fs.rmSync(dir, { recursive: true, force: true });
    removed.push(entry.name);
  }

  return removed;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const nArg = argv.find((a) => /^\d+$/.test(a));
  const days = nArg ? Number(nArg) : env.runsRetentionDays;

  const removed = pruneRuns(days, dry);
  log.info(`Retention ${days} day(s) — ${dry ? 'would remove' : 'removed'} ${removed.length} run folder(s).`);
  removed.forEach((r) => log.info(`  · runs/${r}`));
}
