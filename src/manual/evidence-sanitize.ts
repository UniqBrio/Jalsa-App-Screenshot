/**
 * Node-side reduction of raw browser readings to the minimum permitted evidence.
 * Pure functions — every one is unit-tested without a browser.
 *
 * readVisualState (visual-state.ts) keys elements by aria-label/text slices and
 * copies error/toast text verbatim; page.url() carries record ids. None of that
 * may be persisted raw, so it is reduced here before anything is written.
 */
import * as crypto from 'crypto';
import { interpolate, redactSecrets } from '../env';
import type { Flow, FlowStep, KnownRoute } from '../types';
import type { VisualState } from '../visual-state';
import { classifyTextRun, normaliseTestid, type ClassifyRules } from './census-probe';
import type { InputEvidence, SanitizedUrl, SanitizedVisualState, SelectorKind } from './evidence-types';

export function hmac(key: string, text: string): string {
  if (!text) return '';
  return crypto.createHmac('sha256', key).update(text).digest('hex');
}

export function sha256File(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(buf: Buffer): { width: number; height: number } {
  const sig = '89504e470d0a1a0a';
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== sig || buf.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('not a PNG (bad signature or missing IHDR)');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|(?=[0-9a-z]*\d)[0-9a-z]{8,})$/i;
const ROUTE_SHAPED = /^\/[A-Za-z0-9/_-]*$/;

/** Route pattern for a pathname: a known_routes pattern when one matches, else id-like segments become [id]. */
export function routePattern(pathname: string, knownRoutes: KnownRoute[]): string {
  const clean = pathname.replace(/\/+$/, '') || '/';
  const known = knownRoutes.map((r) => r.path);
  if (known.includes(clean)) return clean;
  for (const pattern of known) {
    if (!pattern.includes('[')) continue;
    const re = new RegExp('^' + pattern.split('/').map((s) => (/^\[.+\]$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|\\]/g, '\\$&'))).join('/') + '$');
    if (re.test(clean)) return pattern;
  }
  return clean.split('/').map((s) => (s && ID_SEGMENT.test(s) ? '[id]' : s)).join('/');
}

export function sanitizeUrl(rawUrl: string, knownRoutes: KnownRoute[], key: string): SanitizedUrl {
  let u: URL;
  try {
    u = new URL(rawUrl, 'https://placeholder.invalid');
  } catch {
    return { pattern: '[unparseable]', path_sha256: hmac(key, rawUrl), query: [], record_screen: false };
  }
  const pattern = u.protocol === 'about:' ? 'about:blank' : routePattern(u.pathname, knownRoutes);
  const query = Array.from(u.searchParams.entries()).map(([k, v]) =>
    ROUTE_SHAPED.test(v) ? { key: k, value: v, value_sha256: null } : { key: k, value: null, value_sha256: hmac(key, v) },
  );
  return { pattern, path_sha256: hmac(key, u.pathname), query, record_screen: pattern.includes('[') };
}

/** Reduces a visual-state element key (`testid:…`, `role:r/label`, `id:…`, `tag:t/label`) to a label-free key. */
export function sanitizeKey(raw: string, key: string): string {
  if (raw === 'window') return raw;
  if (raw.startsWith('testid:')) return 'testid:' + normaliseTestid(raw.slice(7)).family;
  const m = raw.match(/^(role|tag):([^/]*)\/?(.*)$/s);
  if (m) return m[3] ? `${m[1]}:${m[2]}/#${hmac(key, m[3]).slice(0, 12)}` : `${m[1]}:${m[2]}`;
  if (raw.startsWith('id:')) return 'id:#' + hmac(key, raw.slice(3)).slice(0, 12);
  return '#' + hmac(key, raw).slice(0, 12);
}

/** `key:number` entries (scroll tops, list counts): sanitize the key, keep the number. */
function sanitizeCounted(entry: string, key: string): string {
  const i = entry.lastIndexOf(':');
  const num = entry.slice(i + 1);
  if (i <= 0 || !/^\d+$/.test(num)) return '#' + hmac(key, entry).slice(0, 12);
  return `${sanitizeKey(entry.slice(0, i), key)}:${num}`;
}

/** Error/toast entries are `key:text` with no reliable delimiter — keep only the element kind and a digest. */
function sanitizeTextEntry(entry: string, key: string): { key: string; sha256: string; length: number } {
  const t = entry.match(/^testid:([^:]+):/);
  return { key: t ? 'testid:' + normaliseTestid(t[1]).family : entry.startsWith('role:') ? 'role' : 'other', sha256: hmac(key, entry), length: entry.length };
}

export function sanitizeVisualState(v: VisualState, knownRoutes: KnownRoute[], key: string): SanitizedVisualState {
  return {
    route: sanitizeUrl(v.route, knownRoutes, key),
    overlays: v.overlays.map((k) => sanitizeKey(k, key)),
    scroll_tops: v.scrollTops.map((s) => sanitizeCounted(s, key)),
    visible_keys: Array.from(new Set(v.visibleKeys.map((k) => sanitizeKey(k, key)))).sort(),
    lists: v.lists.map((s) => sanitizeCounted(s, key)),
    errors: v.errors.map((e) => sanitizeTextEntry(e, key)),
    toasts: v.toasts.map((e) => sanitizeTextEntry(e, key)),
    active_tab: v.activeTab ? sanitizeKey(v.activeTab, key) : '',
    loading: v.loading.map((k) => sanitizeKey(k, key)),
    disabled: v.disabled.map((k) => sanitizeKey(k, key)),
  };
}

