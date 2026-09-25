/**
 * Authentication — one saved session per identity of the selected app.
 *
 * Identities are the `accounts` of the app profile (e.g. admin, staff, dummy);
 * how to sign in is the profile's login adapter (login-adapters.ts). Flows with
 * `auth: none` get a fresh signed-out context from the runner and never come
 * through here.
 *
 * Cost control: authenticate ONCE per identity per run, persist storageState
 * (cookies + localStorage), reuse it across every flow. A stale state file is
 * detected and re-authenticated.
 *
 * The dummy identity is verified after EVERY sign-in and every session reuse:
 * the tenant id and name the app shows must equal the profile's dummy
 * fingerprint exactly, or a DummyIdentityError aborts the run before any flow
 * acts. Which credential variable was used proves nothing; what the app says
 * about the session does.
 *
 * Saved sessions are live sessions. apps/<app-id>/.auth/ is gitignored; keep
 * it that way.
 */
import * as fs from 'fs';
import { Browser, BrowserContext, Page } from '@playwright/test';
import { env, paths, profile, storageStatePath, isDummyIdentity } from './env';
import { ensureDir, writeJson } from './fsx';
import { log } from './logger';
import { newContext } from './browser';
import { createLoginAdapter, type LoginAdapter } from './login-adapters';
import { verifyDummyIdentity, DummyIdentityError } from './write-gates';
import type { DeviceProfile } from './devices';

/** An account name from the profile. */
export type Identity = string;

let adapter: { appId: string; impl: LoginAdapter } | null = null;
function loginAdapter(): LoginAdapter {
  if (adapter?.appId !== profile.id) adapter = { appId: profile.id, impl: createLoginAdapter(profile) };
  return adapter.impl;
}

/** Why an identity cannot authenticate right now, or null if it can. */
export function authPreflight(identity: Identity): string | null {
  const creds = env.accounts[identity];
  if (!creds) return `"${identity}" is not an account in apps/${profile.id}/app.config.json`;
  return loginAdapter().preflight(identity, creds);
}

/** Throws DummyIdentityError unless the signed-in session is the dummy tenant. */
async function assertDummy(page: Page): Promise<void> {
  const result = await verifyDummyIdentity(page, profile);
  if (!result.ok) throw new DummyIdentityError(result.problems);
  log.ok(`dummy identity verified — tenant matches the profile fingerprint`);
}

/**
 * Returns an authenticated context for the identity, reusing storageState when
 * it is still valid. Called once per identity per device per run.
 */
export async function getAuthenticatedContext(
  browser: Browser,
  identity: Identity,
  device?: DeviceProfile,
): Promise<BrowserContext> {
  const problem = authPreflight(identity);
  if (problem) throw new Error(`Cannot authenticate as "${identity}": ${problem}`);
  const statePath = storageStatePath(identity);
  const dummy = isDummyIdentity(identity);

  ensureDir(paths.auth);

  // Try the saved session first.
  if (fs.existsSync(statePath)) {
    const ctx = await newContext(browser, statePath, device);
    const page = await ctx.newPage();
    const ok = await loginAdapter().isAuthenticated(page).catch(() => false);
    if (ok) {
      try {
        if (dummy) await assertDummy(page);
      } catch (err) {
        await page.close();
        await ctx.close();
        throw err;
      }
      await page.close();
      log.ok(`Reusing saved ${identity} session.`);
      return ctx;
    }
    await page.close();
    log.warn(`Saved ${identity} session is stale — re-authenticating.`);
    await ctx.close();
    fs.rmSync(statePath, { force: true });
  }

  const ctx = await newContext(browser, undefined, device);
  const page = await ctx.newPage();
  try {
    await loginAdapter().authenticate(page, identity, env.accounts[identity]);
    if (dummy) await assertDummy(page);
  } catch (err) {
    await ctx.close();
    throw err;
  }
  await writeStorageStateAtomically(ctx, statePath);
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
