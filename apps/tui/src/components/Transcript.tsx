/**
 * The conversation, drawn.
 *
 * Every transcript row has one face here — user turns, streamed assistant
 * text rendered from markdown, tool calls with their diffs, permission
 * outcomes, notices, run ends — and the same faces serve three surfaces: the
 * live viewport, a replayed subagent transcript, and a resumed conversation.
 *
 * Live rows subscribe to their own id and are redrawn on the transcript
 * model's flush, so a token touches one row. The viewport bounds how many rows
 * exist at once (see `WINDOW_ROWS`), which is what keeps a long conversation
 * cheap in a layout that is redrawn whole.
 *
 * Pending permission rows draw nothing here; the card that answers them is a
 * separate live component, and drawing the request twice would be worse than
 * either once.
 */

import { useMemo, useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';

import type { AgentError, AgentEvent } from '@rx-artemis/protocol';
import {
  TranscriptModel,
  describeActivity,
  detectFileEdit,
  formatDuration,
  formatTokens,
  formatUsd,
  isGroupId,
  oneLine,
  summarizeToolInput,
  syncScheduler,
  totalInputTokens,
  type ActivityGroup,
  type TranscriptItem,
} from '@rx-artemis/transcript';

import { renderDiff } from '../render/diff.js';
import { renderMarkdown } from '../render/markdown.js';

/* -------------------------------------------------------------------------- */
/* Settling                                                                   */
/* -------------------------------------------------------------------------- */

function itemSettled(item: TranscriptItem | undefined): boolean {
  if (item === undefined) return true;
  switch (item.kind) {
    case 'user':
      return !item.pending;
    case 'assistant':
    case 'thinking':
      return !item.streaming;
    case 'tool':
      return item.status !== 'running';
    case 'permission':
      return item.state !== 'pending';
    default:
      return true;
  }
}

interface Snapshot {
  readonly key: string;
  readonly item?: TranscriptItem;
  readonly group?: ActivityGroup;
  readonly members?: readonly TranscriptItem[];
}

function snapshotRow(id: string, transcript: TranscriptModel, key: string): Snapshot | null {
  if (isGroupId(id)) {
    const group = transcript.getGroup(id);
    if (group === undefined) return null;
    const members = group.ids.map((memberId) => transcript.getItem(memberId)).filter((m): m is TranscriptItem => m !== undefined);
    return { key, group, members };
  }
  const item = transcript.getItem(id);
  return item === undefined ? null : { key, item };
}

function rowSettled(id: string, transcript: TranscriptModel): boolean {
  if (isGroupId(id)) {
    const group = transcript.getGroup(id);
    if (group === undefined) return true;
    return group.running === 0 && group.ids.every((memberId) => itemSettled(transcript.getItem(memberId)));
  }
  return itemSettled(transcript.getItem(id));
}


/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

const TOOL_GLYPH: Record<string, { glyph: string; color?: string; dim?: boolean }> = {
  running: { glyph: '◌', color: 'cyan' },
  ok: { glyph: '✓', color: 'green' },
  error: { glyph: '✗', color: 'red' },
  denied: { glyph: '⊘', color: 'yellow' },
  cancelled: { glyph: '∅', dim: true },
};

function ErrorLine({ error }: { readonly error: AgentError | undefined }): React.JSX.Element | null {
  if (error === undefined) return null;
  return (
    <Text color="red">
      {'    '}
      {oneLine(error.message, 200)}
    </Text>
  );
}

function ToolRow({ item }: { readonly item: Extract<TranscriptItem, { kind: 'tool' }> }): React.JSX.Element {
  const style = TOOL_GLYPH[item.status] ?? TOOL_GLYPH['ok'];
  const title = item.title ?? `${item.name} ${summarizeToolInput(item.input)}`.trim();
  const edit = detectFileEdit(item.name, item.input);
  const resultLines =
    edit === null && item.status === 'ok' && item.resultText !== undefined
      ? item.resultText.split('\n').filter((line) => line.trim().length > 0).slice(0, 3)
      : [];
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={style?.color} dimColor={style?.dim}>
          {style?.glyph ?? '•'}{' '}
        </Text>
        <Text bold={item.status === 'running'}>{oneLine(title, 160)}</Text>
        {item.durationMs !== undefined && <Text dimColor>{`  ${formatDuration(item.durationMs)}`}</Text>}
      </Text>
      {edit !== null && (
        <Box flexDirection="column" paddingLeft={2}>
          {renderDiff(edit).map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      )}
      {resultLines.map((line, i) => (
        <Text key={i} dimColor>
          {'    '}
          {oneLine(line, 160)}
        </Text>
      ))}
      {item.status === 'denied' && <Text color="yellow">{'    '}denied</Text>}
      <ErrorLine error={item.error} />
    </Box>
  );
}

function ItemRow({ item }: { readonly item: TranscriptItem }): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color="cyan" bold>
            {'> '}
          </Text>
          <Text dimColor={item.pending}>{item.text}</Text>
        </Box>
      );
    case 'assistant':
      if (item.text.length === 0) return null;
      return (
        <Box marginTop={1} paddingLeft={2}>
          <Text dimColor={item.synthetic === true}>{renderMarkdown(item.text)}</Text>
        </Box>
      );
    case 'thinking':
      return (
        <Text dimColor italic>
          {'  ∴ '}
          {item.redacted ? 'thinking (redacted)' : oneLine(item.text, 120)}
        </Text>
      );
    case 'tool':
      return (
        <Box paddingLeft={2}>
          <ToolRow item={item} />
        </Box>
      );
    case 'permission':
      if (item.state === 'pending') return null;
      return (
        <Text dimColor>
          {'  ⚿ '}
          {item.request.toolName} — {item.state}
          {item.note !== undefined ? `: ${oneLine(item.note, 120)}` : ''}
        </Text>
      );
    case 'notice': {
      const color = item.level === 'error' ? 'red' : item.level === 'warn' ? 'yellow' : undefined;
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={color} dimColor={item.level === 'info'}>
            {item.level === 'error' ? '✗ ' : item.level === 'warn' ? '! ' : 'ℹ '}
            {item.text}
          </Text>
          {item.detail?.split('\n').map((line, i) => (
            <Text key={i} dimColor>
              {'  '}
              {line}
            </Text>
          ))}
        </Box>
      );
    }
    case 'command':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            {'/'}
            {item.name}
            {item.args !== undefined ? ` ${item.args}` : ''}
          </Text>
          {item.output !== undefined && item.output.length > 0 && (
            <Text color={item.failed === true ? 'red' : undefined} dimColor={item.failed !== true}>
              {'  '}
              {item.output}
            </Text>
          )}
        </Box>
      );
    case 'run-end': {
      const tokens = totalInputTokens(item.usage?.tokens);
      const parts = [
        item.durationMs !== undefined ? formatDuration(item.durationMs) : undefined,
        tokens !== undefined ? `${formatTokens(tokens)} tok` : undefined,
        item.usage?.costUsd !== undefined ? formatUsd(item.usage.costUsd) : undefined,
      ].filter((part): part is string => part !== undefined);
      if (item.reason === 'completed') {
        return <Text dimColor>{`  ✓ done${parts.length > 0 ? ` · ${parts.join(' · ')}` : ''}`}</Text>;
      }
      return (
        <Box flexDirection="column">
          <Text color={item.reason === 'error' ? 'red' : 'yellow'}>
            {'  '}
            {item.reason === 'interrupted' ? 'interrupted' : item.reason.replace(/_/g, ' ')}
            {parts.length > 0 ? ` · ${parts.join(' · ')}` : ''}
          </Text>
          <ErrorLine error={item.error} />
        </Box>
      );
    }
    default:
      return null;
  }
}

