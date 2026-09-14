/**
 * Documentation generation — BUILD_PLAN §8.
 *
 * Reads the run manifests for modules flagged `changed` (or `new`) and produces
 * docs/{module}.md: a screenshot-illustrated walkthrough of each flow.
 *
 * Cost discipline: this is NOT part of the daily capture. Run it on-change or
 * weekly. One LLM call per changed MODULE, not per step. Without an API key it
 * still produces a complete deterministic doc from the manifests — the LLM only
 * adds the prose intro.
 *
 * Usage:
 *   npm run docs                  # latest run's changed modules
 *   npm run docs -- --all         # every module with run history
 *   npm run docs -- --date 2026-08-10
 */
import * as fs from 'fs';
import * as path from 'path';
import { paths } from './env';
import { readJson, writeText, listFiles, relPosix } from './fsx';
import { log } from './logger';
import { askLlm, llmAvailable } from './llm';
import { loadFlows } from './flow-loader';
import type { FlowRun, Flow } from './types';

function latestRunDate(): string | null {
  if (!fs.existsSync(paths.runs)) return null;
  const days = fs
    .readdirSync(paths.runs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort();
  return days.length ? days[days.length - 1] : null;
}

function loadRunsForDate(date: string): FlowRun[] {
  const dir = path.join(paths.runs, date);
  return listFiles(dir, ['.flow-run.json']).map((f) => readJson<FlowRun>(f, null as unknown as FlowRun)).filter(Boolean);
}

function prettifyStepId(id: string): string {
  return id.replace(/^\d+-/, '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Markdown image path relative to docs/. */
function imgPath(screenshotRel: string): string {
  return path.posix.join('..', screenshotRel);
}

function renderFlowSection(run: FlowRun, flow: Flow | undefined): string {
  const lines: string[] = [];
  lines.push(`## ${flow?.flow ?? run.flow}`);
  lines.push('');
  if (flow?.description) lines.push(flow.description, '');
  if (flow?.depends_on_routes?.length) {
    lines.push(`Routes: ${flow.depends_on_routes.map((r) => `\`${r}\``).join(', ')}`, '');
  }

  for (const step of run.steps) {
    const manifestStep = flow?.steps.find((s) => s.id === step.id);
    const heading = manifestStep?.label ?? prettifyStepId(step.id);
    lines.push(`### ${heading}`);
    lines.push('');
    if (step.screenshot_path) {
      lines.push(`![${heading}](${imgPath(step.screenshot_path)})`);
      lines.push('');
    }
    const bits: string[] = [];
    if (step.next_screen) bits.push(`Screen: \`${step.next_screen}\``);
    if (step.selector) bits.push(`Target: \`${step.selector}\``);
    if (step.input) bits.push(`Input: \`${step.input}\``);
    if (step.status === 'failed') bits.push(`**FAILED** — ${step.error ?? 'unknown error'}`);
    if (bits.length) lines.push(bits.join(' · '), '');
  }

  return lines.join('\n');
}

async function moduleIntro(module: string, runs: FlowRun[], flows: Flow[]): Promise<string> {
  const deterministic =
    `This page documents the **${module}** module of the RosiFit app, captured automatically ` +
    `from the live PWA (read-only) on ${runs[0]?.run_id.slice(0, 10) ?? 'unknown date'}. ` +
    `It covers ${runs.length} flow${runs.length === 1 ? '' : 's'}: ` +
    `${runs.map((r) => `\`${r.flow}\``).join(', ')}.`;

  if (!llmAvailable()) return deterministic;

  const outline = runs
    .map((r) => {
      const flow = flows.find((f) => f.module === r.module && f.flow === r.flow);
      const steps = r.steps
        .map((s) => `  - ${flow?.steps.find((x) => x.id === s.id)?.label ?? prettifyStepId(s.id)}`)
        .join('\n');
      return `Flow: ${r.flow}\n${flow?.description ? `Purpose: ${flow.description}\n` : ''}Steps:\n${steps}`;
    })
    .join('\n\n');

  const prose = await askLlm(
    `Write a 2-3 paragraph introduction for the documentation page of the "${module}" module ` +
      `in RosiFit, an attendance and follow-up app for a fitness academy: staff upload each ` +
      `session's register, the app tracks who is falling behind, and members are reached ` +
      `out to through stored message templates.\n\n` +
      `Here is exactly what the captured flows do:\n\n${outline}\n\n` +
      `Rules: describe only what the flows above actually show — do not invent features. ` +
      `Write for the academy owner, not a developer: plain language, no jargon, no bullet points, ` +
      `no headings. Do not use the words "seamless", "robust", "leverage" or "empower". ` +
      `Output only the prose.`,
    { system: 'You write clear, plain-language product documentation. You never invent functionality that was not described to you.', maxTokens: 800 },
  );

  return prose ? `${prose}\n\n${deterministic}` : deterministic;
}

export async function generateDocs(opts: { date?: string; all?: boolean } = {}): Promise<string[]> {
  const date = opts.date ?? latestRunDate();
  if (!date) {
    log.warn('No run history found — capture something first.');
    return [];
  }

  const runs = loadRunsForDate(date);
  if (!runs.length) {
    log.warn(`No run manifests under runs/${date}/`);
    return [];
  }

  const { flows } = loadFlows({ includeDisabled: true });

  const interesting = opts.all
    ? runs
    : runs.filter((r) => r.status === 'changed' || r.status === 'new');

  if (!interesting.length) {
    log.ok(`Nothing changed in runs/${date}/ — no docs to regenerate. (Use --all to force.)`);
    return [];
  }

  const byModule = new Map<string, FlowRun[]>();
  for (const r of interesting) {
    const list = byModule.get(r.module) ?? [];
    list.push(r);
    byModule.set(r.module, list);
  }

  const written: string[] = [];

  for (const [module, moduleRuns] of byModule) {
    moduleRuns.sort((a, b) => a.flow.localeCompare(b.flow));
    const intro = await moduleIntro(module, moduleRuns, flows);

    const title = module.charAt(0).toUpperCase() + module.slice(1);
    const body = [
      `# ${title}`,
      '',
      `> Auto-generated from capture run \`${date}\`. Edits to this file are overwritten —`,
      `> change the flow manifests in \`flows/\` instead.`,
      '',
      intro,
      '',
      ...moduleRuns.map((r) => renderFlowSection(r, flows.find((f) => f.module === r.module && f.flow === r.flow))),
      '',
      '---',
      '',
      `_Captured from the TEST environment. App commit: \`${moduleRuns[0]?.app_git_sha ?? 'unknown'}\`._`,
      '',
    ].join('\n');

    const file = path.join(paths.docs, `${module}.md`);
    writeText(file, body);
    written.push(relPosix(paths.root, file));
    log.ok(`docs → ${relPosix(paths.root, file)}`);
  }

  return written;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const dIdx = argv.indexOf('--date');
  generateDocs({ all: argv.includes('--all'), date: dIdx >= 0 ? argv[dIdx + 1] : undefined })
    .then((files) => log.banner(`Docs complete — ${files.length} file(s) written`))
    .catch((err) => {
      log.error((err as Error).message);
      process.exitCode = 1;
    });
}
