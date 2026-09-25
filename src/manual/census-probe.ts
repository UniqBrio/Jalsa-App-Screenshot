/**
 * Capture-time PII classification — runs INSIDE the page.
 *
 * Why in the page: text that is not an application label must never leave the
 * browser raw. Classification, hashing and stripping all happen here, so what
 * crosses back into Node is already the minimum permitted representation
 * (class + rule + length + run-scoped HMAC; raw text only for class L).
 *
 * How it gets there: every function below is SELF-CONTAINED (no imports, no
 * module-level references except each other) so its compiled source can be
 * stringified into one injected script — the same trick dom-probe.ts uses, and
 * like page.evaluate it goes through CDP, so the app's CSP does not apply.
 * `normaliseTestid` and `classifyTextRun` are also imported directly by Node
 * code and unit-tested there, which is the point of writing them this way.
 *
 * Rule order (architecture §8.2), first match wins:
 *   1. secrets        password inputs, PIN values                         → S
 *   2. identifiers    the operator mobile numbers, or a ≥5-digit fragment → I
 *   3. patterns       email shape, or the app profile's phone shape        → P
 *   4. data region    config region or automatic list/record region      → region class
 *   5. input values   a literal typed by the flow (run_tag: false)        → L, otherwise P
 *   6. label sources  placeholder, label allowlist, symbol-only text,
 *                     text of a control with a static test id on a
 *                     non-record screen                                  → L
 *   7. anything else                                                      → U
 */
import { DOM_PROBE_SOURCE } from '../dom-probe';

export type Klass = 'S' | 'I' | 'P' | 'O' | 'L' | 'U';

export interface RegionRule {
  id: string;
  class: 'P' | 'O' | 'I';
  match: { testid?: string; testid_family?: string; role?: string; name_regex?: string };
}

export interface ClassifyRules {
  identifiers: Array<{ name: string; digits: string; text?: string }>;
  secrets: string[];
  safe_literals: string[];
  /** Pre-normalised (lower-case, whitespace collapsed). */
  label_texts: string[];
  /**
   * Regex source for a phone number in THIS app's market (profile pii.phonePattern).
   * Absent or empty: no phone-shape rule is applied — the engine assumes nothing
   * about what a phone number looks like.
   */
  phone_pattern?: string;
}

export interface ClassifyInput {
  text: string;
  source: 'text' | 'value' | 'placeholder' | 'name';
  name_source?: string;
  input_type?: string | null;
  region: { id: string; class: 'P' | 'O' | 'I' } | null;
  control_static_testid: boolean;
  record_screen: boolean;
}

export interface TestidParts {
  family: string;
  static: boolean;
}

/** `courses-open-6f1c…` → { family: 'courses-open-*', static: false }. Static ids pass through. */
export function normaliseTestid(testid: string): TestidParts {
  const tails = [
    /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    /-\d{4}-\d{2}-\d{2}$/,
    /-\d+$/,
  ];
  for (const re of tails) {
    const m = testid.match(re);
    if (m && m.index !== undefined && m.index > 0) return { family: testid.slice(0, m.index) + '-*', static: false };
  }
  const alnum = testid.match(/-([0-9a-z]{8,})$/i);
  if (alnum && /\d/.test(alnum[1]) && alnum.index !== undefined && alnum.index > 0) {
    return { family: testid.slice(0, alnum.index) + '-*', static: false };
  }
  return { family: testid, static: true };
}

