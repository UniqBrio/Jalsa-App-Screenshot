/**
 * Static inventory of an app's test ids, read with the TypeScript compiler's
 * own parser — never a regex over source text, which cannot tell a JSX
 * attribute from a comment, a string in a test, or a prop being forwarded.
 *
 * For every JSX element carrying one of the configured test-id attributes it
 * records:
 *
 *   · the id — a literal ("owner-bill-close"), or a PATTERN for an id built at
 *     runtime: `course-card-${course.id}` becomes "course-card-*", and
 *     `on ? 'a' : 'b'` becomes both "a" and "b";
 *   · whether the element is INTERACTIVE — by what it is (button, Pressable,
 *     TextInput …), by a handler it carries (onPress, onClick, href …), or by an
 *     interactive ARIA role — and so is something a flow must exercise;
 *   · file and line.
 *
 * Props that hand an id to a component's inner controls are read too:
 *   · a PREFIX prop (`testIDPrefix="member-tab"`) — the component builds its ids
 *     from it, so it registers the family "member-tab*";
 *   · a named sub-id prop (`confirmTestID="x"`, `closeTestID="y"`) — the id of
 *     one inner control, interactive when the element is, or when the prop names
 *     a button (close, confirm, cancel, submit, save, delete, remove).
 *
 * An id the parser cannot resolve (a forwarded `testID={testID}` prop) is
 * listed as unresolved, never guessed. Its call sites are where the real ids
 * live, and those are inventoried on their own.
 *
 * Everything else that merely LOOKS like an id — `{ testID: 'x' }` in an object,
 * any string literal anywhere — is collected only so that a flow selector is
 * not called stale when the id is assembled somewhere the JSX scan cannot see.
 * Those never create an obligation.
 */
import * as path from 'path';
import ts from 'typescript';
import type { InteractiveRules } from './source-config';

export type IdKind = 'literal' | 'pattern';

export interface TestIdSite {
  file: string;
  line: number;
  /** JSX element name as written: "Pressable", "Dialog.Close", "button". */
  element: string;
  interactive: boolean;
  /** Why it is (or is not) interactive: "element", "handler:onPress", "role:button", "display". */
  why: string;
  /**
   * `<Button asChild data-testid="a"><Link data-testid="b" …/></Button>` — Radix-style
   * Slot merges props and the child's id wins, so "a" never reaches the DOM.
   */
  shadowedBy?: string;
}

export interface TestIdEntry {
  /** The id, or the pattern with "*" for each runtime part. */
  key: string;
  kind: IdKind;
  sites: TestIdSite[];
  /** Interactive at any un-shadowed site. */
  interactive: boolean;
}

export interface UnresolvedSite {
  file: string;
  line: number;
  element: string;
  attribute: string;
  expression: string;
  interactive: boolean;
}

export interface ScanResult {
  filesListed: number;
  filesParsed: number;
  /** Files with syntax errors. They are still walked (the parser recovers), but say so. */
  parseErrors: Array<{ file: string; message: string }>;
  /** Files whose extension the parser does not read. */
  unsupported: string[];
  entries: Map<string, TestIdEntry>;
  unresolved: UnresolvedSite[];
  /** Ids seen outside JSX attributes (object properties). Existence evidence only. */
  indirect: Set<string>;
  /** Every string literal in the scanned files. Existence evidence only. */
  strings: Set<string>;
}

const PARSEABLE: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JSX,
  '.jsx': ts.ScriptKind.JSX,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};

/** ARIA roles that make an element something a user operates. */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'textbox', 'searchbox', 'combobox', 'slider', 'spinbutton',
]);

const WILD = '*';

/** A prop whose name carries "testid" but is not a configured attribute: an id for something inside. */
const ID_PROP = /test[_-]?id/i;
const PREFIX_PROP = /prefix/i;
const BUTTON_PROP = /close|confirm|cancel|submit|save|delete|remove|button|btn/i;

