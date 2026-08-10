/**
 * Appearance.
 * ============================================================================
 *
 * The smallest pane, on purpose. Libra is a dark-only app with one palette and
 * one type scale — those are architecture, not preferences, and a settings pane
 * that offered to change them would be promising something the design system
 * does not support.
 *
 * What is left is genuinely a matter of taste and genuinely wired: how wide the
 * transcript column may grow, and whether the sidebar is showing. Both are
 * persisted, both take effect the moment they are set, and there is nothing
 * else here.
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

import { ReasonButton } from '../disabled-reason';
import { ChoiceList, SettingsGroup, SettingsPane, type Choice } from './pane';
import {
  SIDEBAR_DEFAULT_WIDTH,
  setConversationWidth,
  setSidebarCollapsed,
  setSidebarWidth,
  useApp,
  type ConversationWidth,
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

export function AppearanceSection(): ReactElement {
  const width = useApp((s) => s.conversationWidth);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const sidebarWidth = useApp((s) => s.sidebarWidth);

  return (
    <SettingsPane
      title="Appearance"
      description="How much room the conversation gets, and whether the sidebar is in the way."
    >
      <SettingsGroup label="Conversation width">
        <ChoiceList
          label="Conversation width"
          value={width}
          choices={WIDTHS}
          onChange={setConversationWidth}
        />
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
        Theme, density and motion are not settings. Libra is dark-only by design, the transcript
        uses one spacing scale so that message boundaries stay readable at a glance, and the only
        animations in the app are the ones that show something arriving.
      </p>
    </SettingsPane>
  );
}
