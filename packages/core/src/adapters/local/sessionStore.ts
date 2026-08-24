/**
 * Transcripts for a provider whose server keeps none.
 * ============================================================================
 *
 * Every other provider hands its conversation to something that remembers it:
 * Claude's CLI writes `~/.claude/projects/<encoded-cwd>/<id>.jsonl`, Codex has
 * its rollout files, an Artemis server has a database. An inference server has
 * nothing — `/v1/chat/completions` is a pure function of the array it was sent
 * — so a local model's memory is exactly as long as the message array Artemis
 * builds for it, and until this module existed that array was one turn.
 *
 * The user-visible shape of that: a model that answered "what did I just ask
 * you?" with a guess, a history pane that was empty for these three providers,
 * and no way to reopen yesterday's work.
 *
 * ## The layout is Claude's, deliberately
 *
 *     $ARTEMIS_LOCAL_PROFILE_DIR/sessions/<encoded-cwd>/<sessionId>.jsonl
 *
 * Per-profile because the directory variable is, and per-project because
 * history is scoped by cwd everywhere else in the seam — see
 * `SessionListQuery`, which says so in as many words. The directory name is
 * built the way Claude builds it (every non-alphanumeric character becomes a
 * `-`), which is lossy: `/src/my-app` and `/src/my/app` collide. That is
 * tolerable for *finding* a file and never acceptable for reconstructing a
 * path, so every record carries the real `cwd` and listings read it from there
 * rather than decoding the directory. `ProviderAdapter.listAllSessions`
 * documents this as an obligation; `claudeSessionCwd.ts` is the module that
 * exists because Claude's own SDK once failed it.
 *
 * ## One line per message, and why the events are stored beside them
 *
 * A record is a message the next turn must replay, plus the events that
 * message would have emitted live. Storing both looks redundant and is not:
 * the *messages* are what the server needs and they are lossy for display —
 * a tool result reads identically whether the tool succeeded or failed — while
 * the *events* are what the transcript needs and are useless to the model. A
 * transcript rebuilt from messages alone renders every failed command green.
 *
 * Append-only, including titles and tags: a rename is a new line rather than a
 * rewrite, so a write can never truncate a conversation, and the last one wins
 * on read. Files are small — these are one machine's own turns, not a service's
 * — so reading one whole is cheaper than seeking within it.
 *
 * ## Nothing here is fatal
 *
 * A missing directory is a profile that has not run yet, and a line that does
 * not parse is a process killed mid-write. Both are ordinary states of a
 * desktop, so both read as "less history" rather than as an error: bad lines
 * are skipped and missing files answer empty. The one exception is a *write*,
 * which is allowed to reject so the adapter can decide — it swallows, because
 * a run must not fail because its transcript could not be saved.
 */

