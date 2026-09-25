/** Browser lifecycle — one Chromium instance per run, one context per identity. */
import * as fs from 'fs';
import { chromium, devices, Browser, BrowserContext, Page } from '@playwright/test';
import { env } from './env';
import type { DeviceProfile } from './devices';

export async function launchBrowser(opts: { headless?: boolean } = {}): Promise<Browser> {
  return chromium.launch({
    headless: opts.headless ?? env.browser.headless,
    slowMo: env.browser.slowMo || undefined,
    args: ['--disable-dev-shm-usage'],
  });
}

/**
 * A context for one device profile. Everything that decides which layout the app
 * serves comes from the profile — viewport, density, user agent, `isMobile` and
 * touch — because a wide window that still claims to be a phone would produce a
 * mobile layout labelled "Laptop".
 */
export async function newContext(browser: Browser, storageStatePath?: string, device?: DeviceProfile): Promise<BrowserContext> {
  const useState = storageStatePath && fs.existsSync(storageStatePath) ? storageStatePath : undefined;
  const emulated = device?.emulate ? devices[device.emulate] : undefined;
  const ctx = await browser.newContext({
    baseURL: env.appUrl,
    viewport: device ? { ...device.viewport } : { width: env.browser.width, height: env.browser.height },
    storageState: useState,
    // crisp screenshots — these end up in documentation
    deviceScaleFactor: device ? device.dpr : env.browser.deviceScaleFactor,
    // A desktop profile keeps Chromium's own user agent; a phone/tablet borrows a real one.
    userAgent: device ? emulated?.userAgent : devices['Pixel 7'].userAgent,
    isMobile: device ? device.isMobile : true,
    hasTouch: device ? device.hasTouch : true,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    reducedMotion: 'reduce', // kills animation-induced screenshot flake
    // Pinned so the app's "System" theme choice resolves the same way every run.
    colorScheme: env.browser.colorScheme,
  });
  ctx.setDefaultTimeout(env.browser.stepTimeout);
  ctx.setDefaultNavigationTimeout(env.browser.stepTimeout * 2);
  return ctx;
}

/** Flow-level default when a manifest names neither a step nor a flow settle_ms. */
export const DEFAULT_SETTLE_MS = 350;

/**
 * Waits for the app to stop moving. Unconditional before every capture and
 * before both reads of the visual state, in this order:
 *
 *   network idle -> two animation frames -> settle_ms
 *
 * The two frames matter: networkidle only says the fetches finished, not that
 * the resulting render has been painted. Capturing one frame early catches a
 * half-drawn transition, and a half-drawn transition hashes differently every
 * run, which poisons the fingerprint baseline with permanent false "changed".
 */
export async function settle(page: Page, extraMs = 0): Promise<void> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: env.browser.stepTimeout });
  } catch { /* non-fatal */ }
  try {
    await page.waitForLoadState('networkidle', { timeout: 5_000 });
  } catch { /* SPAs with polling never go idle — expected */ }
  await twoFrames(page);
  if (extraMs > 0) await page.waitForTimeout(extraMs);
}

/**
 * Resolves after two requestAnimationFrames, with a hard fallback so a page
 * that never paints (backgrounded tab, detached frame) can't hang the run.
 */
async function twoFrames(page: Page): Promise<void> {
  await page
    .evaluate(
      () =>
        new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (!done) { done = true; resolve(); }
          };
          requestAnimationFrame(() => requestAnimationFrame(finish));
          setTimeout(finish, 250);
        }),
    )
    .catch(() => undefined);
}
