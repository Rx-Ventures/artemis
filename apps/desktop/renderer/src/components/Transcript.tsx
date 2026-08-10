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
import { activeCapabilities, useApp } from '../state/store';
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
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Markdown parsing is skipped above this size; the cost is not worth it. */
const MARKDOWN_LIMIT = 80_000;

export function Transcript(): ReactElement {
  const ids = useTranscriptIds();
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
        <div ref={contentRef} className="mx-auto flex w-full max-w-4xl flex-col py-3">
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

/** Shared row chrome: a narrow label rail and a content column. */
function Line({
  label,
  tone = 'neutral',
  ts,
  children,
  className,
}: {
  readonly label: string;
  readonly tone?: Tone;
  readonly ts?: number;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  return (
    <div className={cn('group flex gap-3 px-4 py-1', className)}>
      <div className="w-16 shrink-0 pt-[3px] text-right">
        <div className={cn('font-mono text-2xs tracking-wider uppercase', toneClasses.text[tone])}>
          {label}
        </div>
        {ts === undefined ? null : (
          <div className="mt-0.5 font-mono text-2xs text-ink-faint opacity-0 transition-opacity group-hover:opacity-60">
            {formatClock(ts)}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

function UserRow({ item }: { readonly item: UserItem }): ReactElement {
  return (
    <Line label="you" tone="brass" ts={item.ts} className="mt-2">
      <div
        className={cn(
          'rounded-md border-l-2 border-brass/60 bg-raised/50 px-3 py-1.5 font-mono text-sm break-words whitespace-pre-wrap text-ink',
          // Dimmed means "Libra has not confirmed delivery" — a prompt whose
          // call failed stays dimmed on purpose.
          item.pending && 'opacity-70',
        )}
      >
        {item.text}
      </div>
    </Line>
  );
}

function AssistantRow({ item }: { readonly item: AssistantItem }): ReactElement {
  return (
    <Line label={item.agentId ? 'subagent' : 'agent'} tone="neutral" ts={item.ts}>
      <div className="min-w-0">
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
        {item.stopReason && item.stopReason !== 'end_turn' && item.stopReason !== 'tool_use' ? (
          <div className="mt-1">
            <ToneBadge tone="amber">stop: {item.stopReason}</ToneBadge>
          </div>
        ) : null}
      </div>
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
          'rounded-md border bg-panel/60',
          failed ? 'border-signal/35' : 'border-line',
          open && 'border-line-strong',
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-raised/40 focus-visible:ring-2 focus-visible:ring-ring/50"
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

function RunEndRow({ item }: { readonly item: RunEndItem }): ReactElement {
  const tone = END_TONE[item.reason];
  const usage = item.usage;
  const failed = item.reason === 'error';
  return (
    <Line label="end" tone={tone} ts={item.ts} className="mb-3">
      <div
        className={cn(
          'rounded-md border px-2.5 py-1.5',
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
          {item.durationMs === undefined ? null : (
            <Stat label="took" value={formatDuration(item.durationMs)} />
          )}
          {item.numTurns === undefined ? null : <Stat label="turns" value={String(item.numTurns)} />}
          {usage ? (
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
      <span className={cn('font-mono text-2xs', emphasis ? 'text-brass' : 'text-ink-muted')}>
        {value}
      </span>
    </span>
  );
}