import { mkdir, appendFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import type {
  AgentEvent,
  ProfileId,
  ProviderId,
  RunId,
  SessionId,
  SessionSummary,
} from '@rx-artemis/protocol';

import type {
  AggregatedSessionList,
  AllSessionsQuery,
  EnvBundle,
  SessionListPage,
  SessionListQuery,
  SessionTranscript,
} from '../types.js';
import type { ChatMessage } from './loop.js';

/**
 * Where a profile's local-provider state lives.
 *
 * The same inert variable `localCredentials` names as its `configDirVar` —
 * nothing is spawned, so nothing reads it from an environment, but it is what
 * `resolveEnv` and `resolveStoreEnv` point at the profile's directory, which
 * makes it the one thing a history read has to go on.
 */
export const LOCAL_PROFILE_DIR_ENV = 'ARTEMIS_LOCAL_PROFILE_DIR';

/**
 * An event as it is stored: everything but the envelope.
 *
 * `runId`, `seq` and `ts` are stamped on the way out, because a replay belongs
 * to the run that asked for it rather than to the run that produced it — the
 * same re-stamping the Artemis adapter does to the server's events.
 */
export type StoredEvent = Omit<AgentEvent, 'runId' | 'seq' | 'ts'>;

/** One message, and how it looked while it was happening. */
export interface StoredTurnMessage {
  readonly message: ChatMessage;
  /** Empty is legal: an assistant turn that was only tool calls shows nothing. */
  readonly events: readonly StoredEvent[];
}

/** Fields every line carries, whatever kind it is. */
interface RecordBase {
  readonly sessionId: string;
  /**
   * The real working directory, on every record rather than only the first.
   *
   * The first is what a listing reads; the repetition costs a few bytes a line
   * and means a file whose head was lost still knows where it ran.
   */
  readonly cwd: string;
  readonly ts: number;
}

interface MessageRecord extends RecordBase {
  readonly kind: 'message';
  readonly providerId: ProviderId;
  readonly model?: string;
  readonly message: ChatMessage;
  readonly events: readonly StoredEvent[];
}

interface TitleRecord extends RecordBase {
  readonly kind: 'title';
  readonly title: string;
}

interface TagRecord extends RecordBase {
  readonly kind: 'tag';
  /** `null` clears whatever was there. */
  readonly tag: string | null;
}

type TranscriptRecord = MessageRecord | TitleRecord | TagRecord;

/** How much of an opening prompt stands in for a title the user never gave. */
const TITLE_FROM_PROMPT = 80;

/**
 * A directory name for a working directory, Claude's way.
 *
 * Exported because the tests assert the layout rather than inferring it: this
 * mirrors another program's convention, so a test that computed the name the
 * same way the code does would prove nothing about the convention.
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The store this environment names, or nothing when it names none. */
function storeRoot(env: EnvBundle): string | undefined {
  const dir = env[LOCAL_PROFILE_DIR_ENV];
  if (dir === undefined || dir.trim() === '') return undefined;
  return path.join(dir.trim(), 'sessions');
}

/** Whether a path is a readable file. */
async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * The file one session lives in.
 *
 * The cwd narrows the search and does not decide it: a summary carries the
 * directory a session *ran* in, and a caller may well ask about a session from
 * a window that has since moved. Naming the project directory is one `stat`;
 * not finding it there falls back to walking the profile's projects, which is
 * a handful of `stat`s on a desktop's worth of directories.
 */
async function locate(
  env: EnvBundle,
  sessionId: SessionId,
  cwd: string | undefined,
): Promise<string | undefined> {
  const root = storeRoot(env);
  if (root === undefined) return undefined;

  const file = `${String(sessionId)}.jsonl`;
  if (cwd !== undefined) {
    const direct = path.join(root, encodeCwd(cwd), file);
    if (await isFile(direct)) return direct;
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // No store at all: a profile that has never run. Not an error.
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, file);
    if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

/** Whether a parsed line is one of ours. */
function isRecord(value: unknown): value is TranscriptRecord {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'message' || kind === 'title' || kind === 'tag';
}

/**
 * Every record in one file, in the order they were written.
 *
 * A line that does not parse, or parses into something this build does not
 * recognise, is skipped rather than fatal — one truncated record at the end of
 * a transcript is not a reason to lose the conversation, and a record written
 * by a newer build is not a reason to fail the read.
 */
async function readRecords(file: string): Promise<readonly TranscriptRecord[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }

  const records: TranscriptRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(parsed)) records.push(parsed);
  }
  return records;
}

/** The message lines of a file, which are the only ones a turn replays. */
function messageRecords(records: readonly TranscriptRecord[]): readonly MessageRecord[] {
  return records.filter((record): record is MessageRecord => record.kind === 'message');
}

export interface AppendTurnOptions {
  /** The profile's resolved environment — this is what locates the store. */
  readonly env: EnvBundle;
  readonly sessionId: SessionId;
  /** The directory this turn actually ran in. Written into every record. */
  readonly cwd: string;
  readonly providerId: ProviderId;
  readonly model?: string;
  readonly messages: readonly StoredTurnMessage[];
}

/**
 * Add messages to a session, creating it if this is its first turn.
 *
 * Called as the turn happens rather than once at the end, so a run that is
 * interrupted — or that dies with the app — leaves the part of the
 * conversation that did happen. Rejects rather than swallowing: only the
 * caller knows whether a failed write should be visible.
 */
export async function appendTurn(options: AppendTurnOptions): Promise<void> {
  const root = storeRoot(options.env);
  // Nothing to write to. A profile with no directory is a misconfiguration the
  // run itself survives, so this is quiet rather than loud.
  if (root === undefined || options.messages.length === 0) return;

  const directory = path.join(root, encodeCwd(options.cwd));
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const now = Date.now();
  const lines = options.messages.map((entry) => {
    const record: MessageRecord = {
      kind: 'message',
      sessionId: String(options.sessionId),
      cwd: options.cwd,
      ts: now,
      providerId: options.providerId,
      ...(options.model === undefined ? {} : { model: options.model }),
      message: entry.message,
      events: entry.events,
    };
    return `${JSON.stringify(record)}\n`;
  });

  await appendFile(path.join(directory, `${String(options.sessionId)}.jsonl`), lines.join(''), {
    mode: 0o600,
  });
}

