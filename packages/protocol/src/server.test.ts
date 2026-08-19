import { describe, expect, it } from 'vitest';

import type { ProfileId } from './ids.js';
import {
  assignProfileSlugs,
  isValidServerPort,
  modelRoute,
  parseModelRoute,
  profileSlug,
  serverUrl,
} from './server.js';

const id = (value: string): ProfileId => value as ProfileId;

describe('profileSlug', () => {
  it('makes a label typeable', () => {
    expect(profileSlug('Work Max')).toBe('work-max');
    expect(profileSlug('  Personal (Pro)  ')).toBe('personal-pro');
    expect(profileSlug('team_alpha')).toBe('team-alpha');
  });

  it('returns nothing for a label with nothing usable in it', () => {
    // The empty answer is load-bearing: `assignProfileSlugs` falls back to the
    // id, which is always addressable, rather than inventing a generic name.
    expect(profileSlug('🎯')).toBe('');
    expect(profileSlug('   ')).toBe('');
  });
});

describe('assignProfileSlugs', () => {
  it('breaks collisions so a route can only mean one account', () => {
    const slugs = assignProfileSlugs([
      { id: id('a'), label: 'Work' },
      { id: id('b'), label: 'work ' },
      { id: id('c'), label: 'WORK' },
    ]);

    expect(slugs.get(id('a'))).toBe('work');
    expect(slugs.get(id('b'))).toBe('work-2');
    expect(slugs.get(id('c'))).toBe('work-3');
    // The property that actually matters — three accounts, three addresses.
    expect(new Set(slugs.values()).size).toBe(3);
  });

  it('falls back to the id when a label slugs to nothing', () => {
    const slugs = assignProfileSlugs([{ id: id('prof-42'), label: '🎯' }]);
    expect(slugs.get(id('prof-42'))).toBe('prof-42');
  });

  it('is stable for a stable input order', () => {
    const profiles = [
      { id: id('a'), label: 'Work' },
      { id: id('b'), label: 'Work' },
    ];
    expect([...assignProfileSlugs(profiles).values()]).toEqual([
      ...assignProfileSlugs(profiles).values(),
    ]);
  });
});

describe('parseModelRoute', () => {
  it('splits on the first separator only', () => {
    // An Ollama model id contains a slash. The account half never does, so the
    // first separator is the boundary and everything after it is the model.
    expect(parseModelRoute('local/library/llama3:8b')).toEqual({
      profile: 'local',
      model: 'library/llama3:8b',
    });
  });

  it('refuses a bare model id', () => {
    // Deliberate: a model without an account is not an address — two profiles
    // can offer the same model on different plans.
    expect(parseModelRoute('opus')).toBeUndefined();
  });

  it('refuses a half-empty route', () => {
    expect(parseModelRoute('/opus')).toBeUndefined();
    expect(parseModelRoute('work-max/')).toBeUndefined();
  });

  it('round-trips what modelRoute composes', () => {
    expect(parseModelRoute(modelRoute('work-max', 'opus'))).toEqual({
      profile: 'work-max',
      model: 'opus',
    });
  });
});

describe('serverUrl', () => {
  it('brackets an IPv6 literal so the port is still readable', () => {
    expect(serverUrl('127.0.0.1', 6472)).toBe('http://127.0.0.1:6472');
    expect(serverUrl('::1', 6472)).toBe('http://[::1]:6472');
  });
});

describe('isValidServerPort', () => {
  it('accepts 0 as "any free port"', () => {
    expect(isValidServerPort(0)).toBe(true);
  });

  it('rejects the privileged range and anything not an integer', () => {
    expect(isValidServerPort(80)).toBe(false);
    expect(isValidServerPort(1024)).toBe(true);
    expect(isValidServerPort(65_535)).toBe(true);
    expect(isValidServerPort(65_536)).toBe(false);
    expect(isValidServerPort(6472.5)).toBe(false);
    expect(isValidServerPort(Number.NaN)).toBe(false);
  });
});
