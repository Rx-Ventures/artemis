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
 *     most expensive thing this UI could do. What a streaming block renders
 *     instead is `StreamingText`, which fades in each new word and holds the
 *     same rule one level down: the cost is per word *arriving*, never per word
 *     on screen.
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
 * spine carries the tone system — `work` in cyan, `thinking` in sage, `end` in
 * mint or amber or signal — which is how the pane stays scannable at a glance
 * now that the content column is much wider than it used to be.
 *
 * `align` flips the whole row, gutter included, so a user turn puts its label
 * on the right where the bubble is. That is the back-and-forth: the user speaks
 * from the right in a filled beam bubble, everything the agent does answers
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
 *    `--primary`, which here is beam at 73% lightness. A one-line prompt would
 *    survive that; a pasted twenty-line spec is a floodlight in a dark room
 *    someone is sitting in for eight hours. `tinted` is the same beam hue at
 *    30% lightness — unmistakably "yours", legible in `--ink`, and quiet.
 *  - **The agent bubble is `ghost`.** Agent output here is code-heavy markdown
 *    — fenced blocks, tables, diff-adjacent prose — not chat banter. A filled
 *    80%-wide blob would both squeeze the code and fight `.md`, which already
 *    draws its own wells and rules. Ghost strips the chrome and lets the answer
 *    read as full-width prose, which is what it is.
 *  - **One avatar, on the agent's side only, and it *is* the label.** The
 *    gutter of an agent turn carries the mark of the provider that answered —
 *    Anthropic's or OpenAI's — because with two accounts signed in at once,
 *    *which model wrote this* is a fact about the transcript rather than a
 *    setting to go and look up. It sits in a ringed disc with no word under it:
 *    "agent" beneath a mark that already means the agent was a second line of
 *    gutter spent saying nothing, and on a one-line answer that line was taller
 *    than the answer. The ring is what makes the mark read as an avatar rather
 *    than as a stray glyph now that it stands alone. A subagent keeps its word,
 *    because the mark cannot say *which* agent. The user's own turns get no
 *    avatar: alignment and the tinted fill already say whose they are, so a
 *    second constant glyph down the thread would spend horizontal room to
 *    repeat something the layout has already said.
 *
 * Thinking, tool calls, permissions, notices and run-ends are NOT conversation
 * turns and are not bubbles. They stay the compact rows that expand in place,
 * aligned onto the same spine so the column reads as one thread.
 *
 * ============================================================================
 * A STRETCH OF WORK ARRIVES AS ONE MARKER, NOT FORTY ROWS
 *
 * A turn that touches forty files used to be forty rows of machinery between
 * two sentences of answer. A run of *machinery* — the model's thinking and the
 * calls it makes, in whatever order they interleave — is folded into a single
 * activity marker, "Ran 36 commands, read 6 files, used a tool", that expands
 * in place to the individual pieces, each still the card it always was.
 *
 * Thinking is in the fold because leaving it out undid the fold. A real turn
 * emits `thinking / tool / thinking / tool …`, so grouping only the calls left
 * a marker around each single call with a thinking row wedged between every
 * pair — nine rows saying, between them, "the agent worked on this". The
 * boundary that matters to a reader is not "was this a tool call", it is "did
 * anyone say anything": the burst runs until the agent speaks.
 *
 * The folding happens in the transcript model, not here, and that is forced by
 * rule 1 rather than chosen: grouping is a question about neighbours, and a row
 * that looked at its neighbours would have to read items during render. See
 * `ActivityGroup` in `state/transcript.ts` for how it stays off the per-token
 * path.
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
import {
  AppWindowIcon,
  ArrowDownIcon,
  BotIcon,
  BrainIcon,
  ChevronRightIcon,
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

import { useFold } from '../hooks/useFold';
import { useActivityGroup, useTranscriptItem, useTranscriptRows } from '../hooks/useTranscript';
import { recallFold, rememberFold } from '../lib/foldMemory';
import { formatBytes } from '../lib/attachments';
import { detectArtifact } from '../lib/artifact';
import { detectFileEdit } from '../lib/diff';
import { previewablePath } from '../lib/preview';
import {
  activeCapabilities,
  openFile,
  openPreview,
  useApp,
  type ConversationWidth,
} from '../state/store';
import type { FileReference } from '../lib/filePaths';
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
  type ActivityGroup,
  type AssistantItem,
  type NoticeItem,
  type PermissionItem,
  type RunEndItem,
  type ThinkingItem,
  type ToolItem,
  type UserItem,
} from '../state/transcript';
import { DiffView } from './DiffView';
import { ActivityIndicator } from './Activity';
import { EmptyState } from './EmptyState';
import { InlinePermission } from './InlinePermission';
import { Markdown } from './Markdown';
import { CodeBlock, Fold, StatusDot, ToneBadge, toneClasses, type Tone } from './primitives';
import { ProviderLogo } from './provider-mark';
import { StreamingText } from './StreamingText';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Markdown parsing is skipped above this size; the cost is not worth it. */
const MARKDOWN_LIMIT = 80_000;

