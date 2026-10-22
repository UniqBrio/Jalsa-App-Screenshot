/**
 * The two lists that let something stay uncovered — and why they are separate.
 *
 * apps/<app-id>/config/coverage-exceptions.json — APPROVED EXCEPTIONS
 *   A deliberate, reasoned decision that one element or page stays outside the
 *   screenshot flows (a destructive action real accounts may never press, a
 *   flow that needs an external system). Written by a person, reviewed in the
 *   diff. Each entry names exactly one test id, one dynamic-id family (the exact
 *   pattern the scan reports, e.g. "courses-delete-*"), or one route — never a
 *   wildcard of its own, so it cannot approve an id that does not exist yet.
 *
 *   { "app": "my-app",
 *     "exceptions": [
 *       { "testid": "orders-delete", "reason": "…", "module": "orders", "expires": "2027-03-31" },
 *       { "pattern": "orders-refund-*", "reason": "…" },
 *       { "route": "/offline", "reason": "…" } ] }
 *
 * apps/<app-id>/config/coverage-baseline.json — THE ADOPTION BACKLOG
 *   What was already uncovered on the day the check was switched on. Not an
 *   approval: every report lists it as debt. Created once by an explicit
 *   `--init-baseline`, it can only SHRINK (`--shrink-baseline` removes entries
 *   that became covered or disappeared; nothing ever adds to it). Without it, a
 *   check over an existing backlog would be red on day one and switched off on
 *   day two.
 *
 * Neither file is ever written by a normal run.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface CoverageException {
  testid?: string;
  pattern?: string;
  route?: string;
  reason: string;
  module?: string;
  /** ISO date. After it the exception is EXPIRED and fails the check until renewed or resolved. */
  expires?: string;
  approvedBy?: string;
}

export interface ExceptionsFile {
  app: string;
  exceptions: CoverageException[];
}

export interface BacklogFile {
  app: string;
  created: string;
  testids: string[];
  routes: string[];
}

export function exceptionsPath(appDir: string): string {
  return path.join(appDir, 'config', 'coverage-exceptions.json');
}
export function backlogPath(appDir: string): string {
  return path.join(appDir, 'config', 'coverage-baseline.json');
}

const PLACEHOLDER = /^(todo|tbd|n\/?a|none|temp|later|xxx+|fixme|wip|test|-+|\.+|\?+)$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function exceptionKey(x: CoverageException): string {
  return x.testid ? `testid:${x.testid}` : x.pattern ? `pattern:${x.pattern}` : `route:${x.route}`;
}

