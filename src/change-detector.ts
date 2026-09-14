/**
 * Change detection — BUILD_PLAN §3.
 *
 * Layer 1 (primary, pre-execution): git-diff filter.
 *   Diff the app repo between the last successful run's sha and HEAD, scoped to
 *   each module's `source_paths`. No matching diff -> skip the flow entirely,
 *   zero browser cost. Changes under `_global` invalidate every module.
 *
 * Layer 2 (secondary, during execution): DOM fingerprint — lives in
 *   fingerprint.ts and runs per screenshot step, classifying what actually moved.
 *
 * Repo availability: APP_REPO_PATH is optional. If it is unset, missing, or not
 * a git repo, layer 1 degrades gracefully — every flow runs and detection falls
 * back to layer 2 alone. That is the CI story too, until the app repo is
 * reachable from wherever this executes.
 */
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { env, paths } from './env';
import { readJson, writeJson } from './fsx';
import { log } from './logger';
import type { Flow, RoutesMap, LastRunState } from './types';

export interface RepoState {
  available: boolean;
  path: string | null;
  headSha: string | null;
  reason: string;
}

export interface FlowDecision {
  run: boolean;
  reason: string;
}

const GLOBAL_KEY = '_global';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

export function inspectAppRepo(): RepoState {
  const repoPath = env.appRepo.path;
  if (!repoPath) {
    return { available: false, path: null, headSha: null,
      reason: 'APP_REPO_PATH is not set — git-diff skip filter disabled, every flow will run.' };
  }
  if (!fs.existsSync(repoPath)) {
    return { available: false, path: repoPath, headSha: null,
      reason: `APP_REPO_PATH "${repoPath}" does not exist — git-diff skip filter disabled.` };
  }
  try {
    const head = git(repoPath, ['rev-parse', 'HEAD']);
    return { available: true, path: repoPath, headSha: head,
      reason: `App repo at HEAD ${head.slice(0, 7)}.` };
  } catch (err) {
    return { available: false, path: repoPath, headSha: null,
      reason: `"${repoPath}" is not a usable git repo (${(err as Error).message.split('\n')[0]}) — skip filter disabled.` };
  }
}

/** Files changed between two shas. `null` sinceSha => treat everything as changed. */
export function changedFiles(repo: RepoState, sinceSha: string | null): string[] | null {
  if (!repo.available || !repo.path || !sinceSha) return null;
  try {
    // Verify the old sha still exists (force-push / shallow clone / pruned history).
    git(repo.path, ['cat-file', '-e', `${sinceSha}^{commit}`]);
  } catch {
    log.warn(`Last successful sha ${sinceSha.slice(0, 7)} is not in the app repo history — running all flows.`);
    return null;
  }
  try {
    const out = git(repo.path, ['diff', '--name-only', `${sinceSha}..HEAD`]);
    return out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  } catch (err) {
    log.warn(`git diff failed (${(err as Error).message.split('\n')[0]}) — running all flows.`);
    return null;
  }
}

/**
 * Minimal glob -> RegExp. Paths are POSIX-style (git emits forward slashes even
 * on Windows).
 *
 *   `*`    one path segment, no slashes    `app/index*`       -> app/index.tsx
 *   `**`   trailing: everything below      `components/ui/**` -> components/ui/a/b.tsx
 *   `**` + `/`  zero or more directory levels
 *   `?`    one character, not a slash
 *
 * Expo Router group folders — `app/(tabs)/...` — contain literal parentheses
 * that must be escaped, which is why this is a character-by-character walk
 * rather than a chain of regex replaces.
 */
export function globToRegExp(glob: string): RegExp {
  const SPECIAL = '.+^${}()|[]\\';
  let re = '';

  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];

    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++; // consume the second star
        if (glob[i + 1] === '/') {
          i++;                 // "**/" — zero or more directory levels
          re += '(?:[^/]*/)*';
        } else {
          re += '.*';          // trailing "**" — everything below this point
        }
      } else {
        re += '[^/]*';         // a single star stays inside one path segment
      }
      continue;
    }

    if (c === '?') { re += '[^/]'; continue; }
    re += SPECIAL.includes(c) ? `\\${c}` : c;
  }

  return new RegExp(`^${re}$`);
}

export function matchesAny(file: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(file));
}

export class ChangeDetector {
  private routesMap: RoutesMap;
  private diff: string[] | null;
  private globalHit: boolean;

  constructor(
    private repo: RepoState,
    private lastRun: LastRunState,
    private force = false,
  ) {
    this.routesMap = readJson<RoutesMap>(paths.routesMap, {} as RoutesMap);
    this.diff = changedFiles(repo, lastRun.last_successful_app_git_sha);
    const globalPaths = this.routesMap[GLOBAL_KEY]?.source_paths ?? [];
    this.globalHit = Boolean(this.diff && this.diff.some((f) => matchesAny(f, globalPaths)));
    if (this.globalHit) {
      log.warn('Global/shared source paths changed — the skip filter is bypassed for all modules this run.');
    }
  }

  get diffSummary(): string {
    if (this.force) return 'forced: --force flag';
    if (!this.repo.available) return this.repo.reason;
    if (this.diff === null) return 'no usable baseline sha — first run or history rewritten';
    if (this.diff.length === 0) return `no files changed since ${this.lastRun.last_successful_app_git_sha?.slice(0, 7)}`;
    return `${this.diff.length} file(s) changed since ${this.lastRun.last_successful_app_git_sha?.slice(0, 7)}`;
  }

  decide(flow: Flow): FlowDecision {
    if (this.force) return { run: true, reason: 'forced (--force)' };
    if (this.diff === null) {
      return { run: true, reason: this.repo.available
        ? 'no baseline sha to diff against — running to establish one'
        : 'app repo unavailable — DOM-fingerprint detection only' };
    }
    if (this.globalHit) return { run: true, reason: 'shared/global source paths changed' };

    const entry = this.routesMap[flow.module];
    if (!entry) {
      return { run: true, reason: `module "${flow.module}" has no routes.map.json entry — running to be safe` };
    }
    const hits = this.diff.filter((f) => matchesAny(f, entry.source_paths ?? []));
    if (hits.length === 0) {
      return { run: false, reason: `no app-repo changes under ${flow.module} source_paths` };
    }
    const preview = hits.slice(0, 3).join(', ');
    return { run: true, reason: `${hits.length} changed file(s): ${preview}${hits.length > 3 ? ', …' : ''}` };
  }

  /** Never-run flows must execute regardless of diff, to establish a baseline. */
  hasNeverRun(flow: Flow): boolean {
    return !this.lastRun.per_flow_sha[`${flow.module}/${flow.flow}`];
  }
}

export function loadLastRun(): LastRunState {
  return readJson<LastRunState>(paths.lastRun, {
    last_successful_run_id: null,
    last_successful_app_git_sha: null,
    per_flow_sha: {},
  });
}

export function saveLastRun(state: LastRunState): void {
  writeJson(paths.lastRun, state);
}
