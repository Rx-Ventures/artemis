/**
 * One delegated agent's conversation, in a tab of its own.
 * ============================================================================
 *
 *     ╭──────────────────────────────╮╭─────────────────────────────────╮
 *     │ artemis › Audit the repo     ││ ▸ zsh ✕ │ 3 running │ Explore ✕ │
 *     ├──────────────────────────────┤├─────────────────────────────────┤
 *     │  › delegated to 4 agents     ││  I'll read the four files first │
 *     │                              ││  ⏵ Read scripts/release.ts      │
 *     │                              ││  ⏵ Grep "authenticate"          │
 *     ╰──────────────────────────────╯╰─────────────────────────────────╯
 *
 * The delegated list answers "what is running". This answers "what is it
 * *doing*", and it is the only thing that can: a subagent writes its own
 * transcript beside its parent's, and the parent keeps the final report and
 * nothing else. Everything the agent actually did — the reasoning, the tool
 * calls, the file it could not find — exists only in that file, which is why
 * following a workflow from the main thread has never been possible.
 *
 * ## It is the ordinary transcript, deliberately
 *
 * The body is `<Transcript/>` under a `PaneProvider`, the same two lines
 * `PaneColumn` uses. That is the whole reason `AgentView` carries a `Pane`: a
 * subagent's events are ordinary {@link AgentEvent}s, so pointing the existing
 * renderer at a transcript built from them yields every tool card, diff, fold
 * and artifact tile without a second implementation of any of it. A bespoke
 * subagent renderer would have started as a list of strings and spent the next
 * six months growing back into this one.
 *
 * What is *not* rendered is the rest of a column: no composer, no status line,
 * no caption. Nothing here can be talked to — this is a view of a file the
 * provider is writing, and offering a text box under it would be an invitation
 * to type into something with no one on the other end.
 *
 * ## The poll, and why there has to be one
 *
 * A subagent's output never crosses the provider's stream, so there is no event
 * to subscribe to: the only way to see progress is to read the file again. The
 * effect below does that while the task is live and stops when it settles, and
 * each read asks only for what is new — see `refreshAgentView`.
 */

import { useEffect, type ReactElement } from 'react';

import {
  agentViewIsLive,
  refreshAgentView,
  useApp,
  type AgentView,
} from '../state/store';
import { PaneProvider } from '../state/paneContext';
import { Transcript } from './Transcript';

/** How often an open tab asks for what the agent has said since. */
const POLL_MS = 2_500;

export function AgentPane({ viewKey }: { readonly viewKey: string }): ReactElement | null {
  const view = useApp((s) => s.agentViews.find((one) => one.key === viewKey));
  // Read as a boolean rather than as the task, so a progress message that only
  // moves a token count does not re-render a transcript.
  const live = useApp((s) => agentViewIsLive(s, viewKey));

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void refreshAgentView(viewKey), POLL_MS);
    return () => clearInterval(timer);
  }, [viewKey, live]);

  /*
   * One read on settling, outside the interval above.
   *
   * The last thing an agent does is the thing most worth reading, and it lands
   * in the file *after* the row stops being live — so an effect that only ran
   * while `live` would tear its timer down one tick before the final answer
   * arrived, leaving the tab permanently one message short of the point.
   */
  useEffect(() => {
    if (live) return;
    void refreshAgentView(viewKey);
  }, [viewKey, live]);

  if (view === undefined) return null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {view.error === null ? null : <AgentError message={view.error} />}
      <PaneProvider pane={view.pane}>
        {view.consumed === 0 ? <AgentEmpty view={view} live={live} /> : <Transcript />}
      </PaneProvider>
    </div>
  );
}

/**
 * Nothing read yet — which is two different situations, and they must not read
 * the same.
 *
 * A *running* agent with an empty transcript has simply not written its first
 * message; the poll behind this will fill it in, and saying "nothing here"
 * would be wrong within seconds. A *settled* one with nothing on disk is the
 * genuine empty case: the provider kept no transcript for it, which is what
 * happens to a task that never really started.
 */
function AgentEmpty({
  view,
  live,
}: {
  readonly view: AgentView;
  readonly live: boolean;
}): ReactElement {
  return (
    <div className="grid flex-1 place-items-center p-4 text-center text-2xs text-ink-faint">
      {view.loading || live
        ? 'Waiting for this agent to say something…'
        : 'This agent left no transcript.'}
    </div>
  );
}

/**
 * The last read failed, said above whatever was read before it.
 *
 * A banner rather than a replacement, because a poll that fails on message two
 * hundred must not throw away the hundred and ninety-nine already on screen —
 * the transcript is still the most useful thing in the window, and the failure
 * is a footnote to it.
 */
function AgentError({ message }: { readonly message: string }): ReactElement {
  return (
    <p className="shrink-0 border-b border-hairline bg-wash px-2 py-1 text-3xs text-ink-faint">
      Could not read this agent: {message}
    </p>
  );
}
