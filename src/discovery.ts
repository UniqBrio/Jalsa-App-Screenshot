/**
 * Discovery.
 *
 * Crawls the app's navigation, diffs it against config/known_routes.json with
 * a PURE STRUCTURAL diff (no LLM). Only genuinely new items cost an LLM call,
 * and only to propose a first-pass flow draft.
 *
 * RosiFit's navigation is not a list of links. The shell (src/components/
 * AppShell.tsx in the app repo) draws two structures, both as Pressables with
 * test ids rather than hrefs:
 *   · the academy header's underline row — nav-tab-overview, nav-tab-attendance
 *   · the floating pill — Home · Reports · More (role="tab", named; shell-nav-*
 *     test ids only on pushed screens)
 * plus the rows of the More screen (role="button", named "Branches, 1" etc.),
 * which are the way into every settings screen. So the crawl reads labels,
 * not hrefs, and maps each label to the route it opens by TAPPING it and
 * reading the URL back — never by guessing.
 *
 * Drafts land in flows/_drafts/ and are NEVER auto-promoted — you move a draft
 * into flows/ once you have reviewed it. known_routes.json is updated either
 * way, so a deferred draft doesn't re-flag every single day.
 *
 * Usage: npm run discover
 */
import * as fs from 'fs';
import * as path from 'path';
import { Page } from '@playwright/test';
import { paths, assertTargetEnvironment } from './env';
import { readJson, writeJson, writeText, ensureDir, relPosix } from './fsx';
import { log } from './logger';
import { launchBrowser, settle } from './browser';
import { getAuthenticatedContext } from './login';
import { capture } from './screenshot';
import { loadFlows } from './flow-loader';
import { askLlm, llmAvailable } from './llm';
import type { KnownRoutes, KnownRoute } from './types';

interface LiveNavItem {
  path: string;
  label: string;
  tab: boolean;
}

/** Labels of controls that must never be tapped by a crawler. */
const NEVER_TAP = /sign out|delete|remove|send|upload|save|confirm/i;

/**
 * Reads the shell's tab row and pill, then the More screen's rows, and taps
 * each once to learn where it goes. Structural only — no LLM anywhere here.
 */
async function scrapeNav(page: Page): Promise<LiveNavItem[]> {
  const seen = new Map<string, LiveNavItem>();
  const pathOf = () => new URL(page.url()).pathname;

  const learn = async (selector: string, label: string, tab: boolean) => {
    if (NEVER_TAP.test(label)) return;
    const loc = page.locator(selector).first();
    if (!(await loc.isVisible().catch(() => false))) return;
    await loc.click({ timeout: 5_000 }).catch(() => undefined);
    await settle(page, 600);
    const routePath = pathOf();
    if (routePath === '/') return;
    if (!seen.has(routePath)) seen.set(routePath, { path: routePath, label, tab });
  };

  // 1. The academy header's underline tabs and the floating pill.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await settle(page, 1_000);
  const tabs = await page
    .locator('[role="tablist"] [role="tab"]')
    .evaluateAll((els) => els.map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim()))
    .catch(() => [] as string[]);
  for (const label of tabs.filter(Boolean)) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await settle(page, 600);
    await learn(`role=tab[name="${label}"]`, label, true);
  }

  // 2. Every row on the More screen.
  await page.goto('/more', { waitUntil: 'domcontentloaded' });
  await settle(page, 1_000);
  const rows = await page
    .locator('[role="button"][aria-label]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') || ''))
    .catch(() => [] as string[]);
  for (const label of rows.filter(Boolean)) {
    const short = label.split(',')[0].split('.')[0].trim();
    await page.goto('/more', { waitUntil: 'domcontentloaded' });
    await settle(page, 600);
    await learn(`role=button[name="${label}"]`, short, false);
  }

  return Array.from(seen.values());
}