function GroupRow({
  group,
  members,
}: {
  readonly group: ActivityGroup;
  readonly members: readonly TranscriptItem[];
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>
        {'  '}
        {describeActivity(group.counts, group.running > 0)}
        {group.failed > 0 ? ` · ${String(group.failed)} failed` : ''}
      </Text>
      {members.map((member) => (
        <ItemRow key={member.id} item={member} />
      ))}
    </Box>
  );
}

function RowContent({ snapshot }: { readonly snapshot: Snapshot }): React.JSX.Element | null {
  if (snapshot.group !== undefined) return <GroupRow group={snapshot.group} members={snapshot.members ?? []} />;
  if (snapshot.item !== undefined) return <ItemRow item={snapshot.item} />;
  return null;
}

/** A row still subject to change: subscribed to its own id, redrawn on flush. */
function LiveRow({ id, transcript }: { readonly id: string; readonly transcript: TranscriptModel }): React.JSX.Element | null {
  const group = isGroupId(id);
  const snapshot = useSyncExternalStore(
    (onChange) => (group ? transcript.subscribeGroup(id, onChange) : transcript.subscribeItem(id, onChange)),
    () => (group ? transcript.getGroup(id) : transcript.getItem(id)),
  );
  if (snapshot === undefined) return null;
  const built = snapshotRow(id, transcript, id);
  return built === null ? null : <RowContent snapshot={built} />;
}

