/**
 * The left rail: every conversation this account has, in folders.
 *
 * The desktop's session list, in a column. Conversations come from every
 * account's store, across every directory each has worked in — a row from
 * another account says so, and opening it switches to that account — and
 * are grouped by *project* — the repository, with every worktree of it folded
 * into the same folder — exactly as the desktop groups them: a worktree of
 * Artemis is still Artemis. Opening a conversation moves the working
 * directory to wherever it ran, worktree included. Folders are in name order
 * and hold still, as the desktop's are — a heading someone is reaching for
 * must not slide away because a conversation elsewhere was touched — and the
 * conversations inside one are newest first. The project you are in starts
 * open; the others start folded, and Enter on a heading folds or unfolds it.
 * A folder shows its newest few and then an "… n more" row; Enter on that
 * shows the rest.
 *
 * One cursor walks the whole rail — "new", then each folder's heading and
 * its conversations — and Enter does the one thing that row means. The rail
 * draws the cursor only while it has focus (Tab), so the composer's cursor and
 * this one are never both lit. Colours are the terminal's own: the accent is
 * the theme's magenta, the rest is foreground and dim.
 *
 * Nothing here decides anything. What Enter *does* is the app's; the rail
 * reports which row was chosen.
 */

import { basename } from 'node:path';
import { homedir } from 'node:os';

import { Box, Text } from 'ink';
import type { SessionSummary } from '@rx-artemis/protocol';
import { compareFolderNames, formatRelative, oneLine } from '@rx-artemis/transcript';

import { ACCENT } from '../theme.js';

export type RailRow =
  | { readonly kind: 'new' }
  | { readonly kind: 'folder'; readonly project: string; readonly label: string; readonly count: number; readonly open: boolean }
  | { readonly kind: 'session'; readonly session: SessionSummary; readonly account?: string }
  | { readonly kind: 'more'; readonly project: string; readonly hidden: number };

/** How many conversations a folder shows before "… n more"; Enter on that row shows the rest. */
const PER_FOLDER = 8;

/** Newest first; a session id is unique per account, so the account breaks a timestamp tie. */
function newestFirst(a: SessionSummary, b: SessionSummary): number {
  return b.updatedAt - a.updatedAt || `${a.profileId}:${a.id}`.localeCompare(`${b.profileId}:${b.id}`);
}

/** `~/code/repo` for a path under the home directory. */
export function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * The rail's rows in cursor order.
 *
 * `projectOf` maps a working directory to the project it belongs to — the
 * repository root, or the main checkout for a linked worktree — and is what
 * keeps worktrees together. A directory nobody has resolved yet is its own
 * project until the answer lands.
 *
 * Folders sort by name — the same comparator as every folder list in the
 * desktop — and so never move when a conversation is worked on; the current
 * project is not lifted to the top, because a heading that jumps whenever the
 * working directory changes is a heading that cannot be found by position.
 * It is always present, even with nothing in it, so a fresh directory has a
 * heading to open a conversation under. Conversations sort newest first here
 * rather than trusting the input's order: the list is assembled from several
 * accounts' stores, and this is the one place that decides what "in order"
 * means for the rail.
 *
 * `expanded` names the folders showing every conversation rather than the
 * newest `PER_FOLDER`; the "… n more" row is what adds a folder to it.
 */
export function railRows(
  sessions: readonly SessionSummary[],
  currentCwd: string,
  open: ReadonlySet<string>,
  projectOf: (cwd: string) => string,
  /** Label for a session's account when it is not the current one; `undefined` when it is. */
  accountOf: (session: SessionSummary) => string | undefined = () => undefined,
  expanded: ReadonlySet<string> = new Set(),
): readonly RailRow[] {
  const byProject = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const project = projectOf(session.cwd);
    const list = byProject.get(project) ?? [];
    list.push(session);
    byProject.set(project, list);
  }
  const current = projectOf(currentCwd);
  if (!byProject.has(current)) byProject.set(current, []);

  const folders = [...byProject.entries()].sort(([a], [b]) => compareFolderNames(a, b));

  const rows: RailRow[] = [{ kind: 'new' }];
  for (const [project, list] of folders) {
    const isOpen = open.has(project);
    rows.push({ kind: 'folder', project, label: basename(project) || project, count: list.length, open: isOpen });
    if (!isOpen) continue;
    const ordered = [...list].sort(newestFirst);
    const shown = expanded.has(project) ? ordered : ordered.slice(0, PER_FOLDER);
    for (const session of shown) {
      const account = accountOf(session);
      rows.push({ kind: 'session', session, ...(account === undefined ? {} : { account }) });
    }
    if (shown.length < ordered.length) rows.push({ kind: 'more', project, hidden: ordered.length - shown.length });
  }
  return rows;
}

