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
 * built by `encodeProjectDir`, shared with the Claude side rather than copied,
 * and it is lossy in both directions: `/src/my-app` and `/src/my/app` collide,
 * while `/tmp` and `/private/tmp` — the same directory, two spellings — do not.
 *
 * So the name is used to *find* a file and never to decide anything. Every
 * record carries the real `cwd`, which is what listings read (decoding the name
 * instead could resume an agent in a directory nobody has been —
 * `ProviderAdapter.listAllSessions` documents that as an obligation, and
 * `claudeSessionCwd.ts` exists because Claude's own SDK once failed it); and a
 * write goes to whatever file the session already has anywhere in the store,
 * which is what keeps two spellings of one directory from splitting a
 * conversation into two transcripts that each stop growing. See {@link locate}.
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
 * are skipped and missing files answer empty.
 *
 * A read goes further than skipping, because a damaged file can be worse than
 * an incomplete one: an assistant turn holding tool calls whose results never
 * landed is rejected outright by every one of these servers, so a transcript
 * carrying one would be permanently unresumable. `readMessages` repairs that
 * on the way out — see `answeredCallsOnly` — and repairs it *without* touching
 * the file, so the evidence of what happened survives.
 *
 * A *write* is the exception that rejects. Only the caller knows what a failed
 * append means for the run it belongs to; the adapter's answer is to abandon
 * the rest of that turn rather than leave half of one behind, and to say so.
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
  ToolCallId,
} from '@rx-artemis/protocol';

import { readFirstCwd } from '../claudeSessionCwd.js';
import { encodeProjectDir } from '../claudeSessionSpawn.js';
import { adapterError } from '../types.js';
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

/** The store this environment names, or nothing when it names none. */
function storeRoot(env: EnvBundle): string | undefined {
  const dir = env[LOCAL_PROFILE_DIR_ENV];
  if (dir === undefined || dir.trim() === '') return undefined;
  return path.join(dir.trim(), 'sessions');
}

/**
 * Whether a path is a readable file — *following* a link to answer.
 *
 * `stat` rather than a `Dirent`'s own verdict, and the difference is not
 * pedantic: `readdir` reports a symlinked directory as a link and not a
 * directory, so a store whose projects are links — a workspace assembled with
 * `ln -s`, a profile directory shared between machines — enumerated as empty.
 * The same for a linked transcript.
 */
