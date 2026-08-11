/**
 * The transcript pane.
 * ============================================================================
 *
 * THE PERFORMANCE CONTRACT. This is the app's hot path and the rules below are
 * not stylistic — breaking any one of them turns a fast provider's output into
 * O(items) work per token:
 *
 *  1. **The list renders ids, not items.** `useTranscriptIds` fires only when
 *     the transcript's *shape* changes — a block appears, or it is reset. A
 *     token never touches it, so `Transcript` itself does not re-render while
 *     text streams.
 *  2. **Every row is memoised and fetches its own item.** `useTranscriptItem`
 *     subscribes to one id, so a `text.delta` notifies exactly one leaf.
 *     `Row` is wrapped in `memo` so a structural change (some *other* block
 *     appearing) does not re-render the rows that did not change.
 *  3. **Streaming text is never markdown.** Markdown is parsed once, when the
 *     block completes. Re-parsing a long answer on every frame is the single
 *     most expensive thing this UI could do.
 *  4. **Nothing here reads streaming text into `useApp`.** The transcript model
 *     lives outside React on purpose; see `state/transcript.ts`.
 *
 * A consequence worth knowing: the scroll follower uses a `ResizeObserver` on
 * the content element rather than an effect on the id list, because streaming
 * text grows the content without changing the list at all.
 *
 * The scroll container here is a plain overflow div rather than shadcn's
 * `ScrollArea` — also deliberate. Tail-following needs direct `scrollTop`
 * control of the real scroller, and Radix's viewport is an internal element
 * this version does not hand back.
 *
 * ============================================================================
 * THIS IS THE ONLY COLUMN.
 *
 * There is no detail pane to send anything to, so everything a tool call
 * produced expands *in place*: a one-line summary that opens to reveal the full
 * input and output, a file edit that opens as a real diff, and a permission
 * prompt that is answered where it happened. Rule 2 above is what makes that
 * affordable — an expanded row's open state is local to the row, and the row is
 * memoised on its own id, so opening one cannot re-render the rest and a
 * streaming sibling cannot collapse it.
 *
 * ============================================================================
 * THE LAYOUT: A SPINE, AND TWO SIDES OF A CONVERSATION
 *
 * Every row is a `Message` from `components/ui/message`, so the whole pane is
 * one grid: a fixed label gutter (the *spine*) and a content column. The spine
 * carries the tone system — `tool` in cyan, `thinking` in sage, `end` in mint
 * or amber or signal — which is how the pane stays scannable at a glance now
 * that the content column is much wider than it used to be.
 *
 * `Message`'s `align` flips the whole row, gutter included, so a user turn puts
 * its label on the right where the bubble is. That is the back-and-forth: the
 * user speaks from the right in a filled ember bubble, everything the agent
 * does answers from the left.
 *
 * Three choices inside that worth stating, because each had an obvious
 * alternative:
 *
 *  - **The user bubble is `tinted`, not `default`.** `default` fills with
 *    `--primary`, which here is ember at 80% lightness. A one-line prompt would
 *    survive that; a pasted twenty-line spec is a floodlight in a dark room
 *    someone is sitting in for eight hours. `tinted` is the same ember hue at
 *    30% lightness — unmistakably "yours", legible in `--ink`, and quiet.
 *  - **The agent bubble is `ghost`.** Agent output here is code-heavy markdown
 *    — fenced blocks, tables, diff-adjacent prose — not chat banter. A filled
 *    80%-wide blob would both squeeze the code and fight `.md`, which already
 *    draws its own wells and rules. Ghost strips the chrome and lets the answer
 *    read as full-width prose, which is what it is.
 *  - **No `MessageGroup` / `BubbleGroup`, and no avatars.** Grouping
 *    consecutive turns would require a row to know about its neighbours, and
 *    rule 1 says the list only ever hands down an id — a row cannot see the row
 *    before it without the list reading items, which is the exact thing that
 *    makes streaming O(items). Avatars were dropped separately: a repeated
 *    glyph on every turn costs horizontal room in a pane whose whole point is
 *    now to be wide, and the spine already says who is talking.
 *
 * Thinking, tool calls, permissions, notices and run-ends are NOT conversation
 * turns and are not bubbles. They stay the compact rows that expand in place,
 * aligned onto the same spine so the column reads as one thread.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowDownIcon,
  BrainIcon,
  InfoIcon,
  SparklesIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from 'lucide-react';

import { useTranscriptIds, useTranscriptItem } from '../hooks/useTranscript';
import { detectFileEdit } from '../lib/diff';
import { activeCapabilities, useApp, type ConversationWidth } from '../state/store';
import {
  formatClock,
  formatDuration,
  formatJson,
  formatTokens,
  formatUsd,
  oneLine,
  summarizeToolInput,
} from '../lib/format';
import type {
  AssistantItem,
  NoticeItem,
  PermissionItem,
  RunEndItem,
  ThinkingItem,
  ToolItem,
  UserItem,
} from '../state/transcript';
import { DiffView } from './DiffView';
import { EmptyState } from './EmptyState';
import { InlinePermission } from './InlinePermission';
import { CodeBlock, Fold, StatusDot, ToneBadge, toneClasses, type Tone } from './primitives';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import { Message, MessageContent } from '@/components/ui/message';
import { cn } from '@/lib/utils';

/** Markdown parsing is skipped above this size; the cost is not worth it. */
const MARKDOWN_LIMIT = 80_000;

