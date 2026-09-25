/**
 * Screenshot naming + capture modes.
 *
 * Path convention:
 *   runs/{app-id}/{run-id}/{Device}/{module}/{flow}/{step-id}.{mode}.png
 *
 * Stable names within a run are the point: two runs of the same app compare
 * file-for-file, so a filename must not drift when unrelated steps are added.
 * That is why step ids are numbered and hand-assigned rather than positional.
 *
 * Modes:
 *   viewport   what the user actually sees
 *   full       BOTH a viewport shot and a whole-content shot
 *   element    one element, expanded if it scrolls internally
 *   failed     the state at the moment a step threw
 *
 * `full` on a screen with an open scrollable dialog is the interesting case.
 * Playwright's `fullPage: true` captures the *page* scroll, and a page behind a
 * modal is usually scroll-locked, so it would miss exactly the content you
 * wanted. So `full` looks for a visible overlay that overflows and captures
 * that instead, expanding it to its full height first.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Page, Locator } from '@playwright/test';
import { paths } from './env';
import { ensureDir, relPosix } from './fsx';
import { log } from './logger';
import type { CaptureSpec } from './types';

export type CaptureFileMode = 'viewport' | 'full' | 'element' | 'failed' | 'loading';

const TARGET_ATTR = 'data-capture-target';
const SCROLLER_ATTR = 'data-capture-scroller';
const TARGET_SEL = `[${TARGET_ATTR}="1"]`;
const SCROLLER_SEL = `[${SCROLLER_ATTR}="1"]`;

export interface CaptureOptions {
  module: string;
  flow: string;
  stepId: string;
  spec: CaptureSpec;
  /** Selectors blacked out in the PNG so volatile content can't create false diffs. */
  mask?: string[];
  /**
   * The stability gate expired — the page was still loading. Capture a single
   * viewport shot named `{stepId}.loading.png` instead of the normal mode(s), so
   * a mid-load frame is unmistakable and never mistaken for the settled state.
   */
  unstable?: boolean;
  /** Output root: runs/<app>/<run-id>/<Device>/, or inside evidence/<app>/<run_id>/ in evidence mode. */
  root: string;
}

export function screenshotPathFor(
  module: string,
  flow: string,
  stepId: string,
  mode: CaptureFileMode,
  root: string,
): string {
  return path.join(root, module, flow, `${stepId}.${mode}.png`);
}

function maskLocators(page: Page, mask: string[] | undefined): Locator[] {
  return (mask ?? []).map((sel) => page.locator(sel));
}

/**
 * Captures whatever the spec asks for. Returns every file written, repo-relative.
 * A `none` spec writes nothing and returns an empty list.
 */
export async function capture(page: Page, opts: CaptureOptions): Promise<string[]> {
  const { spec } = opts;
  if (spec.mode === 'none') return [];

  // Stability gate expired: one plainly-labelled viewport shot, no full/element
  // expansion (a mid-load DOM isn't worth stitching).
  if (opts.unstable) {
    const abs = screenshotPathFor(opts.module, opts.flow, opts.stepId, 'loading', opts.root);
    ensureDir(path.dirname(abs));
    await page.screenshot({
      path: abs,
      fullPage: false,
      animations: 'disabled',
      caret: 'hide',
      mask: maskLocators(page, opts.mask),
      maskColor: '#7f7f7f',
    });
    return [relPosix(paths.root, abs)];
  }

  const written: string[] = [];

  // `auto` has already decided *whether* to fire by the time we get here; what
  // it captures is a plain viewport shot.
  if (spec.mode === 'viewport' || spec.mode === 'auto' || spec.mode === 'full') {
    written.push(await captureViewport(page, opts));
  }

  if (spec.mode === 'full') {
    written.push(await captureFull(page, opts));
  }

  if (spec.mode === 'element') {
    written.push(await captureElement(page, opts, spec.selector));
  }

  return written;
}

