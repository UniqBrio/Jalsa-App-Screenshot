/**
 * C1 acceptance check for an evidence run — offline, no browser.
 *
 *   npm run evidence:check -- --run <run_id> [--require signin/sign-in-journey,attendance/course-detail]
 *
 * Structure    every *.evidence.json validates against the schema (evidence-types.ts)
 * Privacy      no secret or operator identifier value appears in ANY file (text, JSON, or a file
 *              name), no email/phone-shaped string appears in any JSON or text file, raw text
 *              exists only on class L entries (enforced by the schema validator)
 * Frames       every referenced PNG exists, its IHDR size matches the record, its DPR matches
 *              DEVICE_SCALE_FACTOR
 * Coverage     every ok interaction in the steps phase has a before-frame and a described target
 *              with a box; before/after URL and visual state are present
 * Flows        with --require, each named flow ran and did not fail
 *
 * Writes evidence-check.json into the run directory. Exit 0 = PASS, 1 = FAIL.
 * Messages name files and fields, never the offending value.
 */
import * as fs from 'fs';
import * as path from 'path';
import { env, identifierValues, paths, secretValues, type IdentifierValue } from '../env';
import { writeJson } from '../fsx';
import { log } from '../logger';
import type { FlowRun } from '../types';
import { PRE_FRAME_ACTIONS } from './evidence-capture';
import { pngSize } from './evidence-sanitize';
import { validateStepEvidence, type FrameRef, type StepEvidence } from './evidence-types';

export interface CheckFinding {
  check: string;
  severity: 'error' | 'warn';
  file: string;
  message: string;
}

export interface CheckOptions {
  runDir: string;
  expectedDpr: number;
  requireFlows?: string[];
  identifiers?: IdentifierValue[];
  secrets?: string[];
}

export interface CheckResult {
  passed: boolean;
  files: number;
  steps: number;
  findings: CheckFinding[];
}

const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[A-Za-z]{2,}/;
const PHONE = /(?<![0-9A-Za-z])(?:\+?91[\s-]*)?[6-9][0-9]{4}[\s-]?[0-9]{5}(?![0-9A-Za-z])/;
/** HMAC / sha256 digests, optionally `sha256:`-prefixed or `#`-shortened — never user text. */
const DIGEST = /^(?:sha256:|#)?[0-9a-f]{12,64}$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else out.push(f);
  }
  return out;
}

/** Every string in a JSON value, with its JSON path. */
function strings(v: unknown, at = '$', out: Array<{ at: string; s: string }> = []): Array<{ at: string; s: string }> {
  if (typeof v === 'string') out.push({ at, s: v });
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${at}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, `${at}.${k}`, out);
  return out;
}

