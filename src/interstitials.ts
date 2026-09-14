/**
 * Interstitial dismisser.
 *
 * The UniqBrio capture engine this was cloned from needed this to clear nudge
 * modals that pop over the dashboard seconds after load. RosiFit (as of the
 * app source this project was written against) has no such interstitial: no
 * nudge, no install banner, no cookie prompt. The one overlay that can appear
 * unbidden is the stale-build notice from src/pwa/DeploymentRefresh.tsx, and
 * it reloads the page itself rather than asking.
 *
 * The hook is kept — the executor calls it before every interactive action —
 * so that when the app grows an interstitial, the fix is one selector here and
 * no change to any flow. This is NOISE removal only: text/aria-label matching
 * is allowed here and nowhere else. Keep every selector narrow, so a dialog a
 * flow is actually trying to capture is never dismissed by accident.
 */
import { Page } from '@playwright/test';
import { log } from './logger';

const DISMISS_SELECTORS: string[] = [
  // (none yet — see the header comment)
];

/** Is a known interstitial currently on screen? Cheap presence check. */
export async function interstitialPresent(page: Page): Promise<boolean> {
  for (const sel of DISMISS_SELECTORS) {
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
  if (!DISMISS_SELECTORS.length) return dismissed;
  for (let round = 0; round < maxRounds; round++) {
    let acted = false;
    for (const sel of DISMISS_SELECTORS) {
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
