/**
 * What an update in flight is actually doing.
 * ============================================================================
 *
 * The updater used to report one `working` phase for the whole install, on the
 * argument that the steps were the main process's business and the renderer
 * would draw them all the same way. That was wrong in the only place it
 * mattered: the release zip is around 196MB, so `working` is minutes of a
 * static sentence and a 14px spinner — and a user who cannot tell a download
 * from a hang clicks the button again. Three times, in the report that prompted
 * this.
 *
 * So the phase now carries what it is doing and how far in it is. The steps are
 * the ones a person would name if asked what an update does — fetch it, check
 * it, unpack it, put it in place — rather than the function names behind them.
 *
 * ## Why the counts are nullable
 *
 * Two of the four steps can count bytes honestly and two cannot. A download
 * knows its total only if the server sent `content-length`, and the `gh`
 * fallback route shells out and reports nothing at all; unpacking is one
 * `ditto` call that says nothing until it is done. Rather than invent a
 * denominator — a bar that jumps to 90% and sits there is worse than no bar —
 * an unknown count is `null` and the surface draws an indeterminate state.
 * {@link updatePercent} is the one place that decision is made.
 */

/** Which part of the install is running. */
export type UpdateStep = 'downloading' | 'verifying' | 'unpacking' | 'installing';

/**
 * One reading of an install in flight.
 *
 * A snapshot, not a delta: it rides {@link UpdateState}, which is pushed whole
 * at every window, so a dropped message costs a frame of smoothness and never
 * leaves a bar stranded at the wrong number.
 */
export interface UpdateProgress {
  readonly step: UpdateStep;
  /** Bytes handled so far in this step, or `null` when the step cannot count. */
  readonly transferred: number | null;
  /** Bytes expected in this step, or `null` when the total is not known. */
  readonly total: number | null;
}

/**
 * How far along, 0–100, or `null` when this step cannot honestly say.
 *
 * `null` for a missing count, a missing total, and — deliberately — a total of
 * zero: dividing by it yields `Infinity` or `NaN`, and both render as a bar
 * that is lying rather than one that is absent.
 *
 * Clamped because the two counts come from different places (the byte counter
 * on the stream, the `content-length` header) and a server that under-reports
 * its own body would otherwise produce a bar past its own end.
 */
export function updatePercent(progress: UpdateProgress | null | undefined): number | null {
  if (!progress) return null;
  const { transferred, total } = progress;
  if (transferred === null || total === null || total <= 0) return null;
  if (!Number.isFinite(transferred) || !Number.isFinite(total)) return null;
  return Math.min(100, Math.max(0, Math.round((transferred / total) * 100)));
}
