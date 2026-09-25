/**
 * Environment loading + the safety gate.
 *
 * Everything app-specific comes from the selected app profile
 * (apps/<app-id>/app.config.json, see profile.ts). The app is chosen with
 * `--app <id>` or `APP=<id>`; there is no default, so nothing can ever run
 * against an app nobody named.
 *
 *   · the root .env holds shared, app-independent settings only (browser,
 *     LLM key, retention). It never holds credentials.
 *   · apps/<app-id>/.env holds that app's credentials, and credentials are read
 *     from there and nowhere else — not the root .env, not the shell.
 *
 * READ-ONLY by default. Real accounts never write. A flow may write only as
 * the dummy account, in dummy write mode, against a write-allowed host, after
 * the signed-in tenant has been verified (write-gates.ts).
 *
 * The gate below refuses to start unless the target URL is https (or local)
 * and its host is on the profile's allowlist, so a typo can never point a
 * headless browser holding real credentials at something unexpected.
 *
 * `env`, `paths` and `profile` resolve lazily on first use: importing this
 * module never fails, and a missing app selection is reported by whichever
 * command first needs one.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import {
  loadProfile,
  selectedAppId,
  noAppSelectedMessage,
  DUMMY_IDENTITY,
  type AppProfile,
} from './profile';

export const ROOT = path.resolve(__dirname, '..');

// Shared settings only. dotenv never overrides a variable already set.
dotenv.config({ path: path.join(ROOT, '.env') });

/** Paths that do not depend on the selected app. */
export const sharedPaths = {
  root: ROOT,
  /** Device profiles are shared by every app. */
  devices: path.join(ROOT, 'config', 'devices.json'),
  /** The flow manifest schema reference (also fed to discovery's LLM draft prompt). */
  flowSchema: path.join(ROOT, 'flows', '_SCHEMA.md'),
};

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/**
 * Local digits of a mobile number, whatever separators, country code or trunk
 * `0` the .env carried.
 */
export function normaliseMobile(raw: string, countryCode = '', digits = 10): string {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length > digits && countryCode && d.startsWith(countryCode)) d = d.slice(countryCode.length);
  else if (d.length > digits && d.startsWith('0')) d = d.slice(1);
  return d.slice(0, digits);
}

export interface AccountCreds {
  /** Mobile digits, email or username — normalised for the login adapter. */
  user: string;
  secret: string;
  userEnv: string;
  secretEnv: string;
  optional: boolean;
}

/** Mobile-number options of the mobile-pin adapter, with their defaults. */
export function mobileOptions(p: AppProfile): { countryCode: string; mobileDigits: number; pinDigits: number } {
  const o = p.loginAdapter.options as { countryCode?: unknown; mobileDigits?: unknown; pinDigits?: unknown };
  return {
    countryCode: typeof o.countryCode === 'string' ? o.countryCode.replace(/\D/g, '') : '',
    mobileDigits: typeof o.mobileDigits === 'number' ? o.mobileDigits : 10,
    pinDigits: typeof o.pinDigits === 'number' ? o.pinDigits : 4,
  };
}

function buildEnv(p: AppProfile, appEnv: Record<string, string>) {
  const isMobile = p.loginAdapter.type === 'mobile-pin';
  const mob = mobileOptions(p);
  const accounts: Record<string, AccountCreds> = {};
  for (const [identity, a] of Object.entries(p.accounts)) {
    const rawUser = (appEnv[a.userEnv] ?? '').trim();
    const rawSecret = appEnv[a.secretEnv] ?? '';
    accounts[identity] = {
      user: isMobile ? normaliseMobile(rawUser, mob.countryCode, mob.mobileDigits) : rawUser,
      secret: isMobile ? rawSecret.replace(/\D/g, '') : rawSecret,
      userEnv: a.userEnv,
      secretEnv: a.secretEnv,
      optional: a.optional,
    };
  }
  const extra: Record<string, string> = {};
  for (const name of p.extraEnvVars) extra[name] = appEnv[name] ?? '';

  return {
    appId: p.id,
    appName: p.appName,
    /** APP_URL in the app .env may point at a preview build; the host gate still applies. */
    appUrl: (appEnv.APP_URL || p.baseUrl).replace(/\/+$/, ''),
    allowedHosts: p.allowedHosts,
    writeAllowedHosts: p.writeAllowedHosts,
    /** `dummy` enables write flows (subject to every other gate). Anything else is off. */
    writeMode: ((appEnv.WRITE_MODE || process.env.WRITE_MODE || 'off').trim().toLowerCase() === 'dummy' ? 'dummy' : 'off') as 'dummy' | 'off',
    accounts,
    extraVars: extra,

    appRepo: {
      path: appEnv.APP_REPO_PATH || p.repoPath,
      branch: appEnv.APP_REPO_BRANCH || p.repoBranch,
    },

    runsRetentionDays: num('RUNS_RETENTION_DAYS', 30),

    browser: {
      headless: bool('HEADLESS', true),
      width: num('VIEWPORT_WIDTH', 390),
      height: num('VIEWPORT_HEIGHT', 844),
      deviceScaleFactor: num('DEVICE_SCALE_FACTOR', 2),
      // The emulated OS colour scheme: the profile's theme unless overridden.
      // Pinned so an app's "System" theme choice resolves the same way every run.
      colorScheme: ((process.env.COLOR_SCHEME || p.theme) === 'dark' ? 'dark' : 'light') as 'light' | 'dark',
      locale: p.locale,
      timezone: p.timezone,
      slowMo: num('SLOW_MO_MS', 0),
      stepTimeout: num('STEP_TIMEOUT_MS', 15_000),
    },

    llm: {
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      model: process.env.LLM_MODEL || 'claude-sonnet-5',
    },

    /**
     * Discovery's draft proposal sends the discovered screen's page HTML and a
     * screenshot to the LLM, and a real account's screens carry personal data.
     * Off unless explicitly opted into, independently of ANTHROPIC_API_KEY.
     */
    discoveryLlm: bool('DISCOVERY_LLM_SEND_PAGE_CONTENT', false),
  };
}

