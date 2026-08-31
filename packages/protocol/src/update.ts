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

/**
 * Which part of the install is running.
 *
 * `checking` is the odd one: it is not part of the install so much as the
 * question the install asks before it starts — *is the version on this card
 * still the newest one?* An offer can sit at the foot of the sidebar for days,
 * and the release it names can be superseded in that time, so the answer is
 * re-read at the moment of the click rather than trusted from whenever the card
 * appeared. It is a few hundred bytes and usually over before it is seen, but a
 * step that can fail slowly (an unreachable feed waits out its deadline) is a
 * step the surface has to be able to name.
 */
export type UpdateStep = 'checking' | 'downloading' | 'verifying' | 'unpacking' | 'installing';

/**
 * The repository releases are published to, and the page a person goes to for a
 * build they must fetch by hand.
 *
 * Shared rather than repeated because both processes need it now and they have
 * already drifted once. The updater builds its download URLs from the slug and
 * puts the page on an `error` state as the way out; the About pane offers the
 * page standing — to a Linux user it is not a fallback but the only route there
 * is — and the bug reporter files against the same repository. Three literals,
 * one fact.
 *
 * The drift is not theoretical: the repository moved from the Rx-Ventures org
 * to seth-torrence on 2026-08-30, the copies moved at different times, and the
 * dev mock never moved at all — it was still handing the browser preview the
 * pre-move URL when this constant replaced it.
 *
 * One copy stays out of reach and has to be kept in step by hand: the `publish`
 * block in `apps/desktop/electron-builder.yml`, which has no runtime accessor,
 * the same situation as `appId`. That block is what gets baked into each build,
 * so it is the authority; this constant is what the app says about it.
 */
export const ARTEMIS_REPO = 'seth-torrence/artemis';

/** @see ARTEMIS_REPO */
export const ARTEMIS_RELEASES_URL = `https://github.com/${ARTEMIS_REPO}/releases`;

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
