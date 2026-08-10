/**
 * Client-side id minting.
 *
 * `RunInput.runId` is caller-supplied on purpose: the renderer mints the id,
 * paints optimistic UI, and starts matching inbound events immediately —
 * events for a run can arrive before `runs.start` resolves.
 */

/** A random, collision-resistant id. Falls back when `randomUUID` is absent. */
export function newId(prefix = ''): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random()
          .toString(36)
          .slice(2, 10)}`;
  return prefix ? `${prefix}_${uuid}` : uuid;
}
