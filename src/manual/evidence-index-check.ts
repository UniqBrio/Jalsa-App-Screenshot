/**
 * C2 acceptance check for an Evidence Index — offline, no browser.
 *
 *   npm run evidence:index:check -- --run <run_id> [--require signin/sign-in-journey,...]
 *
 * Schema        evidence-index.json validates against evidence-index-types.ts
 * Frames        every PNG in the run is indexed exactly once, and every frame the
 *               step evidence or a flow-run manifest references is one of them
 * Determinism   rebuilding the index reproduces the file byte for byte, and the
 *               build does not depend on the order flows are given in
 * Canonical     re-derived from the C1 evidence, NOT from the index's own verdict:
 *               nothing failed, skipped, loading, unstable or transitional may be
 *               canonical, and every such frame must be excluded
 * Coverage      each required flow ran, every required step is ok, and each required
 *               screen and interaction has a canonical frame from a REQUIRED step;
 *               optional steps are reported and never counted as required coverage
 * Provenance    every frame's bytes hash to what the index and the C1 evidence record,
 *               and the manifest, flow-run and evidence agree on each step
 * Privacy       the C1 privacy scan is re-run across the whole run (the C2 artifacts
 *               included), and every vocabulary text traces back to a class-L capture
 * Carried       NO_EXPERIENCE is unchanged and each review item is linked with its
 *               texts verbatim
 *
 * Writes c2/index-check.json. Exit 0 = PASS, 1 = FAIL.
 */
import * as fs from 'fs';
import * as path from 'path';
import { env, paths } from '../env';
import { writeJson, relPosix } from '../fsx';
import { log } from '../logger';
import type { Flow, FlowRun } from '../types';
import { PRE_FRAME_ACTIONS } from './evidence-capture';
import { checkEvidenceRun } from './evidence-check';
import type { StepEvidence } from './evidence-types';
import {
  buildEvidenceIndex,
  cliArgs,
  COVERAGE_FILE,
  INDEX_DIR,
  INDEX_FILE,
  loadReviewItems,
  manifestHashes,
  renderCoverage,
  sha256,
  templateLabel,
  runRelative,
  type BuildOptions,
  type ReviewItemConfig,
} from './evidence-index';
import { validateEvidenceIndex, type EvidenceIndex, type IndexedFrame } from './evidence-index-types';

export interface IndexFinding {
  check: string;
  severity: 'error' | 'warn';
  where: string;
  message: string;
}

export interface IndexCheckResult {
  passed: boolean;
  run_id: string;
  frames: number;
  canonical: number;
  findings: IndexFinding[];
}

export interface IndexCheckOptions extends BuildOptions {
  /** Passed through to the C1 privacy scan. */
  identifiers?: Array<{ name: string; digits: string; text?: string }>;
  secrets?: string[];
}

function walk(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f, base));
    else out.push(relPosix(base, f));
  }
  return out.sort();
}

