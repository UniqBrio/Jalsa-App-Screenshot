/**
 * Stability gate — never capture a loading state.
 *
 * Before every screenshot we wait for: network quiet, the absence of
 * spinners/skeletons/progress indicators, and a DOM signature that stops
 * changing across two consecutive polls. There is also a hard floor so a shot is
 * never taken within `minQuietMs` of the action that preceded it.
 *
 * If the wait expires the caller still captures, but names the file `.loading.png`
 * and flags it unstable, so a mid-load shot is visible as such rather than
 * silently poisoning the baseline.
 */
import { Page } from '@playwright/test';

export interface StabilityResult {
  stable: boolean;
  reason: string;
}

/** Selectors that mean "still working" — kept broad; extend as live patterns surface. */
const LOADING_SELECTOR =
  '[aria-busy="true"], [role="progressbar"], [aria-label*="loading" i], ' +
  '[data-testid*="spinner" i], [data-testid*="skeleton" i], [data-testid*="loading" i], ' +
  '[class*="shimmer" i], [class*="skeleton" i], [class*="spinner" i]';

export async function waitForStable(
  page: Page,
  opts: { timeoutMs?: number; minQuietMs?: number; pollMs?: number } = {},
): Promise<StabilityResult> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const minQuietMs = opts.minQuietMs ?? 300;
  const pollMs = opts.pollMs ?? 250;
  const start = Date.now();

  // Best-effort network quiet; SPAs that poll never truly idle, so this is capped.
  await page
    .waitForLoadState('networkidle', { timeout: Math.min(4_000, timeoutMs) })
    .catch(() => undefined);

  // Hard floor: never within minQuietMs of the preceding action.
  const elapsed = Date.now() - start;
  if (elapsed < minQuietMs) await page.waitForTimeout(minQuietMs - elapsed);

  let lastSig = '';
  let stableStreak = 0;

  while (Date.now() - start < timeoutMs) {
    const probe = await page
      .evaluate((loadingSel) => {
        const loading = !!document.querySelector(loadingSel);
        const body = document.body;
        // Cheap structural+text signature; changes when content settles in.
        const sig = body
          ? `${body.getElementsByTagName('*').length}:${(body.innerText || '').length}`
          : '0:0';
        return { loading, sig };
      }, LOADING_SELECTOR)
      .catch(() => ({ loading: false, sig: 'evalerr' }));

    if (probe.loading) {
      stableStreak = 0;
    } else if (probe.sig === lastSig) {
      stableStreak += 1;
      if (stableStreak >= 2) return { stable: true, reason: 'settled' };
    } else {
      stableStreak = 0;
    }
    lastSig = probe.sig;
    await page.waitForTimeout(pollMs);
  }

  // One last look to report the most useful reason.
  const why = await page
    .evaluate((loadingSel) => (document.querySelector(loadingSel) ? 'loader still present' : 'DOM still changing'), LOADING_SELECTOR)
    .catch(() => 'unknown');
  return { stable: false, reason: `${why} after ${timeoutMs}ms` };
}
