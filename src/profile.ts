/**
 * App profiles — everything that is specific to one target app.
 *
 *   apps/<app-id>/
 *     app.config.json   identity, hosts, login adapter, accounts, dummy fingerprint
 *     .env              this app's credentials only (never committed)
 *     flows/            flow manifests
 *     config/           routes.map.json, known_routes.json, pii-regions.json, manual-review-items.json
 *     fingerprints/     baseline.json, last-run.json
 *
 * The engine never falls back to a default app: a run with no app selected
 * stops with an error naming the profiles that exist. `apps/_template/` is the
 * documented starting point for a new one.
 *
 * Parsing is strict and total — every problem is collected and reported at
 * once, before a browser launches.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseSourceConfig, type SourceConfig } from './coverage/source-config';

export const LOGIN_ADAPTERS = ['mobile-pin', 'pin-only', 'email-password', 'username-password'] as const;
export type LoginAdapterType = (typeof LOGIN_ADAPTERS)[number];

export const FRAMEWORKS = ['react-native-web', 'nextjs', 'react', 'vue', 'angular', 'svelte', 'other'] as const;
export type Framework = (typeof FRAMEWORKS)[number];

/** The identity name reserved for the dummy account. Only it may ever write. */
export const DUMMY_IDENTITY = 'dummy';
/** `auth: none` — a fresh signed-out context. Not an account. */
export const NO_AUTH = 'none';

export interface LoginAdapterConfig {
  type: LoginAdapterType;
  /** Adapter-specific selector map. Required keys depend on `type` (see login-adapters.ts). */
  selectors: Record<string, string>;
  /** Adapter-specific options. Unknown keys are rejected by the adapter's own check. */
  options: Record<string, unknown>;
}

export interface AccountConfig {
  /**
   * Name of the app .env variable holding the login (mobile number, email or
   * username). Empty only under the `pin-only` adapter, where the PIN alone
   * identifies the person.
   */
  userEnv: string;
  /** Name of the app .env variable holding the secret (PIN or password). */
  secretEnv: string;
  /** Missing credentials skip this identity's flows with a reason instead of failing the run. */
  optional: boolean;
  description: string;
  /**
   * Where THIS account signs in, when an app has one sign-in screen per
   * surface (an owner console and a staff handset). Overrides the adapter's
   * loginPath for this identity. Supported by `pin-only`.
   */
  loginPath?: string;
}

/** How the app reveals, after sign-in, which tenant the session belongs to. */
export interface TenantProbe {
  /** Element that carries the value. */
  selector?: string;
  /** Read this attribute instead of the element's text. */
  attribute?: string;
  /** Alternatively: a regex with one capture group, matched against the URL after sign-in. */
  urlPattern?: string;
}

/**
 * How this app's test data is kept away from real users and real records.
 *
 *   separate-project  its own deployment AND its own database
 *   separate-tenant   a genuinely separate tenant inside a shared deployment
 *   none              no isolation is claimed — writes are refused outright
 *
 * "none" is the default and the safe answer. Claiming isolation is an
 * assertion about the app's architecture: a single-tenant app CANNOT be
 * "separate-tenant", however many logins it has.
 */
export type DataIsolation = 'separate-project' | 'separate-tenant' | 'none';
export const DATA_ISOLATIONS: DataIsolation[] = ['separate-project', 'separate-tenant', 'none'];

/**
 * A human's attestation that outbound messaging is switched OFF for the target
 * this app writes to, naming the control that does it and the date it was
 * checked. Writes and send-confirming steps are refused without it.
 *
 *   { "email": "EMAIL_PROVIDER=dev", "verifiedOn": "2026-09-25" }
 *
 * Keys other than verifiedOn are channels (email, sms, whatsapp, push).
 */
export interface OutboundKillSwitch {
  /** channel -> the control that disables it. */
  channels: Record<string, string>;
  /** ISO date the attestation was checked. */
  verifiedOn: string;
}

export interface DummyAccountConfig {
  /** Expected identity after sign-in. Both must match EXACTLY or the run aborts. */
  fingerprint: {
    tenantId: string;
    tenantName: string;
    tenantIdProbe: TenantProbe;
    tenantNameProbe: TenantProbe;
  };
  /**
   * True only when outbound email/SMS/WhatsApp is switched off for the dummy
   * tenant. A write flow that declares `sends_messages` is skipped (and flagged
   * in the run report) unless this is true.
   */
  messagingSuppressed: boolean;
  /** Extra phone values a write flow may type, beyond the built-in fake shapes. */
  syntheticPhones: string[];
}

