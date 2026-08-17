/**
 * Cerebro — the team memory bank, from the main process's side.
 *
 * Everything here is a seam over `bin/cerebro`, the single-file CLI that lives
 * inside the bank's own repository. The first design decision was to keep it
 * that way: the CLI is the contract the whole team shares (agents call it from
 * hooks, CI calls it on every PR), and a second implementation of its logic in
 * TypeScript would drift from the first the week someone changed the bank. The
 * CLI also *updates itself* — `sync` fast-forwards the clone it ships in — so
 * shelling out means Artemis always speaks the bank's current dialect without
 * shipping a copy of it.
 *
 * The second decision is that **main owns the location**. The renderer never
 * names a path, a binary, or a remote; this module resolves the repo at a fixed
 * per-machine spot (`~/Documents/cerebro`, the team's documented convention,
 * overridable for development with `ARTEMIS_CEREBRO_ROOT`) and refuses to run
 * anything that is not `bin/cerebro` inside it. That is the same rule the
 * terminal keeps ("main chooses the shell") and `sharedConfig` keeps ("the
 * renderer cannot ask this to lstat a path of its own choosing"), applied to a
 * subprocess that can write.
 *
 * Spawns here are user-clicked, settings-pane rare — never keystroke-adjacent —
 * so the `repo.ts` objection to shelling out (a process per keystroke) does not
 * apply; what does apply is its PATH warning, which `adoptLoginShellPath()` has
 * already answered by the time any of this runs (`git` is found the same way
 * the updater finds `gh`).
 *
 * Parsing is split from spawning, `shellPath.ts`-style: the `parse*` functions
 * are pure, take the CLI's `--json` output as text, and are the unit under
 * test in `cerebro.test.ts`. They rebuild rather than pass through — only the
 * fields the protocol names cross into a response, so a future CLI field can
 * never leak into the renderer unreviewed.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type {
  CerebroCheck,
  CerebroDraftRequest,
  CerebroActionResponse,
  CerebroMemory,
  CerebroPreflight,
  CerebroProfileState,
  CerebroRetireRequest,
  CerebroStatus,
} from '@rx-artemis/protocol';

import { WorkspaceError } from './errors.js';
import { createLogger } from './log.js';

const execFileAsync = promisify(execFile);
const log = createLogger('cerebro');

/** The team's bank. One repo, one URL, documented in the bank's own README. */
const CEREBRO_REPO_URL = 'https://github.com/Rx-Ventures/cerebro.git';

/** Output ceiling for a CLI call — a full `list --json` is ~kilobytes. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Where the bank lives on this machine. */
export function cerebroRoot(): string {
  const override = process.env['ARTEMIS_CEREBRO_ROOT'];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), 'Documents', 'cerebro');
}

function cerebroCli(root: string): string {
  return join(root, 'bin', 'cerebro');
}

/**
 * Run `bin/cerebro <args>` and hand back stdout.
 *
 * A non-zero exit becomes a {@link WorkspaceError} carrying the CLI's own
 * words: the bank's validator writes messages meant for people ("possible
 * secret (GitHub token) — memories must never contain credentials"), and a
 * pane that replaced them with "command failed" would be discarding the only
 * part the user needs.
 */
