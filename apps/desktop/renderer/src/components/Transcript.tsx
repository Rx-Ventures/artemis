/**
 * The transcript pane.
 * ============================================================================
 *
 * THE PERFORMANCE CONTRACT. This is the app's hot path and the rules below are
 * not stylistic — breaking any one of them turns a fast provider's output into
 * O(items) work per token:
 *
 *  1. **The list renders ids, not items.** `useTranscriptRows` fires only when
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
 * Every row is a fixed label gutter (the *spine*) beside a content column. The
 * spine carries the tone system — `tool` in cyan, `thinking` in sage, `end` in
 * mint or amber or signal — which is how the pane stays scannable at a glance
 * now that the content column is much wider than it used to be.
 *
 * `align` flips the whole row, gutter included, so a user turn puts its label
 * on the right where the bubble is. That is the back-and-forth: the user speaks
 * from the right in a filled lunar bubble, everything the agent does answers
 * from the left.
 *
 * Four choices inside that worth stating, because each had an obvious
 * alternative:
 *
 *  - **`Bubble` only — `components/ui/message` is not used.** `Message` is the
 *    registry's full chat row: avatar slot, header, footer, group. This pane
 *    needs one of those four, and a row that is three flex utilities long is
 *    not worth a second component system layered over the first. The row div
 *    below still declares `group/message` and `data-align`, because those are
 *    the hooks `bubble.tsx` itself selects on — renaming the group would
 *    quietly break a vendored file's own styling.
 *  - **The user bubble is `tinted`, not `default`.** `default` fills with
 *    `--primary`, which here is lunar at 73% lightness. A one-line prompt would
 *    survive that; a pasted twenty-line spec is a floodlight in a dark room
 *    someone is sitting in for eight hours. `tinted` is the same lunar hue at
 *    30% lightness — unmistakably "yours", legible in `--ink`, and quiet.
 *  - **The agent bubble is `ghost`.** Agent output here is code-heavy markdown
 *    — fenced blocks, tables, diff-adjacent prose — not chat banter. A filled
 *    80%-wide blob would both squeeze the code and fight `.md`, which already
 *    draws its own wells and rules. Ghost strips the chrome and lets the answer
 *    read as full-width prose, which is what it is.
 *  - **One avatar, on the agent's side only.** The gutter of an agent turn
 *    carries the mark of the provider that answered — Anthropic's or OpenAI's
 *    — because with two accounts signed in at once, *which model wrote this* is
 *    a fact about the transcript rather than a setting to go and look up. The
 *    user's own turns get no avatar: alignment and the tinted fill already say
 *    whose they are, so a second constant glyph down the thread would spend
 *    horizontal room to repeat something the layout has already said.
 *
 * Thinking, tool calls, permissions, notices and run-ends are NOT conversation
 * turns and are not bubbles. They stay the compact rows that expand in place,
 * aligned onto the same spine so the column reads as one thread.
 *
 * ============================================================================
 * TOOL CALLS ARRIVE AS ONE MARKER, NOT FORTY ROWS
 *
 * A turn that touches forty files used to be forty rows of machinery between
 * two sentences of answer. Consecutive tool calls are now folded into a single
 * activity marker — "Ran 36 commands, read 6 files, used a tool" — that expands
 * in place to the individual calls, each still the card it always was.
 *
 * The folding happens in the transcript model, not here, and that is forced by
 * rule 1 rather than chosen: grouping is a question about neighbours, and a row
 * that looked at its neighbours would have to read items during render. See
 * `ToolGroup` in `state/transcript.ts` for how it stays off the per-token path.
 *
 * What this file owns is the phrasing and the icons, and one rule about both: a
 * failure is never summarised away. A group holding an error or a denial says
 * so on the collapsed line and opens itself, because "Ran 36 commands" reading
 * identically whether or not one of them failed is the single worst thing this
 * marker could do.
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
  BotIcon,
  BrainIcon,
  FilePenLineIcon,
  FileTextIcon,
  GlobeIcon,
  InfoIcon,
  ListChecksIcon,
  PlugIcon,
  SearchIcon,
  SparklesIcon,
  SquareArrowOutUpRightIcon,
  TerminalIcon,
  PaperclipIcon,
  TriangleAlertIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react';

import { attachmentBytes, isImageAttachment } from '@rx-artemis/protocol';

import { useToolGroup, useTranscriptItem, useTranscriptRows } from '../hooks/useTranscript';
import { formatBytes } from '../lib/attachments';
import { detectFileEdit } from '../lib/diff';
import { previewablePath } from '../lib/preview';
import { activeCapabilities, openPreview, useApp, type ConversationWidth } from '../state/store';
import { usePane, usePaneRef } from '../state/paneContext';
import {
  formatClock,
  formatDuration,
  formatJson,
  formatTokens,
  formatUsd,
  oneLine,
  summarizeToolInput,
} from '../lib/format';
import {
  TOOL_CATEGORY_ORDER,
  classifyTool,
  describeActivity,
  type ToolCategory,
} from '../lib/tools';
import {
  isGroupId,
  type AssistantItem,
  type NoticeItem,
  type PermissionItem,
  type RunEndItem,
  type ThinkingItem,
  type ToolGroup,
  type ToolItem,
  type UserItem,
} from '../state/transcript';
import { DiffView } from './DiffView';
import { EmptyState } from './EmptyState';
import { InlinePermission } from './InlinePermission';
import { CodeBlock, Fold, StatusDot, ToneBadge, toneClasses, type Tone } from './primitives';
import { ProviderLogo } from './provider-mark';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
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
  const rows = useTranscriptRows();
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
          {rows.length === 0 ? <EmptyState /> : rows.map((id) => <Row key={id} id={id} />)}
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
  const live = usePane((s) => s.run !== null && s.run.status === 'running');
  const streams = usePane((s) => activeCapabilities(s).partialMessages);
  const waiting = usePane((s) => s.permissionQueue.length > 0);

  if (!live || streams || waiting) return null;
  return (
    <Line label="agent" tone="cyan" avatar={<AgentAvatar />}>
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
  // A group id names a fold of several tool calls rather than one item, and
  // subscribes to a different slice of the model. Splitting before the item
  // lookup keeps `ItemRow` on the single-id subscription that rule 2 requires.
  if (isGroupId(id)) return <ActivityRow id={id} />;
  return <ItemRow id={id} />;
});

const ItemRow = memo(function ItemRow({ id }: { readonly id: string }): ReactElement | null {
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
      // Reached only if a tool ever escapes grouping; the model folds every
      // one it knows about. Rendering the bare card is the honest fallback.
      return (
        <Line label="tool" tone="cyan" ts={item.ts}>
          <ToolCard item={item} />
        </Line>
      );
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
 * The gutter follows `align`: the row reverses for `end`, so a user turn's
 * label lands on the right next to its bubble. The text alignment has to flip
 * with it, hence the `group-data-[align=end]/message` override — without it the
 * label would be right-aligned against the window edge, hanging off the bubble
 * it names.
 *
 * The two group names are load-bearing and do different jobs. `group/message`
 * is what `bubble.tsx` selects on to self-align a bubble inside a reversed row,
 * so it has to keep that name even though `components/ui/message` is not used;
 * plain `group` is what the clock's hover reveal uses.
 *
 * `avatar` renders above the label rather than beside it — a 14px mark and a
 * word do not both fit across 3.5rem, and the alternative (widening the spine)
 * would spend the content column's width on every row to decorate two.
 */