/**
 * How an answer reads before it is markdown — while it streams, and for the
 * rare block too large to parse. Shared so those two never drift apart and the
 * markdown swap at the end of a turn is not also a change of typeface.
 *
 * No `font-mono`: this has to match `.md`, which is sans. An answer arriving a
 * word at a time in one face and reflowing into another the instant it finished
 * was the most visible symptom of mono-by-default, because the swap happens in
 * front of the reader.
 */
const STREAMING_TEXT = 'text-sm leading-relaxed break-words whitespace-pre-wrap text-ink';

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
            bubble or machinery — shares one left edge for its gutter.

            `gap-0.5` is the whole thread's baseline rhythm, and it is this
            tight on purpose: a burst of machinery rows is a log, and a log
            reads as one block or as scattered lines with nothing in between.
            The air that separates *turns* is bought back where it means
            something — a margin above a user prompt and above an answer — so
            the spacing says where the conversation is rather than being spread
            evenly over rows that are all equally uninteresting. */}
        <div
          ref={contentRef}
          className={cn('mx-auto flex w-full flex-col gap-0.5 px-4 py-4', COLUMN_MAX[width])}
        >
          {rows.length === 0 ? <EmptyState /> : rows.map((id) => <Row key={id} id={id} />)}
          {/* What the pane is doing, riding the conversation's tail: inside the
              content column so it sits at the bottom of the text itself —
              pushed down by every row that streams in, scrolling with the
              transcript, and sharing the column's measure so the rule crosses
              exactly the width the prose does. See `Activity.tsx`. */}
          <ActivityIndicator />
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
 * characters, ~53px at `text-2xs` — and the clock has to fit on one line or the
 * gutter reflows on hover and shoves every row down by a line. 3.5rem is the
 * first Tailwind step that clears it.
 *
 * The clock *cross-fades with the chrome* rather than sitting under it, and
 * that is what made this pane tight. Stacked, it reserved a second 16px line in
 * every gutter whether or not anyone was hovering — so a collapsed work marker
 * was 35px of row around 16px of content, and a one-line answer had 29px of
 * dead space beneath it. Reserving nothing means the row is exactly as tall as
 * what is in it, which is why the gap between rows could come down to 2px
 * without the thread closing up.
 *
 * Absolute-positioning the clock *below* the chrome instead would keep the
 * avatar on screen while hovering, and was tried: with rows 2px apart a revealed
 * clock paints straight over the next row's label. Swapping is the version that
 * costs no height and cannot collide.
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
 * `avatar` renders above the label rather than beside it — a disc and a word do
 * not both fit across 3.5rem, and the alternative (widening the spine) would
 * spend the content column's width on every row to decorate two. An empty
 * `label` renders nothing at all, which is how an agent turn gets a gutter that
 * is just the mark and a notice gets one that is just the clock.
 */
