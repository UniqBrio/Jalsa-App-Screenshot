/**
 * The comparison: what the app's source contains, against what the screenshot
 * flows exercise and what the inventories say — one pure function, no I/O, so
 * every rule below is unit-testable with plain objects.
 *
 * Verdicts (never a fourth value for "did not run"):
 *   PASS     nothing blocking
 *   FAIL     something blocking (listed in `blocking`, in plain English)
 *   BLOCKED  the check could not run — no source, or the scan read nothing
 *
 * Blocking, by default and not configurable away:
 *   · an interactive test id that no flow exercises and that is neither an
 *     approved exception nor on the adoption backlog — i.e. NEW
 *   · a flow selector naming a test id that exists nowhere in the source
 *   · a page in the source that is not in known_routes.json
 *   · a known route whose page is gone from the source
 *   · a page no flow visits, that is neither excepted nor on the backlog
 *   · a flow `goto` to a path that matches no page
 *   · a malformed or expired exception, and any exception or backlog entry
 *     that is no longer needed — the lists can only shrink
 *   · a source file the parser could not fully read
 *
 * Reported, never blocking: duplicates, ids the parser cannot resolve, role
 * selectors (resolved only by run evidence), unclassifiable routes, display
 * ids, located-but-not-exercised elements.
 */
import { matchesAny } from '../change-detector';
import { patternToRegExp, type ScanResult, type TestIdEntry, type UnresolvedSite } from './testid-scan';
import { routeKey, matchRoute, type RouteScan, type DiscoveredRoute } from './route-scan';
import { exceptionKey, isExpired, type BacklogFile, type CoverageException, type ExceptionsFile } from './exceptions';
import type { FlowUsageResult, Term, Usage } from './flow-usage';
import type { KnownRoutes, RoutesMap } from '../types';

export type Verdict = 'PASS' | 'FAIL' | 'BLOCKED';

export interface IdItem {
  key: string;
  kind: 'literal' | 'pattern';
  module: string;
  file: string;
  line: number;
  element: string;
  why: string;
  /** Flow steps that located it without exercising it. */
  locatedBy?: string[];
  /** Flow steps that exercised it. */
  exercisedBy?: string[];
  /** Every exercising step is optional — it may not have run. */
  conditional?: boolean;
  reason?: string;
  expires?: string;
}

export interface RouteItem {
  path: string;
  module: string;
  files: string[];
  visitedBy?: string[];
  declaredBy?: string[];
  reason?: string;
}

export interface SelectorRef {
  flow: string;
  file: string;
  step: string;
  field: string;
  selector: string;
  candidates?: string[];
}

export interface CoverageReport {
  app: string;
  appName: string;
  generatedAt: string;
  mode: 'static' | 'run-evidence';
  verdict: Verdict;
  blocking: string[];
  notes: string[];
  source: { repository: string; root: string; origin: string; identity: string; commit: string | null; notes: string[] } | null;
  testids: {
    inventory: {
      filesListed: number; filesParsed: number; parseErrors: Array<{ file: string; message: string }>;
      ids: number; interactive: number; display: number; patterns: number; derived: number; shadowed: number; unresolved: number;
    };
    required: number;
    covered: number;
    coveragePercent: number;
    byModule: Record<string, { required: number; covered: number; new: number; existing: number; excepted: number }>;
    newUncovered: IdItem[];
    existingUncovered: IdItem[];
    excepted: IdItem[];
    coveredIds: IdItem[];
    staleReferences: SelectorRef[];
    ambiguous: SelectorRef[];
    roleSelectors: SelectorRef[];
    /** Present in the source only as a plain string, not a JSX attribute — not stale, not inventoried. */
    indirectReferences: SelectorRef[];
    /** Seen on screen by a run but nowhere in the source (e.g. rendered by a library). */
    runOnly: SelectorRef[];
    duplicates: Array<{ key: string; sites: string[] }>;
    unresolved: UnresolvedSite[];
    shadowed: Array<{ key: string; by: string; site: string }>;
    derived: Array<{ key: string; site: string }>;
  };
  routes: {
    strategy: string;
    discovered: number;
    pages: number;
    redirects: number;
    required: number;
    covered: number;
    newUnregistered: RouteItem[];
    removed: RouteItem[];
    unverifiable: RouteItem[];
    newUncovered: RouteItem[];
    existingUncovered: RouteItem[];
    excepted: RouteItem[];
    coveredRoutes: RouteItem[];
    unmatchedVisits: Array<{ flow: string; step: string; path: string; how: string }>;
    duplicates: RouteScan['duplicates'];
    unclassifiable: RouteScan['unclassifiable'];
    ignored: RouteScan['ignored'];
  };
  exceptions: {
    total: number;
    errors: string[];
    expired: CoverageException[];
    unneeded: Array<{ exception: string; why: string }>;
    outstanding: Array<CoverageException & { status: string }>;
  };
  backlog: {
    present: boolean;
    created: string;
    testids: number;
    routes: number;
    errors: string[];
    resolved: Array<{ entry: string; why: string }>;
  };
  flows: { executable: number; errors: string[]; withEvidence?: number; withoutEvidence?: string[]; runs?: string[] };
}

