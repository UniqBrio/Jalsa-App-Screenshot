/**
 * Finding — and fencing — one app's source tree.
 *
 * Where the clone is, in order of precedence:
 *
 *   1. `--source <path>` on the command line (one app only)
 *   2. APP_REPO_PATH_<APP_ID> in the shell, e.g. APP_REPO_PATH_MY_APP — the CI hook,
 *      named per app so `--app all` can never point two apps at one tree
 *   3. APP_REPO_PATH in apps/<app-id>/.env — the existing change-detector setting
 *   4. `repoPath` in apps/<app-id>/app.config.json
 *
 * A bare APP_REPO_PATH in the SHELL is deliberately not read: with several apps
 * in one audit it would aim every one of them at the same repository.
 *
 * Fencing: when the folder is a git clone, its `origin` must be the
 * `source.repository` the profile names, or the check refuses to read it —
 * auditing one app against another app's checkout would produce a confident, wrong
 * report. Every file read is resolved through realpath and must stay inside the
 * root, so a symlink cannot walk the scan into another app's tree.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as dotenv from 'dotenv';
import { globToRegExp } from '../change-detector';
import type { AppProfile } from '../profile';

export interface SourceRoot {
  /** Absolute, realpath'd. */
  root: string;
  /** Which setting supplied it — reports say so, so a wrong path is traceable. */
  origin: string;
  /** "verified" — origin matches; "unverified" — not a git clone or no origin; never "mismatch" (that throws). */
  identity: 'verified' | 'unverified';
  notes: string[];
}

/** Thrown when the source is not where the profile says. The audit turns it into BLOCKED. */
export class SourceUnavailable extends Error {}

export function repoPathEnvName(appId: string): string {
  return `APP_REPO_PATH_${appId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function appEnvRepoPath(profile: AppProfile): string {
  const file = path.join(profile.dir, '.env');
  if (!fs.existsSync(file)) return '';
  return (dotenv.parse(fs.readFileSync(file)).APP_REPO_PATH ?? '').trim();
}

/** owner/name, lower-cased, from any GitHub remote URL form. */
export function repoSlug(remote: string): string | null {
  const m = remote.trim().match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

function gitOrigin(root: string): string | null {
  try {
    return execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function resolveSourceRoot(profile: AppProfile, cliPath?: string): SourceRoot {
  if (!profile.source) {
    throw new SourceUnavailable(
      `apps/${profile.id}/app.config.json has no "source" block, so there is no source to audit. ` +
        `Add one (see apps/_template/app.config.json) to enable coverage and page checks for this app.`,
    );
  }
  const shellName = repoPathEnvName(profile.id);
  const candidates: Array<[string, string]> = [
    [cliPath ?? '', '--source'],
    [(process.env[shellName] ?? '').trim(), shellName],
    [appEnvRepoPath(profile), `APP_REPO_PATH in apps/${profile.id}/.env`],
    [profile.repoPath, `repoPath in apps/${profile.id}/app.config.json`],
  ];
  const hit = candidates.find(([p]) => p);
  if (!hit) {
    throw new SourceUnavailable(
      `No local clone of ${profile.source.repository} is configured for "${profile.id}". Set one of: ` +
        `--source <path>, ${shellName}=<path> (shell/CI), APP_REPO_PATH in apps/${profile.id}/.env, ` +
        `or repoPath in apps/${profile.id}/app.config.json.`,
    );
  }
  const [raw, origin] = hit;
  const abs = path.resolve(raw);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new SourceUnavailable(`${origin} points at "${abs}", which is not a directory. Clone ${profile.source.repository} there, or fix the path.`);
  }
  const root = fs.realpathSync(abs);

  const notes: string[] = [];
  let identity: SourceRoot['identity'] = 'unverified';
  const remote = gitOrigin(root);
  const expected = profile.source.repository.toLowerCase();
  if (remote) {
    const slug = repoSlug(remote);
    if (slug && slug !== expected) {
      throw new SourceUnavailable(
        `${root} is a clone of ${slug}, but apps/${profile.id} audits ${profile.source.repository}. ` +
          `Refusing to read another app's source — point ${origin} at the right clone.`,
      );
    }
    if (slug) identity = 'verified';
    else notes.push(`origin "${remote}" is not a GitHub URL; repository identity not verified`);
  } else {
    notes.push('not a git clone (or no origin remote); repository identity not verified');
  }
  return { root, origin, identity, notes };
}

/** Longest leading part of a glob with no wildcard, as a directory to walk. */
function globBase(glob: string): string {
  const parts = glob.split('/');
  const fixed: string[] = [];
  for (const p of parts.slice(0, -1)) {
    if (/[*?[{]/.test(p)) break;
    fixed.push(p);
  }
  return fixed.join('/');
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '.expo', 'dist', 'build', 'coverage', 'playwright-report']);

/**
 * Repo-relative POSIX paths of every file matching `include` and not
 * `exclude`, sorted. Never leaves `root`.
 */
export function listSourceFiles(root: string, include: string[], exclude: string[]): string[] {
  const inc = include.map(globToRegExp);
  const exc = exclude.map(globToRegExp);
  const out = new Set<string>();
  const bases = [...new Set(include.map(globBase))];

  const walk = (relDir: string) => {
    const absDir = path.join(root, relDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(rel);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        if (!inc.some((r) => r.test(rel)) || exc.some((r) => r.test(rel))) continue;
        const real = safeRealpath(path.join(root, rel));
        if (!real || !(real === root || real.startsWith(root + path.sep))) continue;
        if (!fs.statSync(real).isFile()) continue;
        out.add(rel);
      }
    }
  };
  for (const b of bases) walk(b);
  return [...out].sort();
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Reads a repo-relative file, refusing anything that resolves outside `root`. */
export function readSourceFile(root: string, rel: string): string {
  const real = safeRealpath(path.join(root, rel));
  if (!real || !real.startsWith(root + path.sep)) throw new Error(`${rel}: resolves outside the app source root`);
  return fs.readFileSync(real, 'utf8');
}
