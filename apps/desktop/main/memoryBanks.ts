/**
 * Memory banks — Cerebro generalized, from the main process's side.
 *
 * A machine can carry several git-backed, agent-maintained banks: the team's
 * shared one, a personal local-only one, a client project's, one it only
 * reads. Everything here is a seam over the `cerebro` CLI — for each bank,
 * the copy embedded in the bank itself when it carries one (the CLI *updates
 * itself* with the bank, so Artemis always speaks that bank's current
 * dialect), else the copy Artemis ships for bootstrap. The first design
 * decision is unchanged from the single-bank era: the CLI is the contract
 * (agents call it from hooks, CI calls it on every PR), and a second
 * implementation of its logic in TypeScript would drift from the first the
 * week someone changed a bank.
 *
 * The second decision is that **main owns the locations**. The renderer never
 * names a binary or an arbitrary path; this module resolves banks from the
 * CLI's own registry (`~/.config/cerebro/config.json` — read here, written
 * only through the CLI) and refuses to run anything that is not a `cerebro`
 * CLI it resolved itself. That is the same rule the terminal keeps ("main
 * chooses the shell"), applied to a subprocess that can write.
 *
 * Spawns here are user-clicked, settings-pane rare — never keystroke-adjacent
 * — and the per-run paths (`banksForRun`, `isMasterEnabled`) are synchronous
 * file reads, never spawns.
 *
 * Parsing is split from spawning, `shellPath.ts`-style: the `parse*` functions
 * are pure, take the CLI's `--json` output as text, and are the unit under
 * test in `memoryBanks.test.ts`. They rebuild rather than pass through — only
 * the fields the protocol names cross into a response, so a future CLI field
 * can never leak into the renderer unreviewed.
 *
 * The third decision is that **the environment is composed here, once**. The
 * CLI is a Python script, and on Windows a Python script is not something a
 * process can execute — so this module resolves an interpreter and spawns
 * `[python, cli, …args]` while other platforms keep the direct exec. It also
 * tells every spawn where Artemis keeps its own state (`ARTEMIS_ROOT`,
 * without which the CLI looks in a macOS-only location and reports every
 * machine as unready), forbids git from opening a terminal prompt behind a
 * window nobody is watching, and — for a private bank — supplies the git
 * credential through `gitCredentialEnv.ts`. All of it goes through the one
 * `runCli` choke point, because "every call except that one" is how an
 * environment invariant stops being one.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { MemoryBankCredential, MemoryBankSecrets } from '@rx-artemis/core';
import type {
  MemoryBankActionResponse,
  MemoryBankAddRequest,
  MemoryBankCheck,
  MemoryBankForgetRequest,
  MemoryBankInfo,
  MemoryBankMemory,
  MemoryBankPreflight,
  MemoryBankProfileState,
  MemoryBankPromptInfo,
  MemoryBankRetireRequest,
  MemoryBankSetEnabledRequest,
  MemoryBankSyncRequest,
  MemoryBankVerifyOutcome,
  MemoryBankVerifyRemoteRequest,
  MemoryBankVerifyRemoteResponse,
  MemoryBanksSetMasterEnabledRequest,
  MemoryBanksStatus,
} from '@rx-artemis/protocol';

import { WorkspaceError } from './errors.js';
import {
  credentialOrigin,
  DEFAULT_GIT_USERNAME,
  GIT_TOKEN_ENV,
  gitCredentialEnv,
  gitCredentialsEnv,
  type GitCredential,
  type GitCredentialEnv,
} from './gitCredentialEnv.js';
import { createLogger } from './log.js';
import { scrubSecrets } from './redact.js';

const execFileAsync = promisify(execFile);
const log = createLogger('memory-banks');

/** Output ceiling for a CLI call — a full `list --json` is ~kilobytes. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** The slug whose installs predate multi-bank; the CLI treats it specially. */
const LEGACY_SLUG = 'cerebro';

/**
 * Where the single-bank era put the team bank. Still honoured: a machine that
 * cloned it before banks were plural gets it registered on the first status
 * read, under the legacy slug, without anything moving on disk.
 */
export function legacyRoot(): string {
  const override = process.env['ARTEMIS_CEREBRO_ROOT'];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), 'Documents', 'cerebro');
}

/** A directory is a bank when it holds `memories/` — the CLI's own test. */
function isBank(path: string): boolean {
  return existsSync(join(path, 'memories'));
}

function embeddedCli(bankPath: string): string | null {
  const cli = join(bankPath, 'bin', 'cerebro');
  return existsSync(cli) ? cli : null;
}

/* -------------------------------------------------------------------------- */
/* The CLI's registry, read-only                                              */
/* -------------------------------------------------------------------------- */

/**
 * One bank as the CLI's config records it. Mirrors the CLI's own reading —
 * including the pre-multi-bank `{"bank": path}` shape, which reads as one
 * enabled read-write bank under the legacy slug. Reading the file directly
 * (instead of spawning `banks --json`) is what keeps the per-run paths spawn
 * free; every *write* to it goes through the CLI.
 */
export interface RegistryBank {
  readonly slug: string;
  readonly path: string;
  readonly role: 'readwrite' | 'readonly';
  readonly enabled: boolean;
}

export function registryPath(): string {
  const base = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(base, 'cerebro', 'config.json');
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Parse the registry file's text. Pure; the unit under test. */
export function parseRegistry(text: string): { banks: RegistryBank[]; defaultSlug: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { banks: [], defaultSlug: null };
  }
  if (typeof parsed !== 'object' || parsed === null) return { banks: [], defaultSlug: null };
  const config = parsed as Record<string, unknown>;

  const raw = config['banks'];
  if (!Array.isArray(raw)) {
    const legacy = config['bank'];
    if (typeof legacy === 'string' && legacy.length > 0) {
      return {
        banks: [{ slug: LEGACY_SLUG, path: legacy, role: 'readwrite', enabled: true }],
        defaultSlug: LEGACY_SLUG,
      };
    }
    return { banks: [], defaultSlug: null };
  }

  const banks: RegistryBank[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const slug = item['slug'];
    const path = item['path'];
    if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) continue;
    if (typeof path !== 'string' || path.length === 0) continue;
    banks.push({
      slug,
      path,
      role: item['role'] === 'readonly' ? 'readonly' : 'readwrite',
      enabled: item['enabled'] !== false,
    });
  }
  const wanted = config['default'];
  const defaultSlug = banks.some((bank) => bank.slug === wanted)
    ? (wanted as string)
    : (banks[0]?.slug ?? null);
  return { banks, defaultSlug };
}

function readRegistry(): { banks: RegistryBank[]; defaultSlug: string | null } {
  let text: string;
  try {
    text = readFileSync(registryPath(), 'utf8');
  } catch {
    return { banks: [], defaultSlug: null };
  }
  return parseRegistry(text);
}

/* -------------------------------------------------------------------------- */
/* CLI resolution                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The copy of the CLI Artemis ships, for machines with no bank-embedded one.
 *
 * Bootstrap only: it creates and joins banks that do not exist yet, and
 * drives content-only banks (a bank someone published without embedding the
 * CLI). The moment a bank carries its own copy, that copy wins for the bank's
 * operations — see {@link resolveCli}.
 */