export interface SessionRef {
  readonly env: EnvBundle;
  readonly sessionId: SessionId;
  /** The directory the session ran in. Narrows the search; omit to search all. */
  readonly cwd?: string;
}

/**
 * The conversation so far, in the shape the next request sends.
 *
 * This is the whole point of the module: a turn seeds its message array with
 * what came back from here, so the model is told what it already said. An
 * unknown session answers empty, which is the same array a new conversation
 * starts with.
 */
export async function readMessages(ref: SessionRef): Promise<readonly ChatMessage[]> {
  const file = await locate(ref.env, ref.sessionId, ref.cwd);
  if (file === undefined) return [];
  return messageRecords(await readRecords(file)).map((record) => record.message);
}

/** How many messages a session holds right now. */
export async function count(ref: SessionRef): Promise<number> {
  const file = await locate(ref.env, ref.sessionId, ref.cwd);
  if (file === undefined) return 0;
  return messageRecords(await readRecords(file)).length;
}

export interface ReadEventsQuery extends SessionRef {
  /** The run id to stamp replayed events with, so they join one transcript. */
  readonly runId: RunId;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * The conversation so far, in the shape the transcript renders.
 *
 * Paged in messages, which is the unit {@link count} answers in — a caller
 * asking for `limit: historyOffset` gets everything before a resumed run and
 * nothing of the run itself, which is what that number is for.
 */
export async function readEvents(query: ReadEventsQuery): Promise<SessionTranscript> {
  const file = await locate(query.env, query.sessionId, query.cwd);
  if (file === undefined) return { events: [], hasMore: false };

  const stored = messageRecords(await readRecords(file));
  const offset = query.offset ?? 0;
  const limit = query.limit ?? stored.length;
  const page = stored.slice(offset, offset + limit);

  let seq = 0;
  const events: AgentEvent[] = [];
  for (const record of page) {
    for (const event of record.events) {
      events.push({
        ...event,
        // Text the user is reading back rather than watching arrive. The
        // protocol has a flag for exactly this, so the UI never has to infer it.
        ...(event.type === 'text.complete' ? { replay: true } : {}),
        runId: query.runId,
        seq: seq++,
        ts: record.ts,
      } as AgentEvent);
    }
  }

  return { events, hasMore: offset + page.length < stored.length };
}

/**
 * Everything one file says about itself, as a row in the history pane.
 *
 * `null` for a file holding no messages — a session whose first write failed,
 * or one left behind by a delete that removed the transcript and nothing else.
 * A row for it could not be opened or resumed, so there is nothing to show.
 */
async function summarise(
  file: string,
  profileId: ProfileId,
  providerId: ProviderId,
): Promise<SessionSummary | null> {
  const records = await readRecords(file);
  const messages = messageRecords(records);
  const first = messages[0];
  if (first === undefined) return null;

  // Last one wins: both are appended rather than rewritten, so the newest line
  // is the current answer.
  let title: string | undefined;
  let tag: string | null = null;
  for (const record of records) {
    if (record.kind === 'title') title = record.title;
    if (record.kind === 'tag') tag = record.tag;
  }

  const opening = messages.find((record) => record.message.role === 'user')?.message.content;
  const model = messages.reduce<string | undefined>(
    (chosen, record) => record.model ?? chosen,
    undefined,
  );

  let sizeBytes: number | undefined;
  try {
    sizeBytes = (await stat(file)).size;
  } catch {
    sizeBytes = undefined;
  }

  const updatedAt = records.reduce((latest, record) => Math.max(latest, record.ts), first.ts);

  return {
    id: String(first.sessionId) as SessionId,
    // The flavour that wrote the record, so a session started against Ollama
    // still says so when the sidebar reads it through llama.cpp's adapter —
    // the three share a store as readily as they share a wire format.
    providerId: first.providerId ?? providerId,
    profileId,
    // The record's own directory, never the one encoded in the path above it.
    // See the module header for what decoding that name would get wrong.
    cwd: first.cwd,
    title: title ?? placeholderTitle(opening),
    ...(title === undefined ? {} : { titleIsCustom: true }),
    ...(opening === undefined ? {} : { firstPrompt: opening }),
    updatedAt,
    createdAt: first.ts,
    messageCount: messages.length,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(tag === null ? {} : { tag }),
    ...(model === undefined ? {} : { model }),
  };
}

/** The label a session wears until something gives it a real one. */
function placeholderTitle(opening: string | undefined): string {
  const trimmed = opening?.trim() ?? '';
  if (trimmed === '') return 'Untitled conversation';
  return trimmed.length > TITLE_FROM_PROMPT
    ? `${trimmed.slice(0, TITLE_FROM_PROMPT).trimEnd()}…`
    : trimmed;
}

/** Every session in one project directory, newest first. */
async function summariseDirectory(
  directory: string,
  profileId: ProfileId,
  providerId: ProviderId,
): Promise<SessionSummary[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const summary = await summarise(path.join(directory, entry.name), profileId, providerId);
    if (summary !== null) sessions.push(summary);
  }
  return sessions;
}

