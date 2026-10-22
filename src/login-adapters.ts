/**
 * Login adapters — how one app's sign-in screen is driven.
 *
 * The profile picks one (`loginAdapter.type`) and supplies its selectors and
 * options; nothing about any app's sign-in form lives in this file.
 *
 *   mobile-pin         mobile number → Continue → a numeric PIN that submits
 *                      itself on the last digit (no password, no OTP)
 *   pin-only           a PIN and nothing else — the PIN identifies the person
 *                      (a staff keypad); submits itself on the last digit
 *   email-password     email + password (+ optional "Next" between them)
 *   username-password  username + password (+ optional "Next" between them)
 *
 * Every adapter answers the same three questions: are the credentials
 * plausible (preflight), is this page already signed in, and how to sign in.
 */
import { Page } from '@playwright/test';
import { log } from './logger';
import { settle } from './browser';
import { mobileOptions, type AccountCreds } from './env';
import type { AppProfile, LoginAdapterType } from './profile';

export interface LoginAdapter {
  type: LoginAdapterType;
  /** Problems with the adapter's selectors/options in app.config.json. */
  configErrors(): string[];
  /** Why this identity's credentials cannot be used, or null. Never quotes a value. */
  preflight(identity: string, creds: AccountCreds): string | null;
  /**
   * Loads the app and reports whether the session is signed in. `identity`
   * matters to adapters whose accounts sign in at different paths.
   */
  isAuthenticated(page: Page, identity?: string): Promise<boolean>;
  authenticate(page: Page, identity: string, creds: AccountCreds): Promise<void>;
}

function checkKeys(
  what: string,
  given: Record<string, unknown>,
  required: string[],
  optional: string[],
): string[] {
  const e: string[] = [];
  for (const k of required) if (!given[k]) e.push(`loginAdapter.${what}.${k}: required for this adapter`);
  for (const k of Object.keys(given)) {
    if (!required.includes(k) && !optional.includes(k)) {
      e.push(`loginAdapter.${what}.${k}: not used by this adapter (known: ${[...required, ...optional].join(', ')})`);
    }
  }
  return e;
}

/** Reads a status/error sentence off the page, for a diagnostic message. */
async function visibleStatusText(page: Page, pattern: RegExp, selector?: string): Promise<string> {
  if (selector) {
    const t = await page.locator(selector).first().innerText({ timeout: 1_000 }).catch(() => '');
    if (t.trim()) return t.trim().split('\n')[0];
  }
  const text = await page.locator('body').innerText().catch(() => '');
  return text.split('\n').map((l) => l.trim()).find((l) => pattern.test(l)) ?? '';
}

const DEFAULT_STATUS = 'try again|could not|not been registered|disabled|locked|did not work|invalid|incorrect|wrong';

// ─── mobile-pin ──────────────────────────────────────────────────────────────

/**
 * One screen: the mobile number first, Continue checks it is a registered
 * account, then the PIN step appears and submits itself on the last digit.
 *
 * selectors: phone, continue, pin, signedIn (required); mustChangePin, submit (optional)
 *            `submit` is pressed after the last digit, for an OTP/PIN form that does
 *            not submit itself (a "Verify" button).
 * options:   countryCode, mobileDigits (10), pinDigits (4), loginPath ('/'),
 *            registerUrlPattern (a route a new number is sent to — never filled in),
 *            statusPattern (regex for the status sentence)
 */
