/**
 * Historical sessions.
 *
 * Because each profile gets its own `CLAUDE_CONFIG_DIR`, and Claude stores
 * transcripts under `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<id>.jsonl`,
 * isolating a profile's credentials also isolates its history — for free.
 * Sessions are therefore partitioned by (profile × project), and both
 * coordinates are recoverable without any bookkeeping of Artemis's own: the
 * profile is *which* config directory a session was found in, and the project
 * is the {@link SessionSummary.cwd} recorded inside the session.
 *
 * That is why both fields are on every summary, and why two listings exist:
 * `sessions:list` answers "this profile, this directory", and
 * `sessions:listAll` walks the whole space so a sidebar can group by project
 * and label by profile.
 *
 * **`cwd` is read from the session, never decoded from the directory name.**
 * The encoding replaces every non-alphanumeric character with `-`, so it is
 * lossy and ambiguous for any path containing a real hyphen.
 */

import type { ProfileId, SessionId } from './ids.js';
import type { ProviderId } from './provider.js';

/**
 * One past conversation, summarised for a list view.
 *
 * Only providers advertising {@link import('./provider.js').Capabilities.listSessions}
 * produce these.
 */
export interface SessionSummary {
  readonly id: SessionId;
  readonly providerId: ProviderId;
  /**
   * The profile whose config directory this session was found in.
   *
   * When several reach it — see {@link alsoInProfiles} — this is the first of
   * them in the order the profiles were listed, chosen so that repeated reads
   * agree with each other rather than because it means anything.
   */
  readonly profileId: ProfileId;
  /**
   * The *other* profiles whose config directory reaches this same transcript,
   * when more than one does. Absent in the ordinary case, which is one.
   *
   * A profile's config directory is normally its own store, so a session
   * belongs to exactly one account and `profileId` says which. That stops being
   * true the moment two profiles resolve to one store — two profiles naming the
   * same `configDir`, or a `projects/` symlinked between them to share history
   * across accounts. Then a single conversation is reachable from several, and
   * a field that can only name one of them is not enough to describe it.
   *
   * Carried rather than inferred because only the adapter can answer it: it is
   * the component that knows where a provider keeps its store and can resolve
   * two paths to the same place. Consumers use it for two things — not listing
   * one conversation once per profile, and resuming under an account the user
   * is already using instead of switching them to an arbitrary one.
   *
   * Excludes {@link profileId}. The full set is `[profileId, ...alsoInProfiles]`.
   */
  readonly alsoInProfiles?: readonly ProfileId[];
  /**
   * Set when {@link profileId} is a pick rather than an answer.
   *
   * A shared store has no record of which account ran any given conversation:
   * the transcript names a session, a directory and a branch, and nothing about
   * who paid for it. So when several profiles reach one store the adapter has
   * to put *some* id on the row, and it uses the first sharer — see
   * {@link profileId}. That is stable across reads and means nothing, and a UI
   * that renders it as a fact states the same account on every shared row.
   *
   * Which is a worse failure than it looks. The label is the only place the
   * sidebar answers "whose conversation is this", so an arbitrary one is not a
   * cosmetic slip — it is a confident wrong answer to the question the label
   * exists for. A consumer seeing this flag should show no account rather than
   * name one: absent is honest where arbitrary is not.
   *
   * Cleared, with {@link profileId} rewritten, when the host's own ledger has
   * recorded the account a session actually ran under — which it does for every
   * session Artemis starts or resumes. So a row is unattributed only until the
   * user next opens it, and never for a conversation this install began.
   *
   * Omitted rather than set `false` in the ordinary case, matching
   * {@link alsoInProfiles}: absent means {@link profileId} says what it means.
   */
  readonly profileIsUnknown?: boolean;
  /** Working directory the session ran in. */
  readonly cwd: string;

  /**
   * Best available label. Adapters resolve this in order of preference: an
   * assigned title, then the provider's generated summary, then the first
   * prompt, then a placeholder. The UI should render it verbatim.
   */
  readonly title: string;
  /**
   * True when {@link title} is a name this session was *given*, rather than one
   * derived from its contents.
   *
   * Not the same as "the user typed it", though it used to be. Artemis names a
   * new session from its opening message and stores the result in the
   * provider's own title field — see `ProviderAdapter.setSessionTitle` for why
   * that is the right place — so a generated name is indistinguishable from a
   * typed one here, and deliberately so: both are names, as against the summary
   * or the truncated first prompt that this flag exists to separate them from.
   *
   * Anything that needs "did a human choose this?" specifically cannot use this
   * field and would need the provider to record the difference, which none of
   * them do.
   */
  readonly titleIsCustom?: boolean;
  /** Opening prompt, for a secondary line in the list. */
  readonly firstPrompt?: string;

  /** Last-modified time, ms since epoch. Sort key for the history pane. */
  readonly updatedAt: number;
  /** Creation time, ms since epoch, when the provider records one. */
  readonly createdAt?: number;

  /**
   * Set when a machine opened this conversation, not a person.
   *
   * `'scheduled-task'` covers every firing of Claude's scheduler — cron jobs
   * and cloud routines both open their transcript with a `<scheduled-task …>`
   * turn, and that is the marker the adapter classifies on. One value rather
   * than two because the transcript does not distinguish them, and nothing a
   * consumer does differs between them.
   *
   * Why it is worth a field at all: firings arrive on a schedule, so a store
   * that has been running one for a month holds hundreds of transcripts nobody
   * ever opened. Listed as ordinary rows they bury the conversations the user
   * actually had — the sidebar files rows carrying this under Archived instead,
   * and every *future* firing arrives already filed, which no per-session
   * bookkeeping could do.
   *
   * Omitted, never `false`, for a conversation a person began — matching
   * {@link alsoInProfiles}'s convention that the ordinary case is absent.
   */
  readonly spawnedBy?: 'scheduled-task';

  /** Number of messages, when cheaply available. */
  readonly messageCount?: number;
  /** Transcript size in bytes, when the provider stores it as a file. */
  readonly sizeBytes?: number;
  /** Git branch the session was working on. */
  readonly gitBranch?: string;
  /**
   * Provider-side tag or label attached to the session.
   *
   * What archiving is built on — see {@link ARCHIVED_TAG}. Artemis reads any
   * other value through untouched: the field belongs to the provider's store,
   * and a session someone tagged from the CLI should not be silently rewritten
   * by a desktop app that understands one word of the vocabulary.
   */
  readonly tag?: string;
  /** Model most recently used in the session. */
  readonly model?: string;
}

/**
 * The tag Artemis writes to archive a session.
 *
 * A plain word rather than a namespaced key, because it is written into the
 * provider's store where a person may well read it — `claude` shows tags of its
 * own accord — and `artemis:archived` would be Artemis's filing system leaking
 * into somebody else's file.
 */
export const ARCHIVED_TAG = 'archived';

/** Whether this session has been archived, by Artemis or from the CLI. */
export function isArchived(session: { readonly tag?: string }): boolean {
  return session.tag === ARCHIVED_TAG;
}
