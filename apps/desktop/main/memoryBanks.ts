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
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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
  MemoryBanksSetMasterEnabledRequest,
  MemoryBanksStatus,
} from '@rx-artemis/protocol';

import { WorkspaceError } from './errors.js';
import { createLogger } from './log.js';

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
    'No cerebro CLI is available on this machine — reinstall Artemis, or clone a bank that embeds one.',
  );
}

/**
 * Run the CLI and hand back stdout.
 *
 * A non-zero exit becomes a {@link WorkspaceError} carrying the CLI's own
 * words: the bank's validator writes messages meant for people ("possible
 * secret (GitHub token) — memories must never contain credentials"), and a
 * pane that replaced them with "command failed" would be discarding the only
 * part the user needs.
 */
async function runCli(cli: string, args: readonly string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cli, [...args], {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return stdout;
  } catch (error) {
    throw toCliError(error, args.find((arg) => !arg.startsWith('-')) ?? 'cerebro');
  }
}

function toCliError(error: unknown, verb: string): WorkspaceError {
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WorkspaceError('cerebro returned output that is not JSON');
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
    throw new WorkspaceError('cerebro returned unexpected JSON: list is not an array');
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

/** Tell this module where Artemis keeps its own state. Called once, at startup. */
export function configureMemoryBanks(userDataDir: string): void {
  switchFile = join(userDataDir, SWITCH_FILE);
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
  const fallbackDefault = banks[0]?.slug ?? null;
  return banks.map((bank) => ({
    slug: bank.slug,
    isDefault: bank.slug === (defaultSlug ?? fallbackDefault),
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
          label: 'cerebro CLI',
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
    // `doctor` exits non-zero precisely when something failed, and execFile
    // turns that into a throw with the JSON still on stdout.
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string' && stdout.trim().startsWith('{')) {
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

  // The bootstrap CLI does the registration; the bank's own copy (cloned or
  // freshly embedded) takes over from the next call on.
  await runCli(resolveCli(), setupArgs, request.mode === 'join' ? 300_000 : 60_000);
  steps.push(
    request.mode === 'join'
      ? `Joined ${request.remote ?? ''} at ${path} as '${request.slug}'.`
      : request.mode === 'create'
        ? `Created a bank at ${path} as '${request.slug}'.`
        : `Adopted the bank at ${path} as '${request.slug}'.`,
  );

  await runCli(resolveCli(path), ['--bank', request.slug, 'enable'], 60_000);
  steps.push('Wired every profile (managed block, /cerebro command, session-start sync hook).');

  const synced = (await runCli(resolveCli(path), ['--bank', request.slug, 'sync', '--force'], 180_000)).trim();
  steps.push(synced.length > 0 ? synced : 'Installed into project memory.');

  if (!hadBanks && !isMasterEnabled()) {
    writeSwitch(true);
    steps.push('Memory banks are on for Artemis.');
  }
  return { message: steps.join(' ') };
}

/** Wire one bank on or off — the CLI records the flag and moves the blocks. */
export async function setMemoryBankEnabled(
  request: MemoryBankSetEnabledRequest,
): Promise<MemoryBankActionResponse> {
  if (request.enabled) {
    await runCli(resolveCli(), ['--bank', request.slug, 'enable'], 60_000);
    const synced = (await runCli(resolveCli(), ['--bank', request.slug, 'sync', '--force'], 180_000)).trim();
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
  const output = (await runCli(resolveCli(), [...args, 'sync', '--force'], 180_000)).trim();
  return { message: output.length > 0 ? output : 'Already up to date.' };
}

export async function retireMemoryBankMemory(
  request: MemoryBankRetireRequest,
): Promise<MemoryBankActionResponse> {
  const args = ['--bank', request.slug, 'retire', request.name];
  if (request.reason !== undefined) args.push('--reason', request.reason);
  const output = (await runCli(resolveCli(), args, 120_000)).trim();
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
  await runCli(cli, ['--bank', request.slug, 'disable'], 60_000);
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
  void runCli(cli, ['sync', '--quiet'], 180_000)
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
