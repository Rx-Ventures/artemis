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
  sectionServedAccounts,
  scopedToServedAccount,
  servedAccountLabel,
  servedAccountSlug,
  servedGaugeFor,
  type ServedAccount,
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
  });

  it('never mistakes a separator-less note for a name — the slug is the most it claims', () => {
    // The real case: `unlistedModel` wears a sentence as its note, and the
    // status bar once printed that sentence as the account's name.
    const unlisted = option({
      id: 'work-max/opus',
      note: 'Chosen earlier; this account’s current model list does not include it.',
    });
    expect(servedAccountLabel(unlisted)).toBe('work-max');
    expect(servedAccountLabel(option({ id: 'a/x', note: 'Work' }))).toBe('a');
    expect(servedAccountLabel(option({ id: 'bare', note: '' }))).toBeNull();
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

describe('sectionServedAccounts', () => {
  const providers = [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' },
    { id: 'llamacpp', label: 'llama.cpp' },
  ] as unknown as Parameters<typeof sectionServedAccounts>[1];

  const account = (slug: string, providerId?: string): ServedAccount =>
    ({ slug, label: slug, models: [`${slug}/m`], ...(providerId === undefined ? {} : { providerId }) }) as ServedAccount;

  it('groups a mixed server the way the local account column groups profiles', () => {
    // The case this exists for: one server, five accounts, three providers.
    // It used to render as one undifferentiated list.
    const sections = sectionServedAccounts(
      [
        account('work', 'claude'),
        account('local-ai', 'llamacpp'),
        account('rx-codex', 'codex'),
        account('personal', 'claude'),
      ],
      providers,
    );

    expect(sections.map((s) => [s.label, s.accounts.map((a) => a.slug)])).toEqual([
      ['Claude', ['work', 'personal']],
      ['Codex', ['rx-codex']],
      ['llama.cpp', ['local-ai']],
    ]);
  });

  it('follows the descriptor order rather than the catalogue order', () => {
    // Otherwise the headings reshuffle as accounts are signed in.
    const sections = sectionServedAccounts(
      [account('rx-codex', 'codex'), account('work', 'claude')],
      providers,
    );

    expect(sections.map((s) => s.label)).toEqual(['Claude', 'Codex']);
  });

  it('leaves one provider unheaded', () => {
    // A heading over the whole list is chrome that says nothing, and this is
    // what keeps the common single-provider server looking as it always did.
    const sections = sectionServedAccounts(
      [account('work', 'claude'), account('personal', 'claude')],
      providers,
    );

    expect(sections).toHaveLength(1);
    expect(sections[0]?.label).toBeNull();
    expect(sections[0]?.accounts.map((a) => a.slug)).toEqual(['work', 'personal']);
  });

  it('keeps a provider this build has no name for, under its raw id', () => {
    // An account is not worth hiding because the build has no adapter for its
    // provider — that is exactly when someone needs to see it.
    const sections = sectionServedAccounts(
      [account('work', 'claude'), account('future', 'opencode')],
      providers,
    );

    expect(sections.map((s) => s.label)).toEqual(['Claude', 'opencode']);
  });

  it('shows an older server’s accounts as the one flat list they were', () => {
    // No option carries a provider, so there is nothing to group by and the
    // column must not grow a heading claiming otherwise.
    const sections = sectionServedAccounts([account('work'), account('personal')], providers);

    expect(sections).toEqual([
      { providerId: null, label: null, accounts: [account('work'), account('personal')] },
    ]);
  });

  it('lists accounts from a half-upgraded catalogue last, unheaded', () => {
    // Some rows carry a provider and some do not. Neither dropping the
    // remainder nor filing it under a guess is honest.
    const sections = sectionServedAccounts(
      [account('work', 'claude'), account('mystery')],
      providers,
    );

    expect(sections.map((s) => [s.label, s.accounts.map((a) => a.slug)])).toEqual([
      ['Claude', ['work']],
      [null, ['mystery']],
    ]);
  });

  it('has no sections at all when the server serves nothing', () => {
    expect(sectionServedAccounts([], providers)).toEqual([]);
  });
});