async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** The project directories under a store, links followed. See {@link isFile}. */
async function projectDirectories(root: string): Promise<readonly string[]> {
  let entries: string[];
  try {
    entries = (await readdir(root)).sort();
  } catch {
    // No store at all: a profile that has never run. Not an error.
    return [];
  }

  const directories = await Promise.all(
    entries.map(async (name) => {
      const candidate = path.join(root, name);
      try {
        return (await stat(candidate)).isDirectory() ? candidate : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return directories.filter((directory): directory is string => directory !== undefined);
}

/**
 * The file one session lives in, wherever it is.
 *
 * The cwd narrows the search and does not decide it: a summary carries the
 * directory a session *ran* in, and a caller may well ask about a session from
 * a window that has since moved. Naming the project directory is one `stat`;
 * not finding it there falls back to walking the profile's projects, which is
 * a handful of `stat`s on a desktop's worth of directories.
 *
 * **Writes go through here too.** That is the whole defence against a session
 * splitting in half: the same conversation reached by two spellings of one
 * directory — `/tmp` against `/private/tmp`, a trailing slash, a cwd an API
 * caller passed straight through from a client — encodes to two names, and a
 * write that trusted the caller's spelling would start a second transcript
 * under the same id. The reader would then keep answering from whichever it
 * found first while the turns went to the other one, so the conversation
 * silently stopped growing, the sidebar showed the id twice, and a delete
 * removed one half.
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
    const direct = path.join(root, encodeProjectDir(cwd), file);
    if (await isFile(direct)) return direct;
  }

  for (const directory of await projectDirectories(root)) {
    const candidate = path.join(directory, file);
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

/** A file's records and its size, from the one read that produced both. */
interface Transcript {
  readonly records: readonly TranscriptRecord[];
  readonly sizeBytes: number;
}

/**
 * Every record in one file, in the order they were written.
 *
 * A line that does not parse, or parses into something this build does not
 * recognise, is skipped rather than fatal — one truncated record at the end of
 * a transcript is not a reason to lose the conversation, and a record written
 * by a newer build is not a reason to fail the read.
 *
 * The size comes back with them because a listing wants both and the bytes are
 * already in hand: a second `stat` per session would be a syscall per row to
 * re-measure what was just read.
 */
async function readTranscript(file: string): Promise<Transcript> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { records: [], sizeBytes: 0 };
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
  return { records, sizeBytes: Buffer.byteLength(text) };
}

/** Just the records, for the callers with no use for the size. */
async function readRecords(file: string): Promise<readonly TranscriptRecord[]> {
  return (await readTranscript(file)).records;
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
 *
 * An existing transcript is appended to *wherever it already is* — see
 * {@link locate} for the session-splitting failure that rule exists to
 * prevent. Only a conversation with no file anywhere is created under the
 * directory this cwd encodes to.
 */
export async function appendTurn(options: AppendTurnOptions): Promise<void> {
  const root = storeRoot(options.env);
  // Nothing to write to. A profile with no directory is a misconfiguration the
  // run itself survives, so this is quiet rather than loud.
  if (root === undefined || options.messages.length === 0) return;

  /*
   * A directory is required, because the alternative is worse than a refusal:
   * an empty cwd encodes to an empty name, so the transcript would land loose
   * in `sessions/` rather than in a project — a file no listing walks into and
   * no session that reaches it can be resumed from the sidebar. `RunInput.cwd`
   * is documented as an absolute path; this is where that stops being an
   * assumption.
   */
  if (options.cwd.trim() === '') {
    throw adapterError(
      'invalid_request',
      'A conversation cannot be stored without the directory it ran in.',
    );
  }

  const existing = await locate(options.env, options.sessionId, options.cwd);
  const target =
    existing ?? path.join(root, encodeProjectDir(options.cwd), `${String(options.sessionId)}.jsonl`);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });

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

  await appendFile(target, lines.join(''), { mode: 0o600 });
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
  return answeredCallsOnly(messageRecords(await readRecords(file)).map((record) => record.message));
}

/**
 * Drop tool calls nothing ever answered, and answers to calls nothing made.
 *
 * A transcript is written as the turn happens, so a write that fails partway —
 * a full disk, a revoked permission, a directory deleted underneath the app —
 * can leave an assistant turn holding `tool_calls` whose results never landed.
 * Every one of these servers rejects that array outright: llama.cpp and Ollama
 * answer 400, which this adapter reports as `provider_unavailable`, so the
 * user is told their server is down while it is running perfectly and the
 * session is permanently unresumable. One damaged write would otherwise brick
 * a conversation for good.
 *
 * So the repair happens on the way *out* rather than on the way in. Reading is
 * the only moment the whole array is in hand, and a file that is already wrong
 * has to become sendable without being rewritten — a read path that repaired
 * the file would be a read that can fail, and would destroy the evidence of
 * what actually happened.
 *
 * An assistant turn stripped of its calls keeps its text, because that is what
 * the model said. One with nothing left at all is dropped: a contentless
 * assistant message is a turn the model never took, and some servers refuse it.
 */
function answeredCallsOnly(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  const answered = new Set(
    messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.tool_call_id)
      .filter((id): id is string => id !== undefined),
  );
  const asked = new Set(
    messages.flatMap((message) => (message.tool_calls ?? []).map((call) => call.id)),
  );

  const repaired: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      // An answer to a call that is not in the array is as unsendable as the
      // reverse — the server has no record of asking.
      if (message.tool_call_id !== undefined && asked.has(message.tool_call_id)) {
        repaired.push(message);
      }
      continue;
    }

    if (message.tool_calls === undefined) {
      repaired.push(message);
      continue;
    }

    const kept = message.tool_calls.filter((call) => answered.has(call.id));
    if (kept.length === message.tool_calls.length) {
      repaired.push(message);
      continue;
    }
    if (kept.length > 0) {
      repaired.push({ ...message, tool_calls: kept });
      continue;
    }
    const { tool_calls: _dropped, ...rest } = message;
    if (rest.content !== '') repaired.push(rest);
  }
  return repaired;
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
  page.forEach((record, index) => {
    for (const event of record.events) {
      events.push({
        ...event,
        // Text the user is reading back rather than watching arrive. The
        // protocol has a flag for exactly this, so the UI never has to infer it.
        ...(event.type === 'text.complete' ? { replay: true } : {}),
        ...uniqueToolCallId(event, offset + index),
        runId: query.runId,
        seq: seq++,
        ts: record.ts,
      } as AgentEvent);
    }
  });

  return { events, hasMore: offset + page.length < stored.length };
}