function Line({
  label,
  tone = 'neutral',
  ts,
  align = 'start',
  avatar,
  pinLabel = false,
  children,
  className,
}: {
  readonly label: string;
  readonly tone?: Tone;
  readonly ts?: number;
  readonly align?: 'start' | 'end';
  readonly avatar?: ReactNode;
  /**
   * Keep the label while the pointer is over the row, instead of trading it for
   * the clock.
   *
   * The trade is right for most rows: the label repeats what the shape of the
   * row already says, so hovering swaps a redundancy for something you cannot
   * otherwise see. It is wrong for a row whose label is the *only* thing
   * distinguishing it from ordinary output — reasoning in the thread reads as
   * an answer without it, and it disappeared exactly when the reader pointed at
   * the passage they were trying to identify. The clock still arrives; it just
   * does not evict the one word that says what this is.
   */
  readonly pinLabel?: boolean;
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
      <div className="relative flex w-14 shrink-0 flex-col items-end pt-px group-data-[align=end]/message:items-start">
        <div
          className={cn(
            'flex flex-col items-end gap-0.5 transition-opacity group-data-[align=end]/message:items-start',
            // Only fade for a row that has a clock to arrive in its place. The
            // working row carries no `ts`, and fading it unconditionally would
            // trade the mark for an empty gutter. A pinned label never fades —
            // see `pinLabel`.
            ts === undefined || pinLabel ? undefined : 'group-hover:opacity-0',
          )}
        >
          {avatar}
          {label === '' ? null : (
            <div
              className={cn('chrome-label', toneClasses.text[tone])}
            >
              {label}
            </div>
          )}
        </div>
        {ts === undefined ? null : (
          <div
            className={cn(
              'pointer-events-none absolute right-0 font-mono text-2xs text-ink-faint opacity-0 transition-opacity group-hover:opacity-60 group-data-[align=end]/message:right-auto group-data-[align=end]/message:left-0',
              // Under a pinned label rather than over it: nothing is being
              // swapped out, so the two need somewhere to sit side by side.
              pinLabel ? 'top-4' : 'top-px',
            )}
          >
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
 *
 * The disc is the whole difference between a mark and an avatar. Bare, at 13px
 * against the page, the mark read as decoration on the label under it — and
 * with that label gone there is nothing left to read it against. A hairline
 * ring on a barely-raised fill is the least chrome that still says "this is
 * who", and it is `--line` rather than a brand colour for the reason the marks
 * are monochrome at all: see `provider-mark.tsx`.
 */
function AgentAvatar(): ReactElement {
  const providerId = usePane((s) => s.run?.providerId ?? s.activeProviderId);
  const label = useApp((s) => s.providers.find((p) => p.id === providerId)?.label ?? providerId);
  return (
    <span className="flex size-5 items-center justify-center rounded-full border border-line bg-raised/50 text-ink-muted">
      <ProviderLogo providerId={providerId} title={label} size={11} />
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

function UserRow({ item }: { readonly item: UserItem }): ReactElement {
  return (
    <Line label="you" tone="beam" ts={item.ts} align="end" className="turn-in mt-2">
      <Bubble
        align="end"
        variant="tinted"
        // Dimmed means "Artemis has not confirmed delivery" — a prompt whose
        // call failed stays dimmed on purpose.
        className={cn(item.pending && 'opacity-70')}
      >
        {/* Sans, matching the composer the text was typed into: a prompt should
            look the same after it is sent as it did while it was being written.
            That symmetry is why this moved off mono with the composer and not
            separately — a path or a shell fragment inside a prompt is a fragment
            of a sentence, and backticks around it get a mono `code` span from
            `.md` on the agent's side anyway.

            `whitespace-pre-wrap` stays, and is now the only thing preserving the
            shape of a pasted block here: line breaks and runs of spaces survive,
            columns no longer line up. A prompt that is really a wall of code
            belongs in backticks or a file, not in the bubble's own typeface.

            `rounded-br-sm` is the tail — the one square corner points back at
            the author, which is what makes an aligned bubble read as *from*
            someone rather than merely offset. */}
        <BubbleContent className="rounded-2xl rounded-br-sm border-beam/25 px-3.5 py-2 text-sm whitespace-pre-wrap">
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
                    className="max-h-48 max-w-full rounded-md border border-beam/25 object-contain"
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
                    className="flex max-w-full items-center gap-1.5 rounded-md border border-beam/25 px-2 py-1 font-mono text-2xs text-ink-muted"
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
  const pane = usePaneRef();
  const cwd = usePane((s) => s.cwd);
  /*
   * Stable across the row's life, so `Markdown`'s memo keeps holding: an
   * identity that changed every render would re-parse the answer on every
   * keystroke in the composer below it. `pane` is a handle rather than a value,
   * so it does not change as the conversation does — and `cwd` moves only when
   * the user points this column somewhere else, which is exactly when the paths
   * in the answer above resolve to different files and *should* be re-checked.
   */
  const files = useMemo(
    () => ({ cwd, open: (reference: FileReference) => void openFile(reference, pane) }),
    [cwd, pane],
  );

  return (
    <Line
      // No word for the main agent — the mark above says it, and see the header
      // note on the avatar. A subagent still needs one: the mark is the
      // provider, which is the same for both.
      label={item.agentId ? 'subagent' : ''}
      tone="neutral"
      ts={item.ts}
      avatar={<AgentAvatar />}
      className="turn-in mt-1.5"
    >
      {/* `ghost` zeroes the padding and the fill, so `.md` renders against the
          page exactly as it did before the bubbles landed and needs no
          bubble-specific overrides. `w-full` replaces `BubbleContent`'s default
          `w-fit`: a shrink-wrapped answer would let one long line decide how
          wide the tables and code blocks below it are allowed to be. */}
      <Bubble variant="ghost">
        <BubbleContent className="w-full">
          {item.streaming ? (
            <StreamingText text={item.text} className={STREAMING_TEXT} />
          ) : item.text.length > MARKDOWN_LIMIT ? (
            <div className={STREAMING_TEXT}>{item.text}</div>
          ) : (
            <div className="md text-ink">
              <Markdown files={files}>{item.text}</Markdown>
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

/** The one line of it worth showing collapsed. */
function thinkingPreview(item: ThinkingItem): string {
  if (item.redacted) return 'redacted by the provider';
  return oneLine(item.text, 64) || 'thinking…';
}

/** What a withheld block says instead of itself. */
const REDACTED = 'This thinking block was encrypted or withheld by the provider.';

/**
 * The block itself, in the same sage well wherever it is opened from.
 *
 * Sans, like the answer it precedes. Thinking is the model talking to itself in
 * sentences — not a log, despite arriving in a well — so it follows the same
 * rule as every other stretch of prose in the pane. The sage well and the 11px
 * size are what mark it as private and secondary; the typeface was never
 * carrying that and only made it harder to skim.
 *
 * This is the treatment for a block someone went and *opened* — inside a marker,
 * or by clicking a collapsed row. Thinking the reader asked to have on screen
 * permanently is {@link ThinkingProse}, and is a different shape for a reason
 * given there.
 */
function ThinkingBody({ item }: { readonly item: ThinkingItem }): ReactElement {
  return (
    <div className="rounded-none border border-sage/25 bg-inset px-3 py-2 text-2xs leading-relaxed break-words whitespace-pre-wrap text-sage/85">
      {item.redacted ? REDACTED : item.text}
    </div>
  );
}

/**
 * The same block when the reader has asked to watch the model think.
 *
 * A well is the wrong container for this one. A well says "output, parked here,
 * open it if you want it" — right for a block behind a fold, wrong for the
 * thing the reader turned a setting on to read, and at the length real
 * reasoning runs to it becomes a grey slab between every pair of sentences the
 * agent actually said. So the box goes and a sage rule down the left stays:
 * enough to mark the column as an aside, nothing that has to be got past.
 *
 * Muted rather than sage, and this is the part the setting promises. Sage is a
 * *label* colour in this pane — it says "thinking" in the gutter and tints the
 * fold — and a whole paragraph of it reads as emphasis, which is the opposite
 * of the claim. `--ink-muted` is the app's word for "secondary text", so a
 * reader scanning the column can tell reasoning from answer without reading
 * either. The rule keeps the hue where it costs nothing.
 *
 * 12px, one step under the 13px the answer is set in and one over the 11px of
 * the chrome. The folded treatments can be 11px because nobody reads a fold;
 * this is prose someone opted into and has to hold up over a screenful.
 *
 * No `StreamingText` and no markdown, deliberately, per rules 3 and 4 in the
 * header: the text grows in place as the model writes it, which is the whole
 * request, and it costs one text node per flush rather than a parse.
 */
function ThinkingProse({ item }: { readonly item: ThinkingItem }): ReactElement {
  return (
    <div className="border-l-2 border-sage/30 py-0.5 pl-3 text-xs leading-relaxed break-words whitespace-pre-wrap text-ink-muted">
      {item.redacted ? REDACTED : item.text}
    </div>
  );
}

/**
 * Thinking that stands on its own — the reasoning before an answer, with no
 * tool call anywhere near it, or every block once the Appearance switch is on.
 *
 * Kept as a bare fold on the spine rather than the card {@link ThinkingCard}
 * draws, because the two are in different places and want different weight: a
 * lone thinking block is one row in the thread, while a block inside an
 * expanded marker is a sibling of the tool cards around it and has to look like
 * one. The model decides which case this is; see `ActivityGroup`.
 *
 * The switch decides which way the fold opens, and the collapsed line is worth
 * keeping either way: it is how a reader who wants the reasoning in general
 * gets past the one block that turned out to be four thousand words about a
 * typo.
 */
function ThinkingRow({ item }: { readonly item: ThinkingItem }): ReactElement {
  const shown = useApp((s) => s.showThinking);
  /*
   * The one fold in the app that holds its own state, and hands it to `Fold`
   * rather than letting `useFold` keep it. What `useFold` cannot do is re-seed:
   * its default is read once per mount, which is exactly right for a fold whose
   * default is a fact about the block, and wrong here, where the default is a
   * switch the reader can move while looking at the row. A standalone thinking
   * row keeps its id when the switch flips and so is never remounted — it would
   * have sat there closed while the pane rearranged around it, the setting
   * looking broken at the precise moment it is being tried.
   *
   * So: remembered choice first, then the switch — and the switch *moving* is
   * itself an instruction, which is what the adjustment below says. It is the
   * React-documented shape for state derived from a changing input (no effect,
   * no second paint), and it means a per-block click wins until the reader
   * makes a statement about all of them.
   */
  const [open, setOpen] = useState(() => recallFold(item.id) ?? shown);
  const [wasShown, setWasShown] = useState(shown);
  if (wasShown !== shown) {
    setWasShown(shown);
    setOpen(shown);
  }

  const toggle = (next: boolean): void => {
    setOpen(next);
    // The same key {@link ThinkingCard} writes, so a block that moves between
    // the two renderings keeps the reader's choice. It is one thinking block
    // either way, and the model decides which shape it takes.
    rememberFold(item.id, next);
  };

  return (
    <Line label="thinking" tone="sage" ts={item.ts} pinLabel>
      <Fold
        open={open}
        onOpenChange={toggle}
        triggerClassName="text-2xs"
        summary={
          <span className="flex min-w-0 items-center gap-1.5 text-sage/80">
            <BrainIcon className="size-3 shrink-0" aria-hidden="true" />
            {/* Open, the excerpt would be the next line repeated — so the header
                falls back to naming itself, the way the card's does. Closed, the
                excerpt is the only thing saying what is in there, and it is set
                in the prose face because it is prose, unlike a tool row's
                preview, which is a real command. */}
            {open ? (
              <span className="shrink-0 chrome-label">thinking</span>
            ) : (
              <span className="truncate text-2xs">{thinkingPreview(item)}</span>
            )}
            {item.streaming ? <StatusDot tone="sage" pulse /> : null}
          </span>
        }
      >
        {/* The reader asking for reasoning in general is what earns it the prose
            treatment; a block prised open out of curiosity is still output being
            inspected, and keeps the well. */}
        {shown ? <ThinkingProse item={item} /> : <ThinkingBody item={item} />}
      </Fold>
    </Line>
  );
}

/**
 * Thinking as one member of a burst, shaped like the tool cards beside it.
 *
 * Same chrome as {@link ToolCard} — icon, name, one-line preview, expands in
 * place — so an opened marker reads as a list of what happened rather than two
 * kinds of thing that happen to be stacked. Sage rather than the status tones,
 * because a thinking block has no status: it did not succeed or fail, it is
 * just what the model was working through between two calls.
 */
function ThinkingCard({ item }: { readonly item: ThinkingItem }): ReactElement {
  // Not a `Fold` — see the note above on why this wears the card's chrome — but
  // the same state and so the same memory, under the same key `ThinkingRow` uses.
  const [open, setOpen] = useFold(item.id);
  return (
    <div className={cn('rounded-lg border bg-panel/60', open ? 'border-sage/40' : 'border-line')}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none hover:bg-raised/40 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <BrainIcon className="size-3 shrink-0 text-sage/80" aria-hidden="true" />
        {/* The label is chrome and stays mono; the preview beside it is an
            excerpt of the model's prose and does not. */}
        <span className="shrink-0 font-mono text-xs font-semibold text-sage">thinking</span>
        <span className="min-w-0 flex-1 truncate text-2xs text-ink-faint">
          {thinkingPreview(item)}
        </span>
        {item.streaming ? <StatusDot tone="sage" pulse /> : null}
      </button>

      {open ? (
        <div className="border-t border-line px-2.5 py-2">
          <ThinkingBody item={item} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A tool call that is a row of its own rather than a member of a burst.
 *
 * Two things arrive here, and the gutter label is the whole reason this is not
 * one line inside `ItemRow`:
 *
 *  - **An artifact.** The model deliberately keeps these out of the fold, so
 *    that a page the agent made is visible and openable without first opening a
 *    dropdown labelled "edited 5 files" — see `ActivityGroup` in
 *    `state/transcript.ts`. It gets its own label, because `tool` in the gutter
 *    beside a tile that says `report.html` describes the mechanism at exactly
 *    the moment the reader has stopped caring about it.
 *  - **An escapee.** A call that ended up ungrouped for any other reason. The
 *    bare card under a `tool` label is the honest fallback it always was.
 *
 * The artifact test is repeated here rather than threaded down from the model,
 * which is a real duplicate parse — but only of the rows that reach top level,
 * and after the hoist that is the artifacts and almost nothing else. Paying it
 * on a handful of rows per session is the cheaper half of the trade against
 * putting `cwd` into `ToolCard`'s props and out of its own memo.
 */
function ToolRow({ item }: { readonly item: ToolItem }): ReactElement {
  const cwd = usePane((s) => s.cwd);
  const platform = useApp((s) => s.platform);
  const artifact = useMemo(
    () =>
      item.status === 'ok'
        ? detectArtifact(detectFileEdit(item.name, item.input), cwd, platform)
        : null,
    [item.name, item.input, item.status, cwd, platform],
  );

  return (
    <Line
      label={artifact ? 'artifact' : 'tool'}
      tone={artifact ? 'sage' : 'cyan'}
      ts={item.ts}
      className={artifact ? 'my-1' : undefined}
    >
      <ToolCard item={item} />
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
 * the external transcript store — and remembered under the call's own id, so
 * opening a card, leaving the session and coming back does not close it again.
 * The two folds *inside* it keep their own memory, keyed off the same id: a
 * reader who opened the result and closed the input meant both.
 */
function ToolCard({ item }: { readonly item: ToolItem }): ReactElement {
  const [open, setOpen] = useFold(item.id);
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

  /*
   * The stronger question, asked of the same parse — see `lib/artifact.ts`. A
   * hit replaces the tool row with a tile, so it is deliberately much harder to
   * satisfy than `previewable` above: this one hides a diff, and that is only
   * the right trade for a file whose *rendering* is the point.
   *
   * Never for a call that failed, for the reason the Preview button gives
   * below — there is no file behind a tile whose write was denied.
   */
  const artifact = useMemo(
    () => (item.status === 'ok' ? detectArtifact(edit, cwd, platform) : null),
    [edit, cwd, platform, item.status],
  );

  return (
    <div
      className={cn(
        'rounded-lg border bg-panel/60',
        failed ? 'border-signal/35' : 'border-line',
        open && 'border-line-strong',
        artifact && 'border-line-strong bg-raised/40',
      )}
    >
      {/*
        An artifact takes the row rather than adding to it.

        The tool call is still there — the disclosure below opens to the same
        diff and the same raw arguments any other write has — but what the row
        *says* changes: a page the agent made is named by its title and its
        kind, not by the tool that happened to produce it. `Write` and
        `/tmp/a1b2/report.html` are facts about the mechanism, and the mechanism
        is not what the reader is looking for once the thing itself exists.
      */}
      {artifact ? (
        <div className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            aria-label={open ? 'Hide the diff' : 'Show the diff'}
            className="shrink-0 rounded p-0.5 text-ink-faint outline-none hover:bg-raised/60 focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <ChevronRightIcon
              className={cn('size-3 transition-transform', open && 'rotate-90')}
              aria-hidden="true"
            />
          </button>

          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-line bg-panel">
            {artifact.kind === 'page' ? (
              <AppWindowIcon className="size-3.5 text-cyan" aria-hidden="true" />
            ) : (
              <FileTextIcon className="size-3.5 text-sage" aria-hidden="true" />
            )}
          </span>

          <span className="flex min-w-0 flex-1 flex-col">
            <span title={artifact.path} className="truncate text-xs font-semibold text-ink">
              {artifact.title}
            </span>
            <span className="truncate font-mono text-2xs text-ink-faint">
              {artifact.kind === 'page' ? 'page' : 'markdown'}
              {artifact.bytes === undefined ? '' : ` · ${formatBytes(artifact.bytes)}`}
              {artifact.fresh ? '' : ' · edited'}
            </span>
          </span>

          <Button
            variant="outline"
            size="xs"
            onClick={() => void openPreview(artifact.path, pane)}
            className="shrink-0"
          >
            <SquareArrowOutUpRightIcon />
            Open
          </Button>
        </div>
      ) : null}

      {/*
        A row rather than a single button, because the preview action cannot
        live inside the disclosure control: a button nested in a button is
        invalid markup, and the browsers that tolerate it fire both handlers, so
        opening a preview would also toggle the card underneath it.
      */}
      {artifact ? null : (
      <div className="flex w-full min-w-0 items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
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
      )}

      {open ? (
        <div className="flex flex-col gap-1.5 border-t border-line px-2.5 py-2">
          {edit ? <DiffView edit={edit} /> : null}

          <Fold
            // The raw arguments stay available even when a diff was rendered:
            // the diff is a reading of the input, and the input is the record.
            defaultOpen={edit === null}
            rememberAs={`${item.id}:input`}
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
              rememberAs={`${item.id}:result`}
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
 * A burst of work, as one line.
 *
 * The collapsed line is the whole point — "Ran 36 commands, read 6 files, used
 * a tool" is what someone scrolling back wants, and forty individual cards
 * interleaved with the thinking between them is what they were getting.
 * Expanding restores every piece, in order, exactly as it was.
 *
 * The summary counts the *calls*, not the thinking: what a reader wants off a
 * folded row is what the agent did, and "thought 9 times" is both meaningless
 * and, on a narrow column, in front of the part that is not. That the reasoning
 * is in there is said by the brain icon leading the cluster, which costs no
 * width in the line that truncates.
 *
 * Three things are deliberately *not* summarised away:
 *
 *  - **Failures.** A group holding an error or a denial says so on the
 *    collapsed line, in signal, and opens itself. A marker that read the same
 *    whether or not something broke would be worse than no marker.
 *  - **Work in flight.** While a call is still running the line reads in
 *    present tense with a pulsing dot, so a long `Bash` looks like progress
 *    rather than a thread that stopped.
 *  - **Thinking in flight.** A block still arriving pulses the same dot without
 *    touching the tense — the calls it is thinking *about* are finished, and
 *    "Running 2 commands" would be a lie about work that is over.
 *
 * The gutter beside it carries no label. "work" only repeated the icons and the
 * sentence next to them, and the failure it used to colour is already on the
 * line itself, in signal — the first point above is what carries that now.
 */
const ActivityRow = memo(function ActivityRow({ id }: { readonly id: string }): ReactElement | null {
  const group = useActivityGroup(id);
  if (!group) return null;
  return <ActivityMarker group={group} />;
});

function ActivityMarker({ group }: { readonly group: ActivityGroup }): ReactElement {
  const live = group.running > 0;
  const summary = describeActivity(group.counts, live);
  const icons: Array<{ key: string; Icon: LucideIcon; tone?: string }> = [];
  if (group.thinking > 0) icons.push({ key: 'thinking', Icon: BrainIcon, tone: 'text-sage/70' });
  for (const category of TOOL_CATEGORY_ORDER) {
    if ((group.counts[category] ?? 0) > 0) {
      icons.push({ key: category, Icon: CATEGORY_ICON[category] });
    }
  }

  return (
    <Line label="" ts={group.ts}>
      <Fold
        // A failure opens itself, matching what a single tool card already does
        // with its own error output. `defaultOpen` is read once, so a group that
        // fails *after* being drawn does not spring open under the reader — the
        // signal-toned count on the line is what catches that case.
        defaultOpen={group.failed > 0}
        // And read once *per mount*, which is how a failed group used to reopen
        // itself every time the reader came back to the session having closed
        // it. The group id keys the memory: it is `g:` + its first member's id,
        // so it names the same burst after a replay. See `lib/foldMemory.ts`.
        rememberAs={group.id}
        triggerClassName="text-2xs"
        summary={
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="flex shrink-0 items-center gap-1">
              {icons.slice(0, MAX_MARKER_ICONS).map(({ key, Icon, tone }) => (
                <Icon
                  key={key}
                  className={cn('size-3', tone ?? (live ? 'text-cyan' : 'text-ink-faint'))}
                  aria-hidden="true"
                />
              ))}
            </span>
            <span className="truncate font-mono text-2xs">{summary}</span>
            {live || group.streaming ? (
              <StatusDot tone={live ? 'cyan' : 'sage'} pulse />
            ) : null}
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
            <MemberCard key={memberId} id={memberId} />
          ))}
        </div>
      </Fold>
    </Line>
  );
}

/**
 * One member of an expanded group — a call, or the thinking beside it.
 *
 * Subscribed by its own id and memoised, which is rule 2 applied one level
 * down: a `tool.end` inside an open marker re-renders that one card, not the
 * other thirty-nine beside it, and a thinking block streaming inside an open
 * marker re-renders itself and nothing else. That is what lets thinking join
 * the fold without putting text back on the group's subscription.
 */
const MemberCard = memo(function MemberCard({ id }: { readonly id: string }): ReactElement | null {
  const item = useTranscriptItem(id);
  if (item?.kind === 'thinking') return <ThinkingCard item={item} />;
  if (item?.kind !== 'tool') return null;
  return <ToolCard item={item} />;
});

/**
 * A parked request, answered where it happened.
 *
 * The card itself is `InlinePermission`; this only supplies the transcript's
 * row chrome. Pending requests get a coloured rail label so they are findable
 * by scrolling as well as by the status line's counter — amber for an approval,
 * because that is a risk decision, and cyan for a question, because it is not.
 */
function PermissionRow({ item }: { readonly item: PermissionItem }): ReactElement {
  const pending = item.state === 'pending';
  const asking = item.request.question !== undefined;
  return (
    <Line
      label={asking ? (pending ? 'answer?' : 'question') : pending ? 'approve?' : 'approval'}
      tone={pending ? (asking ? 'cyan' : 'amber') : 'neutral'}
      ts={item.ts}
      className={pending ? 'my-1' : undefined}
    >
      <InlinePermission item={item} />
    </Line>
  );
}

function NoticeRow({ item }: { readonly item: NoticeItem }): ReactElement {
  const tone: Tone = item.level === 'error' ? 'signal' : item.level === 'warn' ? 'amber' : 'neutral';
  const Icon = item.level === 'info' ? InfoIcon : TriangleAlertIcon;
  return (
    <Line label="" ts={item.ts}>
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
    <Line label="end" tone={tone} ts={item.ts} className="mt-1.5 mb-2">
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
            <span className="chrome-label text-ink-muted">
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
      <span className={cn('font-mono text-2xs', emphasis ? 'text-beam' : 'text-ink-muted')}>
        {value}
      </span>
    </span>
  );
}