export function vendoredCliPath(): string | null {
  const override = process.env['ARTEMIS_VENDORED_CEREBRO'];
  const candidates = [
    ...(override !== undefined && override.length > 0 ? [override] : []),
    ...(typeof process.resourcesPath === 'string'
      ? [join(process.resourcesPath, 'cerebro')]
      : []),
    // Development: apps/desktop/resources/cerebro relative to the built main.
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'cerebro'),
    join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'cerebro'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The CLI to drive a bank (or the machine) with.
 *
 * Preference order is about staying current: a bank's embedded CLI updates
 * with the bank, so it speaks that bank's dialect; the default bank's CLI is
 * the machine's own convention (it owns the PATH shim and the hook); the
 * vendored copy is the bootstrap floor. Throws only when there is nothing at
 * all — which after vendoring means a broken install.
 */
function resolveCli(bankPath?: string): string {
  if (bankPath !== undefined) {
    const own = embeddedCli(bankPath);
    if (own !== null) return own;
  }
  const { banks, defaultSlug } = readRegistry();
  const chosen = banks.find((bank) => bank.slug === defaultSlug) ?? banks[0];
  if (chosen !== undefined) {
    const own = embeddedCli(chosen.path);
    if (own !== null) return own;
  }
  const legacy = embeddedCli(legacyRoot());
  if (legacy !== null) return legacy;
  const vendored = vendoredCliPath();
  if (vendored !== null) return vendored;
  throw new WorkspaceError(
    'No memory-bank CLI is available on this machine — reinstall Artemis, or clone a bank that embeds one.',
  );
}

/* -------------------------------------------------------------------------- */
/* Spawning a Python script on a platform that cannot execute one             */
/* -------------------------------------------------------------------------- */

/**
 * An interpreter, as a command plus the arguments that select a version.
 *
 * `py -3` is two words rather than one command because the Windows launcher is
 * a *dispatcher*: bare `py` runs whatever version the machine considers
 * default, which on a machine with Python 2 still installed is the one that
 * cannot run the CLI.
 */
export interface PythonCandidate {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * What to try, in order.
 *
 * The launcher first, because it is the one entry that is *installed with*
 * Python on Windows rather than being whatever a PATH mutation left behind,
 * and it resolves a real interpreter even when the app-execution aliases are
 * in the way. Then the version-qualified name, then the bare one — the order a
 * person would try them in, for the same reasons.
 */
export const PYTHON_CANDIDATES: readonly PythonCandidate[] = [
  { command: 'py', args: ['-3'] },
  { command: 'python3', args: [] },
  { command: 'python', args: [] },
];

/** What running `<candidate> --version` came to. */
export interface PythonProbe {
  /** Did it exit zero? */
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Is this probe a real Python 3?
 *
 * Two rejections matter and one of them is not obvious. The obvious one is a
 * non-zero exit, or an answer that is not a Python 3 version.
 *
 * The other is **the Windows Store stub**. Windows ships `python.exe` and
 * `python3.exe` under `WindowsApps` as app-execution aliases that exist purely
 * to open the Store. Run with `--version` they print nothing at all and exit —
 * so a probe that only checked the exit code would accept the stub, and every
 * later spawn would either open the Store or fail with an error that says
 * nothing about Python. Empty output is therefore a rejection in its own
 * right: a real interpreter always says which one it is.
 */
export function acceptsAsPython3(probe: PythonProbe): boolean {
  if (!probe.ok) return false;
  // `--version` went to stderr on Python 3.3 and earlier and to stdout since;
  // both are read so the check does not depend on which.
  const said = `${probe.stdout} ${probe.stderr}`.trim();
  if (said.length === 0) return false;
  const version = /Python (\d+)\.(\d+)/.exec(said);
  if (version === null) return false;
  return Number(version[1]) >= 3;
}

/** The first candidate whose probe passed, or `null`. Pure; the unit under test. */
export function selectPython(
  probes: readonly { readonly candidate: PythonCandidate; readonly probe: PythonProbe }[],
): PythonCandidate | null {
  return probes.find(({ probe }) => acceptsAsPython3(probe))?.candidate ?? null;
}

/**
 * Does this CLI need an interpreter in front of it on this platform?
 *
 * The bundled CLI is an extension-less file whose first line is a shebang.
 * That is executable on macOS and Linux and is *nothing* on Windows, which
 * has no shebang support and matches executables by `PATHEXT`: `execFile`
 * fails before the script's first line runs, which is why every bank operation
 * used to throw on Windows with an error about a file not being an
 * application.
 *
 * Asked of the path rather than assumed, because the same resolution finds a
 * bank's *embedded* copy — and a bank is free to ship a `.exe`.
 */
export function needsPythonInterpreter(cliPath: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false;
  const extension = extname(cliPath).toLowerCase();
  return extension !== '.exe' && extension !== '.cmd' && extension !== '.bat' && extension !== '.com';
}

/**
 * The resolved interpreter, or `null` when the machine has none.
 *
 * Cached for the process's life: this is three spawns of `--version`, and the
 * answer does not change while the app is open. `undefined` means "not yet
 * asked", `null` means "asked, and there is none" — the distinction is what
 * keeps a machine without Python from re-probing on every status read.
 */
let cachedPython: PythonCandidate | null | undefined;

async function probePython(candidate: PythonCandidate): Promise<PythonProbe> {
  try {
    const { stdout, stderr } = await execFileAsync(
      candidate.command,
      [...candidate.args, '--version'],
      { timeout: 10_000, encoding: 'utf8', maxBuffer: 64 * 1024 },
    );
    return { ok: true, stdout, stderr };
  } catch (error) {
    const raw = error as { stdout?: unknown; stderr?: unknown };
    return {
      ok: false,
      stdout: typeof raw.stdout === 'string' ? raw.stdout : '',
      stderr: typeof raw.stderr === 'string' ? raw.stderr : '',
    };
  }
}

async function resolvePython(): Promise<PythonCandidate | null> {
  if (cachedPython !== undefined) return cachedPython;
  const probes = [];
  for (const candidate of PYTHON_CANDIDATES) {
    // Sequentially, and stopping at the first that answers: the common case is
    // that the first candidate works, and probing all three in parallel would
    // spawn two processes nobody needs on every machine that has Python.
    const probe = await probePython(candidate);
    probes.push({ candidate, probe });
    if (acceptsAsPython3(probe)) break;
  }
  cachedPython = selectPython(probes);
  if (cachedPython !== null) {
    log.info(`Driving the memory-bank CLI with ${[cachedPython.command, ...cachedPython.args].join(' ')}`);
  }
  return cachedPython;
}

/** The error a machine with no interpreter gets, worded so it can be acted on. */
function noPythonError(): WorkspaceError {
  return new WorkspaceError(
    'Python 3 is required for the team memory bank CLI, and this machine has none that answers ' +
      '`--version` (the Microsoft Store stub does not count). Install it from python.org/downloads ' +
      'or with `winget install Python.Python.3.13`, then re-check.',
  );
}

/**
 * How to spawn this CLI: the executable, and whatever has to precede its
 * arguments.
 */
async function spawnPlan(cli: string): Promise<{ command: string; prefix: readonly string[] }> {
  if (!needsPythonInterpreter(cli, process.platform)) return { command: cli, prefix: [] };
  const python = await resolvePython();
  if (python === null) throw noPythonError();
  return { command: python.command, prefix: [...python.args, cli] };
}

/* -------------------------------------------------------------------------- */
/* The one spawn                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What every CLI spawn is told, before anything specific to the call.
 *
 * `ARTEMIS_ROOT` because the CLI's own default is
 * `~/Library/Application Support/Artemis` — the right answer on the machine it
 * was written on and nowhere else. Without it the CLI finds no `profiles.json`
 * off macOS, `doctor` reports "no Artemis profiles" forever, and the pane
 * blocks onboarding on a requirement the user cannot possibly satisfy.
 *
 * `GIT_TERMINAL_PROMPT=0` because everything here runs unattended behind a
 * settings pane. Git's prompt would be written to a console nobody is
 * watching and would hang the spawn until its timeout, turning "this remote
 * needs credentials" — a sentence the pane can act on — into "the CLI did not
 * respond".
 *
 * Exported for the same reason the `parse*` functions are: it is the pure half
 * of a spawn, and asserting that both variables are present is what stops a
 * later edit from quietly dropping the one that un-bricks `doctor`.
 */
export function baseCliEnv(): Record<string, string> {
  return {
    ...(artemisRoot !== null ? { ARTEMIS_ROOT: artemisRoot } : {}),
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * Run the CLI and hand back stdout.
 *
 * A non-zero exit becomes a {@link WorkspaceError} carrying the CLI's own
 * words: the bank's validator writes messages meant for people ("possible
 * secret (GitHub token) — memories must never contain credentials"), and a
 * pane that replaced them with "command failed" would be discarding the only
 * part the user needs.
 *
 * `env` is merged over {@link baseCliEnv} and over the inherited environment,
 * and is where a private bank's git credential arrives. It is a parameter of
 * *this* function rather than of each caller's spawn because there is only one
 * spawn: a second one would be a second place for the credential rules to be
 * got right.
 */
async function runCli(
  cli: string,
  args: readonly string[],
  timeoutMs: number,
  env: Readonly<Record<string, string>> = {},
): Promise<string> {
  const { command, prefix } = await spawnPlan(cli);
  try {
    const { stdout } = await execFileAsync(command, [...prefix, ...args], {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...process.env, ...baseCliEnv(), ...env },
    });
    return stdout;
  } catch (error) {
    throw toCliError(error, args.find((arg) => !arg.startsWith('-')) ?? 'cerebro', tokensIn(env));
  }
}

/**
 * The literal secrets an environment block carries, so they can be scrubbed
 * back out of anything the child said.
 *
 * Derived from the variable *names* rather than tracked separately, which is
 * what keeps this honest: `gitCredentialEnv` puts the token in
 * `ARTEMIS_GIT_TOKEN[_n]` and nowhere else, so anything matching that name is
 * exactly the set of strings that must not reach the renderer. A future
 * variable carrying a secret has to be named to be spawned, and naming it here
 * is one line.
 */
function tokensIn(env: Readonly<Record<string, string>>): readonly string[] {
  return Object.entries(env)
    .filter(([name, value]) => name.startsWith(GIT_TOKEN_ENV) && value.length > 0)
    .map(([, value]) => value);
}

/**
 * Fold a failed spawn into a message meant for a person.
 *
 * `secrets` are removed from that message before it exists. Git does not print
 * a password it was handed — but this text is assembled from a child process's
 * whole stderr, on a path where the caller has just put a token into that
 * child's environment, and "git is careful" is a property of git rather than
 * of this boundary. The scrub is the boundary's own.
 */
/**
 * What the CLI printed to stdout before it exited non-zero, carried on the
 * error so a caller can still read it.
 *
 * A non-zero exit does not always mean nothing useful was said. `doctor` exits
 * 1 whenever it finds a problem — that is its whole job — and prints its report
 * on stdout on the way out. Without this the report is discarded on exactly the
 * runs it exists to explain, and the pane shows "Memory bank doctor failed" over a
 * perfectly good list of what is wrong.
 */
export const CLI_STDOUT = Symbol('cerebro.stdout');

function toCliError(error: unknown, verb: string, secrets: readonly string[] = []): WorkspaceError {
  const raw = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const stdout = typeof raw.stdout === 'string' ? withoutSecrets(raw.stdout, secrets) : null;
  const said = withoutSecrets(
    [raw.stderr, raw.stdout]
      .filter((chunk): chunk is string => typeof chunk === 'string')
      .join('\n')
      .trim(),
    secrets,
  );

  const failure =
    said.length > 0
      ? // The tail, not the head: the CLI states its conclusion last.
        new WorkspaceError(
          `Memory bank ${verb} failed: ${said
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .slice(-3)
            .join(' · ')}`,
        )
      : new WorkspaceError(
          `Memory bank ${verb} failed: ${
            typeof raw.message === 'string'
              ? withoutSecrets(raw.message, secrets)
              : 'the CLI did not respond'
          }`,
        );

  if (stdout !== null) Object.defineProperty(failure, CLI_STDOUT, { value: stdout, enumerable: false });
  return failure;
}

/** The CLI's stdout from a failed run, when it said anything. @see CLI_STDOUT */
export function cliStdoutOf(error: unknown): string | null {
  const carried = (error as Record<symbol, unknown>)?.[CLI_STDOUT];
  return typeof carried === 'string' ? carried : null;
}

/**
 * Replace each known secret with a placeholder, then run the shape-based
 * scrub over what is left.
 *
 * Both halves, because they catch different things: the exact-value pass knows
 * this run's token and nothing else, and `scrubSecrets` knows the shapes of
 * credentials Artemis never held but a git host might have quoted back.
 */
export function withoutSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join('[redacted]');
  }
  return scrubSecrets(out);
}

/* -------------------------------------------------------------------------- */
/* Pure parsing — the unit under test                                         */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkspaceError(`The memory-bank CLI returned unexpected JSON: ${context} is not an object`);
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WorkspaceError('The memory-bank CLI returned output that is not JSON');
  }
}