export function selectorKind(selector: string, step: FlowStep): SelectorKind {
  if (step.selector_exempt) return 'exempt';
  const s = selector.trim();
  if (/^role=/.test(s)) return /name=\//.test(s) ? 'role-regex' : 'role';
  const terms = s.match(/\[[^\]]*\]|role=[^\s]+/g) ?? [];
  if (terms.length > 1 || /\]\s+\[/.test(s)) return 'chain';
  if (/^\[data-testid[\^*$]=/.test(s)) return 'testid-prefix';
  if (/^\[data-testid=/.test(s)) return 'testid';
  return 'other';
}

/** Values a flow types that are literal (no {{VAR}}) and declared not to create data. */
export function safeLiterals(flow: Flow): string[] {
  const all = [...(flow.setup ?? []), ...flow.steps, ...(flow.teardown ?? [])];
  const out = new Set<string>();
  for (const s of all) {
    if (s.value === undefined) continue;
    const raw = String(s.value);
    if (raw.includes('{{')) continue;
    if ((s.action === 'type' || s.action === 'fill' || s.action === 'select') && s.run_tag === false) out.add(raw);
    if (s.action === 'press') out.add(raw);
  }
  return Array.from(out);
}

const CREDENTIAL_VARS = ['SIGNIN_PIN', 'STAFF_PIN'];
const IDENTIFIER_VARS = ['SIGNIN_MOBILE', 'STAFF_MOBILE'];

/** The step's input as evidence: a token for secrets/identifiers, raw text only when it classifies as L. */
export function inputEvidence(
  step: FlowStep,
  vars: Record<string, string>,
  rules: ClassifyRules,
  knownRoutes: KnownRoute[],
  key: string,
): { input: InputEvidence | null; sensitive: null | { kind: 'credential' | 'identifier'; var: string } } {
  if (step.value === undefined) return { input: null, sensitive: null };
  const template = String(step.value);
  const value = interpolate(template, vars);
  const refs = Array.from(template.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)).map((m) => m[1]);
  const base = { length: value.length, sha256: hmac(key, value) };

  const cred = refs.find((r) => CREDENTIAL_VARS.includes(r));
  if (cred) return { input: { class: 'S', rule: `credential:${cred}`, ...base, token: redactSecrets(value) }, sensitive: { kind: 'credential', var: cred } };
  const ident = refs.find((r) => IDENTIFIER_VARS.includes(r));
  if (ident) return { input: { class: 'I', rule: `identifier:${ident}`, ...base, token: redactSecrets(value) }, sensitive: { kind: 'identifier', var: ident } };

  if (step.action === 'goto' || step.action === 'sleep' || step.action === 'wait' || step.action === 'scroll') {
    const text = step.action === 'goto' ? sanitizeUrl(value, knownRoutes, key).pattern : value;
    return { input: { class: 'L', rule: `${step.action}-value`, length: text.length, sha256: hmac(key, text), text, token: null }, sensitive: null };
  }

  const verdict = classifyTextRun(
    { text: value, source: 'value', region: null, control_static_testid: false, record_screen: false },
    rules,
  );
  const redacted = redactSecrets(value);
  const input: InputEvidence = { class: verdict.class, rule: verdict.rule, ...base, token: redacted !== value ? redacted : null };
  if (verdict.class === 'L') input.text = value;
  const sensitive = verdict.class === 'I' ? { kind: 'identifier' as const, var: verdict.rule.split(':')[1] ?? 'unknown' } : null;
  return { input, sensitive };
}

/**
 * Error text for evidence: secrets redacted, and every double-quoted segment
 * masked unless it is authored text we already hold (the selector, a literal) —
 * Playwright and runExpect quote page text ("element text is \"…\"").
 */
export function sanitizeError(message: string, authored: string[], key: string): string {
  const firstLine = redactSecrets(message.split('\n')[0]);
  // Authored strings can themselves contain quotes (`[data-testid="x"]`), so their inner parts are allowed too.
  const allowed = new Set(authored.flatMap((a) => [a, ...Array.from(a.matchAll(/"([^"]*)"/g)).map((m) => m[1])]));
  return firstLine.replace(/"([^"]*)"/g, (whole, inner: string) =>
    allowed.has(inner) || /^«redacted/.test(inner) ? whole : `"#${hmac(key, inner).slice(0, 12)}"`,
  );
}

/**
 * Routes for pattern matching: known_routes.json plus every flow's
 * depends_on_routes, so a static route that discovery never lists (the
 * /member/edit form) is matched exactly instead of by the /member/[id] pattern.
 */
export function evidenceRoutes(knownRoutes: KnownRoute[], flows: Flow[]): KnownRoute[] {
  const seen = new Set(knownRoutes.map((r) => r.path));
  const extra: KnownRoute[] = [];
  for (const f of flows) {
    for (const p of f.depends_on_routes ?? []) {
      if (!seen.has(p)) { seen.add(p); extra.push({ path: p, label: '' }); }
    }
  }
  return [...knownRoutes, ...extra];
}
