/**
 * Appearance.
 * ============================================================================
 *
 * A small pane, on purpose. Artemis is a dark-only app with one palette, and
 * that is architecture rather than preference — a settings pane offering to
 * change it would be promising something the design system does not support.
 *
 * Text size is the one that looks like the same kind of claim and is not, so it
 * is worth being precise about what became settable. The type *scale* is still
 * architecture: 11 / 12 / 13 / 14 / 16 / 20 and the ratios between them are
 * fixed, and nothing here can put the transcript at 13 while the chrome labels
 * stay at 11. What the user moves is a single multiplier over the whole scale —
 * the design system's proportions, rendered larger or smaller. That is why it
 * can be offered honestly, and why it is one number rather than a font panel.
 *
 * The rest is genuinely a matter of taste and genuinely wired: how wide the
 * transcript column may grow, how much of the block at the end of a run it
 * keeps, and whether the sidebar is showing. All are persisted and all take
 * effect the moment they are set.
 *
 * That last part is the rule this file is written to. Every control below
 * writes to a store action that something actually reads. A "reduced motion" or
 * "compact density" switch would be easy to add and would silently do nothing,
 * which is worse than not offering it — the user changes it, sees no
 * difference, and stops trusting the rest of the pane. When those become real
 * settings they belong here; until then the note at the foot says plainly that
 * they are not settings rather than leaving a suspicious gap.
 */

import type { ReactElement } from 'react';
import { MinusIcon, PlusIcon } from 'lucide-react';

import { ReasonButton } from '../disabled-reason';
import { ChoiceList, SettingsGroup, SettingsPane, type Choice } from './pane';
import {
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SIDEBAR_DEFAULT_WIDTH,
  setConversationWidth,
  setFontSize,
  setPlanMeterFocus,
  setRunSummary,
  setSidebarCollapsed,
  setSidebarWidth,
  useApp,
  type ConversationWidth,
  type PlanMeterFocus,
  type RunSummary,
} from '../../state/store';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Switch } from '@/components/ui/switch';

/**
 * The three reading modes.
 *
 * Written as reading modes rather than as sizes because that is what the user
 * is choosing between: a measure tuned for prose, a measure that stops diffs
 * from wrapping, and "use the window". A pixel figure here would be a number
 * nobody can act on.
 */
const WIDTHS: readonly Choice<ConversationWidth>[] = [
  {
    id: 'comfortable',
    label: 'Comfortable',
    note: 'A narrow column, sized for reading. Long lines are the single thing that makes a long transcript tiring.',
  },
  {
    id: 'wide',
    label: 'Wide',
    note: 'Room for diffs, tables and tool output, which wrap badly in a reading column.',
  },
  {
    id: 'full',
    label: 'Full width',
    note: 'Use the whole window. Best on a narrow display, or when the window is already only half the screen.',
  },
];

/**
 * What each setting keeps of the block a run ends with.
 *
 * Every note says what still appears, not what disappears — the question a
 * user has here is "will I lose the error", and the answer is no in all three
 * cases. Trimming is described as trimming; nothing here is described as off.
 */
const RUN_SUMMARIES: readonly Choice<RunSummary>[] = [
  {
    id: 'always',
    label: 'After every run',
    note: 'Duration, turns, tokens and cost. Worth keeping while you are watching spend or comparing models.',
  },
  {
    id: 'failures',
    label: 'Only when a run is cut short',
    note: 'A clean run ends quietly. Errors, interruptions and hitting a turn or budget limit still report — each means the answer above is unfinished.',
  },
  {
    id: 'never',
    label: 'Never',
    note: 'No accounting at all. A failed run still shows its message and code, because this is the only place either appears.',
  },
];

/**
 * Which limit the status-bar meter counts down.
 *
 * One window, not all of them: the meter is a single bar in a status line, and
 * the version that showed "whichever is closest to full" never understated the
 * pressure but also never answered a specific question — the number could be
 * any window at any moment, so it could not be watched.
 *
 * The trade is stated in the last note rather than hidden: a comfortable
 * focused window says nothing about the others.
 */
const METERS: readonly Choice<PlanMeterFocus>[] = [
  {
    id: 'five_hour',
    label: '5-hour limit',
    note: 'The one that interrupts work. A weekly limit is something you budget around over days; this is the one that stops you mid-task.',
  },
  {
    id: 'seven_day',
    label: 'Weekly limit',
    note: 'The whole plan’s 7-day window. Worth watching in the back half of a heavy week.',
  },
  {
    id: 'model',
    label: 'Per-model weekly',
    note: 'The weekly window for the model closest to full — Fable and Opus are metered separately from the plan total on some accounts. Shows a dash if your plan has no per-model limits.',
  },
];

/**
 * The text-size row.
 *
 * A stepper rather than a `ChoiceList`, which is the one place this pane breaks
 * its own habit. The other three settings are a short list of named modes whose
 * notes are the entire point — nobody knows what "wide" costs without the
 * sentence. Text size is a scalar with ten positions and no prose to attach:
 * rendering it as ten radio rows would be ten near-identical cards inventing
 * differences between 15px and 16px that do not exist.
 *
 * There is no preview swatch because the pane *is* the preview — the dialog is
 * laid out in the same rem the setting scales, so it resizes under the pointer
 * as the value changes. A sample line showing "the quick brown fox" at the new
 * size would be a smaller, worse copy of what the user is already looking at.
 *
 * Both buttons stay mounted at the bounds and explain themselves through
 * `ReasonButton`, per the rule in `disabled-reason.tsx`: a `+` that silently
 * stopped working at 20px reads as a bug, not as a limit.
 */
