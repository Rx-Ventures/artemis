/**
 * `@rx-ventures/artemis-sdk` — talk to an Artemis server from your own program.
 *
 * ```ts
 * import { createArtemisClient, deepestThinkingLevel } from '@rx-ventures/artemis-sdk';
 *
 * const artemis = createArtemisClient({ token: process.env.ARTEMIS_TOKEN });
 *
 * for (const model of await artemis.models({ profile: 'work-max' })) {
 *   console.log(model.route, deepestThinkingLevel(model), model.fastMode);
 * }
 * ```
 *
 * Two surfaces, two tools. This one reads the catalogue — which accounts an
 * installation has, what each offers, and what each model actually accepts. To
 * *run* a turn once that lands, point the OpenAI SDK at `${baseUrl}/v1`: it is
 * the same server, and there is no reason for Artemis to ship a worse copy of a
 * client that already works everywhere.
 *
 * The wire types come from `@rx-artemis/protocol` and are re-exported here, so a
 * consumer imports one package rather than two.
 */

/**
 * Running a turn, through whichever OpenAI client you already use.
 *
 * `openAiOptions` configures it; `buildChatRequest` builds the body and refuses
 * settings the chosen route would silently drop. Neither imports the `openai`
 * package — see `openai.ts` for why that is a peer concern.
 */
export {
  buildChatRequest,
  checkChatSettings,
  openAiOptions,
  UnsupportedSettingError,
  type ChatRequestBody,
  type ChatSettings,
  type OpenAiCompatibleOptions,
} from './openai.js';

export type { ArtemisChatExtensions } from '@rx-artemis/protocol';
export { CHAT_EXTENSIONS_FIELD, readChatExtensions } from '@rx-artemis/protocol';

export {
  acceptsThinkingLevel,
  canRunTurns,
  createArtemisClient,
  deepestThinkingLevel,
  usableModels,
  ArtemisAuthError,
  ArtemisNotImplementedError,
  ArtemisServerError,
  ArtemisUnreachableError,
  DEFAULT_BASE_URL,
  type ArtemisClient,
  type ArtemisClientOptions,
  type ListModelsOptions,
  type RequestOptions,
} from './client.js';

/**
 * The shapes the server sends.
 *
 * Re-exported rather than redeclared: a second definition of `ServerModel` in
 * this package would be free to drift from the one the server actually
 * serialises, and the drift would only show up as a field that is quietly
 * always `undefined`.
 */
export type {
  Capabilities,
  OpenAiModel,
  OpenAiModelList,
  ProviderId,
  ProviderKind,
  ServerErrorBody,
  ServerHealthBody,
  ServerConnectionInfo,
  ServerCreateProfileRequest,
  ServerModel,
  ServerModelsBody,
  ServerProfile,
  ServerProfileCreatedBody,
  ServerProfilesBody,
  ServerSignInAccount,
  ServerSignInState,
  ServerSignInStatus,
  ServerThinkingLevel,
  ServerWorkspace,
} from '@rx-artemis/protocol';

/**
 * Route helpers, from the same module the server composes routes with.
 *
 * `parseModelRoute` is the useful one for a consumer: it is how you split a
 * `work-max/opus` a user typed into the account and the model, with the same
 * first-separator rule the server applies — a model id may contain a slash, an
 * account slug never does.
 */
export {
  modelRoute,
  parseModelRoute,
  profileSlug,
  summariseWorkspace,
  workspaceCanRunTurns,
  // The predicate a sign-in poller stops on, from the module that defines the
  // states — a consumer writing its own list of "finished" states would
  // eventually poll a flow the server had already forgotten.
  isSignInSettled,
  SERVER_SIGN_IN_STATES,
  SERVER_API_VERSION,
  DEFAULT_SERVER_PORT,
} from '@rx-artemis/protocol';