function Line({
  label,
  tone = 'neutral',
  ts,
  align = 'start',
  avatar,
  children,
  className,
}: {
  readonly label: string;
  readonly tone?: Tone;
  readonly ts?: number;
  readonly align?: 'start' | 'end';
  readonly avatar?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  return (
    <div
      data-align={align}
      className={cn(
        'group group/message relative flex w-full min-w-0 gap-2 text-sm data-[align=end]:flex-row-reverse',
        className,
      )}
    >
      <div className="flex w-14 shrink-0 flex-col items-end pt-px group-data-[align=end]/message:items-start">
        {avatar}
        <div className={cn('font-mono text-2xs tracking-wider uppercase', toneClasses.text[tone])}>
          {label}
        </div>
        {ts === undefined ? null : (
          <div className="mt-0.5 font-mono text-2xs text-ink-faint opacity-0 transition-opacity group-hover:opacity-60">
            {formatClock(ts)}
          </div>
        )}
      </div>
      {/* The registry's `MessageContent` uses `gap-2.5`, tuned for a chat app
          with one bubble per turn; the transcript stacks a bubble against a
          badge, so it wants a tighter rhythm. */}
      <div className="flex w-full min-w-0 flex-col gap-1 wrap-break-word group-data-[align=end]/message:*:data-slot:self-end">
        {children}
      </div>
    </div>
  );
}

/**
 * The mark of whoever is answering, for the gutter of an agent turn.
 *
 * Prefers the *run's* provider over the pane's current one. They are usually
 * the same, but a transcript that is still on screen after the user switches
 * profiles must keep saying who actually wrote it — relabelling finished turns
 * to match the account now selected would be a quiet lie about the record.
 *
 * Read from the pane rather than the window, which is the same rule one scope
 * out: with several conversations open the window has no single answer, and the
 * one that matters is the account *this* column is billing.
 */
function AgentAvatar(): ReactElement {
  const providerId = usePane((s) => s.run?.providerId ?? s.activeProviderId);
  const label = useApp((s) => s.providers.find((p) => p.id === providerId)?.label ?? providerId);
  return (
    <ProviderLogo
      providerId={providerId}
      title={label}
      size={13}
      className="mb-0.5 text-ink-muted"
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

function UserRow({ item }: { readonly item: UserItem }): ReactElement {
  return (
    <Line label="you" tone="lunar" ts={item.ts} align="end" className="turn-in mt-3">
      <Bubble
        align="end"
        variant="tinted"
        // Dimmed means "Artemis has not confirmed delivery" — a prompt whose
        // call failed stays dimmed on purpose.
        className={cn(item.pending && 'opacity-70')}
      >
        {/* Monospace, matching the composer the text was typed into: a prompt
            that contains a path or a shell fragment should look the same after
            it is sent as it did before. `rounded-br-sm` is the tail — the one
            square corner points back at the author, which is what makes an
            aligned bubble read as *from* someone rather than merely offset. */}
        <BubbleContent className="rounded-2xl rounded-br-sm border-lunar/25 px-3.5 py-2 font-mono text-sm whitespace-pre-wrap">
          {/* Attachments above the text, in the order the model receives them.
              A transcript that showed them the other way round would be a
              record of a prompt nobody sent.

              `items-start` because the row mixes a tall thumbnail with short
              chips, and flexbox's default `stretch` would blow each chip up to
              the image's height. */}
          {item.attachments && item.attachments.length > 0 ? (
            <div className="mb-2 flex flex-wrap items-start justify-end gap-1.5">
              {item.attachments.map((attachment) =>
                isImageAttachment(attachment) ? (
                  <img
                    key={attachment.id}
                    src={`data:${attachment.mediaType};base64,${attachment.data}`}
                    alt={attachment.name ?? 'Attached image'}
                    title={attachment.name ?? 'Attached image'}
                    // Capped rather than full-bleed: a tall screenshot at full
                    // width would push the prompt it belongs to off the screen,
                    // and this is a record of what was sent, not a viewer.
                    className="max-h-48 max-w-full rounded-md border border-lunar/25 object-contain"
                  />
                ) : (
                  /* A file has no picture, so the record of it is its name and
                     size — the same two facts the agent was given. Deliberately
                     not a link: the staged copy is deleted when the run ends,
                     and a control that stops working after a minute is worse
                     than no control. */
                  <span
                    key={attachment.id}
                    title={`${attachment.name} — ${formatBytes(attachmentBytes(attachment))}`}
                    className="flex max-w-full items-center gap-1.5 rounded-md border border-lunar/25 px-2 py-1 font-mono text-2xs text-ink-muted"
                  >
                    <PaperclipIcon className="size-3 shrink-0" />
                    <span className="truncate text-ink">{attachment.name}</span>
                    <span className="shrink-0">{formatBytes(attachmentBytes(attachment))}</span>
                  </span>
                ),
              )}
            </div>
          ) : null}
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
      avatar={<AgentAvatar />}
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
 * A tool call: one compact card that expands in place.
 *
 * Collapsed it is icon + name + primary argument, which is all a reader needs
 * to follow what the agent is doing. Expanded it reveals the full input and
 * output — and, when the call edits a file, a diff instead of two walls of
 * quoted string.
 *
 * Not a bubble, and that is the point: a tool call is not something anyone
 * said. It keeps card chrome so the eye can tell work from speech without
 * reading a word.
 *
 * No `Line` of its own: these are rendered inside an expanded {@link
 * ActivityRow}, which owns the gutter for the whole burst. A card that drew its
 * own spine would put a second `tool` label under the marker's.
 *
 * Open state is local, which is what lets it survive the re-renders driven by
 * the external transcript store.
 */
function ToolCard({ item }: { readonly item: ToolItem }): ReactElement {
  const [open, setOpen] = useState(false);
  const tone = TOOL_TONE[item.status];
  const summary = item.title ?? summarizeToolInput(item.input);
  const failed = item.status === 'error' || item.status === 'denied';
  const Icon = CATEGORY_ICON[classifyTool(item.name)];

  // Recomputed only when the arguments change, which for a tool call is once:
  // `tool.end` carries the result, not a new input. A diff is cheap but not
  // free, and this row can be re-rendered by its own status transition.
  const edit = useMemo(() => detectFileEdit(item.name, item.input), [item.name, item.input]);

  // The pane this card is in, so a preview opens against *this* column's
  // working directory and reports a failure into *this* column's transcript.
  // One subscription that fires on a focus change and never on a token — the
  // same cost `AgentAvatar` two rows up already pays.
  const pane = usePaneRef();
  const cwd = usePane((s) => s.cwd);
  const platform = useApp((s) => s.platform);
  const previewable = useMemo(
    () => previewablePath(edit, cwd, platform),
    [edit, cwd, platform],
  );

  return (
    <div
      className={cn(
        'rounded-lg border bg-panel/60',
        failed ? 'border-signal/35' : 'border-line',
        open && 'border-line-strong',
      )}
    >
      {/*
        A row rather than a single button, because the preview action cannot
        live inside the disclosure control: a button nested in a button is
        invalid markup, and the browsers that tolerate it fire both handlers, so
        opening a preview would also toggle the card underneath it.
      */}
      <div className="flex w-full min-w-0 items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none hover:bg-raised/40 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Icon
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

        {/*
          Only for a call that *succeeded*. A write that errored, was denied or
          was cancelled left no file — or left half of one — and a Preview button
          beside a red badge would be an invitation to open something that is not
          there, answered by a failure a moment later.
        */}
        {previewable !== null && item.status === 'ok' ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() => void openPreview(previewable, pane)}
            className="mr-2 shrink-0"
          >
            <SquareArrowOutUpRightIcon />
            Preview
          </Button>
        ) : null}
      </div>

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
  );
}

/* -------------------------------------------------------------------------- */
/* The activity marker                                                        */
/* -------------------------------------------------------------------------- */

/** One glyph per category, for the marker's icon cluster and each tool card. */
const CATEGORY_ICON: Record<ToolCategory, LucideIcon> = {
  command: TerminalIcon,
  edit: FilePenLineIcon,
  read: FileTextIcon,
  search: SearchIcon,
  web: GlobeIcon,
  agent: BotIcon,
  plan: ListChecksIcon,
  mcp: PlugIcon,
  other: WrenchIcon,
};

/** At most this many icons lead the marker; past three it is a smudge. */
const MAX_MARKER_ICONS = 3;

/**
 * A burst of tool calls, as one line.
 *
 * The collapsed line is the whole point — "Ran 36 commands, read 6 files, used
 * a tool" is what someone scrolling back wants, and forty individual cards is
 * what they were getting. Expanding restores the cards exactly as they were.
 *
 * Two things are deliberately *not* summarised away:
 *
 *  - **Failures.** A group holding an error or a denial says so on the
 *    collapsed line, in signal, and opens itself. A marker that read the same
 *    whether or not something broke would be worse than no marker.
 *  - **Work in flight.** While anything is still running the line reads in
 *    present tense with a pulsing dot, so a long `Bash` looks like progress
 *    rather than a thread that stopped.
 */
const ActivityRow = memo(function ActivityRow({ id }: { readonly id: string }): ReactElement | null {
  const group = useToolGroup(id);
  if (!group) return null;
  return <ActivityMarker group={group} />;
});

function ActivityMarker({ group }: { readonly group: ToolGroup }): ReactElement {
  const live = group.running > 0;
  const summary = describeActivity(group.counts, live);
  const icons = TOOL_CATEGORY_ORDER.filter((c) => (group.counts[c] ?? 0) > 0).slice(
    0,
    MAX_MARKER_ICONS,
  );

  return (
    <Line label="tool" tone={group.failed > 0 ? 'signal' : 'cyan'} ts={group.ts}>
      <Fold
        // A failure opens itself, matching what a single tool card already does
        // with its own error output. `defaultOpen` is read once, so a group that
        // fails *after* being drawn does not spring open under the reader — the
        // signal-toned count on the line is what catches that case.
        defaultOpen={group.failed > 0}
        triggerClassName="text-2xs"
        summary={
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="flex shrink-0 items-center gap-1">
              {icons.map((category) => {
                const Icon = CATEGORY_ICON[category];
                return (
                  <Icon
                    key={category}
                    className={cn('size-3', live ? 'text-cyan' : 'text-ink-faint')}
                    aria-hidden="true"
                  />
                );
              })}
            </span>
            <span className="truncate font-mono text-2xs">{summary}</span>
            {live ? <StatusDot tone="cyan" pulse /> : null}
            {group.failed > 0 ? (
              <span className="shrink-0 font-mono text-2xs text-signal">
                · {group.failed} failed
              </span>
            ) : null}
          </span>
        }
      >
        <div className="flex flex-col gap-1">
          {group.ids.map((memberId) => (
            <ToolCardById key={memberId} id={memberId} />
          ))}
        </div>
      </Fold>
    </Line>
  );
}

/**
 * One member of an expanded group.
 *
 * Subscribed by its own id and memoised, which is rule 2 applied one level
 * down: a `tool.end` inside an open marker re-renders that one card, not the
 * other thirty-nine beside it.
 */
const ToolCardById = memo(function ToolCardById({ id }: { readonly id: string }): ReactElement | null {
  const item = useTranscriptItem(id);
  if (item?.kind !== 'tool') return null;
  return <ToolCard item={item} />;
});

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
      <span className={cn('font-mono text-2xs', emphasis ? 'text-lunar' : 'text-ink-muted')}>
        {value}
      </span>
    </span>
  );
}
