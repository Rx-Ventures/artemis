/**
 * The two lines under the composer.
 *
 * The first says *what the next message goes out as* — account, model and
 * its effort, permission mode — sitting directly under the thing that sends
 * it, and at its right edge how full the plan is: the 5-hour window, the
 * week, and Fable's own bucket where the plan meters one, the same three the
 * desktop's rings show. The second says what is happening now: a spinner
 * while the provider works, what the keys do, tokens and cost so far.
 *
 * Every value here is read from the conversation's state rather than echoed
 * from the last thing chosen — the mode, in particular, is what the provider
 * *said* it started in, which is why it can differ from the picker until the
 * next turn. `bypassPermissions` is painted red: it is the one mode where this
 * line is a warning, and it must never look like the others.
 *
 * Colours are the terminal's own. Each half of each line truncates rather
 * than wraps: a status line that folds onto a second row pushes the layout
 * out of its fixed height, and a clipped account name costs less than that.
 */

import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { isTaskLive, planMeterSlots, type PermissionMode, type PlanMeterSlot } from '@rx-artemis/protocol';
import { contextRatio, formatTokens, formatUsd, totalInputTokens } from '@rx-artemis/transcript';

import type { ConversationState } from '../conversation.js';
import { ACCENT, SPINNER, SPINNER_MS } from '../theme.js';

const MODE_LABEL: Readonly<Record<PermissionMode, string>> = {
  default: 'ask',
  acceptEdits: 'accept edits',
  plan: 'plan',
  auto: 'auto',
  dontAsk: "don't ask",
  bypassPermissions: 'BYPASS PERMISSIONS',
};

export interface StatusBarProps {
  readonly state: ConversationState;
  /** A transient message with priority over the hints, e.g. "press again to quit". */
  readonly flash?: string;
  /** What the keys do right now, e.g. for the sidebar. */
  readonly hint?: string;
}

/**
 * One window's reading, coloured by pressure: red at 90, yellow at 75 — the
 * desktop's own thresholds, pessimistic on purpose because a reset can be
 * hours away. A window the provider is rejecting on is red whatever its
 * stale percentage reads, and says so.
 */
function PlanReading({ slot }: { readonly slot: PlanMeterSlot }): React.JSX.Element {
  const { utilization, status } = slot.window;
  const rejected = status === 'rejected';
  const pct = utilization === null ? (rejected ? '!' : '—') : `${String(Math.round(utilization))}%`;
  const hot = rejected || (utilization !== null && utilization >= 90);
  const warm = !hot && utilization !== null && utilization >= 75;
  return (
    <Text>
      <Text dimColor>{slot.label} </Text>
      <Text color={hot ? 'red' : warm ? 'yellow' : undefined} bold={hot} dimColor={!hot && !warm}>
        {rejected ? `${pct} out` : pct}
      </Text>
    </Text>
  );
}

/** A braille spinner that only ticks while something is happening. */
function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), SPINNER_MS);
    return () => clearInterval(timer);
  }, [active]);
  return active ? SPINNER[frame] ?? '' : '';
}

function describeStatus(state: ConversationState): string {
  switch (state.status) {
    case 'idle':
      return state.sessionId === undefined ? 'ready' : 'idle';
    case 'starting':
      return 'starting…';
    case 'running':
      return state.queued > 0 ? `working · ${String(state.queued)} queued` : 'working…';
    case 'awaiting_permission':
      return 'waiting for you';
    default:
      return '';
  }
}

export function StatusBar({ state, flash, hint }: StatusBarProps): React.JSX.Element {
  const { settings, usage } = state;
  const mode = settings.permissionMode;
  const tokens = totalInputTokens(usage?.tokens);
  const ratio = contextRatio(usage);
  const cost = usage?.costUsd;
  const slots = planMeterSlots(state.planUsage);
  const liveTasks = state.tasks.filter(isTaskLive).length;
  const busy = state.status === 'starting' || state.status === 'running';
  const spinner = useSpinner(busy);
  const model = settings.modelLabel ?? settings.model ?? 'default model';
  const details = [
    settings.effort,
    settings.fastMode === true ? 'fast' : undefined,
    settings.ultracode === true ? 'ultracode' : undefined,
  ].filter((part): part is string => part !== undefined);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate">
          <Text bold>{settings.profileLabel}</Text>
          <Text dimColor>{` ${settings.providerLabel}`}</Text>
          <Text dimColor>{' · '}</Text>
          <Text>{model}</Text>
          {details.length > 0 && <Text dimColor>{` ${details.join(' ')}`}</Text>}
          <Text dimColor>{' · '}</Text>
          <Text color={mode === 'bypassPermissions' ? 'red' : mode === 'plan' ? ACCENT : undefined} bold={mode === 'bypassPermissions'}>
            {MODE_LABEL[mode]}
          </Text>
        </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text>
            {slots.map((slot, i) => (
              <Text key={slot.id}>
                {i > 0 && <Text dimColor>{' · '}</Text>}
                <PlanReading slot={slot} />
              </Text>
            ))}
          </Text>
        </Box>
      </Box>
      <Box justifyContent="space-between">
        <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate">
          {flash !== undefined ? (
            <Text color="yellow">{flash}</Text>
          ) : (
            <>
              {busy && <Text color={ACCENT}>{spinner} </Text>}
              <Text dimColor={!busy && state.status !== 'awaiting_permission'} color={state.status === 'awaiting_permission' ? 'yellow' : undefined}>
                {describeStatus(state)}
              </Text>
              {busy && (
                <Text dimColor>{state.capabilities.midRunSteering ? ' · Enter steers · Esc interrupts' : ' · Esc interrupts'}</Text>
              )}
              {hint !== undefined && <Text dimColor>{` · ${hint}`}</Text>}
            </>
          )}
        </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
        <Text>
          {tokens !== undefined && (
            <Text dimColor>
              {formatTokens(tokens)} tok{ratio !== undefined ? ` (${String(Math.round(ratio * 100))}%)` : ''}
            </Text>
          )}
          {cost !== undefined && <Text dimColor>{' · '}{formatUsd(cost)}</Text>}
          {liveTasks > 0 && <Text color="cyan">{` · ${String(liveTasks)} task${liveTasks === 1 ? '' : 's'}`}</Text>}
          <Text dimColor>{' · /help'}</Text>
        </Text>
        </Box>
      </Box>
    </Box>
  );
}