export interface DiscoveryNavSource {
  /** Route to open before reading the controls. */
  path: string;
  /** Selector matching every navigation control to try. */
  items: string;
  /** How a control is re-found to be tapped: by role + accessible name. */
  role: string;
  /** Label read from this attribute (default: aria-label, then text). */
  labelAttribute?: string;
  /** Cut the label at the first of these characters ("Branches, 1" → "Branches"). */
  labelCut?: string;
  tab: boolean;
}

/**
 * PII shapes that are specific to one app's country and data, not to the engine.
 * A phone number looks different in every market, so the core carries no phone
 * assumption at all: an app that wants phone-shaped text classified as personal
 * says what that shape is.
 */
export interface PiiPatterns {
  /** Regex source matching a phone number in this app's market. null = no phone rule. */
  phonePattern: string | null;
}

export interface AppProfile {
  id: string;
  /** Absolute path of apps/<id>/. */
  dir: string;
  appName: string;
  /** One line. Used in LLM prompts and generated docs. */
  appDescription: string;
  baseUrl: string;
  allowedHosts: string[];
  writeAllowedHosts: string[];
  repoPath: string;
  repoBranch: string;
  framework: Framework;
  theme: 'light' | 'dark';
  locale: string;
  timezone: string;
  /** Who the generated documentation is written for. */
  docsAudience: string;
  loginAdapter: LoginAdapterConfig;
  /** How test data is isolated from real data. "none" refuses every write. */
  dataIsolation: DataIsolation;
  /** App-specific PII shapes for evidence classification. */
  pii: PiiPatterns;
  /** Attestation that outbound messaging is off for this target, or null. */
  outboundKillSwitch: OutboundKillSwitch | null;
  accounts: Record<string, AccountConfig>;
  /** Identity a flow signs in as when it does not say. */
  defaultAccount: string;
  /** Other app .env variables flows may interpolate as {{NAME}} (never credentials). */
  extraEnvVars: string[];
  dummyAccount: DummyAccountConfig | null;
  /** Selectors of nuisance overlays (nudges, cookie prompts) dismissed before each tap. */
  interstitials: string[];
  discovery: { navSources: DiscoveryNavSource[] };
  /**
   * Where the app's source is and how to read test ids and pages from it, for
   * `npm run coverage` / `audit:coverage`. Null = not configured (capture still works).
   */
  source: SourceConfig | null;
}

const ID_RE = /^[a-z0-9_][a-z0-9_-]{0,39}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
/** Names the engine itself defines for interpolation — an account may not shadow them. */
const RESERVED_VARS = ['APP_URL', 'RUN_ID', 'RUN_TAG'];

export function appsDir(root: string): string {
  return process.env.APPS_DIR ? path.resolve(process.env.APPS_DIR) : path.join(root, 'apps');
}

/** Profile folders that exist, for error messages. */
export function listProfiles(root: string): string[] {
  const dir = appsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'app.config.json')))
    .map((e) => e.name)
    .sort();
}

/**
 * The selected app id: `--app <id>` / `--app=<id>` on the command line, else
 * the APP environment variable. Never a default.
 */
export function selectedAppId(argv: string[] = process.argv): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app' && argv[i + 1]) return argv[i + 1].trim();
    if (argv[i].startsWith('--app=')) return argv[i].slice('--app='.length).trim();
  }
  const fromEnv = (process.env.APP ?? '').trim();
  return fromEnv || null;
}

export function noAppSelectedMessage(root: string): string {
  const available = listProfiles(root);
  return (
    `No app selected. Pass --app <app-id> or set APP=<app-id>.\n` +
    `  Profiles available: ${available.length ? available.join(', ') : '(none — copy apps/_template to apps/<app-id>)'}\n` +
    `  There is no default app, on purpose: a run must always say which app it targets.`
  );
}

function hostOk(h: unknown): h is string {
  return typeof h === 'string' && /^[a-z0-9.-]+$/i.test(h) && h.length > 0;
}

function probeErrors(p: unknown, where: string): string[] {
  const e: string[] = [];
  if (!p || typeof p !== 'object') return [`${where}: an object with "selector" (+ optional "attribute") or "urlPattern"`];
  const o = p as TenantProbe;
  if (!o.selector && !o.urlPattern) e.push(`${where}: needs "selector" or "urlPattern"`);
  if (o.selector && o.urlPattern) e.push(`${where}: use "selector" or "urlPattern", not both`);
  if (o.urlPattern) {
    try {
      if (new RegExp(o.urlPattern).source.indexOf('(') === -1) e.push(`${where}.urlPattern: needs one capture group`);
    } catch {
      e.push(`${where}.urlPattern: not a valid regular expression`);
    }
  }
  return e;
}