async function runCerebro(root: string, args: readonly string[], timeoutMs: number): Promise<string> {
  const cli = cerebroCli(root);
  try {
    const { stdout } = await execFileAsync(cli, [...args], {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return stdout;
  } catch (error) {
    throw toCerebroError(error, args[0] ?? 'cerebro');
  }
}

function toCerebroError(error: unknown, verb: string): WorkspaceError {
  const raw = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const said = [raw.stderr, raw.stdout]
    .filter((chunk): chunk is string => typeof chunk === 'string')
    .join('\n')
    .trim();
  if (said.length > 0) {
    // The tail, not the head: the CLI states its conclusion last.
    const lines = said.split('\n').filter((line) => line.trim().length > 0);
    return new WorkspaceError(`cerebro ${verb} failed: ${lines.slice(-3).join(' · ')}`);
  }
  const message = typeof raw.message === 'string' ? raw.message : 'the CLI did not respond';
  return new WorkspaceError(`cerebro ${verb} failed: ${message}`);
}

/* -------------------------------------------------------------------------- */
/* Pure parsing — the unit under test                                         */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkspaceError(`cerebro returned unexpected JSON: ${context} is not an object`);
  }
  return value as Record<string, unknown>;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** `status --json` → the protocol's {@link CerebroStatus}. Rebuilds; never passes through. */
export function parseCerebroStatus(text: string, repoPath: string): CerebroStatus {
  const data = asRecord(parseJson(text), 'status');
  const bank = asRecord(data['bank'] ?? {}, 'status.bank');
  const rawProfiles = Array.isArray(data['profiles']) ? data['profiles'] : [];

  const profiles: CerebroProfileState[] = [];
  let projects = 0;
  for (const entry of rawProfiles) {
    const profile = asRecord(entry, 'status.profiles[]');
    profiles.push({
      name: stringOr(profile['name'], 'unknown'),
      label: stringOr(profile['label'], ''),
      enabled: profile['enabled'] === true,
      hook: profile['hook'] === true,
    });
    const installed = profile['projects'];
    if (Array.isArray(installed)) projects += installed.length;
  }

  return {
    installed: true,
    repoPath,
    remote: stringOrNull(data['remote']),
    source: stringOrNull(data['source']),
    memories: numberOr(bank['memories'], 0),
    validationErrors: numberOr(bank['errors'], 0),
    projects,
    profiles,
  };
}

/** `list --json` → the protocol's {@link CerebroMemory} list, unparseable entries dropped. */
export function parseCerebroList(text: string): CerebroMemory[] {
  const data = parseJson(text);
  if (!Array.isArray(data)) {
    throw new WorkspaceError('cerebro returned unexpected JSON: list is not an array');
  }
  const memories: CerebroMemory[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    // A file the bank itself could not parse comes back name-less; the pane
    // has nothing to render for it, and `status` already counts it as an error.
    if (typeof item['name'] !== 'string') continue;
    const metadata = asRecord(item['metadata'] ?? {}, 'list[].metadata');
    memories.push({
      name: item['name'],
      type: stringOr(metadata['type'], 'unknown'),
      description: stringOr(item['description'], ''),
      body: stringOr(item['body'], ''),
      added: stringOrNull(metadata['added']),
      author: stringOrNull(metadata['author']),
    });
  }
  return memories;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WorkspaceError('cerebro returned output that is not JSON');
  }
}

/* -------------------------------------------------------------------------- */
/* The six operations                                                         */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Preflight — before assuming any of this can run                            */
/* -------------------------------------------------------------------------- */

/**
 * `doctor --json` → the protocol's {@link CerebroPreflight}.
 *
 * Rebuilds each check rather than trusting the CLI's shape, and drops an entry
 * whose `state` is not one the protocol names — a future CLI state must not
 * arrive in the renderer as an unhandled string.
 */
export function parseCerebroDoctor(text: string): CerebroPreflight {
  const data = asRecord(parseJson(text), 'doctor');
  const raw = Array.isArray(data['checks']) ? data['checks'] : [];
  const checks: CerebroCheck[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const state = item['state'];
    if (state !== 'ok' && state !== 'warn' && state !== 'fail') continue;
    checks.push({
      id: stringOr(item['id'], 'unknown'),
      label: stringOr(item['label'], 'Check'),
      state,
      detail: stringOr(item['detail'], ''),
      remedy: stringOrNull(item['remedy']),
    });
  }
  return { ready: data['ready'] === true, checks };
}

/** Probe one binary: absent, present-but-broken, or a version string. */
async function probeTool(binary: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, [...args], { timeout: 10_000, encoding: 'utf8' });
    return stdout.trim().split('\n')[0] ?? '';
  } catch {
    return null;
  }
}

function check(
  id: string,
  label: string,
  state: CerebroCheck['state'],
  detail: string,
  remedy: string | null = null,
): CerebroCheck {
  return { id, label, state, detail, remedy };
}