function TextSize(): ReactElement {
  const fontSize = useApp((s) => s.fontSize);

  return (
    <Item variant="outline" size="sm" className="items-start border-line bg-panel">
      <ItemContent>
        <ItemTitle className="text-xs text-ink">
          Base text size
          <span className="font-mono text-2xs text-ink-muted">{fontSize}px</span>
        </ItemTitle>
        <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
          Scales the whole window, not just the letters — row heights, padding and the sidebar move
          with it, so the transcript stays as dense as it looks now and only gets larger. Persisted,
          and applied before the first paint, so the app opens at the size you left it.
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <ReasonButton
          size="xs"
          variant="outline"
          aria-label="Smaller text"
          disabled={fontSize <= FONT_SIZE_MIN}
          disabledReason={`${FONT_SIZE_MIN}px is as small as the 11px chrome labels stay readable.`}
          onClick={() => setFontSize(fontSize - 1)}
        >
          <MinusIcon />
        </ReasonButton>
        <ReasonButton
          size="xs"
          variant="outline"
          aria-label="Larger text"
          disabled={fontSize >= FONT_SIZE_MAX}
          disabledReason={`${FONT_SIZE_MAX}px is as large as the status line fits on a laptop display.`}
          onClick={() => setFontSize(fontSize + 1)}
        >
          <PlusIcon />
        </ReasonButton>
        {/* Named, not just "Reset": the sidebar row below has a reset of its
            own, and two buttons announcing themselves identically in one pane
            is exactly the ambiguity a screen-reader user cannot resolve. The
            visible label stays short; only the accessible name is qualified. */}
        <ReasonButton
          size="xs"
          variant="outline"
          aria-label="Reset text size"
          disabled={fontSize === FONT_SIZE_DEFAULT}
          disabledReason="Already at the default size."
          onClick={() => setFontSize(FONT_SIZE_DEFAULT)}
        >
          Reset
        </ReasonButton>
      </ItemActions>
    </Item>
  );
}

export function AppearanceSection(): ReactElement {
  const width = useApp((s) => s.conversationWidth);
  const runSummary = useApp((s) => s.runSummary);
  const planMeterFocus = useApp((s) => s.planMeterFocus);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const sidebarWidth = useApp((s) => s.sidebarWidth);

  return (
    <SettingsPane
      title="Appearance"
      description="How big the app is, how much room the conversation gets, how much it reports when a run ends, and whether the sidebar is in the way."
    >
      <SettingsGroup label="Text size">
        <ItemGroup className="gap-2">
          <TextSize />
        </ItemGroup>
      </SettingsGroup>

      <SettingsGroup label="Conversation width">
        <ChoiceList
          label="Conversation width"
          value={width}
          choices={WIDTHS}
          onChange={setConversationWidth}
        />
      </SettingsGroup>

      <SettingsGroup label="Run summary">
        <ChoiceList
          label="Run summary"
          value={runSummary}
          choices={RUN_SUMMARIES}
          onChange={setRunSummary}
        />
      </SettingsGroup>

      <SettingsGroup label="Plan meter">
        <ChoiceList
          label="Plan meter"
          value={planMeterFocus}
          choices={METERS}
          onChange={setPlanMeterFocus}
        />
        <p className="mt-2 text-2xs leading-relaxed text-ink-faint">
          The meter reports this one window. Being comfortable here does not mean the others are —
          click it for every limit your plan reports.
        </p>
      </SettingsGroup>

      <SettingsGroup label="Sidebar">
        <ItemGroup className="gap-2">
          <Item variant="outline" size="sm" className="items-start border-line bg-panel">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">Hide the sidebar</ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                Persisted, so the app opens the way you left it. It stays hidden until you bring it
                back — nothing reopens it for you.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                id="settings-sidebar-collapsed"
                aria-label="Hide the sidebar"
                checked={collapsed}
                onCheckedChange={setSidebarCollapsed}
              />
            </ItemActions>
          </Item>

          <Item variant="outline" size="sm" className="items-start border-line bg-panel">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">
                Width
                <span className="font-mono text-2xs text-ink-muted">{sidebarWidth}px</span>
              </ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                {/* No slider here on purpose: the sidebar is resized by dragging
                    its edge, which is both more direct and already implemented.
                    A second control for the same number would be a way to
                    disagree with the drag handle. This is the undo. */}
                Drag the sidebar’s edge to resize it. This is where you undo that.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <ReasonButton
                size="xs"
                variant="outline"
                aria-label="Reset sidebar width"
                disabled={sidebarWidth === SIDEBAR_DEFAULT_WIDTH}
                disabledReason="Already at the default width."
                onClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
              >
                Reset
              </ReasonButton>
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsGroup>

      <p className="text-2xs leading-relaxed text-ink-faint">
        Theme, density and motion are not settings. Artemis is dark-only by design, the transcript
        uses one spacing scale so that message boundaries stay readable at a glance — text size
        moves that whole scale at once rather than loosening it — and the only animations in the app
        are the ones that show something arriving.
      </p>
    </SettingsPane>
  );
}
