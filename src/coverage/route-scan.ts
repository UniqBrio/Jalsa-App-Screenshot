/**
 * Page discovery from the app's own source — the router's file conventions,
 * read the way the router reads them, so a page is found whether or not any
 * menu links to it.
 *
 * Strategies (profile `source.routes.strategy`):
 *
 *   nextjs-app   Next.js App Router. A page is `page.{tsx,ts,jsx,js,mdx}` under appDir.
 *                (group) folders vanish from the URL; [x] is dynamic, [...x] catch-all,
 *                [[...x]] optional catch-all; _private folders are not routable; route.ts
 *                is an API, not a page; layouts are not pages. Intercepting routes
 *                ((.)x, (..)x, (...)x) and parallel slots (@x) are reported as
 *                UNCLASSIFIABLE — whether they own a URL depends on navigation state.
 *                `redirects()` in next.config are read as redirect routes.
 *   expo-router  Expo Router. Every module under appDir with a default export is a
 *                route; _layout is a layout; +html, +native-intent, +middleware are
 *                special; +not-found is the 404; name+api is an API route; index is
 *                its folder; .ios/.android/.native/.web variants are ONE route. A
 *                module with no default export is not a route (Expo ignores it), and
 *                one that renders no JSX at all (a client or helper kept in the router
 *                folder) is not a screen.
 *   none         The app declares it has no file-based router. Nothing is discovered,
 *                and the report says the check was not applicable — not that it passed.
 *
 * A page that only redirects (no JSX besides <Redirect>, or a Next page that
 * calls redirect() and renders nothing) is kind "redirect": it is listed, but
 * it is not a screen to capture.
 */
import * as path from 'path';
import ts from 'typescript';
import type { RouteConfig } from './source-config';

export type RouteKind = 'page' | 'redirect';

export interface DiscoveredRoute {
  /** URL path in file-route notation: /course/[id], /docs/[...slug]. */
  path: string;
  kind: RouteKind;
  /** Every file that defines it (platform variants of one route are one route). */
  files: string[];
}

export interface RouteScan {
  strategy: RouteConfig['strategy'];
  filesConsidered: number;
  routes: DiscoveredRoute[];
  /** Files under the router folder that are not pages, with the reason. */
  ignored: Array<{ file: string; why: string }>;
  unclassifiable: Array<{ file: string; why: string }>;
  /** Distinct files resolving to one URL — the router can only serve one of them. */
  duplicates: Array<{ path: string; files: string[] }>;
}

/** Comparison key: parameter names do not matter, parameter shapes do. */
export function routeKey(p: string): string {
  let s = p.trim();
  if (s.length > 1) s = s.replace(/\/+$/, '');
  s = s.replace(/:([A-Za-z0-9_]+)\*/g, '[[...$1]]').replace(/:([A-Za-z0-9_]+)\+/g, '[...$1]').replace(/:([A-Za-z0-9_]+)/g, '[$1]');
  return s.replace(/\[\[\.\.\.[^\]]*\]\]/g, '[[...]]').replace(/\[\.\.\.[^\]]*\]/g, '[...]').replace(/\[[^\].]+\]/g, '[]').toLowerCase() || '/';
}

interface ModuleFacts {
  defaultExport: boolean;
  jsxTags: string[];
  redirectCall: boolean;
}

function moduleFacts(file: string, text: string): ModuleFacts {
  const kind = /\.(tsx|jsx)$/i.test(file) ? ts.ScriptKind.TSX : /\.js$/i.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  let defaultExport = false;
  const jsxTags: string[] = [];
  let redirectImported = false;
  let redirectCall = false;
  const visit = (n: ts.Node) => {
    if (ts.isExportAssignment(n) && !n.isExportEquals) defaultExport = true;
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      defaultExport = true;
    }
    if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause)) {
      if (n.exportClause.elements.some((e) => e.name.text === 'default')) defaultExport = true;
    }
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === 'next/navigation') {
      const named = n.importClause?.namedBindings;
      if (named && ts.isNamedImports(named) && named.elements.some((e) => ['redirect', 'permanentRedirect'].includes((e.propertyName ?? e.name).text))) {
        redirectImported = true;
      }
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ['redirect', 'permanentRedirect'].includes(n.expression.text)) redirectCall = true;
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) jsxTags.push(n.tagName.getText(sf));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { defaultExport, jsxTags, redirectCall: redirectImported && redirectCall };
}