export function checkEvidenceRun(opts: CheckOptions): CheckResult {
  const findings: CheckFinding[] = [];
  const add = (check: string, file: string, message: string, severity: 'error' | 'warn' = 'error') =>
    findings.push({ check, severity, file, message });
  const rel = (f: string) => path.relative(opts.runDir, f).split(path.sep).join('/');

  if (!fs.existsSync(opts.runDir)) {
    add('run', opts.runDir, 'evidence run directory does not exist');
    return { passed: false, files: 0, steps: 0, findings };
  }

  const identifiers = (opts.identifiers ?? identifierValues()).filter((i) => i.digits.length === 10);
  const secrets = (opts.secrets ?? secretValues()).filter((s) => s.length >= 3);
  const idPatterns = identifiers.map((i) => ({ name: i.name, re: new RegExp(i.digits.split('').join('[\\s-]*')) }));
  const files = walk(opts.runDir).filter((f) => path.basename(f) !== 'evidence-check.json');
  let steps = 0;

  for (const file of files) {
    const r = rel(file);
    if (idPatterns.some((p) => p.re.test(r)) || secrets.some((s) => r.includes(s))) add('privacy-filename', r, 'file name contains a secret or identifier value');
    const ext = path.extname(file).toLowerCase();
    if (ext === '.png') continue;
    if (!['.json', '.txt'].includes(ext)) { add('unexpected-file', r, `unexpected file type ${ext}`, 'warn'); continue; }

    const text = fs.readFileSync(file, 'utf8');
    const scan = (s: string, where: string) => {
      for (const p of idPatterns) if (p.re.test(s)) add('privacy-identifier', r, `contains the ${p.name} value${where}`);
      // A 4-digit PIN would match inside any hex digest, so digests are skipped and the boundary is alphanumeric.
      for (const sec of secrets) if (new RegExp(`(?<![0-9A-Za-z])${sec}(?![0-9A-Za-z])`).test(s)) add('privacy-secret', r, `contains a secret (PIN) value${where}`);
      if (EMAIL.test(s)) add('privacy-email', r, `email-shaped string${where}`);
      if (PHONE.test(s)) add('privacy-phone', r, `phone-shaped string${where}`);
    };

    if (ext === '.txt') { scan(text, ''); continue; }

    let doc: unknown;
    try { doc = JSON.parse(text); } catch { add('json', r, 'not valid JSON'); continue; }
    for (const { at, s } of strings(doc)) {
      if (DIGEST.test(s)) continue;
      scan(s, ` at ${at}`);
    }

    if (!file.endsWith('.evidence.json')) continue;
    steps += 1;
    for (const e of validateStepEvidence(doc)) add('schema', r, e);
    const ev = doc as StepEvidence;
    if (!ev || typeof ev !== 'object' || !ev.before || !ev.after) continue;

    for (const [phase, frame] of [['before', ev.before.frame], ['after', ev.after.frame]] as Array<[string, FrameRef | null]>) {
      if (!frame) continue;
      const png = path.join(opts.runDir, frame.path);
      if (!fs.existsSync(png)) { add('frame-missing', r, `${phase}.frame.path does not exist`); continue; }
      try {
        const size = pngSize(fs.readFileSync(png));
        if (size.width !== frame.image.width || size.height !== frame.image.height) add('frame-size', r, `${phase}.frame.image does not match the PNG`);
      } catch { add('frame-size', r, `${phase}.frame is not a readable PNG`); }
      if (Math.abs(frame.dpr - opts.expectedDpr) > 0.01) add('frame-dpr', r, `${phase}.frame.dpr ${frame.dpr} ≠ expected ${opts.expectedDpr}`);
      if (!frame.stable) add('frame-unstable', r, `${phase}.frame was captured before the page settled (${frame.stability_reason})`, 'warn');
    }

    if (ev.phase === 'steps' && ev.status === 'ok' && PRE_FRAME_ACTIONS.has(ev.action)) {
      if (!ev.before.frame) add('coverage-frame', r, 'interaction has no before-frame');
      if (!ev.target) add('coverage-target', r, `interaction has no described target (${ev.target_reason ?? 'no reason'})`);
      else if (!ev.target.box) add('coverage-box', r, 'target has no box');
      else if (ev.target.in_viewport === 'none' && !ev.action.startsWith('scroll')) add('coverage-viewport', r, 'target is outside the before-frame', 'warn');
    }
    if (ev.evidence_errors?.length) add('evidence-errors', r, `${ev.evidence_errors.length} evidence reading error(s)`, 'warn');
  }

  const runsDir = path.join(opts.runDir, 'runs');
  for (const req of opts.requireFlows ?? []) {
    const file = path.join(runsDir, `${req.replace('/', '-')}.flow-run.json`);
    if (!fs.existsSync(file)) { add('required-flow', req, 'required flow has no run manifest in this evidence run'); continue; }
    const run = JSON.parse(fs.readFileSync(file, 'utf8')) as FlowRun;
    if (run.status === 'failed') add('required-flow', req, `required flow failed: ${run.errors.length} error(s)`);
  }

  if (steps === 0) add('run', rel(opts.runDir), 'no step evidence found');
  return { passed: !findings.some((f) => f.severity === 'error'), files: files.length, steps, findings };
}

function latestRun(): string | null {
  if (!fs.existsSync(paths.evidence)) return null;
  const runs = fs.readdirSync(paths.evidence, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  return runs.length ? runs[runs.length - 1] : null;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const runId = val('--run') ?? latestRun();
  if (!runId) {
    log.error('No evidence run found — run `npm run capture:evidence` first.');
    process.exitCode = 1;
  } else {
    const runDir = path.join(paths.evidence, runId);
    const result = checkEvidenceRun({
      runDir,
      expectedDpr: env.browser.deviceScaleFactor,
      requireFlows: (val('--require') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    writeJson(path.join(runDir, 'evidence-check.json'), result);
    for (const f of result.findings) (f.severity === 'error' ? log.error : log.warn)(`[${f.check}] ${f.file}: ${f.message}`);
    log.banner(`${result.passed ? 'PASS' : 'FAIL'} — evidence run ${runId}: ${result.steps} step(s), ${result.findings.filter((f) => f.severity === 'error').length} error(s), ${result.findings.filter((f) => f.severity === 'warn').length} warning(s)`);
    process.exitCode = result.passed ? 0 : 1;
  }
}