/** The failure shot — same mask as the step asked for, so PII stays masked. */
export async function captureFailure(page: Page, opts: Omit<CaptureOptions, 'spec'>): Promise<string | null> {
  try {
    const abs = screenshotPathFor(opts.module, opts.flow, opts.stepId, 'failed', opts.root);
    ensureDir(path.dirname(abs));
    await page.screenshot({
      path: abs,
      animations: 'disabled',
      caret: 'hide',
      mask: maskLocators(page, opts.mask),
      maskColor: '#7f7f7f',
    });
    return relPosix(paths.root, abs);
  } catch {
    return null;
  }
}

async function captureViewport(page: Page, opts: CaptureOptions): Promise<string> {
  const abs = screenshotPathFor(opts.module, opts.flow, opts.stepId, 'viewport', opts.root);
  ensureDir(path.dirname(abs));
  await page.screenshot({
    path: abs,
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
    mask: maskLocators(page, opts.mask),
    maskColor: '#7f7f7f',
  });
  return relPosix(paths.root, abs);
}

/**
 * Whole-content shot. Prefers an overflowing overlay when one is open, because
 * that is the content a page-level fullPage capture would silently miss.
 */
async function captureFull(page: Page, opts: CaptureOptions): Promise<string> {
  const abs = screenshotPathFor(opts.module, opts.flow, opts.stepId, 'full', opts.root);
  ensureDir(path.dirname(abs));

  const marked = await markOverflowingOverlay(page);
  if (!marked) {
    await page.screenshot({
      path: abs,
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      mask: maskLocators(page, opts.mask),
      maskColor: '#7f7f7f',
    });
    return relPosix(paths.root, abs);
  }

  try {
    // Let the overlay settle after being marked before measuring/clipping.
    await page.waitForTimeout(250);
    await captureExpandedOrStitched(page, TARGET_SEL, SCROLLER_SEL, abs, opts);
  } finally {
    await clearMarks(page);
  }
  return relPosix(paths.root, abs);
}

async function captureElement(page: Page, opts: CaptureOptions, selector: string): Promise<string> {
  const abs = screenshotPathFor(opts.module, opts.flow, opts.stepId, 'element', opts.root);
  ensureDir(path.dirname(abs));

  // Mark the element itself as the target, and its own scroller if it has one.
  const marked = await page.evaluate(
    ({ sel, targetAttr, scrollerAttr }) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.setAttribute(targetAttr, '1');
      // Centre it first. Playwright scrolls an element into view *minimally*,
      // which parks anything below the fold against the bottom edge — straight
      // under a fixed bottom tab bar, which then composites into the clip and
      // obscures the very thing being captured. Centring clears both the
      // bottom bar and any sticky header.
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const candidates: Element[] = [el, ...Array.from(el.querySelectorAll('*'))];
      for (const c of candidates) {
        const st = getComputedStyle(c);
        if (/(auto|scroll)/.test(st.overflowY) && c.scrollHeight > c.clientHeight + 8) {
          c.setAttribute(scrollerAttr, '1');
          break;
        }
      }
      return true;
    },
    { sel: selector, targetAttr: TARGET_ATTR, scrollerAttr: SCROLLER_ATTR },
  );

  if (!marked) {
    throw new Error(`screenshot element:${selector} — no element matched that selector`);
  }

  try {
    // Let the centring scroll land before measuring/clipping.
    await page.waitForTimeout(250);
    await captureExpandedOrStitched(page, TARGET_SEL, SCROLLER_SEL, abs, opts);
  } finally {
    await clearMarks(page);
  }
  return relPosix(paths.root, abs);
}

/**
 * Two strategies, in order:
 *   1. Expand the scroller to its full height and take one element screenshot.
 *      Keeps surrounding chrome (a dialog header, say) in frame.
 *   2. If the expansion doesn't take (sticky or absolutely positioned layouts
 *      fight it), slice the scroller at successive scroll offsets and composite
 *      them on an offscreen canvas inside the page. No image dependency needed.
 */
