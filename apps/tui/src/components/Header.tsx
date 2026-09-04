/**
 * The top of the screen: the mark, and where you are.
 *
 * Two lines of logo when the terminal is tall enough, one word when it is
 * not, the tagline beside it, and the working directory on the right. That is
 * all — which account is running, which model, which permission mode live
 * *under the conversation*, next to the composer that sends with them, where
 * the eye already is when it matters.
 *
 * Colours are the terminal's own: the mark in the theme's accent, the rest
 * dimmed.
 */

import { Box, Text } from 'ink';

import { ACCENT, LOGO_LINES, TAGLINE } from '../theme.js';
import { shortenPath } from './Sidebar.js';

export interface HeaderProps {
  readonly cwd: string;
  readonly columns: number;
  /** Two-line logo, or one word. */
  readonly tall: boolean;
}

export function Header({ cwd, columns, tall }: HeaderProps): React.JSX.Element {
  const where = <Text dimColor>{shortenPath(cwd)}</Text>;

  if (!tall || columns < 70) {
    return (
      <Box
        paddingX={1}
        justifyContent="space-between"
        borderStyle="single"
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderDimColor
      >
        <Text>
          <Text color={ACCENT} bold>
            ▲ ARTEMIS
          </Text>
          <Text dimColor>{'  '}{TAGLINE}</Text>
        </Text>
        {where}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="row"
      paddingX={1}
      justifyContent="space-between"
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderDimColor
    >
      <Box flexDirection="row">
        <Box flexDirection="column" marginRight={3}>
          {LOGO_LINES.map((line) => (
            <Text key={line} color={ACCENT} bold>
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" justifyContent="flex-end">
          <Text dimColor>{TAGLINE}</Text>
        </Box>
      </Box>
      <Box flexDirection="column" justifyContent="flex-end">{where}</Box>
    </Box>
  );
}