/**
 * `status --json` → the protocol's {@link MemoryBanksStatus}.
 *
 * `masterEnabled` is passed in rather than read from the CLI's output because
 * it is not the CLI's to answer: it is Artemis's own record of whether this
 * machine spends run context on the banks. Keeping it a parameter is also
 * what keeps this function pure, which is what makes it the unit under test.
 */
export function parseBanksStatus(
  text: string,
  masterEnabled: boolean,
  cliAvailable: boolean,
): MemoryBanksStatus {
  const data = asRecord(parseJson(text), 'status');
  const rawBanks = Array.isArray(data['banks']) ? data['banks'] : [];
  const rawProfiles = Array.isArray(data['profiles']) ? data['profiles'] : [];

  // Installed-project counts come from the profile scan: entries stamped with
  // a `bank` belong to that slug, unstamped ones to the legacy dir.
  const projectCounts = new Map<string, number>();
  const profiles: MemoryBankProfileState[] = [];
  for (const entry of rawProfiles) {
    const profile = asRecord(entry, 'status.profiles[]');
    const perBank: Record<string, boolean> = {};
    const rawPerBank = profile['banks'];
    if (typeof rawPerBank === 'object' && rawPerBank !== null && !Array.isArray(rawPerBank)) {
      for (const [slug, on] of Object.entries(rawPerBank as Record<string, unknown>)) {
        if (SLUG_PATTERN.test(slug)) perBank[slug] = on === true;
      }
    }
    profiles.push({
      name: stringOr(profile['name'], 'unknown'),
      label: stringOr(profile['label'], ''),
      hook: profile['hook'] === true,
      banks: perBank,
    });
    const installed = profile['projects'];
    if (Array.isArray(installed)) {
      for (const project of installed) {
        if (typeof project !== 'object' || project === null) continue;
        const slug = stringOr((project as Record<string, unknown>)['bank'], LEGACY_SLUG);
        projectCounts.set(slug, (projectCounts.get(slug) ?? 0) + 1);
      }
    }
  }

  const banks: MemoryBankInfo[] = [];
  for (const entry of rawBanks) {
    const bank = asRecord(entry, 'status.banks[]');
    const slug = stringOr(bank['slug'], '');
    if (!SLUG_PATTERN.test(slug)) continue;
    const health = asRecord(bank['bank'] ?? {}, 'status.banks[].bank');
    banks.push({
      slug,
      path: stringOr(bank['path'], ''),
      remote: stringOrNull(bank['remote']),
      role: bank['role'] === 'readonly' ? 'readonly' : 'readwrite',
      enabled: bank['enabled'] === true,
      isDefault: bank['default'] === true,
      exists: bank['exists'] === true,
      source: stringOrNull(bank['source']),
      memories: numberOr(health['memories'], 0),
      mirrored: numberOr(health['mirrored'], 0),
      validationErrors: numberOr(health['errors'], 0),
      projects: projectCounts.get(slug) ?? 0,
    });
  }

  return { cliAvailable, masterEnabled, banks, profiles };
}

