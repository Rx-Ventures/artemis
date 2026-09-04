/**
 * One list, one choice.
 *
 * Every switcher in the TUI — account, model, effort, permission mode, and the
 * "are you sure" that guards two of them — is this component with different
 * rows. Up/Down or j/k move, Enter picks, Esc leaves without picking. Rows can
 * be disabled with a reason, and a disabled row is still *shown*: the profile
 * screen's rule that an account you cannot use is greyed with its reason, not
 * hidden, because a row you cannot see cannot tell you what to fix.
 *
 * The initial selection is the caller's to set. For a destructive choice that
 * means the safe row, so that Enter pressed once too often does nothing worse
 * than nothing.
 */

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface PickerItem<K extends string = string> {
  readonly key: K;
  readonly label: string;
  /** Shown dimmed after the label. */
  readonly detail?: string;
  /** A second, dimmer line under the row. */
  readonly note?: string;
  readonly disabled?: boolean;
  /** Why it is disabled; replaces `detail` when set. */
  readonly reason?: string;
  /** Paint the label in the danger colour. */
  readonly danger?: boolean;
}

export interface PickerProps<K extends string = string> {
  readonly title: string;
  readonly items: readonly PickerItem<K>[];
  readonly initialKey?: K;
  readonly onSelect: (item: PickerItem<K>) => void;
  readonly onCancel: () => void;
  /** Shown under the list; defaults to the key legend. */
  readonly hint?: string;
  readonly isActive?: boolean;
}

export function Picker<K extends string = string>({
  title,
  items,
  initialKey,
  onSelect,
  onCancel,
  hint,
  isActive = true,
}: PickerProps<K>): React.JSX.Element {
  const initial = Math.max(
    0,
    items.findIndex((item) => item.key === initialKey),
  );
  const [index, setIndex] = useState(initial);

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.upArrow || input === 'k') {
        setIndex((current) => (current - 1 + items.length) % Math.max(1, items.length));
        return;
      }
      if (key.downArrow || input === 'j') {
        setIndex((current) => (current + 1) % Math.max(1, items.length));
        return;
      }
      if (key.return) {
        const item = items[index];
        if (item !== undefined && item.disabled !== true) onSelect(item);
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Text bold>{title}</Text>
      {items.length === 0 && <Text dimColor>Nothing to choose from.</Text>}
      {items.map((item, i) => {
        const selected = i === index;
        const marker = selected ? '❯' : ' ';
        const colour = item.danger === true ? 'red' : selected ? 'cyan' : undefined;
        return (
          <Box key={item.key} flexDirection="column">
            <Text>
              <Text color={selected ? 'cyan' : undefined}>{marker} </Text>
              <Text color={colour} dimColor={item.disabled === true} bold={selected}>
                {item.label}
              </Text>
              {item.disabled === true && item.reason !== undefined ? (
                <Text dimColor>{'  '}{item.reason}</Text>
              ) : item.detail !== undefined ? (
                <Text dimColor>{'  '}{item.detail}</Text>
              ) : null}
            </Text>
            {item.note !== undefined && <Text dimColor>{'    '}{item.note}</Text>}
          </Box>
        );
      })}
      <Text dimColor>{hint ?? '↑↓ move · Enter choose · Esc back'}</Text>
    </Box>
  );
}
