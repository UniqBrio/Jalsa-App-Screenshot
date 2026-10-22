/**
 * What the flows actually DO with each selector — read from the executable
 * manifests, step by step.
 *
 * A selector is EXERCISED when an exercising action (actions.ts) targets it —
 * the last term of a descendant chain is the target; earlier terms only scope
 * it. Every other mention — a waitFor, an assertion, a mask, a scroll, a
 * hover, an ancestor in a chain — LOCATES the element without taking its
 * action. A test id written anywhere else in a manifest (a description, a
 * comment, depends_on_routes) is not a usage at all.
 *
 * Route visits are where a flow demonstrably goes: a `goto`, or an
 * `assert.url_contains` that names a path. `depends_on_routes` is a
 * declaration and is reported as such, never counted as a visit.
 */
import { splitTerms, allSteps } from '../flow-loader';
import { exercises } from './actions';
import type { Flow, FlowStep, StepAction, StepPhase } from '../types';

export type TermOp = '=' | '^=' | '$=' | '*=' | '~=' | '|=';

export type Term =
  | { kind: 'testid'; op: TermOp; value: string; hasVars: boolean; raw: string }
  | { kind: 'role'; raw: string }
  | { kind: 'other'; raw: string };

export interface Usage {
  /** module/flow */
  flow: string;
  /** Manifest path, repo-relative. */
  file: string;
  step: string;
  phase: StepPhase;
  action: StepAction;
  optional: boolean;
  mode: 'exercised' | 'located';
  /** Where in the step the selector sat: selector, assert.selector_visible, mask[0] … */
  field: string;
  term: Term;
  /** static — read from the manifest; run — what the executor recorded touching. */
  source: 'static' | 'run';
}

export interface RouteVisit {
  flow: string;
  file: string;
  step: string;
  /** Path with each {{VAR}} turned into "*". No query, no hash. */
  path: string;
  how: 'goto' | 'url_contains' | 'run';
}

const TESTID_TERM = /^\[data-testid([~^*$|]?=)(?:"([^"]*)"|'([^']*)')(?:\s+i)?\]$/;
const ROLE_TERM = /^role=/;
const VAR = /\{\{\s*[A-Za-z0-9_]+\s*\}\}/g;

function varsToWild(s: string): string {
  return s.replace(VAR, '*').replace(/\*{2,}/g, '*');
}

export function parseTerm(raw: string): Term {
  const m = raw.match(TESTID_TERM);
  if (m) {
    const value = m[2] ?? m[3] ?? '';
    const hasVars = VAR.test(value);
    VAR.lastIndex = 0;
    return { kind: 'testid', op: m[1] as TermOp, value: hasVars ? varsToWild(value) : value, hasVars, raw };
  }
  if (ROLE_TERM.test(raw)) return { kind: 'role', raw };
  return { kind: 'other', raw };
}

/** Terms of a selector, in order — the last one is the element acted on. */
export function parseSelector(selector: string): Term[] {
  return splitTerms(selector).map(parseTerm);
}

/** A goto value or url_contains fragment as a bare path, or null when it is not one. */
export function pathOf(value: string): string | null {
  let v = value.trim();
  v = v.replace(/^\{\{\s*APP_URL\s*\}\}/, '');
  v = v.replace(/^https?:\/\/[^/]+/i, '');
  if (!v.startsWith('/')) return null;
  v = v.split(/[?#]/)[0];
  v = varsToWild(v);
  if (v.length > 1) v = v.replace(/\/+$/, '');
  return v || '/';
}

function selectorFields(step: FlowStep): Array<{ field: string; value: string; target: boolean }> {
  const out: Array<{ field: string; value: string; target: boolean }> = [];
  if (step.selector) out.push({ field: 'selector', value: step.selector, target: true });
  if (step.assert?.selector_visible) out.push({ field: 'assert.selector_visible', value: step.assert.selector_visible, target: false });
  if (step.assert?.selector_hidden) out.push({ field: 'assert.selector_hidden', value: step.assert.selector_hidden, target: false });
  if (step.assert?.count?.selector) out.push({ field: 'assert.count.selector', value: step.assert.count.selector, target: false });
  (step.mask ?? []).forEach((m, i) => typeof m === 'string' && out.push({ field: `mask[${i}]`, value: m, target: false }));
  if (step._capture?.mode === 'element') out.push({ field: 'screenshot element:', value: step._capture.selector, target: false });
  return out;
}

export interface FlowUsageResult {
  usages: Usage[];
  visits: RouteVisit[];
  /** route -> flows that only DECLARE it in depends_on_routes. */
  declared: Map<string, string[]>;
}

/** Usages from the manifests of executable flows (drafts and disabled flows never reach here). */
export function flowUsages(flows: Flow[]): FlowUsageResult {
  const usages: Usage[] = [];
  const visits: RouteVisit[] = [];
  const declared = new Map<string, string[]>();

  for (const flow of flows) {
    const key = `${flow.module}/${flow.flow}`;
    const file = flow._sourcePath ?? key;
    for (const r of flow.depends_on_routes ?? []) {
      const p = pathOf(r);
      if (p) declared.set(p, [...(declared.get(p) ?? []), key]);
    }
    for (const step of allSteps(flow)) {
      if (!step) continue;
      const base = {
        flow: key,
        file,
        step: step.id,
        phase: (step._phase ?? 'steps') as StepPhase,
        action: step.action,
        optional: step.optional === true || step._phase === 'teardown',
        source: 'static' as const,
      };
      for (const f of selectorFields(step)) {
        const terms = parseSelector(f.value);
        terms.forEach((term, i) => {
          const isTarget = f.target && i === terms.length - 1;
          usages.push({ ...base, field: f.field, term, mode: isTarget && exercises(step.action) ? 'exercised' : 'located' });
        });
      }
      if (step.action === 'goto' && step.value !== undefined) {
        const p = pathOf(String(step.value));
        if (p) visits.push({ flow: key, file, step: step.id, path: p, how: 'goto' });
      }
      if (step.assert?.url_contains) {
        const p = pathOf(step.assert.url_contains);
        if (p) visits.push({ flow: key, file, step: step.id, path: p, how: 'url_contains' });
      }
    }
  }
  return { usages, visits, declared };
}