function finish(
  strategy: RouteConfig['strategy'],
  considered: number,
  found: Array<{ path: string; kind: RouteKind; file: string; variantOf: string }>,
  ignored: RouteScan['ignored'],
  unclassifiable: RouteScan['unclassifiable'],
): RouteScan {
  const byKey = new Map<string, { route: DiscoveredRoute; bases: Set<string> }>();
  for (const f of found) {
    const k = routeKey(f.path);
    const cur = byKey.get(k);
    if (!cur) byKey.set(k, { route: { path: f.path, kind: f.kind, files: [f.file] }, bases: new Set([f.variantOf]) });
    else {
      cur.route.files.push(f.file);
      cur.bases.add(f.variantOf);
      if (f.kind === 'page') cur.route.kind = 'page';
    }
  }
  const routes: DiscoveredRoute[] = [];
  const duplicates: RouteScan['duplicates'] = [];
  for (const { route, bases } of byKey.values()) {
    route.files.sort();
    routes.push(route);
    if (bases.size > 1) duplicates.push({ path: route.path, files: route.files });
  }
  routes.sort((a, b) => a.path.localeCompare(b.path));
  return { strategy, filesConsidered: considered, routes, ignored, unclassifiable, duplicates };
}

const NEXT_PAGE = /^page\.(tsx|ts|jsx|js|mdx)$/;

export function scanNextAppRouter(cfg: RouteConfig, files: string[], read: (rel: string) => string): RouteScan {
  const base = cfg.appDir.replace(/\/+$/, '') + '/';
  const found: Array<{ path: string; kind: RouteKind; file: string; variantOf: string }> = [];
  const ignored: RouteScan['ignored'] = [];
  const unclassifiable: RouteScan['unclassifiable'] = [];
  let considered = 0;

  for (const file of files) {
    if (!file.startsWith(base)) continue;
    const rel = file.slice(base.length);
    const parts = rel.split('/');
    const name = parts.pop()!;
    if (!NEXT_PAGE.test(name)) continue;
    considered += 1;
    let why: string | null = null;
    let odd: string | null = null;
    const segs: string[] = [];
    for (const raw of parts) {
      const seg = raw.replace(/%5F/gi, '_');
      if (raw.startsWith('_')) { why = `private folder "${raw}" — not routable`; break; }
      if (/^\((\.{1,3}|\.\.\)\(\.\.)\)/.test(seg)) { odd = `intercepting route "${seg}" — owns a URL only during in-app navigation`; break; }
      if (seg.startsWith('@')) { odd = `parallel route slot "${seg}" — rendered inside its parent, not its own URL`; break; }
      if (/^\(.*\)$/.test(seg)) continue;
      segs.push(seg);
    }
    if (why) { ignored.push({ file, why }); continue; }
    if (odd) { unclassifiable.push({ file, why: odd }); continue; }
    if (name.endsWith('.mdx')) {
      found.push({ path: '/' + segs.join('/'), kind: 'page', file, variantOf: file });
      continue;
    }
    const facts = moduleFacts(file, read(file));
    if (!facts.defaultExport) { ignored.push({ file, why: 'page file with no default export — Next.js would not build it' }); continue; }
    const kind: RouteKind = facts.redirectCall && facts.jsxTags.length === 0 ? 'redirect' : 'page';
    found.push({ path: '/' + segs.join('/'), kind, file, variantOf: file });
  }

  if (cfg.nextConfig && files.includes(cfg.nextConfig)) {
    for (const r of nextConfigRedirects(cfg.nextConfig, read(cfg.nextConfig))) {
      found.push({ path: r, kind: 'redirect', file: cfg.nextConfig, variantOf: `${cfg.nextConfig}#${r}` });
    }
  }
  return finish('nextjs-app', considered, found, ignored, unclassifiable);
}