export function classifyTextRun(input: ClassifyInput, rules: ClassifyRules): { class: Klass; rule: string } {
  const text = input.text;
  const collapsed = text.replace(/\s+/g, ' ').trim();

  // 1. secrets
  if (input.source === 'value' && input.input_type === 'password') return { class: 'S', rule: 'password-input' };
  for (const secret of rules.secrets) {
    if (!secret) continue;
    if (input.source === 'value' && collapsed === secret) return { class: 'S', rule: 'secret-value' };
    if (new RegExp('(?<![0-9])' + secret + '(?![0-9])').test(collapsed)) return { class: 'S', rule: 'secret-in-text' };
  }

  // 2. operator identifiers — the full number in any spacing, or a fragment of it
  const digitRuns = collapsed.match(/[0-9](?:[0-9]|[ -](?=[0-9]))*/g) || [];
  for (const id of rules.identifiers) {
    // An email/username login: matched literally, case-insensitively.
    if (!id.digits && id.text && collapsed.toLowerCase().indexOf(id.text.toLowerCase()) !== -1) return { class: 'I', rule: 'identifier:' + id.name };
    if (!id.digits) continue;
    const full = new RegExp(id.digits.split('').join('[\\s-]*'));
    if (full.test(collapsed)) return { class: 'I', rule: 'identifier:' + id.name };
    for (const run of digitRuns) {
      // The whole run ("90000 48261") and each separated group ("+91 90000" → "90000"),
      // so a country code joined onto a fragment cannot hide it.
      const candidates = [run.replace(/[^0-9]/g, '')].concat(run.split(/[ -]/));
      for (const d of candidates) {
        if (d.length >= 5 && id.digits.indexOf(d) !== -1) return { class: 'I', rule: 'identifier-fragment:' + id.name };
      }
    }
  }

  // 3. personal-data patterns
  if (/\S@\S/.test(collapsed)) return { class: 'P', rule: 'email-pattern' };
  if (rules.phone_pattern) {
    try {
      if (new RegExp(rules.phone_pattern).test(collapsed)) return { class: 'P', rule: 'phone-pattern' };
    } catch {
      // A profile that will not compile is caught by profile validation, not here.
    }
  }

  // 4. data regions
  if (input.region) return { class: input.region.class, rule: 'region:' + input.region.id };

  // 5. input values
  if (input.source === 'value') {
    if (rules.safe_literals.indexOf(text) !== -1) return { class: 'L', rule: 'safe-literal' };
    return { class: 'P', rule: 'input-value' };
  }

  // 6. label sources
  if (input.source === 'placeholder' || input.name_source === 'placeholder') return { class: 'L', rule: 'placeholder' };
  if (collapsed === '') return { class: 'L', rule: 'empty' };
  if (!/[\p{L}\p{N}]/u.test(collapsed)) return { class: 'L', rule: 'symbol-only' };
  const norm = collapsed.toLowerCase();
  if (rules.label_texts.indexOf(norm) !== -1) return { class: 'L', rule: 'label-allowlist' };
  if (!input.record_screen && input.control_static_testid) return { class: 'L', rule: 'static-control' };

  // 7.
  return { class: 'U', rule: 'unclassified' };
}

// ─── page-side ───────────────────────────────────────────────────────────────

