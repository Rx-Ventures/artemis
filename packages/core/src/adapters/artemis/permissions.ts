/**
 * What a remote permission answer may and may not carry.
 * ============================================================================
 *
 * A {@link PermissionDecision} is richer than "yes" or "no". It can switch the
 * run's permission mode, widen the directories it may touch, and write rules to
 * settings files that outlive the run. Every one of those is legitimate from the
 * desktop app, where the person answering owns the machine the run is on. None
 * is legitimate over a connection token, whose whole authority is one folder on
 * *someone else's* machine.
 *
 * The server already refuses these at the parser — see `reviewPermissionDecision`
 * in `server/runs.ts`, whose rules this mirrors. So this guard is not the
 * security boundary; the server is. It exists so the boundary is not reached by
 * accident: a UI that offered "always allow, for this project" against a remote
 * run would build a decision the server answers with a 400, and the honest place
 * to catch that is here, before the round trip, with a message that says which
 * option is not available rather than a bare rejection from the wire.
 *
 * The three refusals, matching the server exactly:
 *
 *  - **A durable scope.** `local`, `project` and `user` write to the serving
 *    machine's own settings. Only `once` and `session` stay inside the run.
 *  - **A mode switch.** `setMode` changes how the run asks — and its most
 *    dangerous value, `bypassPermissions`, is approve-everything. The run's mode
 *    is the serving user's, not this client's to change.
 *  - **A directory grant.** `addDirectories` / `removeDirectories` widen the
 *    connection's pinned workspace by the very thing the workspace constrains.
 */

import type { PermissionDecision, PermissionRuleUpdate, PermissionScope } from '@rx-artemis/protocol';

import { adapterError } from '../types.js';

/** The only two scopes a remote decision may use. See the module header. */
const REMOTE_SCOPES: readonly PermissionScope[] = ['once', 'session'];

function scopeIsRemote(scope: PermissionScope | undefined): boolean {
  return scope === undefined || (REMOTE_SCOPES as readonly string[]).includes(scope);
}

/**
 * Throw an `invalid_request` {@link AdapterError} for anything the server would
 * refuse with a 400. Returns cleanly for a decision that shapes only this run.
 */
export function guardRemoteDecision(decision: PermissionDecision): void {
  // Only an approval carries a scope; a denial has none to widen.
  if (decision.behavior === 'allow' && !scopeIsRemote(decision.scope)) {
    throw adapterError(
      'invalid_request',
      'A remote run can only remember an approval for this run — a durable scope writes to the serving machine\'s own settings, which a connection token may not reach.',
    );
  }
  for (const update of decision.updatedPermissions ?? []) {
    guardRuleUpdate(update);
  }
}

function guardRuleUpdate(update: PermissionRuleUpdate): void {
  if (update.type === 'setMode') {
    throw adapterError(
      'invalid_request',
      'A remote run\'s permission mode is the serving user\'s setting and cannot be changed from here — approve or refuse the call in front of you instead.',
    );
  }
  if (update.type === 'addDirectories' || update.type === 'removeDirectories') {
    throw adapterError(
      'invalid_request',
      'A remote run may not change which directories it can touch — where its turns run was chosen when the connection token was created.',
    );
  }
  if (!scopeIsRemote(update.scope)) {
    throw adapterError(
      'invalid_request',
      'A rule change on a remote run can only last for this run — a durable scope writes to the serving machine\'s own settings.',
    );
  }
}