/** Parses a raw app.config.json. Throws with every problem listed. */
export function parseProfile(raw: unknown, id: string, dir: string): AppProfile {
  const e: string[] = [];
  const src = `apps/${id}/app.config.json`;
  if (typeof raw !== 'object' || raw === null) throw new Error(`${src}: must be a JSON object`);
  const o = raw as Record<string, any>;

  const reqStr = (k: string): string => {
    if (typeof o[k] !== 'string' || !o[k].trim()) { e.push(`${k}: a non-empty string is required`); return ''; }
    return o[k].trim();
  };
  const optStr = (k: string, fallback: string): string => {
    if (o[k] === undefined || o[k] === null) return fallback;
    if (typeof o[k] !== 'string') { e.push(`${k}: must be a string`); return fallback; }
    return o[k].trim() || fallback;
  };
  const hostList = (k: string, required: boolean): string[] => {
    const v = o[k];
    if (v === undefined && !required) return [];
    if (!Array.isArray(v) || (required && !v.length) || !v.every(hostOk)) {
      e.push(`${k}: ${required ? 'a non-empty' : 'an'} array of bare host names (no scheme, no port)`);
      return [];
    }
    return v.map((h: string) => h.toLowerCase());
  };

  if (!ID_RE.test(id)) e.push(`app id "${id}": lower-case letters, digits, - and _ only`);
  if (id === 'all') e.push('app id "all" is reserved: `--app all` means every registered app');

  const appName = reqStr('appName');
  const appDescription = reqStr('appDescription');
  if (/\n/.test(appDescription)) e.push('appDescription: one line only');
  const baseUrl = reqStr('baseUrl').replace(/\/+$/, '');
  const allowedHosts = hostList('allowedHosts', true);
  const writeAllowedHosts = hostList('writeAllowedHosts', false);
  for (const h of writeAllowedHosts) {
    if (!allowedHosts.includes(h)) e.push(`writeAllowedHosts: "${h}" must also be in allowedHosts`);
  }

  const framework = optStr('framework', 'other') as Framework;
  if (!FRAMEWORKS.includes(framework)) e.push(`framework: one of ${FRAMEWORKS.join(' | ')}`);
  const theme = optStr('theme', 'light');
  if (theme !== 'light' && theme !== 'dark') e.push('theme: "light" or "dark"');

  // Login adapter.
  const la = o.loginAdapter;
  let loginAdapter: LoginAdapterConfig = { type: 'email-password', selectors: {}, options: {} };
  if (!la || typeof la !== 'object') e.push('loginAdapter: an object with "type", "selectors" and optional "options"');
  else {
    if (!LOGIN_ADAPTERS.includes(la.type)) e.push(`loginAdapter.type: one of ${LOGIN_ADAPTERS.join(' | ')}`);
    const sels = la.selectors ?? {};
    if (typeof sels !== 'object' || Array.isArray(sels) || !Object.values(sels).every((s) => typeof s === 'string' && s)) {
      e.push('loginAdapter.selectors: an object of non-empty selector strings');
    }
    if (la.options !== undefined && (typeof la.options !== 'object' || Array.isArray(la.options))) {
      e.push('loginAdapter.options: an object');
    }
    loginAdapter = { type: la.type, selectors: { ...sels }, options: { ...(la.options ?? {}) } };
  }

  // Accounts.
  const accounts: Record<string, AccountConfig> = {};
  if (!o.accounts || typeof o.accounts !== 'object' || Array.isArray(o.accounts) || !Object.keys(o.accounts).length) {
    e.push('accounts: an object of { <identity>: { userEnv, secretEnv } } with at least one entry');
  } else {
    const seenEnv = new Set<string>();
    for (const [name, a] of Object.entries<any>(o.accounts)) {
      const where = `accounts.${name}`;
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name) || name === NO_AUTH) {
        e.push(`${where}: identity names are lower-case words, and "${NO_AUTH}" is reserved for signed-out flows`);
        continue;
      }
      if (!a || typeof a !== 'object') { e.push(`${where}: an object`); continue; }
      // A PIN-only sign-in has no login to look up: the PIN is the identity.
      const pinOnly = la?.type === 'pin-only';
      if (pinOnly && a.userEnv === undefined) a.userEnv = '';
      for (const k of ['userEnv', 'secretEnv']) {
        if (k === 'userEnv' && pinOnly && a.userEnv === '') continue;
        if (typeof a[k] !== 'string' || !ENV_NAME_RE.test(a[k])) e.push(`${where}.${k}: an UPPER_SNAKE .env variable name`);
        else if (RESERVED_VARS.includes(a[k])) e.push(`${where}.${k}: "${a[k]}" is reserved by the engine`);
        else if (seenEnv.has(a[k])) e.push(`${where}.${k}: "${a[k]}" is already used by another account`);
        else seenEnv.add(a[k]);
      }
      if (a.loginPath !== undefined && (typeof a.loginPath !== 'string' || !a.loginPath.startsWith('/'))) {
        e.push(`${where}.loginPath: a route starting with "/"`);
      }
      accounts[name] = {
        userEnv: a.userEnv,
        secretEnv: a.secretEnv,
        optional: a.optional === true,
        description: typeof a.description === 'string' ? a.description : '',
        ...(typeof a.loginPath === 'string' ? { loginPath: a.loginPath } : {}),
      };
    }
  }
  const defaultAccount = optStr('defaultAccount', Object.keys(accounts)[0] ?? '');
  if (defaultAccount && !accounts[defaultAccount]) e.push(`defaultAccount: "${defaultAccount}" is not one of the accounts`);
  if (defaultAccount === DUMMY_IDENTITY) e.push(`defaultAccount: may not be "${DUMMY_IDENTITY}" — a flow must opt into the dummy account explicitly`);

  const extraEnvVars = Array.isArray(o.extraEnvVars) ? o.extraEnvVars : [];
  if (o.extraEnvVars !== undefined && (!Array.isArray(o.extraEnvVars) || !o.extraEnvVars.every((v: unknown) => typeof v === 'string' && ENV_NAME_RE.test(v)))) {
    e.push('extraEnvVars: an array of UPPER_SNAKE .env variable names');
  }
  const credentialVars = new Set(Object.values(accounts).flatMap((a) => [a.userEnv, a.secretEnv]).filter(Boolean));
  for (const v of extraEnvVars) if (credentialVars.has(v)) e.push(`extraEnvVars: "${v}" is a credential variable`);

  // Dummy account.
  let dummyAccount: DummyAccountConfig | null = null;
  if (o.dummyAccount !== undefined && o.dummyAccount !== null) {
    const d = o.dummyAccount;
    const fp = d?.fingerprint;
    if (!accounts[DUMMY_IDENTITY]) e.push(`dummyAccount: needs an accounts.${DUMMY_IDENTITY} entry to sign in with`);
    if (!fp || typeof fp !== 'object') e.push('dummyAccount.fingerprint: required');
    else {
      if (typeof fp.tenantId !== 'string') e.push('dummyAccount.fingerprint.tenantId: a string (the dummy tenant id shown after sign-in)');
      if (typeof fp.tenantName !== 'string') e.push('dummyAccount.fingerprint.tenantName: a string (the dummy tenant name shown after sign-in)');
      e.push(...probeErrors(fp.tenantIdProbe, 'dummyAccount.fingerprint.tenantIdProbe'));
      e.push(...probeErrors(fp.tenantNameProbe, 'dummyAccount.fingerprint.tenantNameProbe'));
    }
    const phones = d?.syntheticPhones ?? [];
    if (!Array.isArray(phones) || !phones.every((p: unknown) => typeof p === 'string')) e.push('dummyAccount.syntheticPhones: an array of strings');
    dummyAccount = {
      fingerprint: {
        tenantId: String(fp?.tenantId ?? ''),
        tenantName: String(fp?.tenantName ?? ''),
        tenantIdProbe: { ...(fp?.tenantIdProbe ?? {}) },
        tenantNameProbe: { ...(fp?.tenantNameProbe ?? {}) },
      },
      messagingSuppressed: d?.messagingSuppressed === true,
      syntheticPhones: Array.isArray(phones) ? phones : [],
    };
  }

  // App-specific PII shapes. Absent means the engine applies no phone rule.
  const piiRaw = o.pii ?? {};
  let phonePattern: string | null = null;
  if (typeof piiRaw !== 'object' || Array.isArray(piiRaw)) e.push('pii: an object, e.g. { "phonePattern": "..." }');
  else if (piiRaw.phonePattern !== undefined && piiRaw.phonePattern !== null) {
    if (typeof piiRaw.phonePattern !== 'string' || !piiRaw.phonePattern) e.push('pii.phonePattern: a regular-expression source string, or null');
    else {
      try { new RegExp(piiRaw.phonePattern); phonePattern = piiRaw.phonePattern; }
      catch (err) { e.push(`pii.phonePattern: not a valid regular expression (${(err as Error).message})`); }
    }
  }

  // Isolation: absent means "none". Writes are refused unless it is a real separation.
  const dataIsolation: DataIsolation = o.dataIsolation ?? 'none';
  if (!DATA_ISOLATIONS.includes(dataIsolation)) {
    e.push(`dataIsolation: must be one of ${DATA_ISOLATIONS.join(' | ')} (absent means "none")`);
  }

  // Outbound kill switch attestation.
  let outboundKillSwitch: OutboundKillSwitch | null = null;
  if (o.outboundKillSwitch !== undefined && o.outboundKillSwitch !== null) {
    const k = o.outboundKillSwitch;
    if (typeof k !== 'object' || Array.isArray(k)) e.push('outboundKillSwitch: an object, e.g. { "email": "EMAIL_PROVIDER=dev", "verifiedOn": "2026-09-25" }');
    else {
      const { verifiedOn, ...channels } = k as Record<string, unknown>;
      if (typeof verifiedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(verifiedOn)) {
        e.push('outboundKillSwitch.verifiedOn: the ISO date (YYYY-MM-DD) the attestation was checked');
      }
      const names = Object.keys(channels);
      if (!names.length) e.push('outboundKillSwitch: name at least one channel, e.g. "email": "EMAIL_PROVIDER=dev"');
      for (const n of names) {
        if (typeof channels[n] !== 'string' || !String(channels[n]).trim()) {
          e.push(`outboundKillSwitch.${n}: name the control that switches this channel off`);
        }
      }
      outboundKillSwitch = {
        channels: Object.fromEntries(names.map((n) => [n, String(channels[n])])),
        verifiedOn: String(verifiedOn ?? ''),
      };
    }
  }

  const interstitials = o.interstitials ?? [];
  if (!Array.isArray(interstitials) || !interstitials.every((s: unknown) => typeof s === 'string' && s)) {
    e.push('interstitials: an array of selector strings');
  }

  const navSources: DiscoveryNavSource[] = [];
  const disc = o.discovery?.navSources;
  if (disc !== undefined) {
    if (!Array.isArray(disc)) e.push('discovery.navSources: an array');
    else disc.forEach((s: any, i: number) => {
      const where = `discovery.navSources[${i}]`;
      if (!s || typeof s.path !== 'string' || !s.path.startsWith('/')) e.push(`${where}.path: a route starting with "/"`);
      if (!s || typeof s.items !== 'string' || !s.items) e.push(`${where}.items: a selector`);
      if (!s || typeof s.role !== 'string' || !s.role) e.push(`${where}.role: the ARIA role used to re-find each item`);
      navSources.push({
        path: s?.path, items: s?.items, role: s?.role,
        labelAttribute: typeof s?.labelAttribute === 'string' ? s.labelAttribute : undefined,
        labelCut: typeof s?.labelCut === 'string' ? s.labelCut : undefined,
        tab: s?.tab === true,
      });
    });
  }

  const source = parseSourceConfig(o.source, e);

  if (e.length) throw new Error(`${src} is invalid:\n  ${e.join('\n  ')}`);

  return {
    id,
    dir,
    appName,
    appDescription,
    baseUrl,
    allowedHosts,
    writeAllowedHosts,
    repoPath: optStr('repoPath', ''),
    repoBranch: optStr('repoBranch', 'main'),
    framework,
    theme: theme as 'light' | 'dark',
    locale: optStr('locale', 'en-US'),
    timezone: optStr('timezone', 'UTC'),
    docsAudience: optStr('docsAudience', 'a person using the app for the first time'),
    loginAdapter,
    dataIsolation,
    pii: { phonePattern },
    outboundKillSwitch,
    accounts,
    defaultAccount,
    extraEnvVars,
    dummyAccount,
    interstitials,
    discovery: {
      navSources: navSources.length
        ? navSources
        : [
            { path: '/', items: '[role="tablist"] [role="tab"]', role: 'tab', tab: true },
            { path: '/', items: 'nav a[href]', role: 'link', tab: false },
          ],
    },
    source,
  };
}

export function loadProfile(root: string, id: string): AppProfile {
  const dir = path.join(appsDir(root), id);
  const file = path.join(dir, 'app.config.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      `App profile "${id}" not found (expected ${file}).\n` +
        `  Profiles available: ${listProfiles(root).join(', ') || '(none)'}\n` +
        `  To onboard a new app: copy apps/_template to apps/${id} and fill in app.config.json + .env.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`apps/${id}/app.config.json is not valid JSON: ${(err as Error).message}`);
  }
  return parseProfile(raw, id, dir);
}
