/**
 * Authentication — pluggable by identity.
 *
 * RosiFit signs in with a mobile number and a 4-digit PIN on ONE screen
 * (app/index.tsx in the app repo): the number first, Continue checks it is a
 * registered account, then the PIN step appears and submits itself on the
 * fourth digit. There is no OTP.
 *
 * Two identities use the same form:
 *   admin  — the super admin (academy owner). Lands on Overview ('/').
 *   staff  — a staff account. Lands on the Attendance workspace ('/courses').
 *            Optional: only usable when STAFF_MOBILE / STAFF_PIN are set.
 *
 * Cost control: authenticate ONCE per identity per run, persist storageState
 * (the Supabase session lives in localStorage, which storageState captures),
 * reuse across every flow. A stale state file is detected and re-authenticated.
 *
 * The saved session is a live session for a REAL account. `.auth/` is
 * gitignored; keep it that way.
 */
import * as fs from 'fs';
import { Browser, BrowserContext, Page } from '@playwright/test';
import { env, paths } from './env';
import { ensureDir, writeJson } from './fsx';
import { log } from './logger';
import { newContext, settle } from './browser';
import type { DeviceProfile } from './devices';

export type Identity = 'admin' | 'staff';

/** The sign-in screen's own test ids (app/index.tsx). */
const SEL = {
  phone: '[data-testid="signin-phone"]',
  continue: '[data-testid="signin-continue"]',
  pin: '[data-testid="signin-pin"]',
  restoring: '[data-testid="signin-restoring"]',
  /** The academy header — drawn on every signed-in screen, never before sign-in. */
  signedIn: '[data-testid="shell-academy"]',
  /** /set-pin — the server says this account must change its PIN before going anywhere. */
  mustChangePin: '[data-testid="setpin-field"]',
};

interface Creds {
  mobile: string;
  pin: string;
}

interface AuthStrategy {
  statePath: string;
  creds(): Creds;
  /** Human-readable precondition failure, or null if ready to go. */
  preflight(): string | null;
}

const strategies: Record<Identity, AuthStrategy> = {
  admin: {
    statePath: paths.adminStorageState,
    creds: () => env.admin,
    preflight() {
      if (!env.admin.mobile || env.admin.mobile.length !== 10) {
        return 'SIGNIN_MOBILE is not set in .env (or is not a 10-digit Indian mobile number)';
      }
      if (env.admin.pin.length !== 4) return 'SIGNIN_PIN is not set in .env (or is not 4 digits)';
      return null;
    },
  },
  staff: {
    statePath: paths.staffStorageState,
    creds: () => env.staff,
    preflight() {
      if (!env.staff.mobile || env.staff.mobile.length !== 10) {
        return 'STAFF_MOBILE is not set in .env — staff flows are skipped until it is';
      }
      if (env.staff.pin.length !== 4) return 'STAFF_PIN is not set in .env (or is not 4 digits)';
      return null;
    },
  },
};

/** Why an identity cannot authenticate right now, or null if it can. */
export function authPreflight(identity: Identity): string | null {
  return strategies[identity].preflight();
}

/**
 * Authenticated iff landing on '/' resumes into the shell. '/' is BOTH the
 * sign-in screen and Overview: the sign-in screen asks the server whether a
 * session is live and replaces itself with the shell if so (restoreSession in
 * the app). So the URL says nothing — the DOM does.
 */
async function isAuthenticated(page: Page): Promise<boolean> {
  await page.goto('/', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  const outcome = page.locator(`${SEL.signedIn}, ${SEL.phone}, ${SEL.mustChangePin}`).first();
  await outcome.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
  await settle(page, 300);
  return page.locator(SEL.signedIn).first().isVisible().catch(() => false);
}

async function visibleStatusText(page: Page): Promise<string> {
  // The sign-in sheet's status line has no test id (a polite live region with
  // the sentence the server sent). Reading the sheet's text is diagnostic only.
  const text = await page.locator('body').innerText().catch(() => '');
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /try again|could not|not been registered|disabled|locked|did not work/i.test(l));
  return line ?? '';
}