function slugToModule(routePath: string): string {
  return routePath.replace(/^\//, '').split('/')[0].replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'unknown';
}

async function proposeDraft(item: LiveNavItem, screenshotRel: string, domExcerpt: string): Promise<string> {
  const moduleGuess = slugToModule(item.path);

  const fallback = `# AUTO-GENERATED DRAFT — NOT ACTIVE.
# Discovered on ${new Date().toISOString().slice(0, 10)} at route ${item.path}.
# Review, correct every selector against the live app, then move this file to
# flows/${moduleGuess}.${moduleGuess}-overview.yaml and add "${moduleGuess}" to
# config/routes.map.json with real source_paths.
schema_version: 2
module: ${moduleGuess}
flow: ${moduleGuess}-overview
title: ${item.label}
description: TODO — discovered nav item "${item.label}"
auth: admin

depends_on_routes:
  - ${item.path}

steps:
  - id: 010-open-${moduleGuess}
    action: goto
    value: ${item.path}
    label: Open ${item.label}
    expect_screen: ${moduleGuess}-home
    screenshot: viewport
    settle_ms: 800
`;

  if (!llmAvailable()) return fallback;

  const png = fs.existsSync(path.join(paths.root, screenshotRel))
    ? fs.readFileSync(path.join(paths.root, screenshotRel)).toString('base64')
    : null;

  const schema = fs.existsSync(path.join(paths.flows, '_SCHEMA.md'))
    ? fs.readFileSync(path.join(paths.flows, '_SCHEMA.md'), 'utf8')
    : '';

  const answer = await askLlm(
    `A new navigation item appeared in RosiFit, an attendance and follow-up web app for a fitness academy.\n\n` +
      `Route: ${item.path}\nNav label: ${item.label}\nIs a tab: ${item.tab}\n\n` +
      `DOM excerpt of the screen (structural skeleton, truncated):\n<dom>\n${domExcerpt.slice(0, 6000)}\n</dom>\n\n` +
      `Flow manifest schema:\n<schema>\n${schema.slice(0, 4000)}\n</schema>\n\n` +
      `Produce ONE flow YAML manifest that captures the primary read-only path ` +
      `through this screen. Rules: use only selectors you can actually see in the ` +
      `DOM excerpt, prefer [data-testid="..."], do NOT invent steps that write, send, upload or ` +
      `delete anything, keep it to 3-6 steps, set screenshot: viewport on each step, set ` +
      `run_tag: false on any type step. Output ONLY the YAML — no prose, no code fences.`,
    {
      system: 'You write Playwright flow manifests. You are conservative: you never invent selectors that are not present in the provided DOM, and you never propose a step that writes data.',
      images: png ? [{ base64: png }] : [],
      maxTokens: 1500,
    },
  );

  if (!answer) return fallback;

  const yamlBody = answer.replace(/^```(ya?ml)?/gm, '').replace(/```$/gm, '').trim();
  return `# AUTO-GENERATED DRAFT — NOT ACTIVE. Reviewed by: (nobody yet)
# Discovered ${new Date().toISOString().slice(0, 10)} at route ${item.path}.
# Verify EVERY selector against the live app before promoting this into flows/.
# Reference screenshot: ${screenshotRel}
${yamlBody}
`;
}

export async function runDiscovery(): Promise<{ newRoutes: KnownRoute[]; drafts: string[] }> {
  assertTargetEnvironment();

  const known = readJson<KnownRoutes>(paths.knownRoutes, { last_checked: '', routes: [] });
  const knownPaths = new Set(known.routes.map((r) => r.path));

  const { flows } = loadFlows();
  const coveredRoutes = new Set(flows.flatMap((f) => f.depends_on_routes ?? []));

  const browser = await launchBrowser();
  const newRoutes: KnownRoute[] = [];
  const drafts: string[] = [];

  try {
    const ctx = await getAuthenticatedContext(browser, 'admin');
    const page = await ctx.newPage();

    const live = await scrapeNav(page);
    log.info(`Found ${live.length} navigation destination(s) in the live app.`);

    for (const item of live) {
      if (knownPaths.has(item.path)) continue;

      log.warn(`NEW nav item: ${item.path} ("${item.label}")`);
      const moduleGuess = slugToModule(item.path);

      await page.goto(item.path, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await settle(page, 800);

      const [shot] = await capture(page, {
        module: '_discovered',
        flow: moduleGuess,
        stepId: '010-first-sight',
        spec: { mode: 'viewport' },
      });

      const domExcerpt = await page
        .evaluate(() => document.body?.innerHTML?.slice(0, 20000) ?? '')
        .catch(() => '');

      const draftYaml = await proposeDraft(item, shot ?? '', domExcerpt);
      ensureDir(paths.drafts);
      const draftPath = path.join(paths.drafts, `${moduleGuess}.${moduleGuess}-overview.yaml`);
      writeText(draftPath, draftYaml);
      drafts.push(relPosix(paths.root, draftPath));
      log.ok(`Draft written → ${relPosix(paths.root, draftPath)} (review before promoting)`);

      newRoutes.push({
        path: item.path,
        label: item.label,
        tab: item.tab,
        module: moduleGuess,
        uncovered: true,
      });
    }

    // Flag known routes that still have no flow covering them.
    for (const route of known.routes) {
      route.uncovered = !coveredRoutes.has(route.path);
    }

    await page.close();
    await ctx.close();
  } finally {
    await browser.close();
  }

  // Always update known_routes.json — a deferred draft must not re-flag daily.
  known.routes = [...known.routes, ...newRoutes];
  known.last_checked = new Date().toISOString();
  writeJson(paths.knownRoutes, known);

  const uncovered = known.routes.filter((r) => r.uncovered);
  if (uncovered.length) {
    log.warn(`${uncovered.length} known route(s) have no flow coverage: ${uncovered.map((r) => r.path).join(', ')}`);
  }

  return { newRoutes, drafts };
}

if (require.main === module) {
  runDiscovery()
    .then(({ newRoutes, drafts }) => {
      log.banner(`Discovery complete — ${newRoutes.length} new route(s), ${drafts.length} draft(s)`);
      drafts.forEach((d) => log.info(`  · ${d}`));
      if (!drafts.length) log.ok('No new nav items. Nothing to review.');
    })
    .catch((err) => {
      log.error((err as Error).message);
      process.exitCode = 1;
    });
}
