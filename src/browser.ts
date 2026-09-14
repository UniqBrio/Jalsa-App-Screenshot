/** Browser lifecycle — one Chromium instance per run, one context per identity. */
import * as fs from 'fs';
import { chromium, devices, Browser, BrowserContext, Page } from '@playwright/test';
import { env } from './env';

export async function launchBrowser(opts: { headless?: boolean } = {}): Promise<Browser> {
  return chromium.launch({
    headless: opts.headless ?? env.browser.headless,
    slowMo: env.browser.slowMo || undefined,
    args: ['--disable-dev-shm-usage'],
  });
}

export async function newContext(browser: Browser, storageStatePath?: string): Promise<BrowserContext> {
  const useState = storageStatePath && fs.existsSync(storageStatePath) ? storageStatePath : undefined;
  const ctx = await browser.newContext({
    baseURL: env.appUrl,
    viewport: { width: env.browser.width, height: env.browser.height },
    storageState: useState,
    deviceScaleFactor: env.browser.deviceScaleFactor, // crisp screenshots — these end up in documentation
    // Mobile-first PWA: emulate a real Chrome-on-Android device so the app serves
    // its mobile layout (meta-viewport honoured, touch events, no desktop UA).
    userAgent: devices['Pixel 7'].userAgent,
    isMobile: true,
    hasTouch: true,
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