async function authenticate(page: Page, identity: Identity, creds: Creds): Promise<void> {
  log.step(`${identity} sign-in: entering mobile number…`);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // The prerendered first paint is the "Checking if you are already signed
  // in…" sheet; the number field replaces it once the server has answered.
  const first = page.locator(`${SEL.phone}, ${SEL.signedIn}`).first();
  await first.waitFor({ state: 'visible', timeout: 20_000 });
  if (await page.locator(SEL.signedIn).first().isVisible().catch(() => false)) {
    log.ok(`${identity} already signed in (${page.url()})`);
    return;
  }

  const phone = page.locator(SEL.phone).first();
  await phone.fill('');
  // Real per-character key events: the field groups the digits as it goes
  // (onChangeText), and Continue only arms once ten local digits are present.
  await phone.pressSequentially(creds.mobile);

  const cont = page.locator(SEL.continue).first();
  await cont.waitFor({ state: 'visible' });
  await cont.click();

  // Continue asks the server whether the number is registered. A known number
  // moves to the PIN step; an unknown one is sent to /register (which this
  // project must never fill in), and a lookup that failed stays put with a
  // sentence. Wait for whichever happened.
  const pin = page.locator(SEL.pin).first();
  await Promise.race([
    pin.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined),
    page.waitForURL(/\/register/, { timeout: 20_000 }).catch(() => undefined),
  ]);
  if (/\/register/.test(page.url())) {
    throw new Error(
      `${identity} sign-in: the app sent ${creds.mobile} to /register — this number has no ` +
        `account. This project never registers anything; fix the .env number.`,
    );
  }
  if (!(await pin.isVisible().catch(() => false))) {
    const why = await visibleStatusText(page);
    throw new Error(`${identity} sign-in: the PIN step never appeared${why ? ` — "${why}"` : ''}.`);
  }

  log.step(`${identity} sign-in: entering PIN…`);
  // One hidden 4-digit TextInput sits over the dots (opacity 0.001, so it is
  // focusable and Playwright considers it visible). It submits itself on the
  // fourth digit — there is no Verify button to press.
  await pin.fill('');
  await pin.pressSequentially(creds.pin);

  const landed = page.locator(`${SEL.signedIn}, ${SEL.mustChangePin}`).first();
  await landed.waitFor({ state: 'visible', timeout: 25_000 }).catch(() => undefined);
  await settle(page, 500);

  if (await page.locator(SEL.mustChangePin).first().isVisible().catch(() => false)) {
    throw new Error(
      `${identity} sign-in: this account must change its PIN before it can be used ` +
        `(/set-pin). Do that once by hand in a normal browser, then re-run.`,
    );
  }
  if (!(await page.locator(SEL.signedIn).first().isVisible().catch(() => false))) {
    const why = await visibleStatusText(page);
    throw new Error(
      `${identity} sign-in did not complete — still on ${page.url()}${why ? ` ("${why}")` : ''}. ` +
        `Check SIGNIN_MOBILE / SIGNIN_PIN in .env.`,
    );
  }
  log.ok(`${identity} sign-in complete (${page.url()})`);
}

/**
 * Returns an authenticated context for the identity, reusing storageState when
 * it is still valid. Called once per identity per run.
 */
export async function getAuthenticatedContext(
  browser: Browser,
  identity: Identity,
  device?: DeviceProfile,
): Promise<BrowserContext> {
  const strategy = strategies[identity];
  const problem = strategy.preflight();
  if (problem) throw new Error(`Cannot authenticate as "${identity}": ${problem}`);

  ensureDir(paths.auth);

  // Try the saved session first.
  if (fs.existsSync(strategy.statePath)) {
    const ctx = await newContext(browser, strategy.statePath, device);
    const page = await ctx.newPage();
    const ok = await isAuthenticated(page).catch(() => false);
    await page.close();
    if (ok) {
      log.ok(`Reusing saved ${identity} session.`);
      return ctx;
    }
    log.warn(`Saved ${identity} session is stale — re-authenticating.`);
    await ctx.close();
    fs.rmSync(strategy.statePath, { force: true });
  }

  const ctx = await newContext(browser, undefined, device);
  const page = await ctx.newPage();
  await authenticate(page, identity, strategy.creds());
  await writeStorageStateAtomically(ctx, strategy.statePath);
  await page.close();
  return ctx;
}

/**
 * Writes storageState via a temp-file-then-rename instead of Playwright's
 * direct-path write, so a concurrent process (e.g. `npm run discover`
 * overlapping a scheduled `npm run capture`) reading the same file never
 * observes a partially-written one.
 */
async function writeStorageStateAtomically(ctx: BrowserContext, statePath: string): Promise<void> {
  const state = await ctx.storageState();
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  writeJson(tmpPath, state);
  fs.renameSync(tmpPath, statePath);
}
