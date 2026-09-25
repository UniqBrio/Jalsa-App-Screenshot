/**
 * Retention policy for runs/<app-id>/ — default 30 days (RUNS_RETENTION_DAYS).
 *
 * Only run folders are pruned. The fingerprint baseline and generated docs are
 * the current state of the app and live in the app profile, never pruned.
 *
 * Usage: npm run prune -- --app <id>            (uses RUNS_RETENTION_DAYS)
 *        npm run prune -- --app <id> 7          (override, in days)
 *        npm run prune -- --app <id> 7 --dry
 */
import * as fs from 'fs';
import * as path from 'path';
import { env, paths } from './env';
import { log } from './logger';

/** Run ids start with an ISO date: 2026-08-10T01-30-00Z. */
const RUN_ID_RE = /^(\d{4}-\d{2}-\d{2})T[\dZ-]+$/;

/** Run folders of the current app, oldest first. Dot-folders (dry runs) are not runs. */
export function listRunIds(): string[] {
  if (!fs.existsSync(paths.runs)) return [];
  return fs
    .readdirSync(paths.runs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

/**
 * The run to act on: `--run <id>` exactly, else the latest run on `--date`,
 * else the latest run overall.
 */
export function pickRun(opts: { run?: string | null; date?: string | null }): string | null {
  const ids = listRunIds();
  if (opts.run) return ids.includes(opts.run) ? opts.run : null;
  const pool = opts.date ? ids.filter((id) => id.startsWith(opts.date!)) : ids;
  return pool.length ? pool[pool.length - 1] : null;
}

export function pruneRuns(retentionDays: number, dryRun = false): string[] {
  if (retentionDays <= 0) return [];
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];

  for (const id of listRunIds()) {
    const day = Date.parse(`${id.match(RUN_ID_RE)![1]}T23:59:59Z`);
    if (Number.isNaN(day) || day >= cutoff) continue;
    const dir = path.join(paths.runs, id);
    if (dryRun) log.warn(`would remove runs/${env.appId}/${id}`);
    else fs.rmSync(dir, { recursive: true, force: true });
    removed.push(id);
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
  removed.forEach((r) => log.info(`  · runs/${env.appId}/${r}`));
}
