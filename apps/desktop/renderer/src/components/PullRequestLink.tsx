/**
 * A GitHub pull request link, and what it says when you hover it.
 * ============================================================================
 *
 *      ╭────────────────────────────────────╮
 *      │ ● Merged                           │
 *      │ Delegated work splits live from    │
 *      │ finished                           │
 *      │ ────────────────────────────────── │
 *      │ Rx-Ventures/artemis #141           │
 *      │ ✓ checks passing                   │
 *      │ +128 −34  across 6 files           │
 *      ╰────────────────────────────────────╯
 *
 * An agent that opens a PR says so by pasting the URL, and until now that was
 * the end of it: a link that answers none of the three questions a reader
 * actually has — did it land, is CI green, how big is it — each of which costs a
 * trip to a browser and a lost thread of attention (#130).
 *
 * ## Every link stays a link
 *
 * This wraps rather than replaces. The anchor renders identically whether or not
 * a reading is available, whether or not `gh` is installed, and whether or not
 * anyone is signed in — the popover is additive, and the failure mode of the
 * whole feature is the link you already had.
 *
 * That is the same rule `CodeSpan` keeps for file paths, arrived at from the
 * other direction. There, a path is *not* a link until main confirms there is a
 * file, because the thing being added is clickability and a link that cannot be
 * followed is a lie. Here the link already works — GitHub is on the other end of
 * it either way — so the honest default is to draw it and let the detail arrive
 * when it can.
 *
 * ## The reading is taken on hover, not on render
 *
 * One `gh` subprocess per pull request, and a settled transcript can carry a
 * dozen links. `usePullRequest`'s `active` flag is what keeps that to the ones
 * somebody actually asked about; see `lib/pullRequests.ts` for why this differs
 * from the eager sweep `useReachableFile` does.
 *
 * The consequence on screen is a moment of "Reading…" the first time a link is
 * hovered, which is the honest thing to show — the alternative is a popover that
 * opens empty and fills in, which reads as broken for the same second.
 *
 * ## Why a tooltip and not a popover
 *
 * `TooltipContent`, despite this being a card rather than a label, exactly as
 * `SessionTooltip` is. The trigger is a word in a paragraph: it must not take
 * focus, must not swallow the click that opens the PR, and must open on hover.
 * Radix's Popover is a click-to-open surface that does all three of those the
 * other way round.
 */

import { useState, type ComponentPropsWithoutRef, type ReactElement } from 'react';
import { CheckIcon, CircleDotIcon, ClockIcon, GitMergeIcon, GitPullRequestIcon, XIcon } from 'lucide-react';

import {
  parsePullRequestUrl,
  type PullRequestProblem,
  type PullRequestState,
  type PullRequestSummary,
} from '@rx-artemis/protocol';

import { usePullRequest } from '../lib/pullRequests';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * How each state is drawn, in GitHub's own colours as this theme spells them.
 *
 * A state is a mark *and* a word, never a colour alone. The four are two pairs
 * that differ by hue — open/merged, draft/closed — and a reader who cannot
 * separate green from purple would be left with a coloured dot and no way to
 * tell a merge from an open PR.
 */
const STATE: Record<PullRequestState, { readonly label: string; readonly tone: string; readonly Icon: typeof GitMergeIcon }> = {
  open: { label: 'Open', tone: 'text-mint', Icon: GitPullRequestIcon },
  draft: { label: 'Draft', tone: 'text-ink-muted', Icon: GitPullRequestIcon },
  merged: { label: 'Merged', tone: 'text-lunar', Icon: GitMergeIcon },
  closed: { label: 'Closed', tone: 'text-signal', Icon: XIcon },
};

/**
 * What each problem says, and it is written as a next action wherever there is
 * one.
 *
 * "Not signed in" is a fact about the machine; `gh auth login` is the thing to
 * do about it, and a popover that states the fact without the remedy makes the
 * reader go and find out what the remedy was. Same rule the profile screen's
 * sign-in card follows.
 */
const PROBLEM: Record<PullRequestProblem, string> = {
  'no-cli': 'The GitHub CLI is not installed — brew install gh',
  'not-signed-in': 'The GitHub CLI is not signed in — gh auth login',
  'not-found': 'No pull request there, or this account cannot see it',
  failed: 'Could not read this pull request',
};