/**
 * The pre-clone probes, run by Artemis itself.
 *
 * Deliberately a *second* implementation of part of `cerebro doctor`, and only
 * of the part that has to work when the CLI is not on disk yet. The moment a
 * clone exists, {@link readCerebroPreflight} defers to the CLI instead — one
 * source of truth wherever there can be one, and this fallback covers the gap
 * where there cannot.
 */
async function probeMachine(root: string): Promise<CerebroCheck[]> {
  const checks: CerebroCheck[] = [];

  const gitVersion = await probeTool('git', ['--version']);
  checks.push(
    gitVersion === null
      ? check('git', 'git', 'fail', 'not found on PATH', 'macOS: xcode-select --install')
      : check('git', 'git', 'ok', gitVersion),
  );

  if (gitVersion !== null) {
    const name = await probeTool('git', ['config', '--get', 'user.name']);
    const email = await probeTool('git', ['config', '--get', 'user.email']);
    checks.push(
      name === null || email === null || name === '' || email === ''
        ? check(
            'git-identity',
            'git identity',
            'fail',
            'user.name or user.email is unset — commits would be refused',
            'git config --global user.name "Your Name" && git config --global user.email "you@example.com"',
          )
        : check('git-identity', 'git identity', 'ok', `${name} <${email}>`),
    );
  }

  const python = await probeTool('python3', ['--version']);
  checks.push(
    python === null
      ? check('python', 'Python 3.8+', 'fail', 'python3 not found on PATH', 'macOS: xcode-select --install')
      : check('python', 'Python 3.8+', 'ok', python),
  );

  const gh = await probeTool('gh', ['--version']);
  checks.push(
    gh === null
      ? check(
          'gh',
          'GitHub CLI (optional)',
          'warn',
          'not found — memory changes push a branch for you to open a PR from',
          'brew install gh',
        )
      : check('gh', 'GitHub CLI (optional)', 'ok', gh),
  );

  checks.push(
    existsSync(root)
      ? check(
          'repo',
          'Bank checkout',
          'fail',
          `${root} exists but is not the Cerebro repo`,
          'Move it aside, or set ARTEMIS_CEREBRO_ROOT to the real clone',
        )
      : check('repo', 'Bank checkout', 'warn', `not cloned yet — will be created at ${root}`, null),
  );

  // The real gate on a private repository: can this machine read it at all?
  if (gitVersion !== null) {
    try {
      await execFileAsync('git', ['ls-remote', '--exit-code', CEREBRO_REPO_URL, 'HEAD'], {
        timeout: 30_000,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      checks.push(check('remote', 'Bank access', 'ok', `${CEREBRO_REPO_URL} reachable`));
    } catch (error) {
      const said = (error as { stderr?: unknown }).stderr;
      const detail =
        typeof said === 'string' && said.trim().length > 0
          ? (said.trim().split('\n').pop() ?? '')
          : `cannot read ${CEREBRO_REPO_URL}`;
      checks.push(
        check(
          'remote',
          'Bank access',
          'fail',
          detail,
          'Sign in to GitHub (gh auth login, or add an SSH key) and ask for access to Rx-Ventures/cerebro — it is private',
        ),
      );
    }
  }

  return checks;
}

/**
 * What this machine is missing, with the fix for each.
 *
 * Delegates to `cerebro doctor --json` once the bank is cloned — the CLI knows
 * things Artemis does not, such as whether the checkout's own remote differs
 * from the canonical one — and falls back to Artemis's own probes before that.
 */
export async function readCerebroPreflight(): Promise<CerebroPreflight> {
  const root = cerebroRoot();
  if (existsSync(cerebroCli(root))) {
    try {
      return parseCerebroDoctor(await runCerebro(root, ['doctor', '--json'], 60_000));
    } catch (error) {
      // `doctor` exits non-zero precisely when something failed, and execFile
      // turns that into a throw with the JSON still on stdout. A real parse
      // failure falls through to the probes below.
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout === 'string' && stdout.trim().startsWith('{')) {
        try {
          return parseCerebroDoctor(stdout);
        } catch {
          log.warn('cerebro doctor returned output that could not be parsed');
        }
      } else {
        log.warn('cerebro doctor could not be run; falling back to Artemis probes', error);
      }
    }
  }
  const checks = await probeMachine(root);
  return { ready: !checks.some((entry) => entry.state === 'fail'), checks };
}

/**
 * Is the bank on this machine at all?
 *
 * The same `existsSync` {@link readCerebroStatus} opens with, exposed on its
 * own because one caller needs the answer and cannot afford the rest.
 * `readCerebroStatus` spawns `bin/cerebro status` — tens of milliseconds and a
 * subprocess — which is right for a settings pane the user just opened and
 * wrong for the path of every run, where the Agents pane's built-in Cerebro
 * prompt has to be gated on the bank existing.
 *
 * Deliberately answers the weaker question. "The CLI is there" is not "the
 * profiles are enabled", "the preflight passes" or "the bank has memories", and
 * a prompt that mentions a tool the user has cloned but not finished wiring up
 * is a far cheaper error than a subprocess per run.
 */
export function isCerebroInstalled(): boolean {
  return existsSync(cerebroCli(cerebroRoot()));
}

/* -------------------------------------------------------------------------- */
/* Keeping the bank turning                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How long a sync stands for. The CLI throttles the expensive half itself (a
 * lock directory, a fifteen-minute fetch stamp, and a no-op when `HEAD` has not
 * moved), so this exists only to keep a burst of runs from paying the process
 * spawn several times over.
 */
const SYNC_THROTTLE_MS = 60_000;

let lastSyncAt = 0;
let syncInFlight = false;

/**
 * Run the bank's own sync cycle, in the background, at most once a minute.
 *
 * ## Why the main process does this
 *
 * `cerebro enable` installs a `SessionStart` hook into each profile's
 * `settings.json`, and on a stock Claude Code that is the whole mechanism: the
 * hook promotes queued drafts, fast-forwards from GitHub, and re-installs the
 * bank into every project's memory. Under Artemis that hook has never once
 * fired. Every query runs with `settingSources: []` — the deliberate isolation
 * described in the Claude adapter, which keeps a third-party desktop app from
 * silently adopting the user's hooks, MCP servers and permission rules — and a
 * hook Artemis never loads is a hook that never runs. The bank went stale in
 * exactly the way it was designed not to, while `cerebro status` went on
 * reporting `enabled + sync hook`, because the file it checks did contain one.
 *
 * Opening `settingSources` to fix this would trade a stale bank for the whole
 * class of problem that setting exists to prevent, and it would import every
 * *other* hook in the file to fix the one Artemis put there. So the sync moves
 * to the side of the boundary that provisioned it. Artemis clones the bank,
 * writes the hook and shows the pane; running the cycle is its own housekeeping,
 * not an instruction for the model to carry.
 *
 * ## Why a run is the trigger
 *
 * A run start is Artemis's nearest thing to the `SessionStart` the bank was
 * written against, and it is the moment the freshness actually matters: what a
 * sync does is promote what the last session drafted and pull what teammates
 * landed, and both are only interesting to a session that is about to begin.
 *
 * Fire-and-forget, and silent unless it fails. A run must never wait on the
 * memory bank, and must never fail because of it.
 */
export function syncCerebroInBackground(): void {
  if (syncInFlight) return;
  if (!isCerebroInstalled()) return;

  const now = Date.now();
  if (now - lastSyncAt < SYNC_THROTTLE_MS) return;
  lastSyncAt = now;
  syncInFlight = true;

  // 120s: a sync that has to fetch is bounded by the network, and the CLI's own
  // lock means a slow one cannot overlap the next.
  void runCerebro(cerebroRoot(), ['sync', '--quiet'], 120_000)
    .then((output) => {
      const said = output.trim();
      if (said.length > 0) log.info(`cerebro sync: ${said}`);
    })
    .catch((error: unknown) => {
      // Warn rather than throw. A bank that cannot sync — no network, a clone
      // mid-rebase, a validator refusing a queued draft — is a degraded
      // enhancement, and the run it rode in on has nothing to do with it.
      log.warn('cerebro sync did not complete; the bank may be stale', error);
    })
    .finally(() => {
      syncInFlight = false;
    });
}

/** The bank's condition. `installed: false` is a complete answer, not a fault. */
export async function readCerebroStatus(): Promise<CerebroStatus> {
  const root = cerebroRoot();
  if (!existsSync(cerebroCli(root))) {
    return {
      installed: false,
      repoPath: root,
      remote: null,
      source: null,
      memories: 0,
      validationErrors: 0,
      projects: 0,
      profiles: [],
    };
  }
  return parseCerebroStatus(await runCerebro(root, ['status', '--json'], 15_000), root);
}

export async function readCerebroList(): Promise<CerebroMemory[]> {
  return parseCerebroList(await runCerebro(cerebroRoot(), ['list', '--json'], 15_000));
}

/**
 * Onboarding, whole: clone if missing, enable every profile, sync once.
 *
 * `git` comes from the login-shell PATH the bootstrap adopted. The clone is
 * the one step that cannot go through the CLI (there is no CLI until it
 * lands), and it is pinned to {@link CEREBRO_REPO_URL} — the renderer asked
 * for "set up", not for "clone this".
 */
export async function setupCerebro(): Promise<CerebroActionResponse> {
  const root = cerebroRoot();
  const steps: string[] = [];

  // Check before assuming. Setup shells out to git and then to a Python CLI,
  // and every one of its prerequisites has a specific fix — discovering them
  // by failing halfway through a clone tells the user the least useful version
  // of the truth.
  const preflight = await readCerebroPreflight();
  const blocking = preflight.checks.filter((entry) => entry.state === 'fail');
  if (blocking.length > 0) {
    throw new WorkspaceError(
      `Cerebro cannot be set up on this machine yet — ${blocking
        .map((entry) => `${entry.label}: ${entry.detail}${entry.remedy === null ? '' : ` (${entry.remedy})`}`)
        .join('; ')}`,
    );
  }

  if (!existsSync(cerebroCli(root))) {
    if (existsSync(root)) {
      throw new WorkspaceError(
        `${root} exists but is not the Cerebro repo — move it aside, or point ARTEMIS_CEREBRO_ROOT at the real clone.`,
      );
    }
    log.info(`Cloning ${CEREBRO_REPO_URL} into ${root}`);
    try {
      await execFileAsync('git', ['clone', '--quiet', CEREBRO_REPO_URL, root], {
        timeout: 180_000,
        encoding: 'utf8',
      });
    } catch (error) {
      throw toCerebroError(error, 'clone');
    }
    steps.push(`Cloned the bank into ${root}.`);
  }

  await runCerebro(root, ['enable'], 30_000);
  steps.push('Enabled every profile (CLAUDE.md block, /cerebro command, session-start sync hook).');

  const synced = (await runCerebro(root, ['sync', '--force'], 120_000)).trim();
  steps.push(synced.length > 0 ? synced : 'Bank installed into project memory.');

  return { message: steps.join(' ') };
}

export async function syncCerebro(): Promise<CerebroActionResponse> {
  const output = (await runCerebro(cerebroRoot(), ['sync', '--force'], 120_000)).trim();
  return { message: output.length > 0 ? output : 'Already up to date.' };
}

/** Queue a memory, then land it through the bank's gates (commit or PR). */
export async function draftCerebroMemory(request: CerebroDraftRequest): Promise<CerebroActionResponse> {
  const root = cerebroRoot();
  const drafted = await runCerebro(
    root,
    [
      'draft',
      request.name,
      '--type',
      request.type,
      '--description',
      request.description,
      '--body',
      request.body,
    ],
    30_000,
  );
  const landed = await runCerebro(root, ['promote'], 120_000);
  return { message: `${drafted.trim()} ${landed.trim()}`.trim() };
}

export async function retireCerebroMemory(request: CerebroRetireRequest): Promise<CerebroActionResponse> {
  const args = ['retire', request.name];
  if (request.reason !== undefined) args.push('--reason', request.reason);
  const output = (await runCerebro(cerebroRoot(), args, 120_000)).trim();
  return { message: output.length > 0 ? output : `Retired ${request.name}.` };
}