export interface PageArgs {
  hmacKey: string;
  rules: ClassifyRules;
  regions: RegionRule[];
  recordScreen: boolean;
  maxCensus: number;
  maxInventory: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

async function pageHmac(key: string, text: string): Promise<string> {
  if (!text) return '';
  const w = window as any;
  if (!w.__ubCensusKeys) w.__ubCensusKeys = {};
  let k = w.__ubCensusKeys[key];
  if (!k) {
    k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    w.__ubCensusKeys[key] = k;
  }
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function pageRoleOf(el: Element): string {
  const probe = (window as any).__ubProbe;
  const d = probe ? probe.describe(el) : null;
  return d ? d.role : 'generic';
}

const CONTROL_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
  '[role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="textbox"], [role="searchbox"]';

function pageRegionFor(el: Element, args: PageArgs): { id: string; class: 'P' | 'O' | 'I' } | null {
  const probe = (window as any).__ubProbe;
  let node: Element | null = el;
  while (node && node !== document.body) {
    const testid = node.getAttribute('data-testid');
    const parts = testid ? normaliseTestid(testid) : null;
    for (const r of args.regions) {
      const m = r.match;
      let ok = false;
      if (m.testid && testid === m.testid) ok = true;
      if (m.testid_family && parts && parts.family === m.testid_family) ok = true;
      if (m.role && m.name_regex) {
        const d = probe ? probe.describe(node) : null;
        if (d && d.role === m.role && new RegExp(m.name_regex).test(d.name || '')) ok = true;
      }
      if (ok) return { id: r.id, class: r.class };
    }
    if (parts && !parts.static) return { id: 'auto:id-testid:' + parts.family, class: 'P' };
    const parent: Element | null = node.parentElement;
    if (parent) {
      const role = node.getAttribute('role') || '';
      const tag = node.tagName.toLowerCase();
      const itemish = ['button', 'link', 'listitem', 'row', 'option', 'menuitem', 'article'].indexOf(role) !== -1 || tag === 'li' || tag === 'tr';
      if (itemish) {
        const sig = (e: Element) => e.tagName + '|' + (e.getAttribute('role') || '') + '|' +
          (e.getAttribute('data-testid') ? normaliseTestid(e.getAttribute('data-testid') as string).family : '');
        const mine = sig(node);
        let same = 0;
        for (const sib of Array.from(parent.children)) if (sig(sib) === mine) same++;
        if (same >= 2 && !(parts && parts.static)) return { id: 'auto:list-item', class: 'P' };
      }
    }
    node = parent;
  }
  return null;
}

function pageControlStaticTestid(el: Element): boolean {
  const control = el.closest(CONTROL_SELECTOR);
  if (!control) return false;
  const testid = control.getAttribute('data-testid');
  return !!testid && normaliseTestid(testid).static;
}

function pageTestidFamily(el: Element): string | null {
  const t = el.closest('[data-testid]');
  const id = t ? t.getAttribute('data-testid') : null;
  return id ? normaliseTestid(id).family : null;
}

function pageClip(r: { left: number; top: number; right: number; bottom: number }) {
  const left = Math.max(0, r.left);
  const top = Math.max(0, r.top);
  const right = Math.min(innerWidth, r.right);
  const bottom = Math.min(innerHeight, r.bottom);
  if (right <= left || bottom <= top) return null;
  return { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
}

async function pageClassified(text: string, input: Omit<ClassifyInput, 'text'>, args: PageArgs) {
  const verdict = classifyTextRun({ ...input, text }, args.rules);
  const out: any = { class: verdict.class, rule: verdict.rule, length: text.length, sha256: await pageHmac(args.hmacKey, text) };
  if (verdict.class === 'L') out.text = text;
  return out;
}

function pageNameSource(el: Element, name: string): string {
  if (!name) return 'none';
  const attr = (a: string) => (el.getAttribute(a) || '').replace(/\s+/g, ' ').trim();
  if (attr('aria-label') === name) return 'aria-label';
  if (el.getAttribute('aria-labelledby')) return 'labelledby';
  if (attr('alt') === name) return 'alt';
  if (attr('title') === name) return 'title';
  if (attr('placeholder') === name) return 'placeholder';
  if (attr('name') === name) return 'name-attr';
  return 'text';
}

async function pageDescribe(el: Element, args: PageArgs): Promise<any> {
  const probe = (window as any).__ubProbe;
  const d = probe.describe(el);
  const testid = el.getAttribute('data-testid');
  const parts = testid ? normaliseTestid(testid) : null;
  const region = pageRegionFor(el, args);
  const controlStatic = pageControlStaticTestid(el);
  const nameSource = pageNameSource(el, d.name);
  const base = { region, control_static_testid: controlStatic, record_screen: args.recordScreen, input_type: d.input_type };
  const visible = ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);

  const r = el.getBoundingClientRect();
  const hasBox = r.width > 0 && r.height > 0;
  const clipped = hasBox ? pageClip(r) : null;
  const inViewport = !hasBox || !clipped ? 'none'
    : clipped.w * clipped.h >= Math.round(r.width) * Math.round(r.height) - 1 ? 'full' : 'partial';

  // Occlusion: sample the centre and four inset points that fall inside the viewport.
  let points = 0;
  let clear = 0;
  const hits: Record<string, number> = {};
  if (hasBox) {
    const xs = [0.5, 0.25, 0.75, 0.25, 0.75];
    const ys = [0.5, 0.25, 0.25, 0.75, 0.75];
    for (let i = 0; i < xs.length; i++) {
      const x = r.left + r.width * xs[i];
      const y = r.top + r.height * ys[i];
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      points++;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit) || hit.contains(el))) { clear++; continue; }
      let key = 'none';
      if (hit) {
        const holder = hit.closest('[data-testid]');
        const hid = holder ? holder.getAttribute('data-testid') : null;
        key = hid ? 'testid:' + normaliseTestid(hid).family : 'role:' + pageRoleOf(hit) + '/' + hit.tagName.toLowerCase();
      }
      hits[key] = (hits[key] || 0) + 1;
    }
  }
  let occludedBy: string | null = null;
  if (points > 0 && clear < points) {
    occludedBy = Object.keys(hits).sort((a, b) => hits[b] - hits[a] || (a < b ? -1 : 1))[0];
  }

  const disabled = (el as HTMLInputElement).disabled === true || !!el.closest('[aria-disabled="true"]');

  return {
    testid: parts && parts.static ? testid : null,
    testid_family: parts ? parts.family : null,
    role: d.role,
    tag: d.tag,
    input_type: d.input_type,
    name: await pageClassified(d.name || '', { ...base, source: 'name', name_source: nameSource }, args),
    name_source: nameSource,
    visible_text: await pageClassified(visible, { ...base, source: 'text' }, args),
    box: hasBox ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
    in_viewport: inViewport,
    occluded_by: occludedBy,
    occlusion: { points, clear },
    enabled: !disabled,
    region_id: region ? region.id : null,
  };
}