/** `source` paths of literal { source, destination } objects in next.config — Next's own redirect syntax. */
export function nextConfigRedirects(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      const props = new Map<string, ts.Expression>();
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) props.set(p.name.text, p.initializer);
      }
      const src = props.get('source');
      if (src && props.has('destination') && (ts.isStringLiteral(src) || ts.isNoSubstitutionTemplateLiteral(src)) && src.text.startsWith('/')) {
        out.push(src.text.replace(/:([A-Za-z0-9_]+)\*/g, '[[...$1]]').replace(/:([A-Za-z0-9_]+)\+/g, '[...$1]').replace(/:([A-Za-z0-9_]+)/g, '[$1]'));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const EXPO_EXT = /\.(tsx|ts|jsx|js)$/;
const PLATFORM = /\.(ios|android|native|web)$/;
const EXPO_SPECIAL = new Set(['+html', '+native-intent', '+middleware']);

export function scanExpoRouter(cfg: RouteConfig, files: string[], read: (rel: string) => string): RouteScan {
  const base = cfg.appDir.replace(/\/+$/, '') + '/';
  const found: Array<{ path: string; kind: RouteKind; file: string; variantOf: string }> = [];
  const ignored: RouteScan['ignored'] = [];
  const unclassifiable: RouteScan['unclassifiable'] = [];
  let considered = 0;

  for (const file of files) {
    if (!file.startsWith(base) || !EXPO_EXT.test(file)) continue;
    considered += 1;
    const rel = file.slice(base.length).replace(EXPO_EXT, '');
    const parts = rel.split('/');
    let name = parts.pop()!;
    name = name.replace(PLATFORM, '');
    const variantOf = [...parts, name].join('/');

    if (name === '_layout') { ignored.push({ file, why: 'layout — wraps routes, is not one' }); continue; }
    if (EXPO_SPECIAL.has(name)) { ignored.push({ file, why: `${name} — router special file, not a screen` }); continue; }
    if (name === '+not-found') { ignored.push({ file, why: '+not-found — the 404 screen, reached by any unknown URL' }); continue; }
    if (name.endsWith('+api')) { ignored.push({ file, why: 'API route (+api), not a screen' }); continue; }
    if (name.startsWith('+')) { unclassifiable.push({ file, why: `unknown router special "${name}"` }); continue; }

    // Without a default export a module is not a route, whatever its name.
    const facts = moduleFacts(file, read(file));
    if (!facts.defaultExport) { ignored.push({ file, why: 'no default export — Expo Router does not treat it as a route' }); continue; }
    // A client, a type file, a helper kept in the router folder: exported, but renders nothing.
    if (facts.jsxTags.length === 0) { ignored.push({ file, why: 'renders no JSX — a module kept in the router folder, not a screen' }); continue; }

    const segs: string[] = [];
    let odd: string | null = null;
    for (const seg of [...parts, name]) {
      if (/^\(.*,.*\)$/.test(seg)) { odd = `array group "${seg}" — one file, several URLs`; break; }
      if (/^\(.*\)$/.test(seg)) continue;
      if (seg.startsWith('_')) { odd = `underscore-prefixed "${seg}" — not a router convention this check can classify`; break; }
      segs.push(seg);
    }
    if (odd) { unclassifiable.push({ file, why: odd }); continue; }
    if (segs[segs.length - 1] === 'index') segs.pop();
    const kind: RouteKind = facts.jsxTags.length > 0 && facts.jsxTags.every((t) => t === 'Redirect') ? 'redirect' : 'page';
    found.push({ path: '/' + segs.join('/'), kind, file, variantOf });
  }
  return finish('expo-router', considered, found, ignored, unclassifiable);
}

export function scanRoutes(cfg: RouteConfig, files: string[], read: (rel: string) => string): RouteScan {
  switch (cfg.strategy) {
    case 'nextjs-app': return scanNextAppRouter(cfg, files, read);
    case 'expo-router': return scanExpoRouter(cfg, files, read);
    case 'none': return { strategy: 'none', filesConsidered: 0, routes: [], ignored: [], unclassifiable: [], duplicates: [] };
    default: {
      const never: never = cfg.strategy;
      throw new Error(`Unknown route strategy "${never}"`);
    }
  }
}

/** Repo-relative globs a strategy needs listed, on top of `source.include`. */
export function routeGlobs(cfg: RouteConfig): string[] {
  if (cfg.strategy === 'none') return [];
  const g = [`${cfg.appDir}/**/*`];
  if (cfg.nextConfig) g.push(cfg.nextConfig);
  return g;
}

/**
 * Best route for a concrete path — static segments beat dynamic ones, as both
 * routers resolve them. `*` in the path (a {{VAR}}) matches one segment.
 */
export function matchRoute(visit: string, routes: DiscoveredRoute[]): DiscoveredRoute | null {
  const vs = visit === '/' ? [] : visit.replace(/^\//, '').split('/');
  let best: { r: DiscoveredRoute; score: number } | null = null;
  for (const r of routes) {
    const rs = r.path === '/' ? [] : r.path.replace(/^\//, '').split('/');
    const score = segScore(vs, rs);
    if (score !== null && (!best || score > best.score)) best = { r, score };
  }
  return best?.r ?? null;
}

/** Higher = more specific. null = no match. */
function segScore(vs: string[], rs: string[]): number | null {
  let score = 0;
  let i = 0;
  for (let j = 0; j < rs.length; j++) {
    const seg = rs[j];
    const opt = /^\[\[\.\.\.[^\]]*\]\]$/.test(seg);
    const rest = opt || /^\[\.\.\.[^\]]*\]$/.test(seg);
    if (rest) {
      const remaining = vs.length - i;
      if (remaining < (opt ? 0 : 1)) return null;
      return score + (opt ? 0 : 1);
    }
    if (i >= vs.length) return null;
    const v = vs[i];
    if (/^\[[^\]]+\]$/.test(seg)) score += 2;
    else if (v === '*') score += 1;
    else if (v.toLowerCase() === seg.toLowerCase()) score += 4;
    else return null;
    i++;
  }
  return i === vs.length ? score : null;
}

export function routeLabel(p: string): string {
  if (p === '/') return 'Home';
  const last = path.posix.basename(p).replace(/^\[+\.*|\]+$/g, '');
  return last.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