/** `list --json` → the protocol's {@link MemoryBankMemory} list, unparseable entries dropped. */
export function parseMemories(text: string): MemoryBankMemory[] {
  const data = parseJson(text);
  if (!Array.isArray(data)) {
    throw new WorkspaceError('The memory-bank CLI returned unexpected JSON: list is not an array');
  }
  const memories: MemoryBankMemory[] = [];
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
      org: stringOrNull(item['org']),
      project: stringOrNull(item['project']),
      readonly: item['readonly'] === true,
      file: stringOrNull(item['file']),
    });
  }
  return memories;
}

/**
 * `doctor --json` → the protocol's {@link MemoryBankPreflight}.
 *
 * Rebuilds each check rather than trusting the CLI's shape, and drops an entry
 * whose `state` is not one the protocol names — a future CLI state must not
 * arrive in the renderer as an unhandled string.
 */
export function parseDoctor(text: string): MemoryBankPreflight {
  const data = asRecord(parseJson(text), 'doctor');
  const raw = Array.isArray(data['checks']) ? data['checks'] : [];
  const checks: MemoryBankCheck[] = [];
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

/* -------------------------------------------------------------------------- */
/* The master switch                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Artemis's own answer to "does this machine spend run context on the banks",
 * under `userData`. The file keeps its historical name — it is the same
 * switch, carried over: a machine that said yes to Cerebro has said yes to
 * the banks it registered.
 */
const SWITCH_FILE = 'cerebro.json';

let switchFile: string | null = null;
let cachedEnabled: boolean | null = null;

/**
 * What every spawn is told `ARTEMIS_ROOT` is — Electron's `userData`, which is
 * where `profiles.json` actually lives on this platform. `null` until
 * configured, in which case the variable is simply not set and the CLI falls
 * back to its own default.
 */
let artemisRoot: string | null = null;

/**
 * Where a private bank's git credential is kept.
 *
 * Injected rather than constructed here, for the reason every Electron-shaped
 * thing in Artemis is: `memoryBankSecrets.ts` imports `safeStorage`, and this
 * module is unit-tested in a plain Node process. `null` is a complete state,
 * not a degraded one — a machine whose banks are public or reached over ssh
 * never needs one, and every path below treats an absent store exactly as it
 * treats a bank with no stored token.
 */
let bankSecrets: MemoryBankSecrets | null = null;

/**
 * Tell this module where Artemis keeps its own state. Called once, at startup.
 *
 * Three facts, one call, because they all come from the same place and are all
 * unknowable to a module that may not import `electron`: where the master
 * switch is written, what the CLI should be told `ARTEMIS_ROOT` is, and where
 * to find a bank's stored git credential.
 */
export function configureMemoryBanks(userDataDir: string, secrets?: MemoryBankSecrets): void {
  switchFile = join(userDataDir, SWITCH_FILE);
  artemisRoot = userDataDir;
  bankSecrets = secrets ?? null;
  cachedEnabled = null;
}

/**
 * Has the user switched the banks on for Artemis?
 *
 * **Off unless told otherwise**, and that default is the whole point: banks
 * being configured is not consent to spending every run's context describing
 * them. Read on the path of every run, so it is synchronous and cached; the
 * cache is dropped by the one writer below.
 */
export function isMasterEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  if (switchFile === null) return false;

  let enabled = false;
  try {
    const parsed = JSON.parse(readFileSync(switchFile, 'utf8')) as unknown;
    enabled =
      typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>)['enabled'] === true;
  } catch (error) {
    // ENOENT is the ordinary case — nobody has thrown the switch yet. Anything
    // else is a file we cannot read, which reads as off for the same reason the
    // unconfigured case does.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`Could not read ${switchFile}; treating memory banks as off`, error);
    }
  }
  cachedEnabled = enabled;
  return enabled;
}