/** A pattern's "*" means one or more characters of anything. */
export function patternToRegExp(pattern: string): RegExp {
  const esc = pattern.split(WILD).map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${esc.join('.+')}$`);
}

function collapse(s: string): string {
  return s.replace(/\*{2,}/g, WILD);
}

interface Resolved {
  values: string[];
  /** Some part could not be resolved at all. */
  partial: boolean;
}

/** Statically resolves an attribute expression to literal ids and/or patterns. */
export function resolveIdExpression(expr: ts.Expression): Resolved {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return { values: [expr.text], partial: false };
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr)) {
    return resolveIdExpression(expr.expression);
  }
  if (ts.isTemplateExpression(expr)) {
    let s = expr.head.text;
    for (const span of expr.templateSpans) s += WILD + span.literal.text;
    return { values: [collapse(s)], partial: false };
  }
  if (ts.isConditionalExpression(expr)) {
    const a = resolveIdExpression(expr.whenTrue);
    const b = resolveIdExpression(expr.whenFalse);
    return { values: [...a.values, ...b.values], partial: a.partial || b.partial };
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) {
      const l = resolveIdExpression(expr.left);
      const r = resolveIdExpression(expr.right);
      const left = l.values.length ? l.values : [WILD];
      const right = r.values.length ? r.values : [WILD];
      const out: string[] = [];
      for (const x of left) for (const y of right) out.push(collapse(x + y));
      return { values: out, partial: false };
    }
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      const l = resolveIdExpression(expr.left);
      const r = resolveIdExpression(expr.right);
      return { values: [...l.values, ...r.values], partial: l.partial || r.partial || !l.values.length };
    }
  }
  return { values: [], partial: true };
}

function attrName(a: ts.JsxAttribute): string {
  return a.name.getText();
}

function attrInitExpr(a: ts.JsxAttribute): ts.Expression | null {
  const init = a.initializer;
  if (!init) return null;
  if (ts.isStringLiteral(init)) return init;
  if (ts.isJsxExpression(init) && init.expression) return init.expression;
  return null;
}

function literalAttr(attrs: ts.JsxAttributes, name: string): string | null {
  for (const p of attrs.properties) {
    if (ts.isJsxAttribute(p) && attrName(p) === name) {
      const e = attrInitExpr(p);
      if (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))) return e.text;
    }
  }
  return null;
}

function hasAttr(attrs: ts.JsxAttributes, name: string): boolean {
  return attrs.properties.some((p) => ts.isJsxAttribute(p) && attrName(p) === name);
}

/** Why an element is interactive, or "display". */
export function interactiveReason(tag: string, attrs: ts.JsxAttributes, rules: InteractiveRules): string {
  const last = tag.split('.').pop() ?? tag;
  if (rules.elements.includes(tag) || rules.elements.includes(last)) return 'element';
  for (const p of attrs.properties) {
    if (ts.isJsxAttribute(p) && rules.handlerProps.includes(attrName(p))) {
      const e = attrInitExpr(p);
      // `onPress={undefined}` is a handler that is not there.
      if (e && ts.isIdentifier(e) && e.text === 'undefined') continue;
      return `handler:${attrName(p)}`;
    }
  }
  for (const roleProp of ['role', 'accessibilityRole']) {
    const r = literalAttr(attrs, roleProp);
    if (r && INTERACTIVE_ROLES.has(r)) return `role:${r}`;
  }
  return 'display';
}

export interface ScanOptions {
  root: string;
  files: string[];
  attributes: string[];
  interactive: InteractiveRules;
  read: (rel: string) => string;
}

/** A function-like node's name, when it has one we can match calls and JSX tags against. */
function functionName(fn: ts.Node): string | null {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
    return fn.parent.name.text;
  }
  // React.forwardRef(...) / memo(...) wrapping: const Row = forwardRef((props, ref) => …)
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isCallExpression(fn.parent) && ts.isVariableDeclaration(fn.parent.parent) && ts.isIdentifier(fn.parent.parent.name)) {
    return fn.parent.parent.name.text;
  }
  return null;
}

type FnLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
const isFnLike = (n: ts.Node): n is FnLike => ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n);

/**
 * Which parameter of the nearest named function an id expression comes from:
 *   function Row({ testID }) { … testID={testID} }      → { fn: "Row", index: 0, viaProps: true }
 *   const action = (testID: string) => … testID={testID} → { fn: "action", index: 0, viaProps: false }
 *   function Row(props) { … testID={props.testID} }     → { fn: "Row", index: 0, viaProps: true }
 */
function paramSource(expr: ts.Expression): { fn: string; index: number; viaProps: boolean } | null {
  let e: ts.Expression = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  // `${testId}-confirm`, testId + '-x', cond ? testId : 'y' — the id is still built from the parameter.
  if (ts.isTemplateExpression(e)) {
    for (const span of e.templateSpans) {
      const s = paramSource(span.expression);
      if (s) return s;
    }
    return null;
  }
  if (ts.isBinaryExpression(e)) return paramSource(e.left) ?? paramSource(e.right);
  if (ts.isConditionalExpression(e)) return paramSource(e.whenTrue) ?? paramSource(e.whenFalse);
  let fn: ts.Node | undefined = e.parent;
  while (fn && !isFnLike(fn)) fn = fn.parent;
  if (!fn) return null;
  const name = functionName(fn);
  if (!name) return null;
  const params = (fn as FnLike).parameters;
  if (ts.isIdentifier(e)) {
    for (let i = 0; i < params.length; i++) {
      const b = params[i].name;
      if (ts.isIdentifier(b) && b.text === e.text) return { fn: name, index: i, viaProps: false };
      if (ts.isObjectBindingPattern(b) && b.elements.some((el) => ts.isIdentifier(el.name) && el.name.text === e.text)) {
        return { fn: name, index: i, viaProps: true };
      }
    }
  }
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
    const first = params[0]?.name;
    if (first && ts.isIdentifier(first) && first.text === e.expression.text) return { fn: name, index: 0, viaProps: true };
  }
  return null;
}

export function scanTestIds(opts: ScanOptions): ScanResult {
  const result: ScanResult = {
    filesListed: opts.files.length,
    filesParsed: 0,
    parseErrors: [],
    unsupported: [],
    entries: new Map(),
    unresolved: [],
    indirect: new Set(),
    strings: new Set(),
  };
  const attrSet = new Set(opts.attributes);

  const add = (key: string, site: TestIdSite) => {
    const kind: IdKind = key.includes(WILD) ? 'pattern' : 'literal';
    let e = result.entries.get(key);
    if (!e) {
      e = { key, kind, sites: [], interactive: false };
      result.entries.set(key, e);
    }
    e.sites.push(site);
    if (site.interactive && !site.shadowedBy) e.interactive = true;
  };

  // ── parse every file once ──
  const parsed: Array<{ rel: string; sf: ts.SourceFile }> = [];
  for (const rel of opts.files) {
    const kind = PARSEABLE[path.extname(rel).toLowerCase()];
    if (kind === undefined) {
      result.unsupported.push(rel);
      continue;
    }
    let text: string;
    try {
      text = opts.read(rel);
    } catch (err) {
      result.parseErrors.push({ file: rel, message: (err as Error).message });
      continue;
    }
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
    result.filesParsed += 1;
    const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (diags.length) result.parseErrors.push({ file: rel, message: ts.flattenDiagnosticMessageText(diags[0].messageText, ' ') });
    parsed.push({ rel, sf });
  }

  const idAttrs = (attrs: ts.JsxAttributes) =>
    attrs.properties.filter((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && attrSet.has(attrName(p)));

  // ── pass 1: components and helpers that forward an id to an element inside ──
  // A component whose test-id prop lands on an interactive element is
  // interactive wherever it is used, handler at the call site or not. Matched by
  // JSX tag name across the scanned files — the name a component is exported
  // and imported under in practice.
  const forwardsInteractive = new Map<string, boolean>();
  // Same-file helper functions called with the id as an argument: action('courses-add', …).
  const helpers = new Map<string, Map<string, { index: number; tag: string; interactive: boolean; why: string }>>();
  for (const { rel, sf } of parsed) {
    const visit = (node: ts.Node) => {
      const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
      if (opening) {
        const tag = opening.tagName.getText(sf);
        const why = interactiveReason(tag, opening.attributes, opts.interactive);
        for (const a of idAttrs(opening.attributes)) {
          const expr = attrInitExpr(a);
          const src = expr ? paramSource(expr) : null;
          if (!src) continue;
          if (src.viaProps) forwardsInteractive.set(src.fn, (forwardsInteractive.get(src.fn) ?? false) || why !== 'display');
          else {
            const m = helpers.get(rel) ?? new Map();
            m.set(src.fn, { index: src.index, tag, interactive: why !== 'display', why });
            helpers.set(rel, m);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // ── pass 2: the inventory ──
  for (const { rel, sf } of parsed) {
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const fileHelpers = helpers.get(rel);

    const visitElement = (tagNode: ts.JsxTagNameExpression, attrs: ts.JsxAttributes, children: readonly ts.JsxChild[] | null) => {
      const tag = tagNode.getText(sf);
      let why = interactiveReason(tag, attrs, opts.interactive);
      const last = tag.split('.').pop() ?? tag;
      if (why === 'display' && (forwardsInteractive.get(tag) || forwardsInteractive.get(last))) why = `forwards:${last}`;
      const interactive = why !== 'display';

      // asChild: the child element's own id replaces this one in the DOM.
      let shadowedBy: string | undefined;
      if (children && hasAttr(attrs, 'asChild')) {
        for (const c of children) {
          const childAttrs = ts.isJsxElement(c) ? c.openingElement.attributes : ts.isJsxSelfClosingElement(c) ? c.attributes : null;
          if (!childAttrs) continue;
          for (const a of opts.attributes) {
            const v = literalAttr(childAttrs, a);
            if (v) shadowedBy = v;
          }
        }
      }

      for (const p of attrs.properties) {
        if (!ts.isJsxAttribute(p)) continue;
        const name = attrName(p);
        if (!attrSet.has(name)) {
          if (!ID_PROP.test(name)) continue;
          const subExpr = attrInitExpr(p);
          const vals = subExpr ? resolveIdExpression(subExpr).values.filter((v) => v && v !== WILD) : [];
          for (const v of vals) {
            if (PREFIX_PROP.test(name)) {
              add(collapse(`${v}${WILD}`), { file: rel, line: lineOf(p), element: tag, interactive, why: `prefix:${name}` });
            } else {
              const sub = interactive || BUTTON_PROP.test(name);
              add(v, { file: rel, line: lineOf(p), element: tag, interactive: sub, why: sub ? `prop:${name}` : 'display' });
            }
          }
          continue;
        }
        const expr = attrInitExpr(p);
        const res = expr ? resolveIdExpression(expr) : { values: [], partial: true };
        const values = res.values.filter((v) => v && v !== WILD);
        for (const v of values) {
          add(v, { file: rel, line: lineOf(p), element: tag, interactive, why, ...(shadowedBy && shadowedBy !== v ? { shadowedBy } : {}) });
        }
        if (!values.length) {
          // A forwarded id is resolved at its call sites (pass 1); only the rest is unresolved.
          const src = expr ? paramSource(expr) : null;
          if (src && (src.viaProps || fileHelpers?.has(src.fn))) continue;
          result.unresolved.push({
            file: rel,
            line: lineOf(p),
            element: tag,
            attribute: name,
            expression: (expr?.getText(sf) ?? '(no value)').slice(0, 80),
            interactive,
          });
        }
      }
    };

    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (node.text.length <= 200) result.strings.add(node.text);
      } else if (ts.isTemplateExpression(node)) {
        const r = resolveIdExpression(node);
        for (const v of r.values) result.strings.add(v);
      }
      if (ts.isJsxElement(node)) {
        visitElement(node.openingElement.tagName, node.openingElement.attributes, node.children);
      } else if (ts.isJsxSelfClosingElement(node)) {
        visitElement(node.tagName, node.attributes, null);
      } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && fileHelpers?.has(node.expression.text)) {
        const h = fileHelpers.get(node.expression.text)!;
        const arg = node.arguments[h.index];
        for (const v of arg ? resolveIdExpression(arg).values.filter((x) => x && x !== WILD) : []) {
          add(v, { file: rel, line: lineOf(node), element: `${h.tag} via ${node.expression.text}()`, interactive: h.interactive, why: h.why });
        }
      } else if (ts.isObjectLiteralExpression(node)) {
        // { testID: 'x', onPress } — an id handed over as configuration.
        const props = node.properties.filter(ts.isPropertyAssignment);
        const nameOf = (p: ts.PropertyAssignment) => (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null);
        const handler = node.properties.some((p) => {
          const n = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
          return n !== null && opts.interactive.handlerProps.includes(n);
        });
        for (const p of props) {
          const n = nameOf(p);
          if (!n || !attrSet.has(n)) continue;
          for (const v of resolveIdExpression(p.initializer).values) {
            if (v === WILD) continue;
            result.indirect.add(v);
            if (handler) add(v, { file: rel, line: lineOf(p), element: '{object}', interactive: true, why: 'object:handler' });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return result;
}