async function captureExpandedOrStitched(
  page: Page,
  targetSel: string,
  scrollerSel: string,
  abs: string,
  opts: CaptureOptions,
): Promise<void> {
  const target = page.locator(targetSel).first();
  const hasScroller = (await page.locator(scrollerSel).count()) > 0;

  if (!hasScroller) {
    await target.screenshot({
      path: abs,
      animations: 'disabled',
      caret: 'hide',
      mask: maskLocators(page, opts.mask),
      maskColor: '#7f7f7f',
    });
    return;
  }

  const expansion = await expandScroller(page, targetSel, scrollerSel);
  try {
    if (expansion.expanded) {
      await target.screenshot({
        path: abs,
        animations: 'disabled',
        caret: 'hide',
        mask: maskLocators(page, opts.mask),
        maskColor: '#7f7f7f',
      });
      return;
    }
  } finally {
    await restoreScroller(page, targetSel, scrollerSel, expansion.saved);
  }

  log.step(
    `${opts.stepId}: expansion did not take (${expansion.reason}) — stitching the scroll container instead`,
  );
  await stitchScroller(page, scrollerSel, abs, opts);
}

interface SavedStyles {
  target: string | null;
  scroller: string | null;
}

async function expandScroller(
  page: Page,
  targetSel: string,
  scrollerSel: string,
): Promise<{ expanded: boolean; reason: string; saved: SavedStyles }> {
  return page.evaluate(
    ({ t, s }) => {
      const target = document.querySelector(t) as HTMLElement | null;
      const scroller = (document.querySelector(s) as HTMLElement | null) ?? target;
      const saved: SavedStyles = {
        target: target ? target.getAttribute('style') : null,
        scroller: scroller ? scroller.getAttribute('style') : null,
      };
      if (!target || !scroller) return { expanded: false, reason: 'target vanished', saved };

      const needed = scroller.scrollHeight;
      scroller.scrollTop = 0;
      scroller.style.maxHeight = 'none';
      scroller.style.height = `${needed}px`;
      scroller.style.overflow = 'visible';
      if (target !== scroller) {
        target.style.maxHeight = 'none';
        target.style.height = 'auto';
      }

      // Re-measure: if the layout refused to grow, expansion is not viable.
      const got = scroller.clientHeight;
      return got >= needed - 2
        ? { expanded: true, reason: 'ok', saved }
        : { expanded: false, reason: `wanted ${needed}px, got ${got}px`, saved };
    },
    { t: targetSel, s: scrollerSel },
  );
}

async function restoreScroller(
  page: Page,
  targetSel: string,
  scrollerSel: string,
  saved: SavedStyles,
): Promise<void> {
  await page
    .evaluate(
      ({ t, s, sv }) => {
        const put = (el: Element | null, style: string | null) => {
          if (!el) return;
          if (style === null) el.removeAttribute('style');
          else el.setAttribute('style', style);
        };
        put(document.querySelector(t), sv.target);
        put(document.querySelector(s), sv.scroller);
      },
      { t: targetSel, s: scrollerSel, sv: saved },
    )
    .catch(() => undefined);
}

/**
 * Slice-and-stitch fallback. Captures the scroll container at successive
 * offsets and composites them in-page on a canvas. Each slice is drawn at its
 * true content offset, so the overlap on the final short slice simply
 * overwrites identical pixels rather than needing to be trimmed.
 */
