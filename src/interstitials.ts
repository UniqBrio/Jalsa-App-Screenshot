/**
 * Interstitial dismisser.
 *
 * Some apps pop nudge modals, install banners or cookie prompts over the
 * screen seconds after load. The selectors that dismiss them are per app:
 * `interstitials` in apps/<app-id>/app.config.json. Most apps need none.
 *
 * The executor calls this before every interactive action, so when an app
 * grows an interstitial the fix is one selector in its profile and no change
 * to any flow. This is NOISE removal only: text/aria-label matching is allowed
 * here and nowhere else. Keep every selector narrow, so a dialog a flow is
 * actually trying to capture is never dismissed by accident.
 */
import { Page } from '@playwright/test';
import { log } from './logger';
import { profile } from './env';

const dismissSelectors = (): string[] => profile.interstitials;

/** Is a known interstitial currently on screen? Cheap presence check. */
export async function interstitialPresent(page: Page): Promise<boolean> {
  for (const sel of dismissSelectors()) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

/**
 * Dismisses every interstitial currently on screen. No-op (and fast) when none
 * are present, so it is safe to call before every interactive step. Returns the
 * selectors it actually clicked, for logging.
 */
export async function dismissInterstitials(page: Page, maxRounds = 3): Promise<string[]> {
  const dismissed: string[] = [];
  const selectors = dismissSelectors();
  if (!selectors.length) return dismissed;
  for (let round = 0; round < maxRounds; round++) {
    let acted = false;
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (!(await loc.isVisible().catch(() => false))) continue;
      const ok = await loc.click({ timeout: 2_000 }).then(() => true).catch(() => false);
      if (ok) {
        acted = true;
        dismissed.push(sel);
        await page.waitForTimeout(300); // let the dismissal animate out
        break;
      }
    }
    if (!acted) break;
  }
  if (dismissed.length) log.step(`dismissed interstitial(s): ${dismissed.join(', ')}`);
  return dismissed;
}
