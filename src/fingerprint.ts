/**
 * DOM fingerprinting — the secondary change-detection layer (BUILD_PLAN §3.2).
 *
 * We hash a *normalised skeleton* of the DOM rather than raw HTML:
 *   - only structural attributes survive (tag, data-testid, role, aria-label, type)
 *   - class lists are dropped (utility-class churn is noise, not change)
 *   - masked selectors are removed entirely
 *   - text is collapsed and volatile patterns (dates, times, currency, ids,
 *     relative times) are replaced with placeholders
 *
 * The result: a cosmetic re-render produces the same hash, a real structural or
 * copy change produces a different one.
 */
import * as crypto from 'crypto';
import { Page } from '@playwright/test';
import { paths } from './env';
import { readJson, writeJson } from './fsx';
import type { Fingerprints, FingerprintEntry } from './types';

/** Volatile text patterns replaced before hashing. Order matters. */
const VOLATILE: Array<[RegExp, string]> = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?\b/g, '<DATETIME>'],
  [/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/g, '<DATE>'],
  [/\b\d{4}-\d{2}-\d{2}\b/g, '<DATE>'],
  [/\b\d{1,2}:\d{2}\s*(AM|PM|am|pm)?\b/g, '<TIME>'],
  [/\b(just now|a few seconds ago|\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago)\b/gi, '<RELTIME>'],
  [/[₹$]\s?[\d,]+(\.\d{1,2})?/g, '<MONEY>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>'],
  [/\bSCRSHOT_[0-9A-Za-z_-]+\b/g, '<RUNTAG>'],
  [/\b\d{10}\b/g, '<MOBILE>'],
];

/**
 * Extracts the normalised skeleton in-page. Kept as a single self-contained
 * function because it is serialised into the browser.
 */
async function extractSkeleton(page: Page, mask: string[]): Promise<string> {
  return page.evaluate((maskSelectors: string[]) => {
    const KEEP_ATTRS = ['data-testid', 'role', 'aria-label', 'type', 'name', 'placeholder', 'href'];
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'LINK', 'META']);

    const masked = new Set<Element>();
    for (const sel of maskSelectors) {
      try {
        document.querySelectorAll(sel).forEach((el) => masked.add(el));
      } catch { /* invalid selector — ignore */ }
    }

    const out: string[] = [];

    const walk = (el: Element, depth: number): void => {
      if (depth > 40) return;
      if (SKIP_TAGS.has(el.tagName)) return;
      if (masked.has(el)) { out.push(`${'  '.repeat(depth)}<${el.tagName.toLowerCase()} MASKED/>`); return; }

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;

      const attrs: string[] = [];
      for (const a of KEEP_ATTRS) {
        const v = el.getAttribute(a);
        if (v) attrs.push(`${a}="${v}"`);
      }

      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent ?? '').trim())
        .filter(Boolean)
        .join(' ');

      const head = `${'  '.repeat(depth)}<${el.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
      out.push(ownText ? `${head}${ownText}` : head);

      for (const child of Array.from(el.children)) walk(child, depth + 1);
    };

    if (document.body) walk(document.body, 0);
    return out.join('\n');
  }, mask);
}

export function normalise(skeleton: string): string {
  let s = skeleton.replace(/[ \t]+/g, ' ');
  for (const [re, token] of VOLATILE) s = s.replace(re, token);
  return s.trim();
}

export async function domHash(page: Page, mask: string[] = []): Promise<string> {
  const skeleton = await extractSkeleton(page, mask);
  const normalised = normalise(skeleton);
  return 'sha256:' + crypto.createHash('sha256').update(normalised).digest('hex');
}

export function fingerprintKey(module: string, flow: string, stepId: string): string {
  return `${module}/${flow}/${stepId}`;
}

export function loadBaseline(): Fingerprints {
  return readJson<Fingerprints>(paths.baseline, {});
}

export function saveBaseline(fp: Fingerprints): void {
  writeJson(paths.baseline, fp);
}

export type FingerprintVerdict = 'new' | 'unchanged' | 'changed';

export function compareFingerprint(
  baseline: Fingerprints,
  key: string,
  hash: string,
): FingerprintVerdict {
  const prev = baseline[key];
  if (!prev) return 'new';
  return prev.dom_hash === hash ? 'unchanged' : 'changed';
}

export function updateFingerprint(
  baseline: Fingerprints,
  key: string,
  hash: string,
  mask: string[],
): void {
  const entry: FingerprintEntry = {
    dom_hash: hash,
    masked_selectors: mask,
    last_updated: new Date().toISOString().slice(0, 10),
  };
  baseline[key] = entry;
}