function ChecksLine({ checks }: { readonly checks: PullRequestSummary['checks'] }): ReactElement | null {
  // `none` renders nothing rather than "no checks". A repository without CI is
  // the ordinary case for most of them, and a row asserting its absence would be
  // a line of text spent on a non-event.
  if (checks === 'none') return null;

  const tone =
    checks === 'passing' ? 'text-mint' : checks === 'failing' ? 'text-signal' : 'text-amber';
  const Icon = checks === 'passing' ? CheckIcon : checks === 'failing' ? XIcon : ClockIcon;
  const label =
    checks === 'passing' ? 'checks passing' : checks === 'failing' ? 'checks failing' : 'checks running';

  return (
    <p className={cn('flex items-center gap-1.5 text-2xs leading-snug', tone)}>
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {label}
    </p>
  );
}

/**
 * The diff, as the two numbers people actually compare.
 *
 * `+` and `−` keep their own colours because that is the one convention every
 * diff everywhere already uses, and the file count rides along in prose because
 * "+400 −12" over one file and over forty are different-sized changes wearing
 * the same badge.
 *
 * A true minus sign rather than a hyphen, matching `DiffView`.
 */
function DiffLine({ summary }: { readonly summary: PullRequestSummary }): ReactElement {
  const { additions, deletions, changedFiles } = summary;
  return (
    <p className="flex items-center gap-1.5 text-2xs leading-snug">
      <span className="font-mono text-mint">+{additions}</span>
      <span className="font-mono text-signal">−{deletions}</span>
      <span className="text-ink-faint">
        across {changedFiles} {changedFiles === 1 ? 'file' : 'files'}
      </span>
    </p>
  );
}

/** The card, or the one line that stands in for it. */
function Card({
  slug,
  number,
  summary,
  problem,
}: {
  readonly slug: string;
  readonly number: number;
  readonly summary: PullRequestSummary | undefined;
  readonly problem: PullRequestProblem | undefined;
}): ReactElement {
  const reference = `${slug} #${String(number)}`;

  if (summary === undefined) {
    return (
      <div className="flex min-w-0 flex-col gap-1 py-0.5">
        <p className="font-mono text-2xs leading-snug break-all text-ink-muted">{reference}</p>
        <p className="text-2xs leading-snug wrap-anywhere text-ink-faint">
          {problem === undefined ? 'Reading…' : PROBLEM[problem]}
        </p>
      </div>
    );
  }

  const state = STATE[summary.state];

  return (
    <div className="flex min-w-0 flex-col gap-1.5 py-0.5">
      <p className={cn('flex items-center gap-1.5 text-2xs leading-snug', state.tone)}>
        <state.Icon className="size-3 shrink-0" aria-hidden="true" />
        {state.label}
        {summary.author === null ? null : (
          <span className="min-w-0 truncate text-ink-faint">by {summary.author}</span>
        )}
      </p>

      {summary.title === '' ? null : (
        <p className="text-xs leading-snug font-medium wrap-anywhere text-ink">{summary.title}</p>
      )}

      <div aria-hidden="true" className="h-px bg-line" />

      <p className="font-mono text-2xs leading-snug break-all text-ink-muted">{reference}</p>
      <ChecksLine checks={summary.checks} />
      <DiffLine summary={summary} />
    </div>
  );
}

/**
 * An anchor in rendered markdown, which is sometimes a pull request.
 *
 * Most links are not, so the overwhelmingly common path through here is the
 * plain `<a>` react-markdown would have rendered anyway. The hook runs
 * regardless — hooks must — and costs a no-op subscription on a `null` ref.
 *
 * `target`/`rel` are not set and must not be: `security.ts` intercepts every
 * navigation out of the renderer and hands it to `shell.openExternal`, so the
 * link opens in the user's browser by virtue of being a link. A `target="_blank"`
 * would ask Electron for a second window on the way to the same place.
 */
export function PullRequestLink({
  href,
  children,
  ...rest
}: ComponentPropsWithoutRef<'a'>): ReactElement {
  const ref = href === undefined ? null : parsePullRequestUrl(href);
  /*
   * Opening the tooltip is what asks. Held here rather than read off Radix's
   * own state because the request has to start on the *first* open and survive
   * every close after it — a reading already taken is worth painting instantly
   * next time, and re-arming on each open would re-ask for it.
   */
  const [asked, setAsked] = useState(false);
  const result = usePullRequest(ref, asked);

  if (ref === null) return <a href={href} {...rest}>{children}</a>;

  return (
    <Tooltip onOpenChange={(open) => open && setAsked(true)}>
      <TooltipTrigger asChild>
        <a href={href} {...rest}>
          {children}
        </a>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <Card
          slug={`${ref.owner}/${ref.repo}`}
          number={ref.number}
          summary={result?.summary}
          problem={result?.problem}
        />
      </TooltipContent>
    </Tooltip>
  );
}