async function pageCensus(args: PageArgs): Promise<{ entries: any[]; truncated: boolean }> {
  const SKIP = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'];
  const groups = new Map<Element, Text[]>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    if (!t.textContent || !t.textContent.trim()) continue;
    const p = t.parentElement;
    if (!p || SKIP.indexOf(p.tagName) !== -1) continue;
    const vis = (p as any).checkVisibility ? (p as any).checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
    if (!vis) continue;
    const list = groups.get(p) || [];
    list.push(t);
    groups.set(p, list);
  }

  const entries: any[] = [];
  let truncated = false;
  const push = async (el: Element, text: string, source: 'text' | 'value' | 'placeholder', box: any, inputType: string | null) => {
    if (entries.length >= args.maxCensus) { truncated = true; return; }
    const region = pageRegionFor(el, args);
    const verdict = await pageClassified(
      text,
      { source, input_type: inputType, region, control_static_testid: pageControlStaticTestid(el), record_screen: args.recordScreen },
      args,
    );
    entries.push({ ...verdict, source, box, region_id: region ? region.id : null, testid_family: pageTestidFamily(el) });
  };

  for (const [el, nodes] of groups) {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const node of nodes) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width === 0 || rect.height === 0) continue;
        left = Math.min(left, rect.left); top = Math.min(top, rect.top);
        right = Math.max(right, rect.right); bottom = Math.max(bottom, rect.bottom);
      }
    }
    if (!isFinite(left)) continue;
    const box = pageClip({ left, top, right, bottom });
    if (!box) continue;
    const text = nodes.map((x) => x.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
    await push(el, text, 'text', box, null);
  }

  for (const field of Array.from(document.querySelectorAll('input, textarea, select'))) {
    const f = field as HTMLInputElement;
    const type = (f.getAttribute('type') || 'text').toLowerCase();
    if (type === 'hidden') continue;
    const r = f.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const box = pageClip(r);
    if (!box) continue;
    const value = field.tagName === 'SELECT'
      ? ((field as HTMLSelectElement).selectedOptions[0]?.textContent || '').trim()
      : f.value || '';
    if (value) await push(field, value, 'value', box, type);
    else if (f.getAttribute('placeholder')) await push(field, f.getAttribute('placeholder') as string, 'placeholder', box, type);
  }

  return { entries, truncated };
}

async function pageInventory(args: PageArgs): Promise<any[]> {
  const out: any[] = [];
  for (const el of Array.from(document.querySelectorAll(CONTROL_SELECTOR))) {
    if (out.length >= args.maxInventory) break;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    const vis = (el as any).checkVisibility ? (el as any).checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
    if (!vis) continue;
    const item = await pageDescribe(el, args);
    item.ref = '#inventory:' + out.length;
    out.push(item);
  }
  return out;
}

function pageScroll(): { x: number; y: number; containers: Array<{ key: string; top: number }> } {
  const containers: Array<{ key: string; top: number }> = [];
  let scanned = 0;
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (scanned++ > 4000) break;
    const st = getComputedStyle(el);
    if (!/(auto|scroll)/.test(st.overflowY) || el.scrollHeight <= el.clientHeight + 8) continue;
    const holder = el.closest('[data-testid]');
    const id = holder ? holder.getAttribute('data-testid') : null;
    containers.push({ key: id ? 'testid:' + normaliseTestid(id).family : 'tag:' + el.tagName.toLowerCase(), top: Math.round(el.scrollTop) });
  }
  return { x: Math.round(scrollX), y: Math.round(scrollY), containers };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * The injected script: installs the recorder's dom-probe (so role and accessible
 * name mean the same thing everywhere) and then `window.__ubCensus`.
 */
export function censusProbeSource(): string {
  const fns = [
    normaliseTestid, classifyTextRun, pageHmac, pageRoleOf, pageRegionFor, pageControlStaticTestid,
    pageTestidFamily, pageClip, pageClassified, pageNameSource, pageDescribe, pageCensus, pageInventory, pageScroll,
  ];
  return `${DOM_PROBE_SOURCE}
(() => {
  if (window.__ubCensus) return;
  const CONTROL_SELECTOR = ${JSON.stringify(CONTROL_SELECTOR)};
  ${fns.map((f) => f.toString()).join('\n')}
  window.__ubCensus = { census: pageCensus, describe: pageDescribe, inventory: pageInventory, scroll: pageScroll };
})();`;
}
