/**
 * Documentation generation — BUILD_PLAN §8.
 *
 * Reads the run manifests for modules flagged `changed` (or `new`) and produces
 * apps/<app-id>/docs/<Device>/<module>.md: a screenshot-illustrated
 * walkthrough of each flow. The intro is written from the profile's appName
 * and appDescription — nothing about any particular app lives here.
 *
 * Cost discipline: this is NOT part of the daily capture. Run it on-change or
 * weekly. One LLM call per changed MODULE, not per step. Without an API key it
 * still produces a complete deterministic doc from the manifests — the LLM only
 * adds the prose intro.
 *
 * Usage:
 *   npm run docs -- --app <id>                        # latest run's changed modules
 *   npm run docs -- --app <id> --all                  # every module in that run
 *   npm run docs -- --app <id> --run 2026-08-10T01-30-00Z
 *   npm run docs -- --app <id> --date 2026-08-10      # latest run that day
 */
import * as fs from 'fs';
import * as path from 'path';
import { env, paths, profile, appHost, redactSecrets } from './env';
import { readJson, writeText, listFiles, relPosix } from './fsx';
import { log } from './logger';
import { askLlm, llmAvailable } from './llm';
import { loadFlows } from './flow-loader';
import { pickRun } from './prune-runs';
import type { FlowRun, Flow } from './types';

function loadRuns(runId: string): FlowRun[] {
  const runDir = path.join(paths.runs, runId);
  if (!fs.existsSync(runDir)) return [];
  // runs/<app>/<run-id>/<Device>/<module>-<flow>.flow-run.json
  return fs
    .readdirSync(runDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .flatMap((e) => listFiles(path.join(runDir, e.name), ['.flow-run.json']))
    .map((f) => readJson<FlowRun>(f, null as unknown as FlowRun))
    .filter(Boolean);
}

function prettifyStepId(id: string): string {
  return id.replace(/^\d+-/, '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Copies a run's screenshot next to the doc (img/<module>/<flow>/<file>) and
 * returns the Markdown path to it. Runs are pruned after the retention period;
 * a doc must not lose its pictures when its run does.
 */
function imgPath(docDir: string, run: FlowRun, screenshotRel: string): string {
  const rel = path.posix.join('img', run.module, run.flow, path.basename(screenshotRel));
  const src = path.join(paths.root, screenshotRel);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.join(docDir, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(src, path.join(docDir, rel));
  }
  return rel;
}

function renderFlowSection(run: FlowRun, flow: Flow | undefined, docDir: string): string {
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
      lines.push(`![${heading}](${imgPath(docDir, run, step.screenshot_path)})`);
      lines.push('');
    }
    // Manifests are redacted when written; redacting again here costs nothing
    // and covers a manifest written before a credential was added to .env.
    const bits: string[] = [];
    if (step.next_screen) bits.push(`Screen: \`${step.next_screen}\``);
    if (step.selector) bits.push(`Target: \`${redactSecrets(step.selector)}\``);
    if (step.input) bits.push(`Input: \`${redactSecrets(step.input)}\``);
    if (step.status === 'failed') bits.push(`**FAILED** — ${redactSecrets(step.error ?? 'unknown error')}`);
    if (bits.length) lines.push(bits.join(' · '), '');
  }

  return lines.join('\n');
}

async function moduleIntro(module: string, runs: FlowRun[], flows: Flow[]): Promise<string> {
  const deterministic =
    `This page documents the **${module}** module of ${profile.appName}, captured automatically ` +
    `from ${appHost()} on ${runs[0]?.run_id.slice(0, 10) ?? 'unknown date'}. ` +
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
      `in ${profile.appName}. About the app: ${profile.appDescription}\n\n` +
      `Here is exactly what the captured flows do:\n\n${outline}\n\n` +
      `Rules: describe only what the flows above actually show — do not invent features. ` +
      `Write for ${profile.docsAudience}, not a developer: plain language, no jargon, no bullet points, ` +
      `no headings. Do not use the words "seamless", "robust", "leverage" or "empower". ` +
      `Output only the prose.`,
    { system: 'You write clear, plain-language product documentation. You never invent functionality that was not described to you.', maxTokens: 800 },
  );

  return prose ? `${prose}\n\n${deterministic}` : deterministic;
}

export async function generateDocs(opts: { run?: string; date?: string; all?: boolean } = {}): Promise<string[]> {
  const runId = pickRun({ run: opts.run, date: opts.date });
  if (!runId) {
    log.warn(`No matching run under runs/${env.appId}/ — capture something first.`);
    return [];
  }

  const runs = loadRuns(runId);
  if (!runs.length) {
    log.warn(`No run manifests under runs/${env.appId}/${runId}/`);
    return [];
  }

  const { flows } = loadFlows({ includeDisabled: true });

  const interesting = opts.all
    ? runs
    : runs.filter((r) => r.status === 'changed' || r.status === 'new');

  if (!interesting.length) {
    log.ok(`Nothing changed in run ${runId} — no docs to regenerate. (Use --all to force.)`);
    return [];
  }

  // One page per device and module: apps/<app>/docs/<Device>/<module>.md,
  // illustrated with that device's shots.
  const byPage = new Map<string, FlowRun[]>();
  for (const r of interesting) {
    const key = `${r.device}/${r.module}`;
    const list = byPage.get(key) ?? [];
    list.push(r);
    byPage.set(key, list);
  }

  const written: string[] = [];

  for (const [key, moduleRuns] of byPage) {
    const [device, module] = key.split('/');
    const file = path.join(paths.docs, device, `${module}.md`);
    const docDir = path.dirname(file);
    moduleRuns.sort((a, b) => a.flow.localeCompare(b.flow));
    const intro = await moduleIntro(module, moduleRuns, flows);

    const title = module.charAt(0).toUpperCase() + module.slice(1);
    const body = [
      `# ${title}`,
      '',
      `> Auto-generated from capture run \`${runId}\`. Edits to this file are overwritten —`,
      `> change the flow manifests in \`apps/${env.appId}/flows/\` instead.`,
      '',
      intro,
      '',
      ...moduleRuns.map((r) => renderFlowSection(r, flows.find((f) => f.module === r.module && f.flow === r.flow), docDir)),
      '',
      '---',
      '',
      `_Captured from ${appHost()} on ${device}. App commit: \`${moduleRuns[0]?.app_git_sha ?? 'unknown'}\`._`,
      '',
    ].join('\n');

    writeText(file, body);
    written.push(relPosix(paths.root, file));
    log.ok(`docs → ${relPosix(paths.root, file)}`);
  }

  return written;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  generateDocs({ all: argv.includes('--all'), run: val('--run'), date: val('--date') })
    .then((files) => log.banner(`Docs complete — ${files.length} file(s) written`))
    .catch((err) => {
      log.error((err as Error).message);
      process.exitCode = 1;
    });
}