export function checkEvidenceIndex(o: IndexCheckOptions): IndexCheckResult {
  const findings: IndexFinding[] = [];
  const add = (check: string, where: string, message: string, severity: 'error' | 'warn' = 'error') =>
    findings.push({ check, severity, where, message });
  const runId = path.basename(o.runDir);
  const indexPath = path.join(o.runDir, INDEX_DIR, INDEX_FILE);

  if (!fs.existsSync(indexPath)) {
    add('index-present', `${INDEX_DIR}/${INDEX_FILE}`, 'no evidence index — run `npm run evidence:index` first');
    return { passed: false, run_id: runId, frames: 0, canonical: 0, findings };
  }
  const onDisk = fs.readFileSync(indexPath, 'utf8');
  let index: EvidenceIndex;
  try { index = JSON.parse(onDisk) as EvidenceIndex; } catch { add('index-present', INDEX_FILE, 'not valid JSON'); return { passed: false, run_id: runId, frames: 0, canonical: 0, findings }; }

  for (const e of validateEvidenceIndex(index)) add('schema', INDEX_FILE, e);
  if (index.run_id !== runId) add('schema', INDEX_FILE, `run_id ${index.run_id} does not match the run directory`);

  // ── determinism ────────────────────────────────────────────────────────────
  const rebuild = buildEvidenceIndex(o);
  const rebuilt = JSON.stringify(rebuild, null, 2) + '\n';
  if (rebuilt !== onDisk) add('determinism', INDEX_FILE, 'rebuilding the index does not reproduce the file — it is stale or the build is not deterministic');
  const shuffled = JSON.stringify(buildEvidenceIndex({ ...o, flows: [...o.flows].reverse() }), null, 2) + '\n';
  if (shuffled !== rebuilt) add('determinism', INDEX_FILE, 'the index depends on the order the flow manifests are supplied in');
  const coveragePath = path.join(o.runDir, INDEX_DIR, COVERAGE_FILE);
  if (!fs.existsSync(coveragePath)) add('coverage-file', `${INDEX_DIR}/${COVERAGE_FILE}`, 'missing');
  else if (fs.readFileSync(coveragePath, 'utf8') !== renderCoverage(index)) add('coverage-file', `${INDEX_DIR}/${COVERAGE_FILE}`, 'does not match the index');

  // ── every captured frame indexed, exactly once ─────────────────────────────
  const onDiskPngs = walk(o.runDir).filter((f) => f.toLowerCase().endsWith('.png'));
  const indexed = new Map<string, IndexedFrame>();
  for (const f of index.frames) {
    if (indexed.has(f.file.path)) add('frames-indexed', f.file.path, 'indexed more than once');
    indexed.set(f.file.path, f);
  }
  for (const p of onDiskPngs) if (!indexed.has(p)) add('frames-indexed', p, 'a captured PNG is missing from the index');
  for (const f of index.frames) if (!onDiskPngs.includes(f.file.path)) add('frames-indexed', f.file.path, 'indexed frame does not exist in the run');

  // ── re-derive everything from the C1 evidence, independently of the index ──
  const evidenceDocs = new Map<string, { doc: StepEvidence; rel: string; sha: string }>();
  for (const rel of walk(o.runDir).filter((f) => f.endsWith('.evidence.json'))) {
    const buf = fs.readFileSync(path.join(o.runDir, rel));
    const doc = JSON.parse(buf.toString('utf8')) as StepEvidence;
    evidenceDocs.set(`${doc.module}/${doc.flow}/${doc.step_id}`, { doc, rel, sha: sha256(buf) });
    if (doc.run_id !== runId) add('provenance', rel, `evidence run_id ${doc.run_id} does not match the run directory`);
    for (const [pointer, frame] of [['before.frame', doc.before.frame], ['after.frame', doc.after.frame]] as const) {
      if (!frame) continue;
      const f = indexed.get(frame.path);
      if (!f) { add('frames-indexed', frame.path, `referenced by ${rel} ${pointer} but not indexed`); continue; }
      if (f.provenance.evidence_pointer !== pointer || f.provenance.evidence_file !== rel) add('provenance', frame.path, `does not point back to ${rel} ${pointer}`);
      if (f.file.png_sha256 !== frame.png_sha256) add('provenance', frame.path, 'index hash differs from the hash C1 recorded');
    }
  }

  const runs = new Map<string, { run: FlowRun; rel: string; sha: string }>();
  const runsDir = path.join(o.runDir, 'runs');
  for (const name of fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.flow-run.json')).sort() : []) {
    const buf = fs.readFileSync(path.join(runsDir, name));
    const run = JSON.parse(buf.toString('utf8')) as FlowRun;
    runs.set(`${run.module}/${run.flow}`, { run, rel: `runs/${name}`, sha: sha256(buf) });
    for (const step of run.steps) {
      for (const recorded of step.screenshot_paths ?? []) {
        const rel = runRelative(recorded, o.runDir, o.repoRoot);
        if (!indexed.has(rel)) add('frames-indexed', rel, `recorded by ${run.module}/${run.flow} step ${step.id} but not indexed`);
      }
    }
  }

  // Frame bytes, and the facts that decide suitability.
  for (const f of index.frames) {
    const abs = path.join(o.runDir, f.file.path);
    if (!fs.existsSync(abs)) continue;
    const buf = fs.readFileSync(abs);
    if (sha256(buf) !== f.file.png_sha256) add('provenance', f.file.path, 'file hash does not match the index');
    if (buf.length !== f.file.bytes) add('provenance', f.file.path, 'file size does not match the index');

    const key = f.flow && f.step ? `${f.flow}/${f.step.id}` : null;
    const rec = key ? evidenceDocs.get(key) : undefined;
    const runRec = f.flow ? runs.get(f.flow) : undefined;
    const runStep = runRec?.run.steps.find((s) => s.id === f.step?.id);
    const raw: string[] = [];
    if (runStep && runStep.status !== 'ok') raw.push(`step ${runStep.status}`);
    if (runStep?.unstable) raw.push('executor flagged the capture unstable');
    if (f.kind === 'capture-failed') raw.push('failure capture');
    if (f.kind === 'capture-loading') raw.push('loading capture');
    if (f.kind === 'unreferenced') raw.push('unreferenced file');
    if (rec) {
      const ph = f.kind === 'evidence-pre' ? rec.doc.before : rec.doc.after;
      if (rec.doc.evidence_errors.length) raw.push('evidence reading error');
      if (f.kind === 'evidence-pre' || f.kind === 'evidence-post') {
        if (ph.frame && !ph.frame.stable) raw.push('frame captured before the page settled');
        if (ph.census_truncated) raw.push('census truncated');
        if (ph.census.some((c) => c.class === 'S')) raw.push('secret visible');
      }
      if (ph.visual.loading.length) raw.push('loading indicator visible');
      if (ph.url.pattern !== ph.visual.route.pattern) raw.push('route changed between readings (transitional)');
    }
    if (raw.length && f.suitability !== 'excluded') add('exclusion', f.frame_id, `must be excluded (${raw.join('; ')}) but is ${f.suitability}`);
    if (raw.length && f.canonical_role) add('exclusion', f.frame_id, `canonical despite: ${raw.join('; ')}`);
    if (f.canonical_role === 'screen-state' && (f.kind !== 'evidence-post' || !f.screen.name)) add('exclusion', f.frame_id, 'a screen-state frame must be a named evidence-post frame');
    if (f.canonical_role === 'control-location' && (f.kind !== 'evidence-pre' || !f.target?.described)) add('exclusion', f.frame_id, 'a control-location frame must be an evidence-pre frame with a described target');
  }

  // ── manifest / flow-run / evidence agreement ───────────────────────────────
  for (const flow of index.flows) {
    const manifest = o.flows.find((m) => `${m.module}/${m.flow}` === flow.flow) ?? null;
    const runRec = runs.get(flow.flow);
    if (!runRec) { add('provenance', flow.flow, 'no flow-run manifest'); continue; }
    if (flow.flow_run_sha256 !== runRec.sha) add('provenance', flow.flow, 'flow-run manifest hash does not match the index');
    if (manifest) {
      const steps = [...(manifest.setup ?? []), ...(manifest.steps ?? []), ...(manifest.teardown ?? [])];
      const expected = o.manifestHashes[flow.flow] ?? null;
      if (flow.manifest_sha256 !== expected) add('provenance', flow.flow, 'manifest hash does not match the index');
      for (const s of flow.steps) {
        const m = steps.find((x) => x.id === s.id);
        if (!m) { add('manifest-drift', `${flow.flow}/${s.id}`, 'ran but is not in the manifest'); continue; }
        if (m.action !== s.action) add('manifest-drift', `${flow.flow}/${s.id}`, `action ${s.action} differs from the manifest's ${m.action}`);
        if ((m.expect_screen ?? null) !== s.expect_screen) add('manifest-drift', `${flow.flow}/${s.id}`, 'expect_screen differs from the manifest');
        if ((m.optional === true) !== s.optional) add('manifest-drift', `${flow.flow}/${s.id}`, 'optional differs from the manifest');
        if (s.status === 'skipped' && !s.optional) add('manifest-drift', `${flow.flow}/${s.id}`, 'a step was skipped but is not optional');
      }
    } else if (flow.required) {
      add('provenance', flow.flow, 'a required flow has no manifest, so required/optional cannot be established');
    }
  }

  // ── required coverage, re-derived ──────────────────────────────────────────
  for (const key of o.requiredFlows.slice().sort()) {
    const manifest = o.flows.find((m) => `${m.module}/${m.flow}` === key);
    const runRec = runs.get(key);
    if (!runRec) { add('coverage', key, 'required flow did not run in this evidence run'); continue; }
    if (runRec.run.status === 'failed') add('coverage', key, 'required flow failed');
    if (!manifest) continue;
    const required = (manifest.steps ?? []).filter((s) => s.optional !== true);
    for (const s of required) {
      const rs = runRec.run.steps.find((x) => x.id === s.id);
      if (!rs) { add('coverage', `${key}/${s.id}`, 'required step did not run'); continue; }
      if (rs.status !== 'ok') add('coverage', `${key}/${s.id}`, `required step is ${rs.status}`);
      if (s.expect_screen) {
        const canonical = index.frames.find((f) => f.flow === key && f.canonical_role === 'screen-state' && f.screen.name === s.expect_screen && f.step?.required);
        if (!canonical) add('coverage', `${key}/${s.expect_screen}`, 'no canonical screen-state frame from a required step');
      }
      if (PRE_FRAME_ACTIONS.has(s.action)) {
        const control = index.frames.find((f) => f.flow === key && f.canonical_role === 'control-location' && f.step?.id === s.id);
        if (!control) add('coverage', `${key}/${s.id}`, 'no canonical control-location frame for a required interaction');
      }
    }
    // Optional steps must never be counted as required coverage.
    const cov = index.coverage.find((c) => c.flow === key);
    if (!cov) add('coverage', key, 'no coverage entry in the index');
    else {
      if (cov.required_steps.total !== required.length) add('coverage', key, `required step total ${cov.required_steps.total} ≠ ${required.length} non-optional steps in the manifest`);
      const optionalIds = new Set((manifest.steps ?? []).filter((s) => s.optional === true).map((s) => s.id));
      for (const id of optionalIds) {
        if (index.flows.find((f) => f.flow === key)?.steps.find((s) => s.id === id)?.required) add('coverage', `${key}/${id}`, 'an optional step is marked required');
      }
      for (const s of cov.optional_steps) if (!optionalIds.has(s.id)) add('coverage', `${key}/${s.id}`, 'reported as optional but the manifest does not mark it optional');
      if (!cov.complete) add('coverage', key, 'coverage is not complete');
    }
  }

  // ── privacy: the C1 scan over the whole run, C2 artifacts included ─────────
  const c1 = checkEvidenceRun({
    runDir: o.runDir,
    expectedDpr: o.expectedDpr,
    requireFlows: o.requiredFlows,
    identifiers: o.identifiers,
    secrets: o.secrets,
  });
  for (const f of c1.findings.filter((x) => x.severity === 'error')) add('privacy-c1', f.file, `${f.check}: ${f.message}`);
  if (!c1.passed) add('privacy-c1', runId, 'the C1 evidence check does not pass over this run');
  if (index.sources.evidence_check_passed !== true) add('privacy-c1', INDEX_FILE, 'the index was built from a run whose C1 check had not passed');

  // Every vocabulary text must come from a class-L capture, templated the same way.
  const allowlisted = new Set<string>();
  const lTexts = new Set<string>();
  for (const { doc } of evidenceDocs.values()) {
    for (const ph of [doc.before, doc.after]) {
      for (const c of ph.census) {
        if (c.class !== 'L' || typeof c.text !== 'string' || c.source === 'value') continue;
        const t = templateLabel(c.text, c.rule === 'label-allowlist').text;
        lTexts.add(t);
        if (c.rule === 'label-allowlist') allowlisted.add(t);
      }
    }
  }
  for (const v of index.vocabulary) {
    if (!lTexts.has(v.text)) add('privacy-vocabulary', v.id, 'vocabulary text does not trace back to a class-L capture in this run');
    if (/\d/.test(v.text) && !allowlisted.has(v.text)) add('privacy-vocabulary', v.id, 'a live number survived templating');
  }

  // ── carried decisions ──────────────────────────────────────────────────────
  if (index.engagement.experience !== 'NO_EXPERIENCE') add('engagement', INDEX_FILE, 'NO_EXPERIENCE was not preserved');
  for (const item of o.reviewItems) {
    const linked = index.review_items.find((r) => r.id === item.id);
    if (!linked) { add('review-items', item.id, 'carried review item is missing from the index'); continue; }
    if (linked.status !== item.status) add('review-items', item.id, 'status differs from config');
    const texts = item.match.texts ?? [];
    if (JSON.stringify(linked.texts) !== JSON.stringify(texts)) add('review-items', item.id, 'texts are not carried verbatim from config');
    for (const t of texts) {
      const v = index.vocabulary.find((x) => x.text === t);
      if (v && v.fixed_wording && item.status === 'open') add('review-items', item.id, `"${t}" is marked fixed wording while the item is open`);
      if (v && !v.review_items.includes(item.id)) add('review-items', item.id, `vocabulary entry ${v.id} is not linked to the item`);
    }
    if (item.status === 'open' && !linked.frame_ids.length) add('review-items', item.id, 'no frames linked — the item cannot be reviewed against evidence', 'warn');
  }

  return {
    passed: !findings.some((f) => f.severity === 'error'),
    run_id: runId,
    frames: index.frames.length,
    canonical: index.frames.filter((f) => f.canonical_role).length,
    findings,
  };
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { loadFlows } = require('../flow-loader') as typeof import('../flow-loader');
  const { runId, require: requireFlows } = cliArgs(process.argv.slice(2));
  if (!runId) {
    log.error('No evidence run found — run `npm run capture:evidence` first.');
    process.exitCode = 1;
  } else {
    const runDir = path.join(paths.evidence, runId);
    const { flows } = loadFlows({ includeDisabled: true });
    const review = loadReviewItems();
    const result = checkEvidenceIndex({
      runDir,
      flows,
      manifestHashes: manifestHashes(flows),
      requiredFlows: requireFlows,
      expectedDpr: env.browser.deviceScaleFactor,
      reviewItems: review.items,
      reviewItemsSha256: review.sha256,
      repoRoot: paths.root,
    });
    writeJson(path.join(runDir, INDEX_DIR, 'index-check.json'), result);
    for (const f of result.findings) (f.severity === 'error' ? log.error : log.warn)(`[${f.check}] ${f.where}: ${f.message}`);
    log.banner(`${result.passed ? 'PASS' : 'FAIL'} — evidence index ${runId}: ${result.frames} frame(s), ${result.canonical} canonical, ${result.findings.filter((f) => f.severity === 'error').length} error(s), ${result.findings.filter((f) => f.severity === 'warn').length} warning(s)`);
    process.exitCode = result.passed ? 0 : 1;
  }
}

export type { Flow, ReviewItemConfig };