function mobilePin(profile: AppProfile): LoginAdapter {
  const SEL = profile.loginAdapter.selectors;
  const opt = profile.loginAdapter.options as Record<string, unknown>;
  const { mobileDigits, pinDigits } = mobileOptions(profile);
  const loginPath = typeof opt.loginPath === 'string' ? opt.loginPath : '/';
  const register = typeof opt.registerUrlPattern === 'string' && opt.registerUrlPattern ? new RegExp(opt.registerUrlPattern) : null;
  const status = new RegExp(typeof opt.statusPattern === 'string' ? opt.statusPattern : DEFAULT_STATUS, 'i');
  const signedInOrForm = [SEL.signedIn, SEL.phone, SEL.mustChangePin].filter(Boolean).join(', ');

  return {
    type: 'mobile-pin',
    configErrors: () => [
      ...checkKeys('selectors', SEL, ['phone', 'continue', 'pin', 'signedIn'], ['mustChangePin', 'submit']),
      ...checkKeys('options', opt, [], ['countryCode', 'mobileDigits', 'pinDigits', 'loginPath', 'registerUrlPattern', 'statusPattern']),
    ],

    preflight(identity, creds) {
      if (creds.user.length !== mobileDigits) {
        return `${creds.userEnv} is not set in apps/${profile.id}/.env (or is not a ${mobileDigits}-digit mobile number) — "${identity}" cannot sign in`;
      }
      if (creds.secret.length !== pinDigits) return `${creds.secretEnv} is not set in apps/${profile.id}/.env (or is not ${pinDigits} digits)`;
      return null;
    },

    /**
     * The sign-in route may double as the signed-in home (it resumes a live
     * session by replacing itself with the shell), so the URL says nothing —
     * the DOM does.
     */
    async isAuthenticated(page) {
      await page.goto(loginPath, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.locator(signedInOrForm).first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
      await settle(page, 300);
      return page.locator(SEL.signedIn).first().isVisible().catch(() => false);
    },

    async authenticate(page, identity, creds) {
      log.step(`${identity} sign-in: entering mobile number…`);
      await page.goto(loginPath, { waitUntil: 'domcontentloaded' });

      // A first paint may be a "checking your session" sheet; the number
      // field replaces it once the server has answered.
      const first = page.locator(`${SEL.phone}, ${SEL.signedIn}`).first();
      await first.waitFor({ state: 'visible', timeout: 20_000 });
      if (await page.locator(SEL.signedIn).first().isVisible().catch(() => false)) {
        log.ok(`${identity} already signed in (${page.url()})`);
        return;
      }

      const phone = page.locator(SEL.phone).first();
      await phone.fill('');
      // Real per-character key events: grouped-digit fields format as they go,
      // and Continue typically arms only once every digit is present.
      await phone.pressSequentially(creds.user);

      const cont = page.locator(SEL.continue).first();
      await cont.waitFor({ state: 'visible' });
      await cont.click();

      // Continue asks the server whether the number is registered. A known
      // number moves to the PIN step; an unknown one may be sent to a
      // registration route (which this project must never fill in); a failed
      // lookup stays put with a sentence. Wait for whichever happened.
      const pin = page.locator(SEL.pin).first();
      await Promise.race([
        pin.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined),
        register ? page.waitForURL(register, { timeout: 20_000 }).catch(() => undefined) : new Promise(() => undefined),
      ]);
      if (register && register.test(page.url())) {
        throw new Error(
          `${identity} sign-in: the app sent ${creds.userEnv} to its registration screen — this number has no ` +
            `account. This project never registers anything; fix apps/${profile.id}/.env.`,
        );
      }
      if (!(await pin.isVisible().catch(() => false))) {
        const why = await visibleStatusText(page, status);
        throw new Error(`${identity} sign-in: the PIN step never appeared${why ? ` — "${why}"` : ''}.`);
      }

      log.step(`${identity} sign-in: entering PIN…`);
      // A PIN field that submits itself on the last digit: no button to press.
      await pin.fill('');
      await pin.pressSequentially(creds.secret);
      if (SEL.submit) await page.locator(SEL.submit).first().click();

      const landedSel = [SEL.signedIn, SEL.mustChangePin].filter(Boolean).join(', ');
      await page.locator(landedSel).first().waitFor({ state: 'visible', timeout: 25_000 }).catch(() => undefined);
      await settle(page, 500);

      if (SEL.mustChangePin && (await page.locator(SEL.mustChangePin).first().isVisible().catch(() => false))) {
        throw new Error(
          `${identity} sign-in: this account must change its PIN before it can be used. ` +
            `Do that once by hand in a normal browser, then re-run.`,
        );
      }
      if (!(await page.locator(SEL.signedIn).first().isVisible().catch(() => false))) {
        const why = await visibleStatusText(page, status);
        throw new Error(
          `${identity} sign-in did not complete — still on ${page.url()}${why ? ` ("${why}")` : ''}. ` +
            `Check ${creds.userEnv} / ${creds.secretEnv} in apps/${profile.id}/.env.`,
        );
      }
      log.ok(`${identity} sign-in complete (${page.url()})`);
    },
  };
}

// ─── pin-only ────────────────────────────────────────────────────────────────

/**
 * A PIN keypad with no username: the PIN alone says who is signing in, and the
 * last digit submits it. Apps with one sign-in screen per surface (an owner
 * console at /owner, a staff handset at /staff) give each account its own
 * `loginPath` in `accounts`.
 *
 * selectors: pin, signedIn (required); key, error, mustChangePin (optional)
 *            `key` is a keypad button template with {digit} — e.g.
 *            [data-testid="staff-key-{digit}"] — pressed digit by digit instead of
 *            typing into `pin`, for keypads whose input element is hidden.
 * options:   loginPath ('/'), pinDigits (4), statusPattern
 */