export interface EngineInput {
  appId: string;
  appName: string;
  today: string;
  mode: 'static' | 'run-evidence';
  source: CoverageReport['source'];
  scan: ScanResult;
  routeScan: RouteScan;
  /** Usages read from the manifests: stale/ambiguous references are always judged on these. */
  staticUsage: FlowUsageResult;
  /** Usages that decide coverage: the manifests (static mode) or what runs recorded (run-evidence mode). */
  coverageUsage: FlowUsageResult;
  flowsExecutable: number;
  flowErrors: string[];
  evidence?: { withEvidence: number; withoutEvidence: string[]; runs: string[] };
  routesMap: RoutesMap;
  knownRoutes: KnownRoutes;
  exceptions: ExceptionsFile;
  exceptionErrors: string[];
  backlog: BacklogFile | null;
  backlogErrors: string[];
}

// ─── test id resolution ──────────────────────────────────────────────────────

const staticPrefix = (p: string) => p.split('*')[0];
const staticSuffix = (p: string) => p.split('*').pop() ?? '';
const staticLen = (p: string) => p.replace(/\*/g, '').length;

type Resolution =
  | { status: 'resolved'; keys: string[] }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'indirect' }
  | { status: 'stale' };

class IdIndex {
  readonly literals = new Map<string, TestIdEntry>();
  readonly families: TestIdEntry[] = [];
  readonly derived: Array<{ entry: TestIdEntry; re: RegExp }> = [];
  private stringPatterns: RegExp[];

  constructor(private scan: ScanResult) {
    for (const e of scan.entries.values()) {
      if (e.kind === 'literal') this.literals.set(e.key, e);
      else if (e.key.startsWith('*')) {
        // `${testId}-decrease`: the prefix is whatever the caller passed in.
        this.derived.push({ entry: e, re: new RegExp('^(.+?)' + e.key.slice(1).split('*').map(escapeRe).join('.+') + '$') });
      } else this.families.push(e);
    }
    this.stringPatterns = [...scan.strings].filter((s) => s.includes('*') && staticLen(s) >= 3).map(patternToRegExp);
  }

  private existsAnywhere(test: (s: string) => boolean): boolean {
    for (const s of this.scan.indirect) if (test(s)) return true;
    for (const s of this.scan.strings) if (test(s)) return true;
    return false;
  }

  private pick(fams: TestIdEntry[], lits: TestIdEntry[], exactPrefix?: (e: TestIdEntry) => boolean): Resolution | null {
    if (fams.length === 1) return { status: 'resolved', keys: [fams[0].key] };
    if (fams.length > 1) {
      const exact = exactPrefix ? fams.filter(exactPrefix) : [];
      if (exact.length === 1) return { status: 'resolved', keys: [exact[0].key] };
      return { status: 'ambiguous', candidates: fams.map((f) => f.key) };
    }
    if (lits.length === 1) return { status: 'resolved', keys: [lits[0].key] };
    if (lits.length > 1) return { status: 'ambiguous', candidates: lits.map((l) => l.key) };
    return null;
  }

