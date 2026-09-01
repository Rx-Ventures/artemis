/**
 * The served-account join, against catalogues old and new.
 *
 * A 2.4.4 server sends `account*` on every option; a 2.4.3 server sends none
 * of it and the account survives only as the route prefix and the note's
 * `"<account> — "` wording. Both shapes are load-bearing, so both are pinned.
 */

import { describe, expect, it } from 'vitest';

import type { PlanUsage, ProviderModelOption } from '@rx-artemis/protocol';

import {
  groupServedAccounts,
  scopedToServedAccount,
  servedAccountLabel,
  servedAccountSlug,
  servedGaugeFor,
} from './servedAccounts';

function option(partial: Partial<ProviderModelOption> & { id: string }): ProviderModelOption {
  return { label: partial.id, note: '', ...partial };
}

function usageAt(utilization: number): PlanUsage {
  return {
    available: true,
    windows: [{ id: 'five_hour', label: '5 hours', utilization, resetsAt: null }],
    fetchedAt: 1,
  };
}

describe('servedAccountSlug', () => {
  it('prefers the explicit field over the route prefix', () => {
    expect(servedAccountSlug(option({ id: 'work/opus', accountSlug: 'work-max' }))).toBe('work-max');
  });

  it('falls back to the route prefix, and to null without one', () => {
    expect(servedAccountSlug(option({ id: 'work/opus' }))).toBe('work');
    expect(servedAccountSlug(option({ id: 'opus' }))).toBeNull();
    expect(servedAccountSlug(undefined)).toBeNull();
  });
});

describe('servedAccountLabel', () => {
  it('prefers the explicit field over parsing the note', () => {
    expect(
      servedAccountLabel(option({ id: 'a/x', note: 'Other — note', accountLabel: 'Work' })),
    ).toBe('Work');
  });

  it('reads the note prefix an older server encodes', () => {
    expect(servedAccountLabel(option({ id: 'a/x', note: 'Work — Fast and steady.' }))).toBe('Work');
    expect(servedAccountLabel(option({ id: 'a/x', note: 'Work' }))).toBe('Work');
    expect(servedAccountLabel(option({ id: 'a/x', note: '' }))).toBeNull();
  });
});

describe('servedGaugeFor', () => {
  const gauges = {
    'profile-1/acct-a': { usage: usageAt(10), label: 'Work' },
    'profile-1/acct-b': { usage: usageAt(90), label: 'Personal' },
    'profile-2/acct-a': { usage: usageAt(50), label: 'Work' },
  };

  it('joins exactly on the account id, scoped to the profile', () => {
    const model = option({ id: 'work/opus', accountId: 'acct-b', accountLabel: 'Personal' });
    expect(servedGaugeFor(gauges, 'profile-1', model)?.usage).toEqual(usageAt(90));
  });

  it('falls back to the label match for an older catalogue', () => {
    const model = option({ id: 'work/opus', note: 'Personal — Deep work.' });
    expect(servedGaugeFor(gauges, 'profile-1', model)?.usage).toEqual(usageAt(90));
  });

  it('never crosses profiles, and answers undefined for a stranger', () => {
    const model = option({ id: 'work/opus', accountId: 'acct-a' });
    expect(servedGaugeFor(gauges, 'profile-2', model)?.usage).toEqual(usageAt(50));
    expect(servedGaugeFor(gauges, 'profile-3', model)).toBeUndefined();
    expect(servedGaugeFor(gauges, 'profile-1', option({ id: 'opus' }))).toBeUndefined();
    expect(servedGaugeFor(gauges, 'profile-1', undefined)).toBeUndefined();
  });
});

describe('groupServedAccounts', () => {
  const catalogue = [
    option({ id: 'work/opus', accountId: 'acct-a', accountSlug: 'work', accountLabel: 'Work' }),
    option({ id: 'work/sonnet', accountId: 'acct-a', accountSlug: 'work', accountLabel: 'Work' }),
    option({ id: 'personal/opus', note: 'Personal — Deep work.' }),
    option({ id: 'bare' }),
  ];

  it('groups by slug, keeping id and label where the server sent them', () => {
    expect(groupServedAccounts(catalogue)).toEqual([
      { slug: 'work', label: 'Work', id: 'acct-a', models: ['work/opus', 'work/sonnet'] },
      { slug: 'personal', label: 'Personal', models: ['personal/opus'] },
    ]);
  });
});

describe('scopedToServedAccount', () => {
  const catalogue = [
    option({ id: 'work/opus' }),
    option({ id: 'work/sonnet' }),
    option({ id: 'personal/opus' }),
  ];

  it('narrows to one account', () => {
    expect(scopedToServedAccount(catalogue, 'work').map((m) => m.id)).toEqual([
      'work/opus',
      'work/sonnet',
    ]);
  });

  it('returns the list whole for null, and for a slug that matches nothing', () => {
    expect(scopedToServedAccount(catalogue, null)).toBe(catalogue);
    expect(scopedToServedAccount(catalogue, 'gone')).toBe(catalogue);
  });
});