/* -------------------------------------------------------------------------- */
/* The viewport                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How many rows are ever handed to Ink at once.
 *
 * A screen shows a few dozen lines; a conversation has hundreds of rows. Only
 * the tail — plus whatever the person has scrolled back to — is rendered, so
 * a token arriving in a long conversation costs a bounded amount of work
 * rather than a walk over everything that was ever said.
 */
const WINDOW_ROWS = 40;

export interface TranscriptViewportProps {
  readonly transcript: TranscriptModel;
  /** A run is in flight. */
  readonly live: boolean;
  /** Rows scrolled back from the end. `0` follows the conversation. */
  readonly offset: number;
}

/**
 * The conversation in a fixed-height box, anchored to the bottom.
 *
 * Bottom-anchored by layout — `justifyContent: flex-end` inside an
 * `overflow: hidden` box — so the newest content is always visible and older
 * content is clipped off the top, which is what a chat pane does. Scrolling
 * back moves the window of rows, not the layout. The box takes whatever
 * height the column has left after the composer, the status line and any
 * open card: it grows to fill and shrinks to nothing, never the other way
 * round, so a tall permission card pushes the conversation up rather than the
 * composer off the screen.
 */
export function TranscriptViewport({ transcript, live, offset }: TranscriptViewportProps): React.JSX.Element {
  const rows = useSyncExternalStore(transcript.subscribeList, transcript.getRowsSnapshot);
  // Never scroll past the first row: an over-eager PgUp on a short
  // conversation should show its beginning, not an empty pane.
  const clamped = Math.min(offset, Math.max(0, rows.length - 1));
  const end = Math.max(0, rows.length - clamped);
  const start = Math.max(0, end - WINDOW_ROWS);
  const shown = rows.slice(start, end);
  const above = start;
  const below = rows.length - end;

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} overflowY="hidden" justifyContent="flex-end" paddingX={1}>
      {rows.length === 0 && (
        <Box flexDirection="column" justifyContent="center" flexGrow={1} paddingLeft={1}>
          <Text dimColor>Type a message to begin. /help lists commands.</Text>
          <Text dimColor>Tab moves to the sidebar. Esc interrupts a turn. Ctrl+C twice quits.</Text>
        </Box>
      )}
      {above > 0 && clamped > 0 && <Text dimColor>{`↑ ${String(above)} earlier rows · PgUp`}</Text>}
      {shown.map((id) => (
        <LiveRow key={id} id={id} transcript={transcript} />
      ))}
      {below > 0 && (
        <Text color="yellow">{`↓ ${String(below)} newer rows${live ? ' · streaming' : ''} · End to follow`}</Text>
      )}
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/* A finished transcript, drawn once                                          */
/* -------------------------------------------------------------------------- */

export interface ReplayRowsProps {
  /** Events from a store, in order. Nothing here is live. */
  readonly events: readonly AgentEvent[];
  /** Rows to show from the end; the rest is summarised in one line. */
  readonly maxRows?: number;
}

/**
 * What a delegated agent did, or any other stored stretch of events, run
 * through the same reducer as the live transcript and drawn from the tail.
 * Synchronous scheduler, so the rows exist by the time this returns.
 */
export function ReplayRows({ events, maxRows = 60 }: ReplayRowsProps): React.JSX.Element {
  const snapshots = useMemo(() => {
    const model = new TranscriptModel(syncScheduler);
    for (const event of events) model.apply(event);
    model.flush();
    return model
      .getRowsSnapshot()
      .map((id) => snapshotRow(id, model, id))
      .filter((snapshot): snapshot is Snapshot => snapshot !== null);
  }, [events]);
  const shown = snapshots.slice(-maxRows);
  return (
    <Box flexDirection="column">
      {snapshots.length === 0 && <Text dimColor>Nothing recorded.</Text>}
      {snapshots.length > shown.length && (
        <Text dimColor>⋯ {String(snapshots.length - shown.length)} earlier rows not shown</Text>
      )}
      {shown.map((snapshot) => (
        <RowContent key={snapshot.key} snapshot={snapshot} />
      ))}
    </Box>
  );
}