/**
 * A tool call's id, made unique across the turns of one conversation.
 *
 * These servers routinely omit the id, and `ToolCallAccumulator` stands the
 * call's *index within its turn* in for it — so every turn's first tool call is
 * `call_0`. Live that is harmless, because a turn is one run. Replayed it is
 * not: the renderer keys tool rows on the id and replaces a row when the id
 * repeats, so a reopened four-turn session showed a single tool card carrying
 * the last turn's output, and a live turn then mutated the replayed rows it
 * collided with.
 *
 * The record's position is what disambiguates, because it is the one thing that
 * is unique per turn and stable across reads — a paged read uses the absolute
 * index, so page two says the same thing on its own as it does after page one.
 *
 * Only the *display* events are rewritten. The stored `ChatMessage` array keeps
 * the ids the server issued, because there the id has a job — pairing a result
 * to the call the model asked for — and rewriting it would be changing what the
 * model is told it said.
 */
function uniqueToolCallId(event: StoredEvent, index: number): { toolCallId?: ToolCallId } {
  const id = (event as { toolCallId?: unknown }).toolCallId;
  if (typeof id !== 'string') return {};
  return { toolCallId: `${String(index)}:${id}` as ToolCallId };
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
  const { records, sizeBytes } = await readTranscript(file);
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
    sizeBytes,
    ...(tag === null ? {} : { tag }),
    ...(model === undefined ? {} : { model }),
  };
}

/**
 * The label a session wears until something gives it a real one.
 *
 * Cut by code *point* rather than by code unit: slicing a string mid-surrogate
 * leaves half a character, which renders as a replacement glyph — and an
 * opening message is exactly where an emoji turns up.
 */
function placeholderTitle(opening: string | undefined): string {
  const trimmed = opening?.trim() ?? '';
  if (trimmed === '') return 'Untitled conversation';
  const points = [...trimmed];
  return points.length > TITLE_FROM_PROMPT
    ? `${points.slice(0, TITLE_FROM_PROMPT).join('').trimEnd()}…`
    : trimmed;
}

/**
 * Every session in one project directory.
 *
 * Read in parallel: these are independent files and a project directory holds
 * one row per conversation, so a sidebar opening on a month's work would
 * otherwise pay a full round trip to disk per row, one after another.
 */
async function summariseDirectory(
  directory: string,
  profileId: ProfileId,
  providerId: ProviderId,
): Promise<SessionSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const summaries = await Promise.all(
    entries
      .filter((name) => name.endsWith('.jsonl'))
      .map(async (name) => {
        const file = path.join(directory, name);
        // A link to a transcript is a transcript. See `isFile`.
        return (await isFile(file)) ? summarise(file, profileId, providerId) : null;
      }),
  );
  return summaries.filter((summary): summary is SessionSummary => summary !== null);
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
    path.join(root, encodeProjectDir(query.cwd)),
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

    // A store with no directories yet is not a failure — nothing has run.
    const projects = await projectDirectories(root);
    const perProject = await Promise.all(
      projects.map((directory) => summariseDirectory(directory, scope.profileId, providerId)),
    );
    for (const sessions of perProject) collected.push(...sessions);
  }

  collected.sort(byNewest);
  return { sessions: collected, unreadableProfiles: unreadable };
}

/**
 * Add a bookkeeping line to a session that already exists.
 *
 * Both writers do the same three things — find the file, learn which directory
 * it belongs to, append one line — so they do them in one place. The directory
 * is read back off the file's own head rather than taken from the caller,
 * because `cwd` on a record means "where this conversation ran" and a rename
 * arriving from a window that has moved must not be the line that says
 * otherwise. Read by streaming the first records rather than parsing the whole
 * transcript: the answer is on line one and these files grow all turn.
 *
 * Answers whether there was a session there at all.
 */
async function appendMeta(
  ref: SessionRef,
  build: (base: RecordBase) => TranscriptRecord,
): Promise<boolean> {
  const file = await locate(ref.env, ref.sessionId, ref.cwd);
  if (file === undefined) return false;

  const record = build({
    sessionId: String(ref.sessionId),
    cwd: (await readFirstCwd(file)) ?? ref.cwd ?? '',
    ts: Date.now(),
  });
  await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return true;
}

/**
 * Give a session a name.
 *
 * Appended rather than rewritten, for the reason the header gives: a rename
 * must not be able to truncate a conversation.
 */
export function setTitle(ref: SessionRef, title: string): Promise<boolean> {
  return appendMeta(ref, (base) => ({ ...base, kind: 'title', title }));
}

/** Write a tag beside a session, or clear it with `null`. */
export function tag(ref: SessionRef, value: string | null): Promise<boolean> {
  return appendMeta(ref, (base) => ({ ...base, kind: 'tag', tag: value }));
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
