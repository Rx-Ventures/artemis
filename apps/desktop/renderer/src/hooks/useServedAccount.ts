/**
 * The served account behind the pane's active pick, for the chrome that names
 * and measures accounts.
 *
 * At an Artemis Server profile the *profile* stops identifying an account —
 * the server wears several, and the pick that decides which one a prompt is
 * charged to is the model route's account prefix. The status-bar segment, the
 * corner meter and the navigator footer all need the same answer ("which
 * account, and how full is it"), which this hook gives from the two places the
 * renderer already holds it: the active model's `account*` fields and the
 * served-gauge map the main process's poller fills.
 */

import { activeModel, activeProfile, useApp } from '../state/store';
import { usePane } from '../state/paneContext';
import {
  servedAccountLabel,
  servedGaugeFor,
  type ServedGauge,
} from '../state/servedAccounts';

export function useServedAccount(): {
  /** The pane runs at an Artemis Server profile. */
  readonly atServer: boolean;
  /** The account's display name, or `null` while no pick names one. */
  readonly label: string | null;
  /** The account's gauge, once a reading for it has landed. */
  readonly gauge: ServedGauge | undefined;
} {
  const profileId = usePane((s) => s.activeProfileId);
  const atServer = usePane((s) => activeProfile(s)?.providerId === 'artemis');
  const selected = usePane(activeModel);
  const gauges = useApp((s) => s.planUsageByServerAccount);

  if (!atServer || profileId === null) return { atServer: false, label: null, gauge: undefined };
  const gauge = servedGaugeFor(gauges, profileId, selected);
  // The gauge's label is the server's own current name for the account; the
  // catalogue's copy stands in until a reading lands.
  return { atServer: true, label: gauge?.label ?? servedAccountLabel(selected), gauge };
}
