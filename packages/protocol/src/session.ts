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
  /** The profile whose config directory this session was found in. */
  readonly profileId: ProfileId;
  /** Working directory the session ran in. */
  readonly cwd: string;

  /**
   * Best available label. Adapters resolve this in order of preference: a
   * user-assigned title, then the provider's generated summary, then the first
   * prompt, then a placeholder. The UI should render it verbatim.
   */
  readonly title: string;
  /** True when {@link title} came from the user rather than being derived. */
  readonly titleIsCustom?: boolean;
  /** Opening prompt, for a secondary line in the list. */
  readonly firstPrompt?: string;

  /** Last-modified time, ms since epoch. Sort key for the history pane. */
  readonly updatedAt: number;
  /** Creation time, ms since epoch, when the provider records one. */
  readonly createdAt?: number;

  /** Number of messages, when cheaply available. */
  readonly messageCount?: number;
  /** Transcript size in bytes, when the provider stores it as a file. */
  readonly sizeBytes?: number;
  /** Git branch the session was working on. */
  readonly gitBranch?: string;
  /** Provider-side tag or label attached to the session. */
  readonly tag?: string;
  /** Model most recently used in the session. */
  readonly model?: string;
}
