/**
 * The prompt library, from the main process's side.
 * ============================================================================
 *
 * `<userDataDir>/agent-prompts.json`, written the way `ProfileStore` writes
 * `profiles.json`: whole document, temp file, atomic rename, cached in memory
 * between reads.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FILE IN MAIN AND NOT A KEY IN `localStorage`
 * ---------------------------------------------------------------------------
 *
 * Everything else the settings dialog holds — column widths, which section was
 * last open, the collapsed projects — lives in the renderer's preferences blob,
 * and the first draft of this did too. It is the wrong home, for two reasons
 * that only apply to this one setting.
 *
 * The first is what the content *is*. Preferences are seeds: lose them and the
 * app opens with a different sidebar width. This is authored prose the user
 * spent time on, and `localStorage` is storage the platform is entitled to
 * evict — cleared with site data, gone when a partition is reset, invisible to
 * a backup that copies `userData`. A prompt someone wrote three months ago
 * disappearing to reclaim a few kilobytes is not a preference being forgotten.
 *
 * The second is *who has to be right*. Runs start in the main process. With the
 * library here, the composition happens at the one place every run passes
 * through (`engine.ts`'s `startRun`) and no caller can forget it. With it in
 * the renderer, every future path that starts a run — a scheduled run, a retry,
 * a second window — has to remember to attach the prompt, and the failure when
 * one forgets is silent: the run works, it just is not told anything.
 *
 * ---------------------------------------------------------------------------
 * REBUILT, NEVER PASSED THROUGH
 * ---------------------------------------------------------------------------
 *
 * Both the read and the write go through the protocol's
 * {@link parseAgentPromptsDocument}, which constructs fresh objects holding
 * only the fields the contract names and drops entries it cannot make sense of.
 * That is the same rule `validate.ts` keeps for IPC, applied to the other
 * untrusted input: this file is JSON on disk that a user can hand-edit, and a
 * half-valid document should cost the one prompt that is broken rather than the
 * library.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  defaultAgentPromptsDocument,
  parseAgentPromptsDocument,
  type AgentPromptsDocument,
} from '@rx-artemis/protocol';

import { WorkspaceError } from './errors.js';
import { createLogger } from './log.js';

const log = createLogger('agent-prompts');

/** The document's filename under `userData`. */
export const AGENT_PROMPTS_FILE = 'agent-prompts.json';

/* -------------------------------------------------------------------------- */
/* The store                                                                  */
/* -------------------------------------------------------------------------- */

export interface AgentPromptStoreOptions {
  /** Absolute path to Electron's `userData`. */
  readonly userDataDir: string;
  /** Overridable for tests. */
  readonly fileName?: string;
}

/**
 * The library on disk.
 *
 * One instance per process, created in the composition root and shared: the
 * in-memory cache is what keeps `startRun` from reading a file on the path of
 * every run, and two instances would each hold a copy that the other's writes
 * would not invalidate.
 */
export class AgentPromptStore {
  readonly #file: string;
  readonly #userDataDir: string;
  #cache: AgentPromptsDocument | null = null;
  /**
   * Serialises writes against each other and against the read they are built
   * on. Saves come from a settings pane that debounces its editor, so two can
   * genuinely be in flight at once, and without this the later `writeFile`
   * could land before the earlier `rename`.
   */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: AgentPromptStoreOptions) {
    if (!options.userDataDir || !path.isAbsolute(options.userDataDir)) {
      throw new WorkspaceError(
        `userDataDir must be an absolute path, got ${JSON.stringify(options.userDataDir)}`,
      );
    }
    this.#userDataDir = path.resolve(options.userDataDir);
    this.#file = path.join(this.#userDataDir, options.fileName ?? AGENT_PROMPTS_FILE);
  }

  /** Absolute path of the document. */
  get file(): string {
    return this.#file;
  }

  /** Drop the in-memory copy so the next read hits disk. */
  reload(): void {
    this.#cache = null;
  }

  /**
   * The library.
   *
   * Never throws for an absent or unreadable file: this is on the path of every
   * run, and a run that refused to start because a settings document was
   * corrupt would be Artemis failing at its actual job over a feature the user
   * may not have touched. A bad file is logged once and read as the defaults.
   */
  async read(): Promise<AgentPromptsDocument> {
    if (this.#cache) return this.#cache;

    let raw: string;
    try {
      raw = await readFile(this.#file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Could not read ${this.#file}; using defaults`, error);
      }
      this.#cache = defaultAgentPromptsDocument();
      return this.#cache;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      log.warn(`${this.#file} is not valid JSON; using defaults`, error);
      this.#cache = defaultAgentPromptsDocument();
      return this.#cache;
    }

    this.#cache = parseAgentPromptsDocument(parsed);
    return this.#cache;
  }

  /**
   * Replace the library.
   *
   * A whole-document write rather than per-prompt operations, because the pane
   * edits it as a document: reordering, retitling and retyping a body are one
   * user gesture each and would otherwise be three channels. The cost is that
   * two windows editing at once resolve last-write-wins — the same resolution
   * profiles already have, and settings is a modal surface one window at a time.
   *
   * The payload is re-parsed rather than trusted even though it arrived through
   * the IPC validator. The validator proves the *shape*; this restores the
   * invariants the library has to keep whatever the shape (built-ins present,
   * a built-in's text unstored unless its row says the user took it over, ids
   * unique), so what lands on disk is what a read would have produced.
   */
  async write(document: AgentPromptsDocument): Promise<AgentPromptsDocument> {
    const next = parseAgentPromptsDocument(document);
    const run = this.#tail.then(async () => {
      const body = `${JSON.stringify(next, null, 2)}\n`;
      const tmp = `${this.#file}.${randomUUID().slice(0, 8)}.tmp`;

      await mkdir(this.#userDataDir, { recursive: true, mode: 0o700 });
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
      try {
        await rename(tmp, this.#file);
      } catch (error) {
        await unlink(tmp).catch(() => undefined);
        throw new WorkspaceError(`Could not write ${this.#file}: ${describe(error)}`);
      }
      this.#cache = next;
      return next;
    });
    // The tail must not be left rejected — a failed save would otherwise reject
    // every save after it, and the user would be locked out of the pane by one
    // transient disk error.
    this.#tail = run.catch(() => undefined);
    return run;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
