/**
 * Run-lifecycle errors.
 *
 * Shares the {@link ApolloError} base with the rest of the engine so the main
 * process has exactly one `instanceof` check to make before turning a thrown
 * value into an `IpcFail`.
 */

import { ApolloError } from '../profiles/errors.js';

/**
 * A run could not be started, steered, or torn down.
 *
 * The `code` distinguishes the cases that matter to the UI:
 *
 * - `provider_not_found` — no adapter is registered for the requested provider.
 * - `invalid_request`    — unknown run id, unsupported capability, bad input.
 * - `cancelled`          — the registry is shutting down.
 * - `transport`          — the provider's event stream failed.
 */
export class RunError extends ApolloError {}
