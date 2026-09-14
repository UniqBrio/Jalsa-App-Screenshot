/**
 * Environment loading + the safety gate.
 *
 * RosiFit has ONE Supabase project and ONE deployment (rosi-fit.vercel.app).
 * There is no TEST environment to point this at, so the rule the UniqBrio
 * capture project enforces ("TEST only, always") becomes a different one here:
 *
 *   READ-ONLY, ALWAYS.
 *
 *   · flows may never write — validate refuses any step that declares it does
 *   · there is no cleanup module, because there must be nothing to clean up
 *   · the runner never talks to Supabase; it only drives the PWA like a person
 *
 * The gate below is deliberately blunt about the target: it refuses to start
 * unless APP_URL is https and its host is on the allowlist, so a typo can
 * never point a headless browser (with a real PIN) at something unexpected.
 */
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}
function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}
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

export const ROOT = path.resolve(__dirname, '..');
export const paths = {
  root: ROOT,
  flows: path.join(ROOT, 'flows'),
  drafts: path.join(ROOT, 'flows', '_drafts'),
  config: path.join(ROOT, 'config'),
  screenshots: path.join(ROOT, 'screenshots'),
  runs: path.join(ROOT, 'runs'),
  recordings: path.join(ROOT, 'recordings'),
  fingerprints: path.join(ROOT, 'fingerprints'),
  docs: path.join(ROOT, 'docs'),
  auth: path.join(ROOT, '.auth'),
  routesMap: path.join(ROOT, 'config', 'routes.map.json'),
  knownRoutes: path.join(ROOT, 'config', 'known_routes.json'),
  baseline: path.join(ROOT, 'fingerprints', 'baseline.json'),
  lastRun: path.join(ROOT, 'fingerprints', 'last-run.json'),
  /** Saved browser session per identity — a live Supabase session for a REAL account. Never committed. */
  adminStorageState: path.join(ROOT, '.auth', 'admin.json'),
  staffStorageState: path.join(ROOT, '.auth', 'staff.json'),
};

const DEFAULT_APP_URL = 'https://rosi-fit.vercel.app';
const DEFAULT_ALLOWED_HOSTS = 'rosi-fit.vercel.app,localhost,127.0.0.1';

/** Ten local digits, whatever separators or a +91 / 0 prefix the .env carried. */
export function normaliseMobile(raw: string): string {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length > 10 && d.startsWith('91')) d = d.slice(2);
  else if (d.length > 10 && d.startsWith('0')) d = d.slice(1);
  return d.slice(0, 10);
}

export const env = {
  appUrl: str('APP_URL', DEFAULT_APP_URL).replace(/\/+$/, ''),
  allowedHosts: opt('ALLOWED_APP_HOSTS', DEFAULT_ALLOWED_HOSTS)
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),

  /** The super admin (academy owner) account. Sees Overview + every More row. */
  admin: {
    mobile: normaliseMobile(opt('SIGNIN_MOBILE')),
    pin: opt('SIGNIN_PIN').replace(/\D/g, ''),
  },
  /** Optional staff account — same sign-in form, lands on the Attendance workspace instead of Overview. */
  staff: {
    mobile: normaliseMobile(opt('STAFF_MOBILE')),
    pin: opt('STAFF_PIN').replace(/\D/g, ''),
  },

  /**
   * Optional fixed identities. Flows default to prefix selectors ("the first
   * course card"), which is deterministic for unchanged data; set these to pin
   * a flow to one specific record so a newly added course cannot shift it.
   */
  fixed: {
    courseId: opt('FIXED_COURSE_ID'),
    memberId: opt('FIXED_MEMBER_ID'),
  },

  appRepo: {
    path: opt('APP_REPO_PATH'),
    branch: opt('APP_REPO_BRANCH', 'main'),
  },

  runsRetentionDays: num('RUNS_RETENTION_DAYS', 30),

  browser: {
    headless: bool('HEADLESS', true),
    // Mobile-first PWA: 390x844 @2x is the layout real users see. Desktop
    // (1280x900) is available as a named viewport preset, not the default.
    width: num('VIEWPORT_WIDTH', 390),
    height: num('VIEWPORT_HEIGHT', 844),
    deviceScaleFactor: num('DEVICE_SCALE_FACTOR', 2),
    // RosiFit ships dark-first (app.json backgroundColor #130D18, ThemeProvider
    // default 'dark'). The emulated OS scheme only matters once a viewer picks
    // "System" under Appearance, but it is pinned so that choice is deterministic.
    colorScheme: (opt('COLOR_SCHEME', 'dark') === 'light' ? 'light' : 'dark') as 'light' | 'dark',
    slowMo: num('SLOW_MO_MS', 0),
    stepTimeout: num('STEP_TIMEOUT_MS', 15_000),
  },

  llm: {
    apiKey: opt('ANTHROPIC_API_KEY'),
    model: opt('LLM_MODEL', 'claude-sonnet-5'),
  },
};

