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
  CerebroDraftRequest,
  CerebroActionResponse,
  CerebroMemory,
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
