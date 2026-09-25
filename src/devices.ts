/**
 * Device profiles — which form factors a run captures.
 *
 * A profile is the whole truth about a device: viewport, pixel density, and
 * whether the browser presents itself as a phone (user agent, touch events,
 * `isMobile`). Resizing the window is NOT enough — an app that serves a mobile
 * layout to a touch-capable phone user agent would keep doing so at 1440px, and
 * the "Laptop" screenshots would be a lie.
 *
 * The device is also the top folder of every output, so two devices can never
 * overwrite each other and change detection compares like with like:
 *
 *   screenshots/{Device}/{module}/{flow}/{step}.{mode}.png
 *   runs/{date}/{Device}/{module}-{flow}.flow-run.json
 *   evidence/{run}/{Device}/{module}/{flow}/…
 *   fingerprint key  {Device}/{module}/{flow}/{step}
 */
import * as fs from 'fs';
import * as readline from 'readline';
import { devices as playwrightDevices } from '@playwright/test';
import { paths } from './env';
import { log } from './logger';

export interface DeviceProfile {
  /** Folder name and CLI name. Case-insensitively unique. */
  id: string;
  label: string;
  viewport: { width: number; height: number };
  /** deviceScaleFactor. The C1 evidence gate checks every frame against it. */
  dpr: number;
  /** A Playwright device descriptor to borrow the user agent from, or null for a plain desktop browser. */
  emulate: string | null;
  isMobile: boolean;
  hasTouch: boolean;
}

export interface DevicesConfig {
  devices: DeviceProfile[];
  /** Used when nobody chose and nobody can be asked. */
  default: string[];
}

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export function parseDevicesConfig(raw: unknown, source = 'devices config'): DevicesConfig {
  const obj = raw as { devices?: unknown; default?: unknown };
  if (typeof raw !== 'object' || raw === null) throw new Error(`${source}: must be a JSON object`);
  const errs: string[] = [];
  const seen = new Set<string>();
  const list: DeviceProfile[] = [];

  if (!Array.isArray(obj.devices) || !obj.devices.length) errs.push('devices: a non-empty array is required');
  else obj.devices.forEach((d: any, i: number) => {
    const where = `devices[${i}]`;
    if (typeof d?.id !== 'string' || !ID.test(d.id)) { errs.push(`${where}.id: letters, digits, - and _ only, starting with a letter (it becomes a folder name)`); return; }
    // Windows and macOS treat Mobile/ and mobile/ as one folder; refuse the ambiguity everywhere.
    if (seen.has(d.id.toLowerCase())) errs.push(`${where}.id: duplicate "${d.id}" (ids are compared case-insensitively)`);
    seen.add(d.id.toLowerCase());
    const vp = d.viewport;
    if (!vp || !Number.isInteger(vp.width) || !Number.isInteger(vp.height) || vp.width < 200 || vp.height < 200 || vp.width > 4000 || vp.height > 4000) {
      errs.push(`${where}.viewport: {width, height} integers between 200 and 4000`);
    }
    if (typeof d.dpr !== 'number' || !(d.dpr > 0) || d.dpr > 4) errs.push(`${where}.dpr: a number greater than 0 and at most 4`);
    if (d.emulate !== null && d.emulate !== undefined && typeof d.emulate !== 'string') errs.push(`${where}.emulate: a Playwright device name or null`);
    if (typeof d.emulate === 'string' && !(d.emulate in playwrightDevices)) errs.push(`${where}.emulate: "${d.emulate}" is not a Playwright device descriptor`);
    if (typeof d.isMobile !== 'boolean' || typeof d.hasTouch !== 'boolean') errs.push(`${where}: isMobile and hasTouch are required booleans`);
    if (d.label !== undefined && typeof d.label !== 'string') errs.push(`${where}.label: string`);
    list.push({
      id: d.id,
      label: typeof d.label === 'string' && d.label ? d.label : d.id,
      viewport: { width: vp?.width, height: vp?.height },
      dpr: d.dpr,
      emulate: typeof d.emulate === 'string' ? d.emulate : null,
      isMobile: d.isMobile === true,
      hasTouch: d.hasTouch === true,
    });
  });

  const def = obj.default;
  if (!Array.isArray(def) || !def.length || !def.every((x) => typeof x === 'string')) errs.push('default: a non-empty array of device ids');
  else for (const id of def) if (!list.some((d) => d.id.toLowerCase() === id.toLowerCase())) errs.push(`default: "${id}" is not one of the devices`);

  if (errs.length) throw new Error(`${source} is invalid:\n  ${errs.join('\n  ')}`);
  return { devices: list, default: (def as string[]).map((id) => list.find((d) => d.id.toLowerCase() === id.toLowerCase())!.id) };
}

