/**
 * The provider registry.
 *
 * A map from {@link ProviderId} to a live {@link ProviderAdapter}, plus the one
 * place that turns adapters into the {@link ProviderDescriptor} list the
 * renderer sees.
 *
 * Adding a provider is a single line — see
 * {@link createDefaultProviderRegistry}. Everything else that a new provider
 * needs (capability-driven UI degradation, permission plumbing, session
 * listing, and the credential→environment mapping) is keyed off the seam, so
 * the registry has nothing provider-specific in it beyond a display label.
 *
 * That last item was for a long time the exception that made the claim untrue:
 * credential resolution wrote Anthropic's variable names for every provider.
 * It now comes from `ProviderAdapter.credentials`, which is also where this
 * file reads `signInHowTo` from, so the profile screen explains a sign-in in
 * the words of the adapter whose command it is about to generate.
 *
 * ## Why unregistered providers still appear
 *
 * `describe()` returns a descriptor for *every* known {@link ProviderId}, not
 * just the registered ones, marking the rest unavailable with a reason. Hiding
 * a provider entirely tells the user nothing; showing "Codex — not yet
 * supported in this build" tells them where the product is going and stops them
 * hunting for a setting that does not exist. Protocol's `ProviderDescriptor`
 * carries `available` + `unavailableReason` precisely so the UI can grey a row
 * out rather than drop it.
 */

import type { ProviderDescriptor, ProviderId } from '@rx-apollo/protocol';
import { NO_CAPABILITIES, PROVIDER_IDS } from '@rx-apollo/protocol';

import { createClaudeAdapter } from './claude.js';
import type { ClaudeAdapterOptions } from './claude.js';
import { adapterError } from './types.js';
import type { AdapterAvailability, ProviderAdapter, ProviderRegistry } from './types.js';

/** Display names for every known provider, including ones not yet implemented. */
export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** Why a known provider is missing from this build. */
const NOT_IMPLEMENTED_REASON = 'Not supported in this version of Apollo yet.';

/** Create an empty registry, optionally seeded with adapters. */
export function createProviderRegistry(
  adapters: readonly ProviderAdapter[] = [],
): ProviderRegistry {
  const byId = new Map<ProviderId, ProviderAdapter>();
  const availabilityCache = new Map<ProviderId, AdapterAvailability>();

  const registry: ProviderRegistry = {
    register(adapter, options) {
      if (byId.has(adapter.id) && options?.replace !== true) {
        throw adapterError(
          'invalid_request',
          `A "${adapter.id}" adapter is already registered. Pass { replace: true } to override it.`,
        );
      }
      byId.set(adapter.id, adapter);
      availabilityCache.delete(adapter.id);
    },

    unregister(id) {
      availabilityCache.delete(id);
      return byId.delete(id);
    },

    has(id) {
      return byId.has(id);
    },

    get(id) {
      return byId.get(id);
    },

    require(id) {
      const adapter = byId.get(id);
      if (adapter === undefined) {
        throw adapterError('provider_not_found', `No adapter is registered for provider "${id}".`);
      }
      return adapter;
    },

    list() {
      // `PROVIDER_IDS` is the display order, so the UI never has to sort.
      return PROVIDER_IDS.map((id) => byId.get(id)).filter(
        (adapter): adapter is ProviderAdapter => adapter !== undefined,
      );
    },

    async describe(options) {
      if (options?.refresh === true) availabilityCache.clear();
      const includeUnregistered = options?.includeUnregistered !== false;

      const descriptors: ProviderDescriptor[] = [];
      for (const id of PROVIDER_IDS) {
        const adapter = byId.get(id);

        if (adapter === undefined) {
          if (!includeUnregistered) continue;
          descriptors.push({
            id,
            label: PROVIDER_LABELS[id],
            capabilities: NO_CAPABILITIES,
            // No adapter, so no sign-in instructions to give. The profile
            // editor says the provider is unavailable rather than handing out
            // someone else's command.
            models: [],
            effortLevels: [],
            available: false,
            unavailableReason: NOT_IMPLEMENTED_REASON,
          });
          continue;
        }

        const availability = await resolveAvailability(adapter, availabilityCache);
        descriptors.push({
          id,
          label: adapter.label,
          capabilities: adapter.capabilities,
          // Published so the profile screen can explain the sign-in it is about
          // to generate a command for, in the words of the adapter that owns
          // that command — the same pattern as the permission-mode picker
          // reading `capabilities.permissionModes`.
          signInHowTo: adapter.credentials.signIn.howTo,
          // And the same again for the model and effort pickers. An adapter
          // that declares neither publishes empty lists rather than absent
          // ones, so the renderer can tell "no choice offered" from "this
          // descriptor predates the field" without a second code path.
          models: adapter.models ?? [],
          effortLevels: adapter.effortLevels ?? [],
          available: availability.available,
          unavailableReason: availability.available
            ? undefined
            : (availability.unavailableReason ?? 'Unavailable.'),
        });
      }

      return descriptors;
    },
  };

  for (const adapter of adapters) registry.register(adapter);
  return registry;
}

async function resolveAvailability(
  adapter: ProviderAdapter,
  cache: Map<ProviderId, AdapterAvailability>,
): Promise<AdapterAvailability> {
  const cached = cache.get(adapter.id);
  if (cached !== undefined) return cached;

  let availability: AdapterAvailability;
  if (adapter.checkAvailability === undefined) {
    // No probe means "always usable once registered".
    availability = { available: true };
  } else {
    try {
      availability = await adapter.checkAvailability();
    } catch (error) {
      // A probe that throws is itself evidence the provider is not usable, and
      // it must never take down the whole `providers:list` call.
      availability = {
        available: false,
        unavailableReason: `Could not check availability: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      };
    }
  }

  cache.set(adapter.id, availability);
  return availability;
}

/** Options for {@link createDefaultProviderRegistry}. */
export interface DefaultProviderRegistryOptions {
  /** Forwarded to the Claude adapter. */
  readonly claude?: ClaudeAdapterOptions;
}

/**
 * The registry Apollo ships with.
 *
 * **This is the one-line registration point.** A Codex adapter is added by
 * appending `createCodexAdapter(options?.codex)` to the array below; nothing
 * else in the app changes, because everything downstream reads capabilities
 * rather than provider identity.
 */
export function createDefaultProviderRegistry(
  options?: DefaultProviderRegistryOptions,
): ProviderRegistry {
  return createProviderRegistry([
    createClaudeAdapter(options?.claude),
    // createCodexAdapter(options?.codex),
    // createOpenCodeAdapter(options?.opencode),
  ]);
}