  resolve(term: Extract<Term, { kind: 'testid' }>): Resolution {
    const { op, value: v, hasVars } = term;
    if ((op === '=' || op === '~=') && !hasVars) {
      if (this.literals.has(v)) return { status: 'resolved', keys: [v] };
      const fams = this.families.filter((f) => patternToRegExp(f.key).test(v)).sort((a, b) => staticLen(b.key) - staticLen(a.key));
      if (fams.length) {
        const top = fams.filter((f) => staticLen(f.key) === staticLen(fams[0].key));
        return top.length === 1 ? { status: 'resolved', keys: [top[0].key] } : { status: 'ambiguous', candidates: top.map((f) => f.key) };
      }
      for (const d of this.derived) {
        const m = v.match(d.re);
        if (m && this.literals.has(m[1])) return { status: 'resolved', keys: [m[1]] };
      }
      if (this.scan.indirect.has(v) || this.scan.strings.has(v) || this.stringPatterns.some((re) => re.test(v))) return { status: 'indirect' };
      return { status: 'stale' };
    }
    if (op === '=' || op === '~=') {
      // {{VAR}} inside an exact selector: one member of a dynamic family.
      const re = patternToRegExp(v);
      if (this.scan.entries.has(v) && this.scan.entries.get(v)!.kind === 'pattern') return { status: 'resolved', keys: [v] };
      const shape = v.split('*');
      const fams = this.families.filter((f) => f.key.split('*').length === shape.length && f.key.split('*').every((s, i) => s === shape[i]));
      const lits = [...this.literals.values()].filter((l) => re.test(l.key));
      const r = this.pick(fams, lits);
      if (r) return r;
      return this.existsAnywhere((s) => re.test(s) || s === v) ? { status: 'indirect' } : { status: 'stale' };
    }
    let famTest: (f: TestIdEntry) => boolean;
    let litTest: (l: string) => boolean;
    let exact: ((f: TestIdEntry) => boolean) | undefined;
    if (op === '^=' || op === '|=') {
      const pre = op === '|=' ? `${v}-` : v;
      if (op === '|=' && this.literals.has(v)) return { status: 'resolved', keys: [v] };
      famTest = (f) => { const p = staticPrefix(f.key); return p.startsWith(pre) || (p.length > 0 && pre.startsWith(p)); };
      litTest = (l) => l.startsWith(pre);
      exact = (f) => staticPrefix(f.key) === pre;
    } else if (op === '$=') {
      famTest = (f) => { const s = staticSuffix(f.key); return s.endsWith(v) || (s.length > 0 && v.endsWith(s)); };
      litTest = (l) => l.endsWith(v);
      exact = (f) => staticSuffix(f.key) === v;
    } else {
      famTest = (f) => f.key.split('*').some((part) => part.includes(v));
      litTest = (l) => l.includes(v);
    }
    const r = this.pick(this.families.filter(famTest), [...this.literals.values()].filter((l) => litTest(l.key)), exact);
    if (r) return r;
    return this.existsAnywhere(litTest) ? { status: 'indirect' } : { status: 'stale' };
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── modules ─────────────────────────────────────────────────────────────────

export function moduleOf(file: string, routesMap: RoutesMap): string {
  for (const [m, entry] of Object.entries(routesMap)) {
    if (m.startsWith('$') || m === '_global' || !entry || !Array.isArray(entry.source_paths)) continue;
    if (matchesAny(file, entry.source_paths)) return m;
  }
  const g = routesMap._global;
  if (g && Array.isArray(g.source_paths) && matchesAny(file, g.source_paths)) return '_global';
  return 'unmapped';
}

const where = (u: Usage) => `${u.flow}#${u.step}`;

// ─── the comparison ──────────────────────────────────────────────────────────

export function compare(input: EngineInput): CoverageReport {
  const blocking: string[] = [];
  const notes: string[] = [];
  const { scan, routesMap } = input;
  const index = new IdIndex(scan);

  // Exceptions, by what they name.
  const excById = new Map<string, CoverageException>();
  const excRoute = new Map<string, CoverageException>();
  for (const x of input.exceptions.exceptions) {
    if (x.testid) excById.set(x.testid, x);
    if (x.pattern) excById.set(x.pattern, x);
    if (x.route) excRoute.set(routeKey(x.route), x);
  }
  const backlogIds = new Set(input.backlog?.testids ?? []);
  const backlogRoutes = new Map((input.backlog?.routes ?? []).map((r) => [routeKey(r), r]));

  // ── usages → coverage ──
  const exercised = new Map<string, Usage[]>();
  const located = new Map<string, Usage[]>();
  const staleReferences: SelectorRef[] = [];
  const ambiguous: SelectorRef[] = [];
  const roleSelectors: SelectorRef[] = [];
  const indirectReferences: SelectorRef[] = [];
  const runOnly: SelectorRef[] = [];
  const ref = (u: Usage, extra: Partial<SelectorRef> = {}): SelectorRef => ({ flow: u.flow, file: u.file, step: u.step, field: u.field, selector: u.term.raw, ...extra });

  for (const u of input.staticUsage.usages) {
    if (u.term.kind === 'role') { roleSelectors.push(ref(u)); continue; }
    if (u.term.kind !== 'testid') continue;
    const r = index.resolve(u.term);
    if (r.status === 'stale') staleReferences.push(ref(u));
    else if (r.status === 'ambiguous') ambiguous.push(ref(u, { candidates: r.candidates }));
    else if (r.status === 'indirect') indirectReferences.push(ref(u));
    else if (u.mode === 'located') for (const k of r.keys) located.set(k, [...(located.get(k) ?? []), u]);
  }
  for (const u of input.coverageUsage.usages) {
    if (u.term.kind !== 'testid' || u.mode !== 'exercised') continue;
    const r = index.resolve(u.term);
    if (r.status === 'resolved') for (const k of r.keys) exercised.set(k, [...(exercised.get(k) ?? []), u]);
    else if (u.source === 'run' && r.status === 'stale') runOnly.push(ref(u));
  }

  // ── inventory classification ──
  const item = (e: TestIdEntry): IdItem => {
    const site = e.sites.find((s) => s.interactive && !s.shadowedBy) ?? e.sites[0];
    return { key: e.key, kind: e.kind, module: moduleOf(site.file, routesMap), file: site.file, line: site.line, element: site.element, why: site.why };
  };
  const newUncovered: IdItem[] = [];
  const existingUncovered: IdItem[] = [];
  const excepted: IdItem[] = [];
  const covered: IdItem[] = [];
  const byModule: CoverageReport['testids']['byModule'] = {};
  const shadowed: CoverageReport['testids']['shadowed'] = [];
  const derived: CoverageReport['testids']['derived'] = [];
  const required = new Set<string>();
  let display = 0;

  for (const e of scan.entries.values()) {
    if (e.kind === 'pattern' && e.key.startsWith('*')) {
      derived.push({ key: e.key, site: `${e.sites[0].file}:${e.sites[0].line}` });
      continue;
    }
    if (!e.interactive) {
      const sh = e.sites.find((s) => s.shadowedBy);
      if (sh) shadowed.push({ key: e.key, by: sh.shadowedBy!, site: `${sh.file}:${sh.line}` });
      else display += 1;
      continue;
    }
    required.add(e.key);
    const it = item(e);
    const m = (byModule[it.module] ??= { required: 0, covered: 0, new: 0, existing: 0, excepted: 0 });
    m.required += 1;
    const ex = exercised.get(e.key);
    const loc = located.get(e.key);
    if (loc) it.locatedBy = [...new Set(loc.map(where))];
    if (ex) {
      it.exercisedBy = [...new Set(ex.map(where))];
      if (ex.every((u) => u.optional)) it.conditional = true;
      covered.push(it);
      m.covered += 1;
      continue;
    }
    const x = excById.get(e.key);
    if (x) {
      excepted.push({ ...it, reason: x.reason, ...(x.expires ? { expires: x.expires } : {}) });
      m.excepted += 1;
    } else if (backlogIds.has(e.key)) {
      existingUncovered.push(it);
      m.existing += 1;
    } else {
      newUncovered.push(it);
      m.new += 1;
    }
  }

  for (const it of newUncovered) {
    blocking.push(
      `NEW uncovered ${it.kind === 'pattern' ? 'test-id family' : 'test id'} "${it.key}" (${it.module}) — ${it.file}:${it.line} <${it.element}>` +
        (it.locatedBy ? `; located by ${it.locatedBy.join(', ')} but never exercised` : '') +
        ' — add a flow step that exercises it, or a reasoned entry in coverage-exceptions.json',
    );
  }
  for (const s of staleReferences) blocking.push(`STALE flow reference ${s.selector} in ${s.file} step ${s.step} (${s.field}) — no such test id in the source any more`);

  // ── routes ──
  const rs = input.routeScan;
  const discoveredByKey = new Map(rs.routes.map((r) => [routeKey(r.path), r]));
  const known = input.knownRoutes.routes ?? [];
  const knownByKey = new Map(known.map((k) => [routeKey(k.path), k]));
  const routeModule = (r: DiscoveredRoute) => knownByKey.get(routeKey(r.path))?.module ?? moduleOf(r.files[0], routesMap);
  const rItem = (r: DiscoveredRoute): RouteItem => ({ path: r.path, module: routeModule(r), files: r.files });

  const newUnregistered: RouteItem[] = [];
  const removed: RouteItem[] = [];
  const unverifiable: RouteItem[] = [];
  if (rs.strategy !== 'none') {
    for (const r of rs.routes) {
      if (r.kind === 'page' && !knownByKey.has(routeKey(r.path))) newUnregistered.push(rItem(r));
    }
    for (const k of known) {
      if (discoveredByKey.has(routeKey(k.path))) continue;
      const it: RouteItem = { path: k.path, module: k.module ?? 'unmapped', files: [] };
      if (k.kind === 'virtual') unverifiable.push(it);
      else removed.push(it);
    }
  } else {
    notes.push('Page check not applicable: the profile declares source.routes.strategy "none".');
  }
  for (const r of newUnregistered) blocking.push(`NEW page ${r.path} (${r.files.join(', ')}) is not in known_routes.json — register it (npm run coverage -- --app ${input.appId} --register-routes) and give it a flow`);
  for (const r of removed) blocking.push(`REMOVED page ${r.path} is in known_routes.json but no longer exists in the source — delete the entry (or mark it "kind": "virtual" if it is not a file route)`);

  const pages = rs.routes.filter((r) => r.kind === 'page');
  const visitedBy = new Map<string, string[]>();
  const unmatchedVisits: CoverageReport['routes']['unmatchedVisits'] = [];
  if (rs.strategy !== 'none') {
    for (const v of input.coverageUsage.visits) {
      const hit = matchRoute(v.path, rs.routes);
      if (hit) visitedBy.set(routeKey(hit.path), [...(visitedBy.get(routeKey(hit.path)) ?? []), `${v.flow}#${v.step}`]);
    }
    for (const v of input.staticUsage.visits) {
      if (v.how === 'goto' && !matchRoute(v.path, rs.routes)) unmatchedVisits.push({ flow: v.flow, step: v.step, path: v.path, how: v.how });
    }
  }
  for (const v of unmatchedVisits) blocking.push(`STALE navigation: ${v.flow} step ${v.step} goes to ${v.path}, which matches no page in the source`);

  const declaredFor = (r: DiscoveredRoute): string[] | undefined => {
    const out: string[] = [];
    for (const [p, flows] of input.staticUsage.declared) if (matchRoute(p, [r])) out.push(...flows);
    return out.length ? [...new Set(out)] : undefined;
  };
  const newUncoveredRoutes: RouteItem[] = [];
  const existingUncoveredRoutes: RouteItem[] = [];
  const exceptedRoutes: RouteItem[] = [];
  const coveredRoutes: RouteItem[] = [];
  if (rs.strategy !== 'none') {
    for (const r of pages) {
      const k = routeKey(r.path);
      const it = rItem(r);
      const by = visitedBy.get(k);
      if (by) { coveredRoutes.push({ ...it, visitedBy: [...new Set(by)] }); continue; }
      const d = declaredFor(r);
      if (d) it.declaredBy = d;
      const x = excRoute.get(k);
      if (x) exceptedRoutes.push({ ...it, reason: x.reason });
      else if (backlogRoutes.has(k)) existingUncoveredRoutes.push(it);
      else newUncoveredRoutes.push(it);
    }
  }
  for (const r of newUncoveredRoutes) {
    blocking.push(
      `NEW uncovered page ${r.path} (${r.module}) — no flow visits it` +
        (r.declaredBy ? ` (${r.declaredBy.join(', ')} only declare it in depends_on_routes)` : '') +
        ' — add a goto (or a url_contains assertion) to a flow, or a reasoned route exception',
    );
  }

  // ── exceptions: invalid, expired, no longer needed ──
  const unneeded: CoverageReport['exceptions']['unneeded'] = [];
  const expired: CoverageException[] = [];
  const outstanding: CoverageReport['exceptions']['outstanding'] = [];
  for (const x of input.exceptions.exceptions) {
    const label = exceptionKey(x);
    if (isExpired(x, input.today)) expired.push(x);
    let why: string | null = null;
    if (x.testid || x.pattern) {
      const k = (x.testid ?? x.pattern)!;
      const e = scan.entries.get(k);
      if (!e) why = x.pattern ? `no test-id family "${k}" exists in the source (a pattern must match the scan's pattern exactly)` : `no test id "${k}" exists in the source any more`;
      else if (!required.has(k)) why = `"${k}" is not an interactive element, so it needs no exception`;
      else if (exercised.has(k)) why = `"${k}" is now exercised by ${[...new Set(exercised.get(k)!.map(where))].join(', ')}`;
    } else if (x.route) {
      const r = discoveredByKey.get(routeKey(x.route));
      if (!r) why = `no page ${x.route} exists in the source any more`;
      else if (r.kind !== 'page') why = `${x.route} is a redirect, so it needs no exception`;
      else if (visitedBy.has(routeKey(x.route))) why = `${x.route} is now visited by ${visitedBy.get(routeKey(x.route))!.join(', ')}`;
    }
    if (why) unneeded.push({ exception: label, why });
    outstanding.push({ ...x, status: why ? 'no longer needed' : isExpired(x, input.today) ? 'expired' : 'active' });
  }
  for (const err of input.exceptionErrors) blocking.push(`INVALID exception file: ${err}`);
  for (const x of expired) blocking.push(`EXPIRED exception ${exceptionKey(x)} (expired ${x.expires}) — renew it with a fresh review date, or cover the element`);
  for (const u of unneeded) blocking.push(`UNNEEDED exception ${u.exception}: ${u.why} — remove it from coverage-exceptions.json`);

  // ── backlog: can only shrink ──
  const resolved: CoverageReport['backlog']['resolved'] = [];
  for (const k of input.backlog?.testids ?? []) {
    const e = scan.entries.get(k);
    if (!e) resolved.push({ entry: `testid:${k}`, why: 'no longer exists in the source' });
    else if (!required.has(k)) resolved.push({ entry: `testid:${k}`, why: 'is no longer an interactive element' });
    else if (exercised.has(k)) resolved.push({ entry: `testid:${k}`, why: `is now exercised by ${[...new Set(exercised.get(k)!.map(where))].join(', ')}` });
    else if (excById.has(k)) resolved.push({ entry: `testid:${k}`, why: 'is also an approved exception — keep one of the two' });
  }
  for (const [k, raw] of backlogRoutes) {
    const r = discoveredByKey.get(k);
    if (!r) resolved.push({ entry: `route:${raw}`, why: 'no longer exists in the source' });
    else if (visitedBy.has(k)) resolved.push({ entry: `route:${raw}`, why: `is now visited by ${visitedBy.get(k)!.join(', ')}` });
    else if (excRoute.has(k)) resolved.push({ entry: `route:${raw}`, why: 'is also an approved exception — keep one of the two' });
  }
  for (const err of input.backlogErrors) blocking.push(`INVALID backlog file: ${err}`);
  if (resolved.length) {
    blocking.push(
      `${resolved.length} adoption-backlog entr${resolved.length === 1 ? 'y is' : 'ies are'} resolved but still listed — ` +
        `run: npm run coverage -- --app ${input.appId} --shrink-baseline (the backlog can only shrink)`,
    );
  }

  for (const err of input.flowErrors) blocking.push(`INVALID flow: ${err}`);
  // A detector must be able to read what it audits: a file the parser could
  // not fully read may hold ids the scan never saw.
  for (const p of scan.parseErrors) blocking.push(`PARSE error in ${p.file} — the scan could not fully read it (${p.message})`);

  // ── duplicates and notes ──
  // profile.tsx and profile.ios.tsx are one screen on two platforms: an id in
  // each is not a duplicate. Two places in ONE file, or in two screens, are.
  const PLATFORM_FILE = /\.(ios|android|native|web)(\.[a-z]+)$/;
  const duplicates = [...scan.entries.values()]
    .filter((e) => {
      if (e.kind !== 'literal') return false;
      const perBase = new Map<string, Map<string, Set<number>>>();
      for (const s of e.sites) {
        const base = s.file.replace(PLATFORM_FILE, '$2');
        const files = perBase.get(base) ?? new Map<string, Set<number>>();
        files.set(s.file, (files.get(s.file) ?? new Set()).add(s.line));
        perBase.set(base, files);
      }
      let n = 0;
      for (const files of perBase.values()) n += Math.max(...[...files.values()].map((l) => l.size));
      return n > 1;
    })
    .map((e) => ({ key: e.key, sites: [...new Set(e.sites.map((s) => `${s.file}:${s.line}`))] }));
  if (roleSelectors.length && input.mode === 'static') {
    notes.push(`${roleSelectors.length} role= selector(s) cannot be mapped to a test id from the manifest alone; run evidence (--evidence) resolves them to what was actually pressed.`);
  }
  if (scan.unresolved.length) notes.push(`${scan.unresolved.length} test-id attribute(s) are forwarded props the parser cannot resolve; their call sites carry the real ids.`);
  const conditional = covered.filter((c) => c.conditional).length;
  if (conditional) notes.push(`${conditional} element(s) are covered only by optional steps, which may have been skipped at run time.`);

  const reqCount = required.size;
  const report: CoverageReport = {
    app: input.appId,
    appName: input.appName,
    generatedAt: new Date().toISOString(),
    mode: input.mode,
    verdict: blocking.length ? 'FAIL' : 'PASS',
    blocking,
    notes,
    source: input.source,
    testids: {
      inventory: {
        filesListed: scan.filesListed,
        filesParsed: scan.filesParsed,
        parseErrors: scan.parseErrors,
        ids: scan.entries.size,
        interactive: reqCount,
        display,
        patterns: [...scan.entries.values()].filter((e) => e.kind === 'pattern').length,
        derived: derived.length,
        shadowed: shadowed.length,
        unresolved: scan.unresolved.length,
      },
      required: reqCount,
      covered: covered.length,
      coveragePercent: reqCount ? Math.round((covered.length / reqCount) * 1000) / 10 : 100,
      byModule,
      newUncovered,
      existingUncovered,
      excepted,
      coveredIds: covered,
      staleReferences,
      ambiguous,
      roleSelectors,
      indirectReferences,
      runOnly,
      duplicates,
      unresolved: scan.unresolved,
      shadowed,
      derived,
    },
    routes: {
      strategy: rs.strategy,
      discovered: rs.routes.length,
      pages: pages.length,
      redirects: rs.routes.length - pages.length,
      required: pages.length,
      covered: coveredRoutes.length,
      newUnregistered,
      removed,
      unverifiable,
      newUncovered: newUncoveredRoutes,
      existingUncovered: existingUncoveredRoutes,
      excepted: exceptedRoutes,
      coveredRoutes,
      unmatchedVisits,
      duplicates: rs.duplicates,
      unclassifiable: rs.unclassifiable,
      ignored: rs.ignored,
    },
    exceptions: {
      total: input.exceptions.exceptions.length,
      errors: input.exceptionErrors,
      expired,
      unneeded,
      outstanding,
    },
    backlog: {
      present: Boolean(input.backlog),
      created: input.backlog?.created ?? '',
      testids: input.backlog?.testids.length ?? 0,
      routes: input.backlog?.routes.length ?? 0,
      errors: input.backlogErrors,
      resolved,
    },
    flows: {
      executable: input.flowsExecutable,
      errors: input.flowErrors,
      ...(input.evidence ? { withEvidence: input.evidence.withEvidence, withoutEvidence: input.evidence.withoutEvidence, runs: input.evidence.runs } : {}),
    },
  };
  return report;
}

/** Keys a fresh backlog would hold: every uncovered required id and page that is not excepted. */
export function backlogCandidates(r: CoverageReport): { testids: string[]; routes: string[] } {
  return {
    testids: [...r.testids.newUncovered, ...r.testids.existingUncovered].map((i) => i.key),
    routes: [...r.routes.newUncovered, ...r.routes.existingUncovered].map((i) => i.path),
  };
}
