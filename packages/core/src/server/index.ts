/**
 * The local server, as the main process consumes it.
 *
 * Three pieces and one seam: {@link createCatalogue} turns the engine's three
 * questions into the catalogue other programs read, and
 * {@link createArtemisServer} puts it on a port. Neither knows anything about
 * Electron — the engine reaches this through {@link CatalogueSource}, which is
 * the wall `packages/core` keeps everywhere else too.
 *
 * `workspaces.ts` is the third: a connection names where its turns run, and that
 * has to become a real directory on this disk — created and reaped when it is
 * scratch space, checked when it is the user's own folder.
 *
 * `runs.ts` is the fourth, and it is the one that only exists because clients
 * are remote: it remembers which connection owns which completions-started
 * run, so a run can be addressed after the request that started it is over,
 * and it holds the two deadlines that keep "addressable later" from meaning
 * "alive forever". The remote bridge's own runs are governed by `guard.ts`
 * instead, and no run is ever in both.
 *
 * `signin.ts` is the fifth, and it exists because a server has no terminal. A
 * profile is worth serving once an account is signed into it, and in a
 * container there is nobody inside to run the login — so the login runs *here*,
 * driven by a person on a client somewhere else. It carries a verification URL
 * out and a pasted code in, and no credential either way.
 */

export {
  createCatalogue,
  DEFAULT_CATALOGUE_TTL_MS,
  type Catalogue,
  type CatalogueOptions,
  type CatalogueSource,
} from './catalogue.js';

export {
  createWorkspaceResolver,
  sweepStaleWorkspaces,
  SCRATCH_ROOT_NAME,
  STALE_WORKSPACE_MS,
  WorkspaceUnavailableError,
  type ResolvedWorkspace,
  type WorkspaceResolver,
  type WorkspaceResolverOptions,
} from './workspaces.js';

export {
  createSessionLedger,
  SERVER_LEDGER_FILE,
  workspaceKeyFor,
  type LedgerEntry,
  type LedgerScope,
  type SessionLedger,
} from './ledger.js';

export {
  chatChunk,
  chatResponse,
  finishReasonFor,
  promptFromMessages,
  runTurn,
  UNATTENDED_PERMISSION_MESSAGE,
  type RunSource,
  type TurnEvent,
  type TurnRequest,
  type TurnResult,
} from './completions.js';

export {
  createRunDirectory,
  reviewPermissionDecision,
  DEFAULT_DETACHED_RUN_TTL_MS,
  DEFAULT_PERMISSION_PARK_MS,
  type DecisionReview,
  type RunDirectory,
  type RunDirectoryOptions,
} from './runs.js';

export {
  createSignInDirector,
  findCodeRejection,
  findUserCode,
  findVerificationUrl,
  looksLikeCodePrompt,
  resolveExecutable,
  DEFAULT_SIGN_IN_TIMEOUT_MS,
  DuplicateProfileLabelError,
  SignInBusyError,
  SignInNotWaitingError,
  SignInUnavailableError,
  type ProfileAdmin,
  type ServerProfileRecord,
  type SignInDirector,
  type SignInDirectorOptions,
} from './signin.js';

export {
  createArtemisServer,
  handleServerRequest,
  isStreamReply,
  type ArtemisServer,
  type ArtemisServerOptions,
  type ServerContext,
  type ServerReply,
  type ServerRequestInfo,
  type ServerStreamReply,
  type SessionSource,
  type UsageSource,
} from './http.js';

export {
  createPushFeed,
  type FeedEvent,
  type FeedReplay,
  type FeedScope,
  type PushFeed,
  type PushFeedOptions,
} from './feed.js';

export { type RemoteStreamOptions } from './remote.js';

export {
  createRemoteRunGuard,
  type RemoteRunGuard,
  type RemoteRunGuardOptions,
  type TrackedRun,
} from './guard.js';

export {
  createRemoteTerminals,
  MAX_REMOTE_TERMINALS_PER_FAMILY,
  TooManyRemoteTerminalsError,
  UnknownRemoteTerminalError,
  type RemoteTerminals,
  type RemoteTerminalsOptions,
  type TerminalSource,
} from './terminals.js';

export { pathsOf, readRunInput, RunInputError, type ParsedRunInput } from './runInput.js';
