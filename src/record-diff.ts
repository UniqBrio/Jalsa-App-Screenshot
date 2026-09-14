/**
 * record:diff — what a re-conversion would change. Writes nothing, ever.
 *
 * Two comparisons, both useful and different:
 *   · against flows/<flow>.generated.yaml — has the recording or the converter
 *     moved since the draft was written?
 *   · against flows/<flow>.yaml — has the app drifted away from the promoted
 *     flow that is running every night?
 *
 * The diff is a small in-repo LCS rather than a dependency or a shell-out to
 * `git diff --no-index`, which would need temp files and a git binary.
 *
 * Usage: npm run record:diff -- --flow students.add-student
 */
import * as fs from 'fs';
import { paths } from './env';
import { relPosix } from './fsx';
import { log } from './logger';
import {
  convertRecording,
  loadRecording,
  generatedPathFor,
  promotedPathFor,
} from './record-convert';

export interface DiffLine {
  kind: ' ' | '-' | '+';
  text: string;
}

/** Longest common subsequence over lines, then a unified rendering of it. */
export function diffLines(before: string[], after: string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;

  // lcs[i][j] = length of the LCS of before[i..] and after[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ kind: ' ', text: before[i] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: '-', text: before[i] });
      i++;
    } else {
      out.push({ kind: '+', text: after[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: '-', text: before[i++] });
  while (j < m) out.push({ kind: '+', text: after[j++] });
  return out;
}

/** Unified diff with `context` unchanged lines around each change. */
export function renderDiff(before: string, after: string, context = 3): string {
  const lines = diffLines(before.split('\n'), after.split('\n'));
  if (!lines.some((l) => l.kind !== ' ')) return '';

  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.kind === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
      keep[k] = true;
    }
  });

  const out: string[] = [];
  let skipping = false;
  lines.forEach((l, idx) => {
    if (!keep[idx]) {
      if (!skipping) { out.push('  ...'); skipping = true; }
      return;
    }
    skipping = false;
    out.push(`${l.kind} ${l.text}`);
  });
  return out.join('\n');
}

function compare(label: string, file: string, fresh: string): boolean {
  if (!fs.existsSync(file)) {
    log.info(`${label}: ${relPosix(paths.root, file)} does not exist — nothing to compare.`);
    return false;
  }
  const existing = fs.readFileSync(file, 'utf8');
  const diff = renderDiff(existing, fresh);
  if (!diff) {
    log.ok(`${label}: ${relPosix(paths.root, file)} is identical to a fresh conversion.`);
    return false;
  }
  log.warn(`${label}: ${relPosix(paths.root, file)} differs from a fresh conversion.`);
  console.log(`\n--- ${relPosix(paths.root, file)}\n+++ (fresh conversion)\n${diff}\n`);
  return true;
}

const argv = process.argv.slice(2);
const val = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

function main(): void {
  const flow = val('flow', '');
  if (!flow) throw new Error('Usage: npm run record:diff -- --flow <module>.<flow>');

  const rec = loadRecording(flow);
  const { yaml } = convertRecording(rec);

  log.banner(`Diffing ${flow} (read-only — nothing is written)`);

  const draftDiffers = compare('DRAFT', generatedPathFor(flow), yaml);
  const promotedDiffers = compare('PROMOTED', promotedPathFor(flow), yaml);

  if (!draftDiffers && !promotedDiffers) {
    log.ok('Nothing would change.');
  } else {
    log.info('Re-run "npm run record:convert" to update the DRAFT. The PROMOTED flow is never');
    log.info('written by any of these commands — promoting stays a manual, reviewed step.');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    log.error((err as Error).message);
    process.exitCode = 1;
  }
}