function pinOnly(profile: AppProfile): LoginAdapter {
  const SEL = profile.loginAdapter.selectors;
  const opt = profile.loginAdapter.options as Record<string, unknown>;
  const { pinDigits } = mobileOptions(profile);
  const defaultPath = typeof opt.loginPath === 'string' ? opt.loginPath : '/';
  const status = new RegExp(typeof opt.statusPattern === 'string' ? opt.statusPattern : DEFAULT_STATUS, 'i');
  const pathFor = (identity?: string) => (identity && profile.accounts[identity]?.loginPath) || defaultPath;
  const landed = [SEL.signedIn, SEL.mustChangePin].filter(Boolean).join(', ');

  return {
    type: 'pin-only',
    configErrors: () => {
      const e = [
        ...checkKeys('selectors', SEL, ['pin', 'signedIn'], ['key', 'error', 'mustChangePin']),
        ...checkKeys('options', opt, [], ['loginPath', 'pinDigits', 'statusPattern']),
      ];
      if (SEL.key && !SEL.key.includes('{digit}')) e.push('loginAdapter.selectors.key: must contain {digit}, e.g. [data-testid="key-{digit}"]');
      for (const [name, a] of Object.entries(profile.accounts)) {
        if (a.userEnv) e.push(`accounts.${name}.userEnv: a pin-only sign-in has no login — remove it, the PIN is the identity`);
      }
      return e;
    },

    preflight(identity, creds) {
      if (creds.secret.length !== pinDigits) {
        return `${creds.secretEnv} is not set in apps/${profile.id}/.env (or is not ${pinDigits} digits) — "${identity}" cannot sign in`;
      }
      return null;
    },

    async isAuthenticated(page, identity) {
      await page.goto(pathFor(identity), { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.locator(`${SEL.signedIn}, ${SEL.pin}`).first().waitFor({ state: 'attached', timeout: 20_000 }).catch(() => undefined);
      await settle(page, 300);
      return page.locator(SEL.signedIn).first().isVisible().catch(() => false);
    },

    async authenticate(page, identity, creds) {
      const loginPath = pathFor(identity);
      log.step(`${identity} sign-in: opening ${loginPath}…`);
      await page.goto(loginPath, { waitUntil: 'domcontentloaded' });
      // The PIN input of a keypad is often visually hidden: attached is the honest wait.
      await page.locator(`${SEL.pin}, ${SEL.signedIn}`).first().waitFor({ state: 'attached', timeout: 20_000 });
      if (await page.locator(SEL.signedIn).first().isVisible().catch(() => false)) {
        log.ok(`${identity} already signed in (${page.url()})`);
        return;
      }

      log.step(`${identity} sign-in: entering PIN…`);
      if (SEL.key) {
        for (const d of creds.secret) await page.locator(SEL.key.split('{digit}').join(d)).first().click();
      } else {
        const pin = page.locator(SEL.pin).first();
        await pin.fill('');
        await pin.pressSequentially(creds.secret);
      }

      await page.locator(landed).first().waitFor({ state: 'visible', timeout: 25_000 }).catch(() => undefined);
      await settle(page, 500);
      if (SEL.mustChangePin && (await page.locator(SEL.mustChangePin).first().isVisible().catch(() => false))) {
        throw new Error(
          `${identity} sign-in: this account must choose its own PIN before it can be used. ` +
            `Do that once by hand in a normal browser, then put the new PIN in apps/${profile.id}/.env.`,
        );
      }
      if (!(await page.locator(SEL.signedIn).first().isVisible().catch(() => false))) {
        const why = await visibleStatusText(page, status, SEL.error);
        throw new Error(
          `${identity} sign-in did not complete — still on ${page.url()}${why ? ` ("${why}")` : ''}. ` +
            `Check ${creds.secretEnv} in apps/${profile.id}/.env.`,
        );
      }
      log.ok(`${identity} sign-in complete (${page.url()})`);
    },
  };
}

// ─── email-password / username-password ─────────────────────────────────────

/**
 * A classic form. `next` supports two-step forms that ask for the login first
 * and reveal the password field after a button press.
 *
 * selectors: <user field> ('email' or 'username'), password, submit, signedIn (required);
 *            next, error (optional)
 * options:   loginPath ('/login'), homePath ('/'),
 *            typing ('fill' | 'sequential' — default 'sequential' for react-native-web, else 'fill'),
 *            statusPattern (regex for the error sentence)
 */
function formLogin(profile: AppProfile, userField: 'email' | 'username'): LoginAdapter {
  const SEL = profile.loginAdapter.selectors;
  const opt = profile.loginAdapter.options as Record<string, unknown>;
  const loginPath = typeof opt.loginPath === 'string' ? opt.loginPath : '/login';
  const homePath = typeof opt.homePath === 'string' ? opt.homePath : '/';
  // Controlled inputs in react-native-web key their state off key events, so
  // fill() can look right on screen without arming the submit button.
  const typing = opt.typing === 'fill' || opt.typing === 'sequential'
    ? opt.typing
    : profile.framework === 'react-native-web' ? 'sequential' : 'fill';
  const status = new RegExp(typeof opt.statusPattern === 'string' ? opt.statusPattern : DEFAULT_STATUS, 'i');

  const enter = async (page: Page, selector: string, value: string) => {
    const field = page.locator(selector).first();
    await field.waitFor({ state: 'visible' });
    await field.fill('');
    if (typing === 'sequential') await field.pressSequentially(value);
    else await field.fill(value);
  };

  return {
    type: userField === 'email' ? 'email-password' : 'username-password',
    configErrors: () => [
      ...checkKeys('selectors', SEL, [userField, 'password', 'submit', 'signedIn'], ['next', 'error']),
      ...checkKeys('options', opt, [], ['loginPath', 'homePath', 'typing', 'statusPattern']),
      ...(opt.typing !== undefined && opt.typing !== 'fill' && opt.typing !== 'sequential'
        ? ['loginAdapter.options.typing: "fill" or "sequential"'] : []),
    ],

    preflight(identity, creds) {
      if (!creds.user) return `${creds.userEnv} is not set in apps/${profile.id}/.env — "${identity}" cannot sign in`;
      if (userField === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(creds.user)) {
        return `${creds.userEnv} in apps/${profile.id}/.env is not an email address`;
      }
      if (!creds.secret) return `${creds.secretEnv} is not set in apps/${profile.id}/.env`;
      return null;
    },

    async isAuthenticated(page) {
      await page.goto(homePath, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.locator(`${SEL.signedIn}, ${SEL[userField]}`).first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
      await settle(page, 300);
      return page.locator(SEL.signedIn).first().isVisible().catch(() => false);
    },

    async authenticate(page, identity, creds) {
      log.step(`${identity} sign-in: opening ${loginPath}…`);
      await page.goto(loginPath, { waitUntil: 'domcontentloaded' });
      await page.locator(`${SEL[userField]}, ${SEL.signedIn}`).first().waitFor({ state: 'visible', timeout: 20_000 });
      if (await page.locator(SEL.signedIn).first().isVisible().catch(() => false)) {
        log.ok(`${identity} already signed in (${page.url()})`);
        return;
      }

      log.step(`${identity} sign-in: entering ${userField}…`);
      await enter(page, SEL[userField], creds.user);
      if (SEL.next) {
        await page.locator(SEL.next).first().click();
        await page.locator(SEL.password).first().waitFor({ state: 'visible', timeout: 20_000 });
      }
      log.step(`${identity} sign-in: entering password…`);
      await enter(page, SEL.password, creds.secret);
      await page.locator(SEL.submit).first().click();

      await page.locator(SEL.signedIn).first().waitFor({ state: 'visible', timeout: 25_000 }).catch(() => undefined);
      await settle(page, 500);
      if (!(await page.locator(SEL.signedIn).first().isVisible().catch(() => false))) {
        const why = await visibleStatusText(page, status, SEL.error);
        throw new Error(
          `${identity} sign-in did not complete — still on ${page.url()}${why ? ` ("${why}")` : ''}. ` +
            `Check ${creds.userEnv} / ${creds.secretEnv} in apps/${profile.id}/.env.`,
        );
      }
      log.ok(`${identity} sign-in complete (${page.url()})`);
    },
  };
}

export function createLoginAdapter(profile: AppProfile): LoginAdapter {
  switch (profile.loginAdapter.type) {
    case 'mobile-pin': return mobilePin(profile);
    case 'pin-only': return pinOnly(profile);
    case 'email-password': return formLogin(profile, 'email');
    case 'username-password': return formLogin(profile, 'username');
    default: {
      const never: never = profile.loginAdapter.type;
      throw new Error(`Unknown login adapter "${never}"`);
    }
  }
}
