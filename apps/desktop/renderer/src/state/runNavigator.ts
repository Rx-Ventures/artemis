/**
 * The run navigator's state logic.
 * ============================================================================
 *
 * The profile chip and the model chip open one popover: a Finder-column
 * navigator, columns revealed left to right as picks land — Profile → Model →
 * Effort — with a footer of toggles that exist only when the picked
 * combination supports them. This module holds every decision that surface
 * makes that is not markup: which columns are revealed, which footer controls
 * exist, and which model rows a query shows. Pure functions over
 * `SessionState`, so the rules are testable without mounting a menu.
 *
 * The per-row facts (exhaustion, pressure, cost posture, the Recommended row)
 * live next door in `modelFacts.ts` — they are shared with the palette's
 * models page and Settings § Models, which this surface deliberately is not.
 */

import type { PermissionMode, ProviderModelOption } from '@rx-artemis/protocol';

import type { SessionState } from './pane';
import {
  activeCapabilities,
  activeModel,
  activeModels,
  fastModeAvailable,
  providerOffersFastMode,
  thinkingLevels,
} from './store';

/* -------------------------------------------------------------------------- */
/* Column reveal                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Which columns the navigator shows right now.
 *
 * The profile column always exists — it is the first pick, and with nothing
 * picked it is the whole surface. Each later column is revealed by the pick to
 * its left *landing*, not by being interacted with this session: a pane opened
 * with a profile and model already chosen shows all three at once, because
 * those picks landed long ago and hiding their consequences would make the
 * navigator forget what it knows.
 */
export interface NavigatorColumns {
  /**
   * A profile pick has landed, so the model column exists. It may still be
   * *dead* — a provider with no model choice renders the column as the reason
   * why, the same disabled-with-reason rule every degraded control follows —
   * but dead is revealed, not hidden.
   */
  readonly model: boolean;
  /**
   * A model pick has resolved to a concrete option *and* that model has a
   * thinking ladder. A provider with no effort scale has no ladder to show,
   * so the column is absent rather than present-and-dead — there is nothing
   * on the surface for a reason to attach to (the same carve-out the old
   * model popover made for its Thinking row).
   */
  readonly effort: boolean;
}

export function navigatorColumns(state: SessionState): NavigatorColumns {
  const profilePicked = state.activeProfileId !== null;
  const model = profilePicked;
  const effort = model && activeModel(state) !== undefined && thinkingLevels(state).length > 0;
  return { model, effort };
}

/* -------------------------------------------------------------------------- */
/* Footer gating                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Fast mode's three-way state, unchanged from the status line's rules:
 *
 * - `absent`   — no model this provider offers has the concept, so the switch
 *                could never light up and is not drawn. The narrow carve-out
 *                from "never hide a control" (`providerOffersFastMode`).
 * - `disabled` — the *selected* model does not offer it. Actionable: another
 *                model on the same ladder does, so the switch stays, dead,
 *                and switching models lights it up.
 * - `offered`  — the picked combination supports it.
 */
export type FastModePresence = 'absent' | 'disabled' | 'offered';

/** The toggles the footer draws, gated by the picked combination. */
export interface NavigatorFooter {
  readonly fastMode: FastModePresence;
  /**
   * What the switch shows when drawn: on *and* honoured. A flag the run would
   * ignore must not read as in force — the same `on && available` expression
   * the closed chip's zap uses, so the two can never disagree.
   */
  readonly fastModeOn: boolean;
  /**
   * Permission modes the provider accepts, empty when the concept does not
   * apply — in which case the footer's permission control is absent and the
   * status line's own mode chip (which stays regardless) carries the
   * disabled-with-reason explanation.
   */
  readonly permissionModes: readonly PermissionMode[];
}

export function navigatorFooter(state: SessionState): NavigatorFooter {
  const offered = providerOffersFastMode(state);
  const available = fastModeAvailable(state);
  return {
    fastMode: !offered ? 'absent' : available ? 'offered' : 'disabled',
    fastModeOn: state.fastMode && available,
    permissionModes: activeCapabilities(state).permissionModes,
  };
}

/* -------------------------------------------------------------------------- */
/* The model column's rows                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Match a model against a typed query, on everything a user might type:
 * short label, full name, the alias id and the wire id it resolves to —
 * "sonnet" and "claude-sonnet-5" must both find the same row. Substring, not
 * fuzzy, for the reason the settings catalogue gives: someone typing "gpt"
 * wants the gpt models, not a ranked guess that also matches something else.
 */
function matchesQuery(model: ProviderModelOption, needle: string): boolean {
  return (
    model.id.toLowerCase().includes(needle) ||
    model.label.toLowerCase().includes(needle) ||
    (model.displayName?.toLowerCase().includes(needle) ?? false) ||
    (model.resolvedModel?.toLowerCase().includes(needle) ?? false)
  );
}

/**
 * The rows the model column lists for a query.
 *
 * With nothing typed: the per-profile pins, plus the selected model when it is
 * not among them — the same appended-selection rule the old picker carried,
 * because a radio group whose value names no row paints no check. The rest of
 * the catalogue stays behind the search and behind the "Edit quick access…"
 * door, both of which say how much they are hiding.
 *
 * With a query: the *whole* catalogue is searched, not the shortlist. A
 * shortlist you have to search is not a search — the box exists precisely to
 * reach the models the pins left out, without a trip to settings.
 */
export function navigatorModelRows(
  catalogue: readonly ProviderModelOption[],
  quick: readonly ProviderModelOption[],
  selected: ProviderModelOption | undefined,
  query: string,
): readonly ProviderModelOption[] {
  const needle = query.trim().toLowerCase();
  if (needle.length > 0) return catalogue.filter((model) => matchesQuery(model, needle));
  if (selected === undefined || quick.some((m) => m.id === selected.id)) return quick;
  return [...quick, selected];
}

/**
 * How many catalogue models the list is not showing. Only worth saying when it
 * is a shortlist — "9 more" is information, "0 more" is noise — and the
 * callers already render nothing at zero.
 */
export function hiddenModelCount(catalogueSize: number, shown: number): number {
  return Math.max(0, catalogueSize - shown);
}