/** Strictly parses the exceptions file. Missing file = no exceptions. Every problem is returned, none thrown. */
export function loadExceptions(appDir: string, appId: string, knownModules: string[]): { file: ExceptionsFile; errors: string[] } {
  const p = exceptionsPath(appDir);
  const rel = `apps/${appId}/config/coverage-exceptions.json`;
  const empty: ExceptionsFile = { app: appId, exceptions: [] };
  if (!fs.existsSync(p)) return { file: empty, errors: [] };
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    return { file: empty, errors: [`${rel}: not valid JSON — ${(err as Error).message}`] };
  }
  const e: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { file: empty, errors: [`${rel}: must be an object { "app", "exceptions": [...] }`] };
  if (raw.app !== appId) e.push(`${rel}: "app" is ${JSON.stringify(raw.app)} — must be "${appId}", so a file copied from another app cannot apply here`);
  if (!Array.isArray(raw.exceptions)) {
    e.push(`${rel}: "exceptions" must be an array`);
    return { file: empty, errors: e };
  }
  const allowed = new Set(['testid', 'pattern', 'route', 'reason', 'module', 'expires', 'approvedBy', '$comment']);
  const seen = new Set<string>();
  const out: CoverageException[] = [];
  raw.exceptions.forEach((x: any, i: number) => {
    const at = `${rel}: exceptions[${i}]`;
    if (!x || typeof x !== 'object' || Array.isArray(x)) { e.push(`${at}: must be an object`); return; }
    for (const k of Object.keys(x)) if (!allowed.has(k)) e.push(`${at}.${k}: unknown key (known: testid, pattern, route, reason, module, expires, approvedBy)`);
    const targets = ['testid', 'pattern', 'route'].filter((k) => x[k] !== undefined);
    if (targets.length !== 1) { e.push(`${at}: name exactly ONE of "testid", "pattern" or "route"`); return; }
    const t = targets[0];
    if (typeof x[t] !== 'string' || !x[t].trim()) { e.push(`${at}.${t}: a non-empty string`); return; }
    if (t === 'testid' && x.testid.includes('*')) e.push(`${at}.testid: an exact id — for a dynamic family use "pattern" with the exact pattern the report prints`);
    if (t === 'pattern') {
      const staticChars = x.pattern.replace(/\*/g, '').length;
      if (!x.pattern.includes('*')) e.push(`${at}.pattern: "${x.pattern}" has no "*" — use "testid" for one exact id`);
      if (x.pattern.startsWith('*') || staticChars < 4) {
        e.push(`${at}.pattern: "${x.pattern}" is too broad — a pattern must start with at least 4 fixed characters, so it cannot approve ids nobody has written yet`);
      }
    }
    if (t === 'route' && !x.route.startsWith('/')) e.push(`${at}.route: a path starting with "/"`);
    const reason = typeof x.reason === 'string' ? x.reason.trim() : '';
    if (!reason) e.push(`${at}.reason: required — say in plain English why this stays uncovered`);
    else if (PLACEHOLDER.test(reason) || reason.length < 15) e.push(`${at}.reason: "${reason}" is not a reason — say why this stays out of the screenshot flows`);
    if (x.module !== undefined && (typeof x.module !== 'string' || !knownModules.includes(x.module))) {
      e.push(`${at}.module: "${x.module}" is not a module in routes.map.json (${knownModules.join(', ') || 'none defined'})`);
    }
    if (x.expires !== undefined && (typeof x.expires !== 'string' || !ISO.test(x.expires) || Number.isNaN(Date.parse(x.expires)))) {
      e.push(`${at}.expires: an ISO date, YYYY-MM-DD`);
    }
    if (x.approvedBy !== undefined && (typeof x.approvedBy !== 'string' || !x.approvedBy.trim())) e.push(`${at}.approvedBy: a non-empty string`);
    const entry: CoverageException = { [t]: x[t].trim(), reason, ...(x.module ? { module: x.module } : {}), ...(x.expires ? { expires: x.expires } : {}), ...(x.approvedBy ? { approvedBy: x.approvedBy } : {}) } as CoverageException;
    const key = exceptionKey(entry);
    if (seen.has(key)) e.push(`${at}: duplicate of an earlier exception for ${key}`);
    seen.add(key);
    out.push(entry);
  });
  return { file: { app: appId, exceptions: out }, errors: e };
}

export function isExpired(x: CoverageException, today: string): boolean {
  return Boolean(x.expires && x.expires < today);
}

export function loadBacklog(appDir: string, appId: string): { file: BacklogFile | null; errors: string[] } {
  const p = backlogPath(appDir);
  const rel = `apps/${appId}/config/coverage-baseline.json`;
  if (!fs.existsSync(p)) return { file: null, errors: [] };
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    return { file: null, errors: [`${rel}: not valid JSON — ${(err as Error).message}`] };
  }
  const e: string[] = [];
  if (!raw || typeof raw !== 'object') return { file: null, errors: [`${rel}: must be an object`] };
  if (raw.app !== appId) e.push(`${rel}: "app" is ${JSON.stringify(raw.app)} — must be "${appId}"`);
  const list = (k: string): string[] => {
    if (!Array.isArray(raw[k]) || !raw[k].every((s: unknown) => typeof s === 'string' && s)) {
      e.push(`${rel}: "${k}" must be an array of strings`);
      return [];
    }
    const dup = raw[k].filter((s: string, i: number) => raw[k].indexOf(s) !== i);
    if (dup.length) e.push(`${rel}: "${k}" lists ${dup.join(', ')} more than once`);
    return raw[k];
  };
  const file: BacklogFile = { app: appId, created: String(raw.created ?? ''), testids: list('testids'), routes: list('routes') };
  if (!ISO.test(file.created)) e.push(`${rel}: "created" must be the ISO date the backlog was taken`);
  return { file, errors: e };
}

const BACKLOG_COMMENT = [
  'ADOPTION BACKLOG — what was already uncovered when the coverage check was switched on.',
  'Not an approval: every coverage report lists these as debt. It can only shrink:',
  '`npm run coverage -- --app <id> --shrink-baseline` removes entries that became covered or',
  'disappeared, and nothing ever adds to it. A NEW uncovered element needs a flow, or a',
  'reasoned entry in coverage-exceptions.json.',
];

export function writeBacklog(appDir: string, file: BacklogFile): void {
  const body = { $comment: BACKLOG_COMMENT, app: file.app, created: file.created, testids: [...file.testids].sort(), routes: [...file.routes].sort() };
  fs.mkdirSync(path.dirname(backlogPath(appDir)), { recursive: true });
  fs.writeFileSync(backlogPath(appDir), JSON.stringify(body, null, 2) + '\n', 'utf8');
}
