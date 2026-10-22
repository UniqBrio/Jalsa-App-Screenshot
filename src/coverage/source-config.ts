/**
 * The `source` block of an app profile: where an app's source code is, and how
 * to read test ids and pages out of it.
 *
 *   "source": {
 *     "repository": "your-org/your-app",
 *     "include": ["web/src/**\/*.tsx"],
 *     "exclude": ["**\/*.test.tsx"],
 *     "testIdAttributes": ["data-testid", "testID"],
 *     "interactive": { "elements": ["Button"], "handlerProps": ["onPress"] },
 *     "routes": { "strategy": "nextjs-app", "appDir": "web/src/app", "nextConfig": "web/next.config.ts" }
 *   }
 *
 * Every path is relative to the app repo ROOT, the same convention as
 * routes.map.json's source_paths (both are matched against `git diff
 * --name-only` output), so one module mapping serves the skip filter and the
 * coverage report alike.
 *
 * The block is optional: a profile without it still captures, and the
 * coverage commands say plainly that the app has no source configured.
 *
 * This file is pure — no env, no filesystem — so profile.ts can call it while
 * parsing without an import cycle.
 */

export const ROUTE_STRATEGIES = ['nextjs-app', 'expo-router', 'none'] as const;
export type RouteStrategy = (typeof ROUTE_STRATEGIES)[number];

export interface InteractiveRules {
  /** JSX element names that are interactive whatever their props (button, Pressable …). */
  elements: string[];
  /** Props that make ANY element interactive (onPress, onClick, href …). */
  handlerProps: string[];
}

export interface RouteConfig {
  strategy: RouteStrategy;
  /** Repo-relative folder the router reads (Next: src/app or app; Expo: app). */
  appDir: string;
  /** Next.js only: repo-relative next.config.* whose redirects() are read. Optional. */
  nextConfig: string;
}

export interface SourceConfig {
  /** "owner/name" on GitHub. Used to verify a local clone is the right repo, and by CI to check it out. */
  repository: string;
  include: string[];
  exclude: string[];
  testIdAttributes: string[];
  interactive: InteractiveRules;
  routes: RouteConfig;
}

/** Elements that are interactive by what they ARE, across web and React Native. */
export const DEFAULT_INTERACTIVE_ELEMENTS = [
  // web
  'a', 'button', 'input', 'select', 'textarea', 'summary',
  // React Native / react-native-web
  'Pressable', 'TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback',
  'TouchableNativeFeedback', 'TextInput', 'Switch',
  // the usual design-system and router names
  'Button', 'Link',
];

/** Props that make any element interactive, whatever it is called. */
export const DEFAULT_HANDLER_PROPS = [
  'onClick', 'onPress', 'onLongPress', 'onPressIn', 'onChange', 'onChangeText', 'onValueChange',
  'onSubmit', 'onSubmitEditing', 'onCheckedChange', 'onSelect', 'onToggle', 'onConfirm', 'onCancel', 'href',
];

export const DEFAULT_TESTID_ATTRIBUTES = ['data-testid', 'testID'];

const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/*.d.ts',
];

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function strList(v: unknown, where: string, e: string[], opts: { required?: boolean } = {}): string[] {
  if (v === undefined && !opts.required) return [];
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string' && s.trim()) || (opts.required && !v.length)) {
    e.push(`${where}: ${opts.required ? 'a non-empty' : 'an'} array of non-empty strings`);
    return [];
  }
  return v.map((s: string) => s.trim());
}

function relPathOk(p: string): boolean {
  return !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split('/').includes('..');
}

/**
 * Parses the raw `source` value. Pushes every problem into `e` (prefixed
 * `source.`) and returns null when the block is absent.
 */
export function parseSourceConfig(raw: unknown, e: string[]): SourceConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    e.push('source: an object — see apps/_template/app.config.json');
    return null;
  }
  const o = raw as Record<string, any>;

  const repository = typeof o.repository === 'string' ? o.repository.trim() : '';
  if (!REPO_RE.test(repository)) e.push('source.repository: "owner/name" of the app repo on GitHub');

  const include = strList(o.include, 'source.include', e, { required: true });
  const exclude = [...DEFAULT_EXCLUDE, ...strList(o.exclude, 'source.exclude', e)];
  for (const g of [...include, ...exclude]) {
    if (!relPathOk(g)) e.push(`source: "${g}" must be relative to the app repo root (no leading /, no ..)`);
  }

  const attrs = o.testIdAttributes === undefined ? DEFAULT_TESTID_ATTRIBUTES : strList(o.testIdAttributes, 'source.testIdAttributes', e, { required: true });
  for (const a of attrs) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(a)) e.push(`source.testIdAttributes: "${a}" is not a JSX attribute name`);
  }

  const inter = o.interactive ?? {};
  if (typeof inter !== 'object' || Array.isArray(inter)) e.push('source.interactive: an object of { elements, handlerProps }');
  const interactive: InteractiveRules = {
    elements: [...DEFAULT_INTERACTIVE_ELEMENTS, ...strList(inter.elements, 'source.interactive.elements', e)],
    handlerProps: [...DEFAULT_HANDLER_PROPS, ...strList(inter.handlerProps, 'source.interactive.handlerProps', e)],
  };

  const r = o.routes;
  let routes: RouteConfig = { strategy: 'none', appDir: '', nextConfig: '' };
  if (r === undefined) {
    e.push('source.routes: required — { "strategy": "nextjs-app" | "expo-router" | "none", "appDir": "..." }. ' +
      'Say "none" explicitly when the app has no file-based router, so a missing page check is a decision, not an accident.');
  } else if (!r || typeof r !== 'object' || Array.isArray(r)) {
    e.push('source.routes: an object');
  } else {
    if (!ROUTE_STRATEGIES.includes(r.strategy)) e.push(`source.routes.strategy: one of ${ROUTE_STRATEGIES.join(' | ')}`);
    const appDir = typeof r.appDir === 'string' ? r.appDir.trim().replace(/\/+$/, '') : '';
    if (r.strategy !== 'none' && !appDir) e.push('source.routes.appDir: the repo-relative folder the router reads, e.g. "app" or "src/app"');
    if (appDir && !relPathOk(appDir)) e.push('source.routes.appDir: relative to the app repo root');
    const nextConfig = typeof r.nextConfig === 'string' ? r.nextConfig.trim() : '';
    if (nextConfig && r.strategy !== 'nextjs-app') e.push('source.routes.nextConfig: only meaningful with strategy "nextjs-app"');
    if (nextConfig && !relPathOk(nextConfig)) e.push('source.routes.nextConfig: relative to the app repo root');
    routes = { strategy: r.strategy, appDir, nextConfig };
  }

  const known = ['$comment', 'repository', 'include', 'exclude', 'testIdAttributes', 'interactive', 'routes'];
  for (const k of Object.keys(o)) if (!known.includes(k)) e.push(`source.${k}: unknown key (known: ${known.slice(1).join(', ')})`);

  return { repository, include, exclude, testIdAttributes: attrs, interactive, routes };
}