export interface SidebarProps {
  readonly rows: readonly RailRow[];
  readonly selected: number;
  readonly focused: boolean;
  readonly activeSessionId?: string;
  /** The project the working directory belongs to. */
  readonly currentProject: string;
  readonly width: number;
  readonly height: number;
  readonly loading: boolean;
}

export function Sidebar({
  rows,
  selected,
  focused,
  activeSessionId,
  currentProject,
  width,
  height,
  loading,
}: SidebarProps): React.JSX.Element {
  const inner = Math.max(8, width - 3);
  // Rows the screen can hold: title, hint, and one line each. The window
  // follows the cursor so a long list can still be walked.
  const budget = Math.max(3, height - 4);
  const first = focused ? Math.max(0, Math.min(selected - Math.floor(budget / 2), rows.length - budget)) : 0;
  const visible = rows.slice(first, first + budget);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      paddingX={1}
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderBottom={false}
      borderDimColor={!focused}
      borderColor={focused ? ACCENT : undefined}
    >
      <Text color={ACCENT} bold>
        CONVERSATIONS
      </Text>
      {loading && rows.length <= 2 && <Text dimColor>  reading…</Text>}
      {visible.map((row, i) => {
        const index = first + i;
        const isSelected = focused && index === selected;
        const cursor = isSelected ? '❯' : ' ';
        switch (row.kind) {
          case 'new':
            return (
              <Text key="new">
                <Text color={ACCENT}>{cursor} </Text>
                <Text color={isSelected ? ACCENT : undefined} bold={isSelected} dimColor={!isSelected}>
                  + new conversation
                </Text>
              </Text>
            );
          case 'folder': {
            const current = row.project === currentProject;
            const glyph = row.open ? '▾' : '▸';
            return (
              <Box key={`folder:${row.project}`} marginTop={1} flexDirection="column">
                <Text>
                  <Text color={ACCENT}>{cursor} </Text>
                  <Text bold color={isSelected ? ACCENT : undefined} dimColor={!current && !isSelected}>
                    {glyph} {oneLine(row.label, inner - 8)}
                  </Text>
                  <Text dimColor>{` ${String(row.count)}`}</Text>
                </Text>
                {isSelected && <Text dimColor>{'    '}{oneLine(shortenPath(row.project), inner - 4)}</Text>}
              </Box>
            );
          }
          case 'session': {
            const active = row.session.id === activeSessionId;
            return (
              <Box key={`session:${row.session.id}`} flexDirection="column">
                <Text>
                  <Text color={ACCENT}>{cursor} </Text>
                  <Text color={isSelected || active ? ACCENT : undefined} bold={isSelected || active} dimColor={!isSelected && !active}>
                    {'  '}
                    {oneLine(row.session.title, inner - 4 - (row.account === undefined ? 0 : row.account.length + 3))}
                  </Text>
                  {row.account !== undefined && <Text dimColor>{` · ${row.account}`}</Text>}
                </Text>
                {isSelected && (
                  <Text dimColor>
                    {'      '}
                    {oneLine(
                      [
                        formatRelative(row.session.updatedAt),
                        row.session.gitBranch,
                        row.session.model,
                      ]
                        .filter((part): part is string => part !== undefined && part.length > 0)
                        .join(' · '),
                      inner - 6,
                    )}
                  </Text>
                )}
              </Box>
            );
          }
          case 'more':
            return (
              <Text key={`more:${row.project}`}>
                <Text color={ACCENT}>{cursor} </Text>
                <Text color={isSelected ? ACCENT : undefined} bold={isSelected} dimColor={!isSelected}>
                  {'  '}… {String(row.hidden)} more
                </Text>
              </Text>
            );
          default:
            return null;
        }
      })}
      <Box flexGrow={1} />
      <Text dimColor>{focused ? '↑↓ · Enter · Esc' : 'Tab: conversations'}</Text>
    </Box>
  );
}
