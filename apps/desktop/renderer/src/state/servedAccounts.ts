/**
 * Joining a served catalogue to the accounts behind it.
 *
 * An Artemis Server profile is one profile wearing several accounts: the
 * catalogue it serves flattens every account × model into routes
 * (`work-max/opus`), and its usage report keys gauges by the *serving side's*
 * profile id. Three places need to walk that join — the account rows in the
 * navigator, the model column that narrows to one account, and the status-bar
 * meter that names and measures the account behind the active pick — and each
 * had grown its own parsing of the route prefix and the note's wording. This
 * module is the one copy.
 *
 * Every reader here prefers the catalogue's explicit `account*` fields and
 * falls back to what older servers encode implicitly: the slug is the route
 * prefix, the label is the `"<account> — "` prefix the adapter writes into
 * every note. The fallbacks are load-bearing, not vestigial — a 2.4.3 server
 * sends none of the explicit fields.
 */

import type { PlanUsage, ProviderModelOption } from '@rx-artemis/protocol';

/** One served account's gauge, as `installPlanUsageFeed` files it. */
export interface ServedGauge {
  readonly usage: PlanUsage;
  readonly label: string;
}

/** The store's served-gauge map, keyed `profileId/accountId`. */
export type ServedGaugeMap = Readonly<Record<string, ServedGauge>>;

/** The route prefix naming an option's account, however old the server. */
export function servedAccountSlug(model: ProviderModelOption | null | undefined): string | null {
  if (model === null || model === undefined) return null;
  if (model.accountSlug !== undefined) return model.accountSlug;
  const slash = model.id.indexOf('/');
  return slash > 0 ? model.id.slice(0, slash) : null;
}

/**
 * The display name of the account behind an option, however old the server.
 *
 * The fallback reads the note the adapter composes — `"<account> — <note>"` —
 * but only when the separator is actually there. A note without one is *some
 * sentence*, not a name: `unlistedModel`'s "Chosen earlier; this account's
 * current model list does not include it." is a note exactly like any other,
 * and treating it as the account name printed that whole sentence into the
 * status bar. Without the separator the slug is the most that can honestly be
 * claimed, and the explicit field is why new servers never land here at all.
 */
export function servedAccountLabel(model: ProviderModelOption | null | undefined): string | null {
  if (model === null || model === undefined) return null;
  if (model.accountLabel !== undefined) return model.accountLabel;
  if (model.note.includes(' — ')) return model.note.split(' — ')[0] ?? null;
  return servedAccountSlug(model);
}

/**
 * The gauge behind an option: exact join on the account id where the server
 * sent one, label match against the map's own labels where it did not — the
 * server enforces label uniqueness, which is what makes the fallback honest.
 */
export function servedGaugeFor(
  gauges: ServedGaugeMap,
  profileId: string,
  model: ProviderModelOption | null | undefined,
): ServedGauge | undefined {
  if (model === null || model === undefined) return undefined;
  if (model.accountId !== undefined) {
    const exact = gauges[`${profileId}/${model.accountId}`];
    if (exact !== undefined) return exact;
  }
  const label = servedAccountLabel(model);
  if (label === null) return undefined;
  for (const [key, entry] of Object.entries(gauges)) {
    if (key.startsWith(`${profileId}/`) && entry.label === label) return entry;
  }
  return undefined;
}

/** One account's rows of the flattened catalogue, in catalogue order. */
export interface ServedAccount {
  readonly slug: string;
  readonly label: string;
  /** The serving side's profile id, absent against an older server. */
  readonly id?: string;
  readonly models: readonly string[];
}

/**
 * The accounts a served catalogue flattens together, grouped by route prefix.
 *
 * A row without a prefix (no `/` in its id) belongs to no account and is left
 * out, exactly as the account rows have always treated it.
 */
export function groupServedAccounts(
  catalogue: readonly ProviderModelOption[],
): readonly ServedAccount[] {
  const groups = new Map<string, { label: string; id?: string; models: string[] }>();
  for (const model of catalogue) {
    const slug = servedAccountSlug(model);
    if (slug === null) continue;
    let group = groups.get(slug);
    if (group === undefined) {
      group = {
        label: servedAccountLabel(model) ?? slug,
        ...(model.accountId === undefined ? {} : { id: model.accountId }),
        models: [],
      };
      groups.set(slug, group);
    }
    group.models.push(model.id);
  }
  return [...groups.entries()].map(([slug, group]) => ({ slug, ...group }));
}

/**
 * The catalogue narrowed to one account, for the model column at a server.
 *
 * `null` means "no account to narrow by" and returns the list whole. So does a
 * slug that matches nothing — a selection pointing at an account the server no
 * longer serves must degrade to the full list, not to an empty column claiming
 * the server offers no models.
 */
export function scopedToServedAccount(
  catalogue: readonly ProviderModelOption[],
  slug: string | null,
): readonly ProviderModelOption[] {
  if (slug === null) return catalogue;
  const scoped = catalogue.filter((model) => servedAccountSlug(model) === slug);
  return scoped.length > 0 ? scoped : catalogue;
}