/**
 * How wide the conversation column is allowed to get.
 *
 * A static lookup, NOT `` `max-w-${width}` ``: Tailwind v4 finds classes by
 * scanning source text for literals, so an interpolated name is never generated
 * and the column would silently fall back to full-bleed. Every value here has
 * to appear verbatim somewhere in the file, and this object is that somewhere.
 *
 * `comfortable` is deliberately *wider* than the `max-w-4xl` this pane used
 * before the overhaul. The ask was a wider conversation, and the setting most
 * people never touch is the one that has to deliver it; the two steps above it
 * are for people who want more. `full` is uncapped on purpose — at that point
 * the reader has explicitly said they want the whole window, and second-guessing
 * them with a hidden prose measure would make the setting a lie.
 */
const COLUMN_MAX: Record<ConversationWidth, string> = {
  comfortable: 'max-w-5xl',
  wide: 'max-w-7xl',
  full: 'max-w-none',
};

export function Transcript(): ReactElement {
  const ids = useTranscriptIds();
  // A scalar the user changes from Appearance, not transcript state — reading
  // it here costs one subscription that fires roughly never, and does not go
  // near rule 4 (which is about streaming text, not preferences).
  const width = useApp((s) => s.conversationWidth);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance < 48;
    pinned.current = atBottom;
    setShowJump((current) => (current === !atBottom ? current : !atBottom));
  }, []);

  /**
   * Follow the tail while the user is at the bottom, and stop the moment they
   * scroll up. Observing the content box catches streaming growth, which no
   * React-level signal would.
   *
   * The turn-entry animation also grows the box for ~160ms after a turn
   * appears, so this fires a handful of extra times per turn. That is fine —
   * the handler only assigns `scrollTop` — but it is why the animation is a
   * short translate rather than a height transition, which would fight the
   * follower for as long as it ran.
   */
  useEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!viewport || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const jumpToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = true;
    setShowJump(false);
    el.scrollTop = el.scrollHeight;
  }, []);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-x-hidden overflow-y-auto overscroll-contain"
      >
        {/* Horizontal padding lives here rather than on each row so every row —
            bubble or machinery — shares one left edge for its gutter. */}
        <div
          ref={contentRef}
          className={cn('mx-auto flex w-full flex-col gap-1.5 px-4 py-4', COLUMN_MAX[width])}
        >
          {ids.length === 0 ? <EmptyState /> : ids.map((id) => <Row key={id} id={id} />)}
          <Working />
        </div>
      </div>

      {showJump ? (
        <Button
          variant="outline"
          size="xs"
          onClick={jumpToEnd}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-4xl bg-raised px-3 shadow-lg shadow-black/40"
        >
          <ArrowDownIcon />
          Jump to latest
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The working indicator, for providers that do not stream.
 *
 * `partialMessages` is a rendering capability rather than a control, so it can
 * never be "gated" the way a button is — but leaving it unhandled would mean a
 * non-streaming provider showed a completely static screen for the whole time
 * it was thinking, which reads as a hung app. This is where that capability is
 * answered: a typewriter when the provider streams, a pulse when it does not.
 *
 * Subscribed narrowly, and to `useApp` rather than to the transcript, so it
 * costs nothing while text is arriving.
 */
function Working(): ReactElement | null {
  const live = useApp((s) => s.run !== null && s.run.status === 'running');
  const streams = useApp((s) => activeCapabilities(s).partialMessages);
  const waiting = useApp((s) => s.permissionQueue.length > 0);

  if (!live || streams || waiting) return null;
  return (
    <Line label="agent" tone="cyan">
      <span className="flex items-center gap-2 py-1 font-mono text-2xs text-ink-faint">
        <StatusDot tone="cyan" pulse />
        Working — this provider sends whole messages, so nothing appears until the block is done.
      </span>
    </Line>
  );
}

/* -------------------------------------------------------------------------- */
/* Row dispatch                                                               */
/* -------------------------------------------------------------------------- */

const Row = memo(function Row({ id }: { readonly id: string }): ReactElement | null {
  const item = useTranscriptItem(id);
  if (!item) return null;

  switch (item.kind) {
    case 'user':
      return <UserRow item={item} />;
    case 'assistant':
      return <AssistantRow item={item} />;
    case 'thinking':
      return <ThinkingRow item={item} />;
    case 'tool':
      return <ToolRow item={item} />;
    case 'permission':
      return <PermissionRow item={item} />;
    case 'notice':
      return <NoticeRow item={item} />;
    case 'run-end':
      return <RunEndRow item={item} />;
    default:
      return null;
  }
});

/**
 * Shared row chrome: the label gutter and the content column.
 *
 * `w-14` is not arbitrary. `formatClock` produces `HH:MM:SS` — eight monospace
 * characters, ~53px at `text-2xs` — and the clock has to fit on one line under
 * the label or the gutter reflows on hover and shoves every row down by a line.
 * 3.5rem is the first Tailwind step that clears it.
 *
 * The gutter follows `align`: `Message` reverses the row for `end`, so a user
 * turn's label lands on the right next to its bubble. The text alignment has to
 * flip with it, hence the `group-data-[align=end]/message` override — without
 * it the label would be right-aligned against the window edge, hanging off the
 * bubble it names.
 */
function Line({
  label,
  tone = 'neutral',
  ts,
  align = 'start',
  children,
  className,
}: {
  readonly label: string;
  readonly tone?: Tone;
  readonly ts?: number;
  readonly align?: 'start' | 'end';
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  return (
    <Message align={align} className={cn('group', className)}>
      <div className="w-14 shrink-0 pt-px text-right group-data-[align=end]/message:text-left">
        <div className={cn('font-mono text-2xs tracking-wider uppercase', toneClasses.text[tone])}>
          {label}
        </div>
        {ts === undefined ? null : (
          <div className="mt-0.5 font-mono text-2xs text-ink-faint opacity-0 transition-opacity group-hover:opacity-60">
            {formatClock(ts)}
          </div>
        )}
      </div>
      {/* `gap-2.5` is `MessageContent`'s default and is tuned for a chat app
          with one bubble per turn; the transcript stacks a bubble against a
          badge, so it wants a tighter rhythm. */}
      <MessageContent className="gap-1">{children}</MessageContent>
    </Message>
  );
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

function UserRow({ item }: { readonly item: UserItem }): ReactElement {
  return (
    <Line label="you" tone="ember" ts={item.ts} align="end" className="turn-in mt-3">
      <Bubble
        align="end"
        variant="tinted"
        // Dimmed means "Apollo has not confirmed delivery" — a prompt whose
        // call failed stays dimmed on purpose.
        className={cn(item.pending && 'opacity-70')}
      >
        {/* Monospace, matching the composer the text was typed into: a prompt
            that contains a path or a shell fragment should look the same after
            it is sent as it did before. `rounded-br-sm` is the tail — the one
            square corner points back at the author, which is what makes an
            aligned bubble read as *from* someone rather than merely offset. */}
        <BubbleContent className="rounded-2xl rounded-br-sm border-ember/25 px-3.5 py-2 font-mono text-sm whitespace-pre-wrap">
          {item.text}
        </BubbleContent>
      </Bubble>
    </Line>
  );
}

function AssistantRow({ item }: { readonly item: AssistantItem }): ReactElement {
  return (
    <Line
      label={item.agentId ? 'subagent' : 'agent'}
      tone="neutral"
      ts={item.ts}
      className="turn-in"
    >
      {/* `ghost` zeroes the padding and the fill, so `.md` renders against the
          page exactly as it did before the bubbles landed and needs no
          bubble-specific overrides. `w-full` replaces `BubbleContent`'s default
          `w-fit`: a shrink-wrapped answer would let one long line decide how
          wide the tables and code blocks below it are allowed to be. */}
      <Bubble variant="ghost">
        <BubbleContent className="w-full">
          {item.streaming || item.text.length > MARKDOWN_LIMIT ? (
            <div
              className={cn(
                'font-mono text-sm leading-relaxed break-words whitespace-pre-wrap text-ink',
                item.streaming && 'caret',
              )}
            >
              {item.text}
            </div>
          ) : (
            <div className="md text-ink">
              <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
            </div>
          )}
        </BubbleContent>
      </Bubble>
      {item.stopReason && item.stopReason !== 'end_turn' && item.stopReason !== 'tool_use' ? (
        <ToneBadge tone="amber" className="w-fit">
          stop: {item.stopReason}
        </ToneBadge>
      ) : null}
    </Line>
  );
}

function ThinkingRow({ item }: { readonly item: ThinkingItem }): ReactElement {
  const preview = item.redacted ? 'redacted by the provider' : oneLine(item.text, 64);
  return (
    <Line label="thinking" tone="sage" ts={item.ts}>
      {/* Collapsed by default: thinking is context for the answer, not the
          answer, and expanded by default it buries every other row. */}
      <Fold
        triggerClassName="text-2xs"
        summary={
          <span className="flex min-w-0 items-center gap-1.5 text-sage/80">
            <BrainIcon className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate font-mono text-2xs">{preview || 'thinking…'}</span>
            {item.streaming ? <StatusDot tone="sage" pulse /> : null}
          </span>
        }
      >
        <div className="rounded-md border border-sage/25 bg-inset px-3 py-2 font-mono text-2xs leading-relaxed break-words whitespace-pre-wrap text-sage/85">
          {item.redacted
            ? 'This thinking block was encrypted or withheld by the provider.'
            : item.text}
        </div>
      </Fold>
    </Line>
  );
}

const TOOL_TONE: Record<ToolItem['status'], Tone> = {
  running: 'cyan',
  ok: 'mint',
  error: 'signal',
  denied: 'amber',
  cancelled: 'neutral',
};

/**
 * A tool call: one compact line that expands in place.
 *
 * Collapsed it is icon + name + primary argument, which is all a reader needs
 * to follow what the agent is doing. Expanded it reveals the full input and
 * output — and, when the call edits a file, a diff instead of two walls of
 * quoted string.
 *
 * Not a bubble, and that is the point: a tool call is not something anyone
 * said. It sits on the same spine as the agent's turns so the thread reads
 * continuously, but it keeps card chrome so the eye can tell work from speech
 * without reading a word.
 *
 * Open state is local, which is what lets it survive the re-renders driven by
 * the external transcript store: this row is memoised on its own id, so a
 * `text.delta` on a sibling never reaches it and cannot fold it shut.
 */
function ToolRow({ item }: { readonly item: ToolItem }): ReactElement {
  const [open, setOpen] = useState(false);
  const tone = TOOL_TONE[item.status];
  const summary = item.title ?? summarizeToolInput(item.input);
  const failed = item.status === 'error' || item.status === 'denied';

  // Recomputed only when the arguments change, which for a tool call is once:
  // `tool.end` carries the result, not a new input. A diff is cheap but not
  // free, and this row can be re-rendered by its own status transition.
  const edit = useMemo(() => detectFileEdit(item.name, item.input), [item.name, item.input]);

  return (
    <Line label="tool" tone="cyan" ts={item.ts}>
      <div
        className={cn(
          'rounded-lg border bg-panel/60',
          failed ? 'border-signal/35' : 'border-line',
          open && 'border-line-strong',
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none hover:bg-raised/40 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <TerminalIcon
            className={cn(
              'size-3 shrink-0',
              item.status === 'running' ? 'text-cyan' : 'text-ink-faint',
            )}
            aria-hidden="true"
          />
          <span className="shrink-0 font-mono text-xs font-semibold text-ink">{item.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-faint">
            {summary}
          </span>
          {/* A file edit advertises its size in the collapsed row. Whether an
              edit touched three lines or three hundred is the single most
              useful thing to know before deciding to open it. */}
          {edit && !edit.whole ? (
            <span className="shrink-0 font-mono text-2xs">
              <span className="text-mint">+{edit.added}</span>{' '}
              <span className="text-signal">−{edit.removed}</span>
            </span>
          ) : null}
          {item.durationMs === undefined ? null : (
            <span className="shrink-0 font-mono text-2xs text-ink-faint">
              {formatDuration(item.durationMs)}
            </span>
          )}
          <ToneBadge tone={tone}>
            {item.status === 'running' ? <StatusDot tone="cyan" pulse /> : null}
            {item.status}
          </ToneBadge>
        </button>

        {open ? (
          <div className="flex flex-col gap-1.5 border-t border-line px-2.5 py-2">
            {edit ? <DiffView edit={edit} /> : null}

            <Fold
              // The raw arguments stay available even when a diff was rendered:
              // the diff is a reading of the input, and the input is the record.
              defaultOpen={edit === null}
              triggerClassName="text-2xs"
              summary={
                <span className="font-mono text-2xs">{edit ? 'raw arguments' : 'input'}</span>
              }
            >
              <CodeBlock text={formatJson(item.input)} />
            </Fold>

            {item.status === 'running' ? (
              <p className="font-mono text-2xs text-cyan">still running…</p>
            ) : (
              <Fold
                // A failure opens itself. Everything else stays folded: a
                // successful `Read` of a 4,000-line file is noise.
                defaultOpen={failed}
                triggerClassName="text-2xs"
                summary={
                  <span className={cn('font-mono text-2xs', failed && 'text-signal')}>
                    {failed ? 'error' : 'result'}
                  </span>
                }
              >
                <CodeBlock
                  tone={failed ? 'error' : 'neutral'}
                  text={
                    item.error
                      ? `${item.error.code}: ${item.error.message}\n\n${item.resultText ?? formatJson(item.result)}`
                      : (item.resultText ?? formatJson(item.result))
                  }
                />
              </Fold>
            )}
          </div>
        ) : null}
      </div>
    </Line>
  );
}

/**
 * A permission prompt, answered where it happened.
 *
 * The card itself is `InlinePermission`; this only supplies the transcript's
 * row chrome. Pending prompts get an amber rail label so they are findable by
 * scrolling as well as by the status line's counter.
 */
function PermissionRow({ item }: { readonly item: PermissionItem }): ReactElement {
  return (
    <Line
      label={item.state === 'pending' ? 'approve?' : 'approval'}
      tone={item.state === 'pending' ? 'amber' : 'neutral'}
      ts={item.ts}
      className={item.state === 'pending' ? 'my-1' : undefined}
    >
      <InlinePermission item={item} />
    </Line>
  );
}

function NoticeRow({ item }: { readonly item: NoticeItem }): ReactElement {
  const tone: Tone = item.level === 'error' ? 'signal' : item.level === 'warn' ? 'amber' : 'neutral';
  const Icon = item.level === 'info' ? InfoIcon : TriangleAlertIcon;
  return (
    <Line label="" tone={tone} ts={item.ts}>
      <div className="flex items-start gap-1.5 py-0.5">
        <Icon
          className={cn('mt-[2px] size-3 shrink-0', toneClasses.text[tone])}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <span className="font-mono text-2xs text-ink-muted">{item.text}</span>
          {item.detail ? (
            <span className="ml-1.5 font-mono text-2xs text-ink-faint">{item.detail}</span>
          ) : null}
        </div>
      </div>
    </Line>
  );
}

const END_TONE: Record<RunEndItem['reason'], Tone> = {
  completed: 'mint',
  interrupted: 'amber',
  disposed: 'neutral',
  max_turns: 'amber',
  budget_exceeded: 'amber',
  permission_denied: 'amber',
  error: 'signal',
};

/**
 * The run-end block, trimmed to the user's `runSummary` setting.
 *
 * Two rules hold across all three settings, and they are why this is not a
 * plain boolean:
 *
 *  - **A failure is never hidden.** `'never'` still renders an errored run —
 *    just the reason and the message, with the accounting dropped. This row is
 *    the only place a run's error text and code ever appear, so hiding it would
 *    turn a failed run into one that simply stopped.
 *  - **Anything the user has to act on stays.** `'failures'` keeps interrupted,
 *    `max_turns` and `budget_exceeded` too: each means the answer on screen is
 *    cut short, which is not something to infer from the absence of a row.
 *
 * The cost of hiding a clean run's block is that consecutive runs lose their
 * visual boundary — the `end` gutter label was doing that work. Prompts are
 * bubbles, so the seam is still legible; if that stops being true, the fix is a
 * rule between runs, not putting the accounting back.
 */
function RunEndRow({ item }: { readonly item: RunEndItem }): ReactElement | null {
  const setting = useApp((s) => s.runSummary);
  const tone = END_TONE[item.reason];
  const usage = item.usage;
  const failed = item.reason === 'error';

  if (setting === 'never' ? !failed : setting === 'failures' && item.reason === 'completed') {
    return null;
  }
  const accounting = setting !== 'never';

  return (
    <Line label="end" tone={tone} ts={item.ts} className="mb-4">
      <div
        className={cn(
          'rounded-lg border px-2.5 py-1.5',
          failed ? 'border-signal/40 bg-signal/5' : 'border-line bg-panel/60',
        )}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1.5">
            {failed ? (
              <TriangleAlertIcon className="size-3 text-signal" aria-hidden="true" />
            ) : (
              <SparklesIcon className="size-3 text-mint" aria-hidden="true" />
            )}
            <span className="font-mono text-2xs tracking-wider text-ink-muted uppercase">
              {item.reason.replace(/_/g, ' ')}
            </span>
          </span>
          {accounting && item.durationMs !== undefined ? (
            <Stat label="took" value={formatDuration(item.durationMs)} />
          ) : null}
          {accounting && item.numTurns !== undefined ? (
            <Stat label="turns" value={String(item.numTurns)} />
          ) : null}
          {accounting && usage ? (
            <>
              <Stat label="in" value={formatTokens(usage.tokens.inputTokens)} />
              <Stat label="out" value={formatTokens(usage.tokens.outputTokens)} />
              {usage.tokens.cacheReadInputTokens === undefined ? null : (
                <Stat label="cached" value={formatTokens(usage.tokens.cacheReadInputTokens)} />
              )}
              {usage.costUsd === undefined ? null : (
                <Stat label="cost" value={formatUsd(usage.costUsd)} emphasis />
              )}
            </>
          ) : null}
        </div>

        {item.error ? (
          <div className="mt-1.5">
            <p className="font-mono text-2xs text-signal">{item.error.message}</p>
            <p className="mt-0.5 font-mono text-2xs text-ink-faint">
              code {item.error.code}
              {item.error.retryable ? ' · retryable' : ''}
            </p>
          </div>
        ) : null}
      </div>
    </Line>
  );
}

function Stat({
  label,
  value,
  emphasis = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: boolean;
}): ReactElement {
  return (
    <span className="flex items-baseline gap-1">
      <span className="font-mono text-2xs text-ink-faint">{label}</span>
      <span className={cn('font-mono text-2xs', emphasis ? 'text-ember' : 'text-ink-muted')}>
        {value}
      </span>
    </span>
  );
}
