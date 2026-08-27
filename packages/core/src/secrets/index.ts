/**
 * Key managers: the part of them core owns.
 *
 * All of the protocol talking, and none of the storage. The providers below
 * are pure request/response machines over an injected transport — give one a
 * connection, a credential and a reference and it gives back a value; give it
 * a bad one and it gives back a *category*, which is the thing the panes above
 * are actually built on.
 *
 * What lives in `apps/desktop/main` instead: which connections exist, where
 * their credentials are encrypted, when a token is renewed, and the
 * certificate preview — all four need Electron, a disk, or a clock the tests
 * would have to fake.
 */

export * from './credentials.js';
export * from './doppler.js';
export * from './openbao.js';
export * from './transport.js';
export * from './types.js';

import type { SecretProviderId } from '@rx-artemis/protocol';

import { createDopplerProvider } from './doppler.js';
import { createOpenBaoProvider } from './openbao.js';
import { createHttpsTransport } from './transport.js';
import type { SecretManagerProvider, SecretTransport } from './types.js';

/**
 * Every provider, over one transport.
 *
 * A record rather than a list because every caller has an id in hand — a
 * connection's `provider`, a ref's `provider` — and iterating a list to find a
 * match is how a third provider ends up supported in three places and
 * forgotten in a fourth.
 *
 * The transport is a parameter with a default so that a test can hand in
 * canned bytes without also having to know which providers exist.
 */
export function createSecretProviders(
  transport: SecretTransport = createHttpsTransport(),
): Readonly<Record<SecretProviderId, SecretManagerProvider>> {
  return Object.freeze({
    openbao: createOpenBaoProvider(transport),
    doppler: createDopplerProvider(transport),
  });
}