function writeSwitch(enabled: boolean): void {
  if (switchFile === null) {
    throw new WorkspaceError('Memory banks are not configured in this process.');
  }
  const body = `${JSON.stringify({ version: 1, enabled }, null, 2)}\n`;
  const tmp = `${switchFile}.tmp`;
  mkdirSync(dirname(switchFile), { recursive: true, mode: 0o700 });
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(tmp, switchFile);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The rename is what mattered; a stray temp file is not worth a second error.
    }
    throw new WorkspaceError(
      `Could not write ${switchFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  cachedEnabled = enabled;
}

/* -------------------------------------------------------------------------- */
/* Cheap per-run reads — never a spawn                                        */
/* -------------------------------------------------------------------------- */

/**
 * The banks a run should know about: registered, enabled, present on disk.
 *
 * Registry first; a machine with no registry but the legacy clone gets that
 * clone, so pre-multi-bank machines keep working before the one-time
 * registration in {@link readMemoryBanksStatus} has run.
 */
export function banksForRun(): RegistryBank[] {
  const { banks } = readRegistry();
  if (banks.length > 0) {
    return banks.filter((bank) => bank.enabled && isBank(bank.path));
  }
  const root = legacyRoot();
  if (isBank(root) && embeddedCli(root) !== null) {
    return [{ slug: LEGACY_SLUG, path: root, role: 'readwrite', enabled: true }];
  }
  return [];
}

/** The precondition for `builtin:cerebro`: something to describe, and a CLI to teach. */
export function anyBankAvailable(): boolean {
  if (banksForRun().length === 0) return false;
  try {
    resolveCli();
    return true;
  } catch {
    return false;
  }
}

/** The facts the prompt renderer needs, in composition's pure vocabulary. */
export function promptBanks(): MemoryBankPromptInfo[] {
  const { defaultSlug } = readRegistry();
  const banks = banksForRun();
  /*
   * A configured default only counts while the bank it names is still here.
   * Forgetting a bank does not necessarily rewrite the registry's `default`,
   * and a default naming a bank that is gone would leave every bank
   * un-defaulted — which the prompt renderer reads as "no primary", so the
   * name it speaks and the bank it drafts into would both change shape for a
   * reason the user never chose. Falling through to the first surviving bank
   * is what makes removal a promotion rather than a hole.
   */
  const resolvedDefault =
    defaultSlug !== null && banks.some((bank) => bank.slug === defaultSlug)
      ? defaultSlug
      : (banks[0]?.slug ?? null);
  return banks.map((bank) => ({
    slug: bank.slug,
    isDefault: bank.slug === resolvedDefault,
    readonly: bank.role === 'readonly',
    cli: embeddedCli(bank.path) ?? safeResolveCli() ?? 'bin/cerebro',
  }));
}

function safeResolveCli(): string | null {
  try {
    return resolveCli();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

let migrated = false;

/**
 * A pre-multi-bank machine has the clone and the switch but no registry.
 * Register it once, under the legacy slug — a change of description, not of
 * disk: the CLI's legacy slug keeps the exact install namespace those
 * machines already have. `--mode local` on purpose: the clone's origin stays
 * whatever it is, and registration must not touch the network.
 */
async function migrateLegacyBank(): Promise<void> {
  if (migrated) return;
  migrated = true;
  const { banks } = readRegistry();
  if (banks.length > 0) return;
  const root = legacyRoot();
  const cli = embeddedCli(root);
  if (cli === null || !isBank(root)) return;
  try {
    await runCli(cli, ['setup', '--mode', 'local', '--path', root, '--slug', LEGACY_SLUG], 60_000);
    log.info(`Registered the pre-existing bank at ${root} as '${LEGACY_SLUG}'`);
  } catch (error) {
    migrated = false; // Try again next read; registration is idempotent.
    log.warn('Could not register the legacy bank; the pane will show none', error);
  }
}

/** Every bank's condition. `banks: []` is a complete answer, not a fault. */
export async function readMemoryBanksStatus(): Promise<MemoryBanksStatus> {
  await migrateLegacyBank();
  const cliAvailable = safeResolveCli() !== null;
  const { banks } = readRegistry();
  if (banks.length === 0) {
    return { cliAvailable, masterEnabled: isMasterEnabled(), banks: [], profiles: [] };
  }
  const text = await runCli(resolveCli(), ['status', '--json'], 30_000);
  return parseBanksStatus(text, isMasterEnabled(), cliAvailable);
}

export async function readMemoryBankMemories(slug: string): Promise<MemoryBankMemory[]> {
  return parseMemories(await runCli(resolveCli(), ['--bank', slug, 'list', '--json'], 15_000));
}

/**
 * What this machine is missing, with the fix for each.
 *
 * `--offline` when no bank is registered yet: the CLI's network probe checks
 * the addressed bank's remote, and with no bank that falls back to the team
 * repository — a check an outside user can only fail. Reachability of a
 * remote they actually join is checked by the join itself.
 */
export async function readMemoryBanksPreflight(): Promise<MemoryBankPreflight> {
  const cli = safeResolveCli();
  if (cli === null) {
    return {
      ready: false,
      checks: [
        {
          id: 'cli',
          label: 'Bank CLI',
          state: 'fail',
          detail: 'no CLI is available on this machine',
          remedy: 'Reinstall Artemis — the CLI ships with it',
        },
      ],
    };
  }
  const { banks } = readRegistry();
  const args = ['doctor', '--json', ...(banks.length === 0 ? ['--offline'] : [])];
  try {
    return parseDoctor(await runCli(cli, args, 60_000));
  } catch (error) {
    /*
     * `doctor` exits 1 whenever it finds a problem, which is the ordinary case
     * on a machine that has not set a bank up yet — so this path is the norm
     * rather than the exception, and the report it carries is exactly what the
     * pane needs to render. It is read off the error rather than the raw
     * execFile rejection because `runCli` has already turned that into a
     * `WorkspaceError`; `CLI_STDOUT` is what survives the wrapping.
     */
    const stdout = cliStdoutOf(error);
    if (stdout !== null && stdout.trim().startsWith('{')) {
      try {
        return parseDoctor(stdout);
      } catch {
        log.warn('cerebro doctor returned output that could not be parsed');
      }
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Credentials for a private bank                                             */
/* -------------------------------------------------------------------------- */

/**
 * A clone's `origin` URL, out of its own `.git/config`.
 *
 * Read rather than asked for, because `git remote get-url` would be a spawn on
 * a path that must not have one — this is called from the background sync,
 * which fires at every run start. Parsed as its own function so the awkward
 * half (git's config grammar) is testable without a repository.
 *
 * A hand-rolled parse of a format git owns, so it is deliberately narrow: the
 * first `url` under `[remote "origin"]`, and nothing else. Anything it fails
 * to understand reads as "no origin", and a bank with no origin is one that
 * syncs without a credential — the same as today.
 */
export function parseGitOrigin(configText: string): string | null {
  let inOrigin = false;
  for (const raw of configText.split('\n')) {
    const line = raw.trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section !== null) {
      inOrigin = /^remote\s+"origin"$/.test((section[1] ?? '').trim());
      continue;
    }
    if (!inOrigin) continue;
    const url = /^url\s*=\s*(.+)$/.exec(line);
    if (url !== null) return url[1]?.trim() ?? null;
  }
  return null;
}

function bankRemote(bankPath: string): string | null {
  try {
    return parseGitOrigin(readFileSync(join(bankPath, '.git', 'config'), 'utf8'));
  } catch {
    // Not a clone, or not readable. Either way there is no remote to scope a
    // credential to.
    return null;
  }
}

/**
 * The git credential for one registered bank, or `null`.
 *
 * The registry and the remote are consulted *before* the store, so a bank
 * whose credential could not be used anyway — unregistered, no origin, an ssh
 * origin — is never decrypted. Cheap questions first is the ordinary way to
 * write this; here it is also the rule that keeps a secret out of memory when
 * nothing was going to use it.
 */
async function credentialFor(slug: string): Promise<GitCredential | null> {
  if (bankSecrets === null) return null;
  const bank = readRegistry().banks.find((entry) => entry.slug === slug);
  if (bank === undefined) return null;
  const remote = bankRemote(bank.path);
  if (remote === null) return null;
  const origin = credentialOrigin(remote);
  if (origin === null) return null;
  const stored = await bankSecrets.read(slug);
  if (stored === null) return null;
  return { origin, token: stored.token, username: stored.username };
}

/**
 * The environment for a spawn that addresses one bank, or every bank.
 *
 * The every-bank case is the background sync's: one CLI pass covers all of
 * them, so all of their origins have to be configured up front. `list()` is
 * asked first and never decrypts, so a machine whose banks are all public
 * pays one file read and no decryption at all.
 */
async function bankCredentialEnv(slug?: string): Promise<GitCredentialEnv> {
  if (bankSecrets === null) return {};
  if (slug !== undefined) {
    const credential = await credentialFor(slug);
    return credential === null ? {} : gitCredentialEnv(credential);
  }
  const credentials: GitCredential[] = [];
  for (const stored of await bankSecrets.list()) {
    const credential = await credentialFor(stored);
    if (credential !== null) credentials.push(credential);
  }
  return gitCredentialsEnv(credentials);
}

/**
 * The credential a join was asked to use, before the bank it belongs to exists.
 *
 * The one place the origin cannot come from a clone's config, because there is
 * no clone yet — it comes from the URL the user typed, which is also the URL
 * about to be cloned.
 *
 * A token offered for a remote that cannot carry one is refused rather than
 * dropped. Silently ignoring it would produce the worst version of this
 * failure: a clone that prompts for an ssh key it does not have, while the
 * pane shows a token the user is sure they supplied.
 */
function requestedCredential(request: MemoryBankAddRequest): GitCredential | null {
  const auth = request.auth;
  if (auth === undefined || auth.token.length === 0) return null;
  const remote = request.remote ?? '';
  const origin = credentialOrigin(remote);
  if (origin === null) {
    throw new WorkspaceError(
      'An access token can only be used with an https:// remote. This remote is reached another ' +
        'way (ssh, for instance), which authenticates with a key rather than a token — join it ' +
        'without a token, or use the repository’s https:// URL.',
    );
  }
  return { origin, token: auth.token, username: auth.username ?? DEFAULT_GIT_USERNAME };
}

/* -------------------------------------------------------------------------- */
/* Verifying a remote, before anything is cloned                              */
/* -------------------------------------------------------------------------- */

/** How long a reachability probe is worth waiting for, with a person watching. */
const VERIFY_TIMEOUT_MS = 15_000;

/** What running `git ls-remote` came to, before it is interpreted. */
export interface LsRemoteResult {
  /** `null` when the process was killed rather than exiting on its own. */
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Patterns, in the order they are asked.
 *
 * Order is the whole design here. GitHub answers an unreadable private
 * repository with `The requested URL returned error: 403`, which matches both
 * "unable to access" and an authentication shape; Forgejo answers a wrong
 * token with `unable to access … Authentication failed`. Asking "is this
 * about credentials?" before "is this about the network?" is what keeps a
 * missing token from being reported as an outage — the failure that sends a
 * user to check their wifi while the pane holds the remedy.
 */
const VERIFY_PATTERNS: readonly { readonly outcome: MemoryBankVerifyOutcome; readonly pattern: RegExp }[] = [
  { outcome: 'auth-required', pattern: /authentication failed/i },
  { outcome: 'auth-required', pattern: /could not read (username|password)/i },
  { outcome: 'auth-required', pattern: /terminal prompts disabled/i },
  { outcome: 'auth-required', pattern: /\b(401|403)\b/ },
  { outcome: 'auth-required', pattern: /unauthorized|access denied|permission denied/i },
  { outcome: 'auth-required', pattern: /invalid (username or )?(password|token|credentials)/i },
  { outcome: 'not-found', pattern: /repository not found/i },
  { outcome: 'not-found', pattern: /\b404\b/ },
  { outcome: 'not-found', pattern: /not found|does not exist/i },
  { outcome: 'not-found', pattern: /does not appear to be a git repository/i },
  { outcome: 'unreachable', pattern: /could not resolve (host|proxy)/i },
  { outcome: 'unreachable', pattern: /couldn'?t connect|failed to connect|connection (refused|timed out|reset)/i },
  { outcome: 'unreachable', pattern: /network is unreachable|operation timed out|no route to host/i },
  { outcome: 'unreachable', pattern: /ssl|certificate/i },
];

/**
 * Turn one `git ls-remote` into an answer the pane can render.
 *
 * Pure, and the unit under test against canned stderr from the hosts this
 * actually meets. The interesting case is the one that looks like a failure
 * and is not: `--exit-code` makes git exit 2 when no ref matched, which for
 * `HEAD` means **the repository is readable and empty**. That is a perfectly
 * good bank to join — it is what a team's second machine sees on the day the
 * bank is created — and reporting it as an error would block the join with an
 * accurate-sounding sentence about a repository that is fine.
 */
export function categorizeLsRemote(result: LsRemoteResult): MemoryBankVerifyRemoteResponse {
  if (result.timedOut) {
    return {
      outcome: 'unreachable',
      headPresent: false,
      detail: `the remote did not answer within ${VERIFY_TIMEOUT_MS / 1000} seconds`,
    };
  }

  const said = `${result.stderr}\n${result.stdout}`;
  const fatal = /^fatal:|^error:/im.test(result.stderr);

  if (result.code === 0) {
    const head = /^([0-9a-f]{7,40})\s+HEAD/im.exec(result.stdout);
    return {
      outcome: 'ok',
      headPresent: head !== null,
      detail: head === null ? 'the remote answered' : `HEAD is ${(head[1] ?? '').slice(0, 8)}`,
    };
  }

  // Exit 2 with nothing fatal on stderr: git read the remote and found no
  // matching ref. See the doc comment — an empty repository, not a failure.
  if (result.code === 2 && !fatal) {
    return {
      outcome: 'ok',
      headPresent: false,
      detail: 'readable, and empty — joining it starts the bank',
    };
  }

  const detail = lastLine(result.stderr) || lastLine(result.stdout) || 'git gave no reason';
  for (const { outcome, pattern } of VERIFY_PATTERNS) {
    if (pattern.test(said)) return { outcome, headPresent: false, detail };
  }
  // Anything git failed at that names none of the shapes above. `unreachable`
  // rather than a sixth category, because the remedy the pane offers for it —
  // read what git said, and try again — is the right one for an unknown
  // failure too.
  return { outcome: 'unreachable', headPresent: false, detail };
}

function lastLine(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  return (lines.at(-1) ?? '').trim().slice(0, 240);
}

/**
 * Can this machine read that remote, with those credentials?
 *
 * One `git ls-remote`, spawned directly rather than through the banks' CLI:
 * see `IPC.memoryBanksVerifyRemote` for why a question asked before any bank
 * exists should not depend on a Python interpreter.
 *
 * The token supplied for the probe is not stored. Verifying is a question,
 * and a question that quietly wrote a credential to disk would be a different
 * feature; the token is stored when a bank is actually joined with it.
 */
export async function verifyMemoryBankRemote(
  request: MemoryBankVerifyRemoteRequest,
): Promise<MemoryBankVerifyRemoteResponse> {
  const remote = request.remote.trim();
  const auth = request.auth;
  let env: GitCredentialEnv = {};

  if (auth !== undefined && auth.token.length > 0) {
    const origin = credentialOrigin(remote);
    if (origin === null) {
      return {
        outcome: 'invalid-url',
        headPresent: false,
        detail:
          'an access token needs an https:// URL — this one is reached another way, which ' +
          'authenticates with a key instead',
      };
    }
    env = gitCredentialEnv({ origin, token: auth.token, username: auth.username ?? DEFAULT_GIT_USERNAME });
  }

  const secrets = tokensIn(env);
  try {
    const { stdout, stderr } = await execFileAsync('git', ['ls-remote', '--exit-code', remote, 'HEAD'], {
      timeout: VERIFY_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    });
    return scrubVerify(categorizeLsRemote({ code: 0, timedOut: false, stdout, stderr }), secrets);
  } catch (error) {
    const raw = error as {
      code?: unknown;
      killed?: unknown;
      signal?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    // `code` is the exit status for a process that ran, and an errno string
    // (`ENOENT`) for one that never started. The second means git is not
    // installed, which is a machine fact rather than a fact about the remote.
    if (typeof raw.code === 'string') {
      return {
        outcome: 'unreachable',
        headPresent: false,
        detail:
          raw.code === 'ENOENT'
            ? 'git is not installed on this machine, so no remote can be checked'
            : `git could not be run: ${raw.code}`,
      };
    }
    return scrubVerify(
      categorizeLsRemote({
        code: typeof raw.code === 'number' ? raw.code : null,
        timedOut: raw.killed === true || typeof raw.signal === 'string',
        stdout: typeof raw.stdout === 'string' ? raw.stdout : '',
        stderr:
          typeof raw.stderr === 'string' && raw.stderr.length > 0
            ? raw.stderr
            : typeof raw.message === 'string'
              ? raw.message
              : '',
      }),
      secrets,
    );
  }
}

/**
 * The last gate before a verify result becomes a response.
 *
 * `detail` is assembled from a child's stderr on the one path in Artemis where
 * a token was just put into that child's environment. Nothing observed says
 * git echoes it — and this scrub is what makes that a claim the boundary does
 * not have to rely on.
 */
function scrubVerify(
  response: MemoryBankVerifyRemoteResponse,
  secrets: readonly string[],
): MemoryBankVerifyRemoteResponse {
  return { ...response, detail: withoutSecrets(response.detail, secrets) };
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Join, create, or adopt a bank — then wire it and sync it once.
 *
 * Adding the first bank also throws the master switch: onboarding *is* the
 * yes, exactly as single-bank setup was. Adding a later bank leaves the
 * master alone — its state is a decision the user already made.
 */
export async function addMemoryBank(request: MemoryBankAddRequest): Promise<MemoryBankActionResponse> {
  const path = request.path ?? join(homedir(), 'Documents', request.slug);
  if (request.mode === 'adopt' && !isBank(path)) {
    throw new WorkspaceError(
      `${path} has no memories/ directory — it is not a bank. Use "create" to start one there.`,
    );
  }
  if (request.mode === 'join' && (request.remote === undefined || request.remote.length === 0)) {
    throw new WorkspaceError('Joining a bank needs its remote URL.');
  }

  const hadBanks = readRegistry().banks.length > 0;
  const steps: string[] = [];
  const setupArgs =
    request.mode === 'join'
      ? ['setup', '--mode', 'remote', '--remote', request.remote ?? '', '--path', path]
      : ['setup', '--mode', 'local', '--path', path];
  setupArgs.push('--slug', request.slug, '--role', request.role);

  // Composed once and used by all three spawns below. `enable` and the first
  // `sync` reach the remote too — a bank whose credential arrived only in time
  // for the clone would join successfully and then fail on its own first sync,
  // which is the confusing half of a two-step failure.
  const credential = requestedCredential(request);
  const credentialEnv = credential === null ? {} : gitCredentialEnv(credential);

  // The bootstrap CLI does the registration; the bank's own copy (cloned or
  // freshly embedded) takes over from the next call on.
  await runCli(resolveCli(), setupArgs, request.mode === 'join' ? 300_000 : 60_000, credentialEnv);
  steps.push(
    request.mode === 'join'
      ? `Joined ${request.remote ?? ''} at ${path} as '${request.slug}'.`
      : request.mode === 'create'
        ? `Created a bank at ${path} as '${request.slug}'.`
        : `Adopted the bank at ${path} as '${request.slug}'.`,
  );

  // Stored here rather than at the end, because *this* is the step that proved
  // the token works. A wiring or sync failure after a successful clone leaves
  // a real bank on disk that the user will retry; one that had forgotten its
  // credential would retry into an authentication error.
  if (credential !== null) {
    await storeCredential(request.slug, credential);
    steps.push('Its access token is stored encrypted, so background syncs keep working.');
  }

  await runCli(resolveCli(path), ['--bank', request.slug, 'enable'], 60_000, credentialEnv);
  steps.push('Wired every profile (managed block, /cerebro command, session-start sync hook).');

  const synced = (
    await runCli(resolveCli(path), ['--bank', request.slug, 'sync', '--force'], 180_000, credentialEnv)
  ).trim();
  steps.push(synced.length > 0 ? synced : 'Installed into project memory.');

  if (!hadBanks && !isMasterEnabled()) {
    writeSwitch(true);
    steps.push('Memory banks are on for Artemis.');
  }
  return { message: steps.join(' ') };
}

/**
 * Store one bank's credential, failing the whole action if it cannot be
 * stored.
 *
 * Loud rather than best-effort, following `profileSecrets.ts`: a join that
 * reported success while quietly discarding the token would leave the user
 * with a bank that works exactly once — until the window closes and the next
 * background sync meets a private remote with nothing to present.
 */
async function storeCredential(slug: string, credential: GitCredential): Promise<void> {
  if (bankSecrets === null) {
    throw new WorkspaceError(
      'This process cannot store an access token, so the bank would stop syncing when Artemis ' +
        'restarts. Join it without a token, or report this — it means memory banks were not ' +
        'configured at startup.',
    );
  }
  const record: MemoryBankCredential = {
    token: credential.token,
    // Resolved rather than carried through as optional: what is stored is what
    // git will be presented with on every later sync, and "whatever the default
    // was on the day it was joined" is not a thing to record.
    username: credential.username ?? DEFAULT_GIT_USERNAME,
  };
  try {
    await bankSecrets.write(slug, record);
  } catch (error) {
    throw new WorkspaceError(
      `The bank was set up, but its access token could not be stored: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Wire one bank on or off — the CLI records the flag and moves the blocks. */
export async function setMemoryBankEnabled(
  request: MemoryBankSetEnabledRequest,
): Promise<MemoryBankActionResponse> {
  if (request.enabled) {
    const credentialEnv = await bankCredentialEnv(request.slug);
    await runCli(resolveCli(), ['--bank', request.slug, 'enable'], 60_000, credentialEnv);
    const synced = (
      await runCli(resolveCli(), ['--bank', request.slug, 'sync', '--force'], 180_000, credentialEnv)
    ).trim();
    return {
      message: `'${request.slug}' is on. ${synced.length > 0 ? synced : 'Installed into project memory.'}`,
    };
  }
  await runCli(resolveCli(), ['--bank', request.slug, 'disable'], 60_000);
  return {
    message: `'${request.slug}' is off — its profile block is out, and syncs skip it. Its installed memories stay until you forget the bank.`,
  };
}

/** Artemis's gate alone: no CLI call, no machine rewiring. */
export function setMasterEnabled(
  request: MemoryBanksSetMasterEnabledRequest,
): MemoryBankActionResponse {
  writeSwitch(request.enabled);
  if (request.enabled) {
    syncMemoryBanksInBackground();
    return {
      message:
        'Memory banks are on for Artemis: runs sync them at start and agents are briefed about them. Per-bank wiring is unchanged.',
    };
  }
  return {
    message:
      'Memory banks are off for Artemis: no run-start syncs, no prompt. The machine wiring (hooks, blocks) stays as the per-bank switches left it.',
  };
}

export async function syncMemoryBank(request: MemoryBankSyncRequest): Promise<MemoryBankActionResponse> {
  const args = request.slug !== undefined ? ['--bank', request.slug] : [];
  const output = (
    await runCli(resolveCli(), [...args, 'sync', '--force'], 180_000, await bankCredentialEnv(request.slug))
  ).trim();
  return { message: output.length > 0 ? output : 'Already up to date.' };
}

/**
 * Retirement reaches the remote — with a remote configured it opens a pull
 * request — so it carries the bank's credential like any other write.
 */
export async function retireMemoryBankMemory(
  request: MemoryBankRetireRequest,
): Promise<MemoryBankActionResponse> {
  const args = ['--bank', request.slug, 'retire', request.name];
  if (request.reason !== undefined) args.push('--reason', request.reason);
  const output = (await runCli(resolveCli(), args, 120_000, await bankCredentialEnv(request.slug))).trim();
  return { message: output.length > 0 ? output : `Retired ${request.name}.` };
}

/**
 * Unwire, uninstall, forget — in that order, because the middle step needs
 * the registry entry the last one removes. The repository stays on disk:
 * deleting a git repo is not something this channel can be aimed at.
 */
export async function forgetMemoryBank(request: MemoryBankForgetRequest): Promise<MemoryBankActionResponse> {
  const cli = resolveCli();
  const steps: string[] = [];
  // Resolved before the registry entry goes, because that entry is how the
  // bank's origin is found — and after `forget` there is nothing left to scope
  // a credential to.
  const credentialEnv = await bankCredentialEnv(request.slug);
  await runCli(cli, ['--bank', request.slug, 'disable'], 60_000, credentialEnv);
  steps.push(`Unwired '${request.slug}' from every profile.`);
  try {
    await runCli(cli, ['--bank', request.slug, 'uninstall', '--all-projects'], 120_000);
    steps.push('Removed its installed memories from project memory.');
  } catch (error) {
    // Uninstall failing (a project dir gone read-only, say) should not leave
    // the bank half-forgotten and still registered.
    log.warn(`uninstall for '${request.slug}' did not complete`, error);
    steps.push('Some installed copies may remain; they are inert without the registry entry.');
  }
  const output = (await runCli(cli, ['forget', request.slug], 30_000)).trim();
  steps.push(output.length > 0 ? output.split('\n')[0]! : `Forgot '${request.slug}'.`);

  // The credential last, and unconditionally: a bank Artemis no longer knows
  // about must not leave an encrypted token behind for a slug nothing will
  // ever resolve again. Best-effort on purpose — the bank *is* forgotten by
  // this point, and failing the action now would report the opposite.
  if (bankSecrets !== null) {
    try {
      await bankSecrets.clear(request.slug);
    } catch (error) {
      log.warn(`Could not delete the stored access token for '${request.slug}'`, error);
    }
  }
  return { message: steps.join(' ') };
}

/* -------------------------------------------------------------------------- */
/* Keeping the banks turning                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How long a sync stands for. The CLI throttles the expensive half itself (a
 * lock directory per bank, a fifteen-minute fetch stamp, and a no-op when
 * `HEAD` has not moved), so this exists only to keep a burst of runs from
 * paying the process spawn several times over.
 */
const SYNC_THROTTLE_MS = 60_000;

let lastSyncAt = 0;
let syncInFlight = false;

/**
 * Run the banks' own sync cycle, in the background, at most once a minute.
 *
 * ## Why the main process does this
 *
 * `enable` installs a `SessionStart` hook into each profile's `settings.json`,
 * and on a stock Claude Code that is the whole mechanism. Under Artemis that
 * hook never fires: every query runs with `settingSources: []` — the
 * deliberate isolation described in the Claude adapter — and a hook Artemis
 * never loads is a hook that never runs. So the sync moves to the side of the
 * boundary that provisioned it: Artemis wires the banks and shows the pane;
 * running the cycle is its own housekeeping, not an instruction for the model
 * to carry. One spawn covers every enabled bank — the CLI iterates them.
 *
 * ## Why a run is the trigger
 *
 * A run start is Artemis's nearest thing to the `SessionStart` the banks were
 * written against, and it is the moment freshness actually matters: a sync
 * promotes what the last session drafted and pulls what teammates landed, and
 * both are only interesting to a session that is about to begin.
 *
 * Fire-and-forget, and silent unless it fails. A run must never wait on a
 * memory bank, and must never fail because of one.
 */
export function syncMemoryBanksInBackground(): void {
  if (syncInFlight) return;
  // The switch before the disk checks, because it is the cheaper question and
  // the more important one: a machine that has banks configured but has not
  // said yes must not have drafts promoted or remotes written to by the mere
  // act of starting a run.
  if (!isMasterEnabled()) return;
  if (banksForRun().length === 0) return;
  const cli = safeResolveCli();
  if (cli === null) return;

  const now = Date.now();
  if (now - lastSyncAt < SYNC_THROTTLE_MS) return;
  lastSyncAt = now;
  syncInFlight = true;

  // 180s: a sync that has to fetch is bounded by the network once per bank,
  // and the CLI's own locks mean a slow one cannot overlap the next.
  //
  // Every private bank's credential goes in, because one spawn covers every
  // enabled bank — see `bankCredentialEnv`. A machine with none composes an
  // empty block and spawns exactly what it spawned before any of this existed.
  void bankCredentialEnv()
    .then((credentialEnv) => runCli(cli, ['sync', '--quiet'], 180_000, credentialEnv))
    .then((output) => {
      const said = output.trim();
      if (said.length > 0) log.info(`memory-banks sync: ${said}`);
    })
    .catch((error: unknown) => {
      // Warn rather than throw. A bank that cannot sync — no network, a clone
      // mid-rebase, a validator refusing a queued draft — is a degraded
      // enhancement, and the run it rode in on has nothing to do with it.
      log.warn('memory-banks sync did not complete; a bank may be stale', error);
    })
    .finally(() => {
      syncInFlight = false;
    });
}