/** Values available for {{VAR}} interpolation inside flow selectors/inputs. */
export function envInterpolationVars(): Record<string, string> {
  return {
    APP_URL: env.appUrl,
    SIGNIN_MOBILE: env.admin.mobile,
    SIGNIN_PIN: env.admin.pin,
    STAFF_MOBILE: env.staff.mobile,
    STAFF_PIN: env.staff.pin,
    FIXED_COURSE_ID: env.fixed.courseId,
    FIXED_MEMBER_ID: env.fixed.memberId,
  };
}

/**
 * Values that must never reach a committed file. Run manifests record every
 * interpolated selector and input; the PIN of a live account is exactly the
 * thing that must not end up in git history that way.
 */
export function secretValues(): string[] {
  return [env.admin.pin, env.staff.pin].filter((s) => s.length >= 3);
}

const REDACTED = '«redacted»';

/** Replaces every secret value in `text` with a marker. Idempotent, cheap. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of secretValues()) out = out.split(secret).join(REDACTED);
  return out;
}

function hostOf(url: string): string {
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
 * Refuses to proceed unless we are demonstrably pointed at the RosiFit PWA
 * (or a local build of it). Called by runner.ts, discovery.ts and recorder.ts
 * before any network work.
 */
export function assertTargetEnvironment(): void {
  const problems: string[] = [];

  if (!/^https?:\/\//.test(env.appUrl)) {
    problems.push(`APP_URL must be an http(s) URL — got "${env.appUrl}"`);
  }
  const host = hostOf(env.appUrl);
  if (!host) {
    problems.push(`APP_URL "${env.appUrl}" is not a parseable URL.`);
  } else if (!env.allowedHosts.includes(host)) {
    problems.push(
      `APP_URL host "${host}" is not in ALLOWED_APP_HOSTS (${env.allowedHosts.join(', ')}). ` +
        `Refusing to run — this project only ever drives the RosiFit PWA.`,
    );
  }
  if (env.appUrl.startsWith('http://') && !['localhost', '127.0.0.1'].includes(host)) {
    problems.push(`APP_URL must be https unless it points at localhost — got "${env.appUrl}"`);
  }

  if (problems.length) {
    throw new Error(
      `\n╔══ ENVIRONMENT SAFETY GATE FAILED ═══════════════════════════════════╗\n` +
        problems.map((p) => `  • ${p}`).join('\n') +
        `\n╚═════════════════════════════════════════════════════════════════════╝\n`,
    );
  }
}

/** Replaces {{VAR}} with env + flow-local vars. Unknown vars are left intact. */
export function interpolate(input: string, extra: Record<string, string> = {}): string {
  const vars = { ...extra, ...envInterpolationVars() };
  return input.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, name: string) => {
    const v = vars[name];
    return v === undefined || v === '' ? whole : v;
  });
}