export type Env = ReturnType<typeof buildEnv>;

function buildPaths(p: AppProfile) {
  const app = p.dir;
  return {
    ...sharedPaths,
    /** apps/<app-id>/ */
    app,
    flows: path.join(app, 'flows'),
    drafts: path.join(app, 'flows', '_drafts'),
    config: path.join(app, 'config'),
    /** runs/<app-id>/<run-id>/<Device>/… — gitignored. */
    runs: path.join(ROOT, 'runs', p.id),
    recordings: path.join(app, 'recordings'),
    fingerprints: path.join(app, 'fingerprints'),
    /** Generated module docs: apps/<app-id>/docs/<Device>/<module>.md */
    docs: path.join(app, 'docs'),
    /** Evidence-mode output only. Gitignored: raw frames can hold personal data. */
    evidence: path.join(ROOT, 'evidence', p.id),
    piiRegions: path.join(app, 'config', 'pii-regions.json'),
    reviewItems: path.join(app, 'config', 'manual-review-items.json'),
    routesMap: path.join(app, 'config', 'routes.map.json'),
    knownRoutes: path.join(app, 'config', 'known_routes.json'),
    baseline: path.join(app, 'fingerprints', 'baseline.json'),
    lastRun: path.join(app, 'fingerprints', 'last-run.json'),
    /** Saved browser sessions, one per identity. Live sessions — never committed. */
    auth: path.join(app, '.auth'),
  };
}

export type Paths = ReturnType<typeof buildPaths>;

interface AppContext {
  profile: AppProfile;
  env: Env;
  paths: Paths;
  warnings: string[];
}

let current: AppContext | null = null;

/** Loads (once) the selected app's profile, credentials and paths. Throws when no app is selected. */
export function currentApp(): AppContext {
  if (current) return current;
  const id = selectedAppId();
  if (!id) throw new Error(noAppSelectedMessage(ROOT));
  const profile = loadProfile(ROOT, id);
  const envFile = path.join(profile.dir, '.env');
  const appEnv = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};

  const warnings: string[] = [];
  // Credentials come from the app's own .env only. One that is also set in the
  // shell or the root .env is ignored there, and said so, so nobody believes
  // the other value is in use.
  for (const a of Object.values(profile.accounts)) {
    for (const name of [a.userEnv, a.secretEnv]) {
      if (process.env[name]) warnings.push(`${name} is set outside apps/${id}/.env — ignored; credentials are read from apps/${id}/.env only.`);
    }
  }
  current = { profile, env: buildEnv(profile, appEnv), paths: buildPaths(profile), warnings };
  return current;
}

/** Tests only: forget the loaded app so the next access reloads it. */
export function resetAppContext(): void {
  current = null;
}

/** Non-fatal configuration notes collected while loading the app. */
export function envWarnings(): string[] {
  return currentApp().warnings;
}

function lazy<T extends object>(resolve: () => T, shared: Record<string, unknown> = {}): T {
  return new Proxy({} as T, {
    get: (_t, key) => (typeof key === 'string' && key in shared ? shared[key] : (resolve() as any)[key]),
    has: (_t, key) => key in shared || key in resolve(),
    ownKeys: () => Reflect.ownKeys(resolve()),
    getOwnPropertyDescriptor: (_t, key) => ({ configurable: true, enumerable: true, value: (resolve() as any)[key] }),
  });
}

export const profile: AppProfile = lazy(() => currentApp().profile);
export const env: Env = lazy(() => currentApp().env);
/** App-independent keys (root, devices, flowSchema) resolve without an app selected. */
export const paths: Paths = lazy(() => currentApp().paths, sharedPaths);

/** Saved storageState for one identity of the current app. */
export function storageStatePath(identity: string): string {
  return path.join(paths.auth, `${identity}.json`);
}

