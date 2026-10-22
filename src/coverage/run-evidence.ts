/**
 * Coverage from what a capture run ACTUALLY did, rather than what the manifest
 * says it will do.
 *
 * The executor records, for every exercising step, the data-testid of the
 * element it really pressed (`target_testid`, read from the live DOM just
 * before the action) and the path the page was on afterwards (`url_after`).
 * That resolves what a manifest cannot: which element a `role=button[name=…]`
 * or a `^=` prefix selector landed on, and whether an optional step ran at all.
 *
 * Evidence per flow is its most recent run that did not skip it, across every
 * device that run captured. A flow with no such run contributes NOTHING in this
 * mode — its manifest is not taken on trust — and is listed as lacking
 * evidence. Runs written before the executor recorded `target_testid` fall back
 * to the selector it ran with, for steps that passed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { exercises } from './actions';
import { parseSelector, pathOf, type FlowUsageResult, type Usage, type RouteVisit } from './flow-usage';
import type { Flow, FlowRun } from '../types';

export interface RunEvidence {
  usage: FlowUsageResult;
  withEvidence: number;
  withoutEvidence: string[];
  runs: string[];
}

function listDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

/** Every flow-run manifest of one run, across its device folders. */
function runManifests(runDir: string): FlowRun[] {
  const out: FlowRun[] = [];
  for (const dev of listDirs(runDir)) {
    const d = path.join(runDir, dev);
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.flow-run.json')) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) as FlowRun);
      } catch {
        // A truncated manifest is no evidence; the flow is reported as lacking it.
      }
    }
  }
  return out;
}

export function loadRunEvidence(runsDir: string, flows: Flow[], onlyRun?: string): RunEvidence {
  const wanted = new Map(flows.map((f) => [`${f.module}/${f.flow}`, f]));
  const runIds = listDirs(runsDir).sort().reverse().filter((r) => !onlyRun || r === onlyRun);
  const chosen = new Map<string, { run: string; manifests: FlowRun[] }>();

  for (const runId of runIds) {
    for (const m of runManifests(path.join(runsDir, runId))) {
      const key = `${m.module}/${m.flow}`;
      if (!wanted.has(key) || m.status === 'skipped') continue;
      const cur = chosen.get(key);
      if (!cur) chosen.set(key, { run: runId, manifests: [m] });
      else if (cur.run === runId) cur.manifests.push(m);
    }
  }

  const usages: Usage[] = [];
  const visits: RouteVisit[] = [];
  for (const [key, { manifests }] of chosen) {
    const file = wanted.get(key)?._sourcePath ?? key;
    for (const m of manifests) {
      for (const s of m.steps) {
        if (s.status !== 'ok') continue;
        const base = { flow: key, file, step: s.id, phase: s.phase, action: s.action, optional: false, source: 'run' as const };
        if (exercises(s.action)) {
          if (s.target_testid) {
            usages.push({
              ...base,
              field: `${m.device}: pressed`,
              mode: 'exercised',
              term: { kind: 'testid', op: '=', value: s.target_testid, hasVars: false, raw: `[data-testid="${s.target_testid}"]` },
            });
          } else if (s.selector) {
            const terms = parseSelector(s.selector);
            const last = terms[terms.length - 1];
            if (last) usages.push({ ...base, field: `${m.device}: selector`, mode: 'exercised', term: last });
          }
        }
        if (s.url_after) {
          const p = pathOf(s.url_after);
          if (p) visits.push({ flow: key, file, step: s.id, path: p, how: 'run' });
        }
      }
    }
  }
  const withoutEvidence = [...wanted.keys()].filter((k) => !chosen.has(k)).sort();
  return {
    usage: { usages, visits, declared: new Map() },
    withEvidence: chosen.size,
    withoutEvidence,
    runs: [...new Set([...chosen.values()].map((c) => c.run))].sort(),
  };
}