async function stitchScroller(
  page: Page,
  scrollerSel: string,
  abs: string,
  opts: CaptureOptions,
): Promise<void> {
  const scroller = page.locator(scrollerSel).first();
  const metrics = await page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null;
    if (!el) return null;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }, scrollerSel);

  if (!metrics || metrics.clientHeight <= 0) {
    throw new Error('stitch failed — scroll container has no measurable height');
  }

  const offsets: number[] = [];
  for (let y = 0; y < metrics.scrollHeight - metrics.clientHeight; y += metrics.clientHeight) {
    offsets.push(y);
  }
  offsets.push(metrics.scrollHeight - metrics.clientHeight);

  const slices: Array<{ dataUrl: string; offset: number }> = [];
  for (const offset of offsets) {
    await page.evaluate(
      ({ s, y }) => {
        const el = document.querySelector(s) as HTMLElement | null;
        if (el) el.scrollTop = y;
      },
      { s: scrollerSel, y: offset },
    );
    // One frame for the scroll to paint before the slice is taken.
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    const buf = await scroller.screenshot({
      animations: 'disabled',
      caret: 'hide',
      mask: maskLocators(page, opts.mask),
      maskColor: '#7f7f7f',
    });
    slices.push({ dataUrl: `data:image/png;base64,${buf.toString('base64')}`, offset });
  }

  const composed = await page.evaluate(
    async ({ parts, clientHeight, scrollHeight }) => {
      const images = await Promise.all(
        parts.map(
          (p: { dataUrl: string; offset: number }) =>
            new Promise<{ img: HTMLImageElement; offset: number }>((resolve, reject) => {
              const img = new Image();
              img.onload = () => resolve({ img, offset: p.offset });
              img.onerror = () => reject(new Error('slice failed to decode'));
              img.src = p.dataUrl;
            }),
        ),
      );
      if (!images.length) throw new Error('no slices captured');

      // Device-pixel scale, derived from the slice itself rather than assumed.
      const scale = images[0].img.naturalHeight / clientHeight;
      const canvas = document.createElement('canvas');
      canvas.width = images[0].img.naturalWidth;
      canvas.height = Math.round(scrollHeight * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context available for stitching');
      for (const { img, offset } of images) {
        ctx.drawImage(img, 0, Math.round(offset * scale));
      }
      return canvas.toDataURL('image/png');
    },
    { parts: slices, clientHeight: metrics.clientHeight, scrollHeight: metrics.scrollHeight },
  );

  fs.writeFileSync(abs, Buffer.from(composed.split(',')[1], 'base64'));

  // Leave the container where we found it.
  await page
    .evaluate((s) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (el) el.scrollTop = 0;
    }, scrollerSel)
    .catch(() => undefined);
}

/** Finds the largest visible overlay that (or whose descendant) scrolls. */
async function markOverflowingOverlay(page: Page): Promise<boolean> {
  return page.evaluate(({ targetAttr, scrollerAttr }) => {
    const visible = (el: Element): boolean => {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const overlays = Array.from(
      document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [data-testid*="modal" i], ' +
          '[data-testid*="sheet" i], [data-testid*="drawer" i]',
      ),
    ).filter(visible);
    if (!overlays.length) return false;

    const area = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width * r.height;
    };
    overlays.sort((a, b) => area(b) - area(a));

    for (const overlay of overlays) {
      const candidates: Element[] = [overlay, ...Array.from(overlay.querySelectorAll('*'))];
      for (const c of candidates) {
        const st = getComputedStyle(c);
        if (/(auto|scroll)/.test(st.overflowY) && c.scrollHeight > c.clientHeight + 8) {
          overlay.setAttribute(targetAttr, '1');
          c.setAttribute(scrollerAttr, '1');
          return true;
        }
      }
    }
    return false;
  }, { targetAttr: TARGET_ATTR, scrollerAttr: SCROLLER_ATTR });
}

async function clearMarks(page: Page): Promise<void> {
  await page
    .evaluate(
      ({ targetAttr, scrollerAttr }) => {
        document.querySelectorAll(`[${targetAttr}]`).forEach((e) => e.removeAttribute(targetAttr));
        document.querySelectorAll(`[${scrollerAttr}]`).forEach((e) => e.removeAttribute(scrollerAttr));
      },
      { targetAttr: TARGET_ATTR, scrollerAttr: SCROLLER_ATTR },
    )
    .catch(() => undefined);
}