/** Values available for {{VAR}} interpolation inside flow selectors/inputs. */
export function envInterpolationVars(): Record<string, string> {
  const vars: Record<string, string> = { APP_URL: env.appUrl };
  for (const a of Object.values(env.accounts)) {
    vars[a.userEnv] = a.user;
    vars[a.secretEnv] = a.secret;
  }
  return { ...env.extraVars, ...vars };
}

/**
 * Values that must never reach a written file, a log or a screenshot label:
 * every account's PIN or password.
 */
export function secretValues(): string[] {
  return Object.values(env.accounts).map((a) => a.secret).filter((s) => s.length >= 3);
}

export interface IdentifierValue {
  /** The .env name, used in the redaction token. */
  name: string;
  /** Local digits of a mobile-number login ('' for an email/username login). */
  digits: string;
  /** An email/username login, matched literally and case-insensitively. */
  text?: string;
}

/**
 * Operator identifiers — the logins the runner signs in with. Not secrets, but
 * personal data about the people operating the capture, so they are held to
 * the same rule: never written to a manifest, a log or a doc.
 */
export function identifierValues(): IdentifierValue[] {
  const isMobile = profile.loginAdapter.type === 'mobile-pin';
  const { mobileDigits } = mobileOptions(profile);
  const out: IdentifierValue[] = [];
  for (const a of Object.values(env.accounts)) {
    if (!a.user) continue;
    if (isMobile) {
      if (a.user.length === mobileDigits) out.push({ name: a.userEnv, digits: a.user });
    } else if (a.user.length >= 3) {
      out.push({ name: a.userEnv, digits: '', text: a.user });
    }
  }
  return out;
}

const REDACTED = '«redacted»';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A mobile number as it can appear in text: its digits with any spaces or
 * hyphens between them (sign-in fields often render "98765 43210"), optionally
 * behind a +<country code> / <country code> / 0 prefix.
 */
function identifierPattern(digits: string, countryCode: string): RegExp {
  const body = digits.split('').join('[\\s-]*');
  const prefix = countryCode ? `(?:\\+?${countryCode}[\\s-]*|0)?` : '(?:0)?';
  return new RegExp(`${prefix}${body}`, 'g');
}

/**
 * The redaction itself, as a pure function so it can be tested without an
 * app. Identifiers go FIRST: a PIN's digits can occur inside a mobile number,
 * and splitting the PIN out first would break the number into fragments that
 * no longer match — leaking the rest of it.
 */
export function redactValues(text: string, secrets: string[], identifiers: IdentifierValue[], countryCode = ''): string {
  let out = text;
  for (const id of identifiers) {
    if (id.digits) out = out.replace(identifierPattern(id.digits, countryCode), `«redacted:${id.name}»`);
    else if (id.text) out = out.replace(new RegExp(escapeRe(id.text), 'gi'), `«redacted:${id.name}»`);
  }
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  return out;
}

/**
 * Replaces every secret and operator identifier in `text` with a marker.
 * Idempotent, cheap. Every manifest, log and doc writer routes through it.
 * Before an app is selected there is nothing to redact.
 */
export function redactSecrets(text: string): string {
  if (!current) {
    try { currentApp(); } catch { return text; }
  }
  return redactValues(text, secretValues(), identifierValues(), mobileOptions(profile).countryCode);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function appHost(): string {
  return hostOf(env.appUrl);
}

/**
 * Refuses to proceed unless the target URL's host is on the selected
 * profile's allowlist. Called by runner.ts, discovery.ts, recorder.ts and
 * validate.ts before any network work.
 */
export function assertTargetEnvironment(): void {
  const problems: string[] = [];

  if (!/^https?:\/\//.test(env.appUrl)) {
    problems.push(`The target URL must be an http(s) URL — got "${env.appUrl}"`);
  }
  const host = hostOf(env.appUrl);
  if (!host) {
    problems.push(`The target URL "${env.appUrl}" is not a parseable URL.`);
  } else if (!env.allowedHosts.includes(host)) {
    problems.push(
      `Host "${host}" is not in allowedHosts of apps/${env.appId}/app.config.json ` +
        `(${env.allowedHosts.join(', ')}). Refusing to run.`,
    );
  }
  if (env.appUrl.startsWith('http://') && !['localhost', '127.0.0.1'].includes(host)) {
    problems.push(`The target URL must be https unless it points at localhost — got "${env.appUrl}"`);
  }

  if (problems.length) {
    throw new Error(
      `\n╔══ ENVIRONMENT SAFETY GATE FAILED ═══════════════════════════════════╗\n` +
        problems.map((p) => `  • ${p}`).join('\n') +
        `\n╚═════════════════════════════════════════════════════════════════════╝\n`,
    );
  }
}

/** True when `identity` is the dummy account of the current app. */
export function isDummyIdentity(identity: string): boolean {
  return identity === DUMMY_IDENTITY;
}

/** Replaces {{VAR}} with env + flow-local vars. Unknown vars are left intact. */
export function interpolate(input: string, extra: Record<string, string> = {}): string {
  const vars = { ...extra, ...envInterpolationVars() };
  return input.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, name: string) => {
    const v = vars[name];
    return v === undefined || v === '' ? whole : v;
  });
}