export function loadDevicesConfig(file = paths.devices): DevicesConfig {
  if (!fs.existsSync(file)) throw new Error(`Device config not found at ${file} — copy config/devices.json from the repo.`);
  return parseDevicesConfig(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}

/** Resolves a name or 1-based menu number to a profile. Case-insensitive. */
export function findDevice(config: DevicesConfig, token: string): DeviceProfile | null {
  const t = token.trim();
  if (!t) return null;
  const byName = config.devices.find((d) => d.id.toLowerCase() === t.toLowerCase());
  if (byName) return byName;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= config.devices.length ? config.devices[n - 1] : null;
}

export function describeDevice(d: DeviceProfile): string {
  const kind = d.isMobile ? (d.hasTouch ? 'touch' : 'mobile UA') : 'desktop browser, no touch';
  return `${d.viewport.width} x ${d.viewport.height} @${d.dpr}x  ${d.label}${d.label === d.id ? '' : ''} (${kind})`;
}

export interface DeviceSelectionInput {
  /** --device values, repeatable. */
  requested: string[];
  /** --all-devices */
  all: boolean;
  /** DEVICES env var, comma-separated. Used only when no flag was given. */
  env?: string;
}

/**
 * Which devices this run captures, without asking:
 *   --all-devices  >  --device  >  DEVICES=  >  (caller prompts, or falls back to config default)
 * Returns null when nobody has said anything — the caller decides whether to ask.
 */
export function selectDevices(config: DevicesConfig, input: DeviceSelectionInput): DeviceProfile[] | null {
  if (input.all) return config.devices.slice();
  const tokens = input.requested.length
    ? input.requested
    : (input.env ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!tokens.length) return null;
  if (tokens.length === 1 && tokens[0].toLowerCase() === 'all') return config.devices.slice();
  const out: DeviceProfile[] = [];
  const unknown: string[] = [];
  for (const t of tokens) {
    const d = findDevice(config, t);
    if (!d) unknown.push(t);
    else if (!out.some((x) => x.id === d.id)) out.push(d);
  }
  if (unknown.length) {
    throw new Error(
      `Unknown device ${unknown.map((u) => `"${u}"`).join(', ')}. ` +
        `Known devices: ${config.devices.map((d) => d.id).join(', ')}.`,
    );
  }
  return out;
}

export function defaultDevices(config: DevicesConfig): DeviceProfile[] {
  return config.default.map((id) => config.devices.find((d) => d.id === id)!);
}

/** Parses one answer to the prompt. Returns null when the line is not understood. */
export function parseDeviceAnswer(config: DevicesConfig, answer: string): DeviceProfile[] | null {
  const line = answer.trim();
  if (!line) return defaultDevices(config);
  if (line.toLowerCase() === 'all') return config.devices.slice();
  const tokens = line.split(/[,\s]+/).filter(Boolean);
  const out: DeviceProfile[] = [];
  for (const t of tokens) {
    const d = findDevice(config, t);
    if (!d) return null;
    if (!out.some((x) => x.id === d.id)) out.push(d);
  }
  return out.length ? out : null;
}

export function deviceMenu(config: DevicesConfig): string[] {
  return config.devices.map((d, i) => `  ${i + 1}) ${d.id.padEnd(10)} ${describeDevice(d)}`);
}

/**
 * Asks which device types to capture. Only called on an interactive terminal —
 * a scheduled run never blocks on a question nobody is there to answer.
 */
export async function promptForDevices(config: DevicesConfig): Promise<DeviceProfile[]> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));
  try {
    console.log('\nWhich device types should this run capture?\n');
    for (const line of deviceMenu(config)) console.log(line);
    console.log('');
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = await ask(
        `Numbers or names, comma-separated · "all" · Enter for [${config.default.join(', ')}]: `,
      );
      const chosen = parseDeviceAnswer(config, answer);
      if (chosen) return chosen;
      console.log(`  Not understood. Use e.g. "1,3" or "Mobile,Laptop", or "all".`);
    }
    throw new Error('No device selected after three attempts — pass --device or --all-devices instead.');
  } finally {
    rl.close();
  }
}

/** True when there is a human at the other end to answer a prompt. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * The devices for this run: flags, else the environment, else a prompt when a
 * human is present, else the configured default (announced, never silent).
 */
export async function resolveDevices(config: DevicesConfig, input: DeviceSelectionInput): Promise<DeviceProfile[]> {
  const chosen = selectDevices(config, input);
  if (chosen) return chosen;
  if (isInteractive()) return promptForDevices(config);
  const fallback = defaultDevices(config);
  log.warn(
    `No device given and no terminal to ask — capturing ${fallback.map((d) => d.id).join(', ')} ` +
      `(config/devices.json "default"). Pass --device or DEVICES= to choose.`,
  );
  return fallback;
}

/** Devices a flow may run on: its own `devices:` list, intersected with the run's selection. */
export function devicesForFlow(selected: DeviceProfile[], flowDevices: string[] | undefined): DeviceProfile[] {
  if (!flowDevices?.length) return selected;
  const want = new Set(flowDevices.map((d) => d.toLowerCase()));
  return selected.filter((d) => want.has(d.id.toLowerCase()));
}
