/**
 * Discovery.
 *
 * Crawls the app's navigation, diffs it against config/known_routes.json with
 * a PURE STRUCTURAL diff (no LLM). Only genuinely new items cost an LLM call,
 * and only to propose a first-pass flow draft.
 *
 * Navigation is read from the places the app profile names
 * (`discovery.navSources` in apps/<app-id>/app.config.json): each source is a
 * route to open and a selector matching its navigation controls — a tab row,
 * a nav bar of links, the rows of a settings screen. Many apps draw navigation
 * as buttons or tabs with no href, so the crawl reads labels, not hrefs, and
 * maps each label to the route it opens by TAPPING it and reading the URL
 * back — never by guessing. Without a navSources entry, the tabs and nav links
 * on '/' are read.
 *
 * Drafts land in apps/<app-id>/flows/_drafts/ and are NEVER auto-promoted —
 * you move a draft into flows/ once you have reviewed it. known_routes.json is updated either
 * way, so a deferred draft doesn't re-flag every single day.
 *
 * Usage: npm run discover -- --app <id>
 */
import * as fs from 'fs';
import * as path from 'path';
import { Page } from '@playwright/test';
import { env, paths, profile, sharedPaths, assertTargetEnvironment } from './env';
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
 * Reads each configured navigation source and taps every control once to learn
 * where it goes. Structural only — no LLM anywhere here.
 */
async function scrapeNav(page: Page): Promise<LiveNavItem[]> {
  const seen = new Map<string, LiveNavItem>();
  const pathOf = () => new URL(page.url()).pathname;

  for (const source of profile.discovery.navSources) {
    await page.goto(source.path, { waitUntil: 'domcontentloaded' });
    await settle(page, 1_000);
    const labels = await page
      .locator(source.items)
      .evaluateAll(
        (els, attr) => els.map((el) => ((attr ? el.getAttribute(attr) : null) || el.getAttribute('aria-label') || el.textContent || '').trim()),
        source.labelAttribute ?? null,
      )
      .catch(() => [] as string[]);

    for (const label of labels.filter(Boolean)) {
      const short = source.labelCut
        ? label.split(new RegExp(`[${source.labelCut.replace(/[\]\\^-]/g, '\\$&')}]`))[0].trim()
        : label;
      if (NEVER_TAP.test(short)) continue;
      await page.goto(source.path, { waitUntil: 'domcontentloaded' });
      await settle(page, 600);
      const loc = page.locator(`role=${source.role}[name="${label.replace(/"/g, '\\"')}"]`).first();
      if (!(await loc.isVisible().catch(() => false))) continue;
      await loc.click({ timeout: 5_000 }).catch(() => undefined);
      await settle(page, 600);
      const routePath = pathOf();
      if (routePath === source.path) continue;
      if (!seen.has(routePath)) seen.set(routePath, { path: routePath, label: short, tab: source.tab });
    }
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
# apps/${env.appId}/flows/${moduleGuess}.${moduleGuess}-overview.yaml and add
# "${moduleGuess}" to apps/${env.appId}/config/routes.map.json with real source_paths.
schema_version: 2
module: ${moduleGuess}
flow: ${moduleGuess}-overview
title: ${item.label}
description: TODO — discovered nav item "${item.label}"
auth: ${profile.defaultAccount}

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
  // The payload below is the screen's page HTML and a screenshot, which carry
  // member names and emails. Personal data never reaches the LLM by default.
  if (!env.discoveryLlm) {
    log.skip(
      `LLM draft proposal skipped — it would send page content (may include personal data). ` +
        `Writing the deterministic draft instead. Opt in with DISCOVERY_LLM_SEND_PAGE_CONTENT=true.`,
    );
    return fallback;
  }

  const png = fs.existsSync(path.join(paths.root, screenshotRel))
    ? fs.readFileSync(path.join(paths.root, screenshotRel)).toString('base64')
    : null;

  const schema = fs.existsSync(sharedPaths.flowSchema) ? fs.readFileSync(sharedPaths.flowSchema, 'utf8') : '';

  const answer = await askLlm(
    `A new navigation item appeared in ${profile.appName}. About the app: ${profile.appDescription}\n\n` +
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
    const ctx = await getAuthenticatedContext(browser, profile.defaultAccount);
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
        root: path.join(paths.runs, '_discovery', new Date().toISOString().slice(0, 10)),
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
