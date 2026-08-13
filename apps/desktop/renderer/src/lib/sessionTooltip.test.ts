/**
 * The sidebar tooltip's copy.
 *
 * These helpers decide what a hover *says* — which fields earn a row, what a
 * missing profile is called, how much of a prompt-derived title is still a
 * title — and they are the half of #85 that can be tested without a DOM. The
 * other half, the wrapping, is a property of the box and lives with the
 * component (`session-tooltip.test.tsx` pins what jsdom can see of it).
 */

import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@rx-artemis/protocol';

import { sessionCountLabel, sessionTooltipRows, sessionTooltipTitle } from './sessionTooltip';

const NOW = 1_700_000_000_000;

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    providerId: 'claude',
    profileId: 'p1',
    cwd: '/Users/ada/code/artemis',
    title: 'Wire the adapter seam',
    updatedAt: NOW - 4 * 60_000,
    ...overrides,
  } as SessionSummary;
}

function labels(rows: ReturnType<typeof sessionTooltipRows>): readonly string[] {
  return rows.map((row) => row.label);
}

function row(rows: ReturnType<typeof sessionTooltipRows>, label: string) {
  const found = rows.find((r) => r.label === label);
  if (!found) throw new Error(`no “${label}” row`);
  return found;
}

describe('sessionTooltipRows', () => {
  it('always carries the directory, the profile and the activity', () => {
    const rows = sessionTooltipRows(summary(), { profileLabel: 'Work', now: NOW });
    expect(labels(rows)).toEqual(['directory', 'profile', 'activity']);
    expect(row(rows, 'directory').value).toBe('/Users/ada/code/artemis');
    expect(row(rows, 'profile').value).toBe('Work');
    expect(row(rows, 'activity').value).toBe('4m ago');
  });

  it('adds branch, model and messages when the summary has them, in that order', () => {
    const rows = sessionTooltipRows(
      summary({ gitBranch: 'feat/adapter-seam', model: 'claude-fable-5', messageCount: 34 }),
      { profileLabel: 'Work', now: NOW },
    );
    expect(labels(rows)).toEqual([
      'directory',
      'branch',
      'profile',
      'model',
      'messages',
      'activity',
    ]);
    expect(row(rows, 'branch').value).toBe('feat/adapter-seam');
    expect(row(rows, 'model').value).toBe('claude-fable-5');
    expect(row(rows, 'messages').value).toBe('34');
  });

  it('drops a row rather than rendering a blank for an empty branch', () => {
    const rows = sessionTooltipRows(summary({ gitBranch: '' }), { now: NOW });
    expect(labels(rows)).not.toContain('branch');
  });

  it('keeps a zero message count — an empty session is a fact, not an absence', () => {
    const rows = sessionTooltipRows(summary({ messageCount: 0 }), { now: NOW });
    expect(row(rows, 'messages').value).toBe('0');
  });

  it('names the missing profile instead of printing undefined', () => {
    // Defensive: an orphaned row is disabled and shows its `disabledReason`
    // instead of this tooltip, so this value is the trap-not-armed case.
    const rows = sessionTooltipRows(summary(), { now: NOW });
    expect(row(rows, 'profile').value).toBe('p1 (no longer exists)');
  });

  it('marks the long-token values as mono and the prose as not', () => {
    const rows = sessionTooltipRows(
      summary({ gitBranch: 'main', model: 'claude-fable-5', messageCount: 2 }),
      { profileLabel: 'Work', now: NOW },
    );
    const mono = rows.filter((r) => r.mono).map((r) => r.label);
    expect(mono).toEqual(['directory', 'branch', 'model', 'messages']);
  });
});

describe('sessionTooltipTitle', () => {
  it('passes an ordinary title through whole', () => {
    expect(sessionTooltipTitle('Wire the adapter seam')).toBe('Wire the adapter seam');
  });

  it('does not fold to eight words the way the row does', () => {
    const prompt =
      'Can you take a look at the failing permission test and work out why it only fails in CI?';
    expect(sessionTooltipTitle(prompt)).toBe(prompt);
  });

  it('flattens the newlines of a prompt-derived title', () => {
    expect(sessionTooltipTitle('Fix   the\n\nresume bug')).toBe('Fix the resume bug');
  });

  it('caps a pasted-essay title so the tooltip stays a tooltip', () => {
    const essay = 'word '.repeat(200);
    const result = sessionTooltipTitle(essay);
    expect(result.length).toBeLessThanOrEqual(280);
    expect(result.endsWith('…')).toBe(true);
  });

  it('names an empty title rather than rendering an empty headline', () => {
    expect(sessionTooltipTitle('')).toBe('Untitled session');
    expect(sessionTooltipTitle('   ')).toBe('Untitled session');
  });
});

describe('sessionCountLabel', () => {
  it('counts in sessions, singular and plural', () => {
    expect(sessionCountLabel(1)).toBe('1 session');
    expect(sessionCountLabel(22)).toBe('22 sessions');
  });
});