/** Newest first, ties broken by id so repeated reads agree with each other. */
function byNewest(a: SessionSummary, b: SessionSummary): number {
  return b.updatedAt - a.updatedAt || String(a.id).localeCompare(String(b.id));
}

/**
 * One project's history.
 *
 * Reads only the directory this cwd encodes to. A different directory that
 * happens to encode the same — the lossy-name case in the header — would show
 * up here, and its rows carry their own `cwd`, so a consumer grouping by that
 * field files them where they belong rather than where they were found.
 */
export async function list(query: SessionListQuery, providerId: ProviderId): Promise<SessionListPage> {
  const root = storeRoot(query.env);
  if (root === undefined) return { sessions: [], hasMore: false };

  const sessions = await summariseDirectory(
    path.join(root, encodeCwd(query.cwd)),
    query.profileId,
    providerId,
  );
  sessions.sort(byNewest);

  const offset = query.offset ?? 0;
  const limit = query.limit ?? sessions.length;
  const page = sessions.slice(offset, offset + limit);
  return { sessions: page, hasMore: offset + page.length < sessions.length };
}

/**
 * Every project's history, for every profile named.
 *
 * A profile whose store cannot be read contributes nothing and is named rather
 * than failing the query — one profile with a deleted directory must not blank
 * the whole sidebar. A profile that simply has no sessions yet is *not*
 * unreadable: its directory is absent because nothing has run, which is an
 * answer and not a failure.
 */
export async function listAll(
  query: AllSessionsQuery,
  providerId: ProviderId,
): Promise<AggregatedSessionList> {
  const collected: SessionSummary[] = [];
  const unreadable: ProfileId[] = [];

  for (const scope of query.profiles) {
    const root = storeRoot(scope.env);
    if (root === undefined) {
      unreadable.push(scope.profileId);
      continue;
    }

    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      // No store yet. Nothing to report and nothing wrong.
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      collected.push(
        ...(await summariseDirectory(path.join(root, entry.name), scope.profileId, providerId)),
      );
    }
  }

  collected.sort(byNewest);
  return { sessions: collected, unreadableProfiles: unreadable };
}

/**
 * Give a session a name.
 *
 * Answers whether there was a session to name. Appended rather than rewritten,
 * for the reason the header gives: a rename must not be able to truncate a
 * conversation.
 */
export async function setTitle(ref: SessionRef, title: string): Promise<boolean> {
  const file = await locate(ref.env, ref.sessionId, ref.cwd);
  if (file === undefined) return false;

  const cwd = (await readRecords(file))[0]?.cwd ?? ref.cwd ?? '';
  const record: TitleRecord = {
    kind: 'title',
    sessionId: String(ref.sessionId),
    cwd,
    ts: Date.now(),
    title,
  };
  await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return true;
}

/** Write a tag beside a session, or clear it with `null`. */
export async function tag(ref: SessionRef, value: string | null): Promise<boolean> {
  const file = await locate(ref.env, ref.sessionId, ref.cwd);
  if (file === undefined) return false;

  const cwd = (await readRecords(file))[0]?.cwd ?? ref.cwd ?? '';
  const record: TagRecord = {
    kind: 'tag',
    sessionId: String(ref.sessionId),
    cwd,
    ts: Date.now(),
    tag: value,
  };
  await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return true;
}

/**
 * Destroy a session's transcript.
 *
 * A real delete, not an archive — `Capabilities.deleteSession` says the UI may
 * confirm this as irreversible, so it has to be. Answers whether there was
 * anything there to remove.
 */
export async function remove(ref: SessionRef): Promise<boolean> {
  const file = await locate(ref.env, ref.sessionId, ref.cwd);
  if (file === undefined) return false;
  await rm(file, { force: true });
  return true;
}
