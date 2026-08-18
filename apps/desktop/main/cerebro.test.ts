/**
 * The pure half of `cerebro.ts` — parsing the CLI's `--json` output into the
 * protocol's shapes. Fixtures mirror real output from `bin/cerebro` 0.2.0,
 * including the case the numbers hide: profiles that symlink one shared
 * projects store, where only the first profile lists projects and the rest
 * say `shared_with`.
 */

import { describe, expect, it } from 'vitest';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configureCerebro,
  isCerebroEnabled,
  parseCerebroDoctor,
  parseCerebroList,
  parseCerebroStatus,
} from './cerebro';

const STATUS_FIXTURE = JSON.stringify({
  repo: '/Users/demo/Documents/cerebro',
  source: 'cerebro@52a0a32',
  remote: 'https://github.com/Rx-Ventures/cerebro.git',
  artemis_root: '/Users/demo/Library/Application Support/Artemis',
  bank: { memories: 3, errors: 0, warnings: 0 },
  profiles: [
    {
      name: 'storrence-dev',
      label: 'storrence.dev',
      enabled: true,
      hook: true,
      projects: [
        { key: '-Users-demo-Documents-app', memories: 3, source: 'cerebro@52a0a32' },
        { key: '-Users-demo-Documents-api', memories: 3, source: 'cerebro@52a0a32' },
      ],
      shared_with: null,
    },
    {
      name: 'work',
      label: 'Work – Team',
      enabled: true,
      hook: false,
      projects: [],
      shared_with: 'storrence-dev',
    },
  ],
});

describe('parseCerebroStatus', () => {
  it('rebuilds the protocol shape from real status output', () => {
    const status = parseCerebroStatus(STATUS_FIXTURE, '/Users/demo/Documents/cerebro', true);
    expect(status).toEqual({
      installed: true,
      enabled: true,
      repoPath: '/Users/demo/Documents/cerebro',
      remote: 'https://github.com/Rx-Ventures/cerebro.git',
      source: 'cerebro@52a0a32',
      memories: 3,
      validationErrors: 0,
      projects: 2,
      profiles: [
        { name: 'storrence-dev', label: 'storrence.dev', enabled: true, hook: true },
        { name: 'work', label: 'Work – Team', enabled: true, hook: false },
      ],
    });
  });

  it('tolerates missing optional fields without inventing values', () => {
    const status = parseCerebroStatus(JSON.stringify({ bank: {}, profiles: [] }), '/tmp/x', false);
    expect(status.remote).toBeNull();
    expect(status.source).toBeNull();
    expect(status.memories).toBe(0);
    expect(status.projects).toBe(0);
  });

  it('throws on output that is not JSON', () => {
    expect(() => parseCerebroStatus('fatal: not a git repository', '/tmp/x', false)).toThrow(/not JSON/);
  });

  it('reports the switch Artemis owns, not one the CLI could answer for', () => {
    // The bank's own `enabled` is per profile — the managed block being present
    // in that profile's CLAUDE.md. Artemis's is whether the user said yes to the
    // whole thing, and the fixture has every profile enabled precisely so the
    // two cannot be confused for one another here.
    const off = parseCerebroStatus(STATUS_FIXTURE, '/Users/demo/Documents/cerebro', false);
    expect(off.enabled).toBe(false);
    expect(off.profiles.every((profile) => profile.enabled)).toBe(true);
  });

  it('throws on JSON of the wrong shape', () => {
    expect(() => parseCerebroStatus('[1, 2, 3]', '/tmp/x', false)).toThrow(/not an object/);
  });
});

describe('parseCerebroList', () => {
  it('maps entries and lifts frontmatter metadata', () => {
    const memories = parseCerebroList(
      JSON.stringify([
        {
          name: 'cerebro-memory-bank',
          description: 'What Cerebro is',
          metadata: { type: 'reference', added: '2026-08-14', author: 'seth@storrence.dev' },
          body: 'Cerebro is the shared memory bank.',
          file: 'memories/cerebro-memory-bank.md',
          errors: [],
          warnings: [],
        },
      ]),
    );
    expect(memories).toEqual([
      {
        name: 'cerebro-memory-bank',
        type: 'reference',
        description: 'What Cerebro is',
        body: 'Cerebro is the shared memory bank.',
        added: '2026-08-14',
        author: 'seth@storrence.dev',
      },
    ]);
  });

  it('drops entries the bank itself could not parse', () => {
    const memories = parseCerebroList(
      JSON.stringify([
        { file: 'memories/broken.md', errors: ['missing frontmatter'] },
        { name: 'ok', description: '', metadata: {}, body: 'x' },
        null,
      ]),
    );
    expect(memories.map((m) => m.name)).toEqual(['ok']);
    expect(memories[0]?.type).toBe('unknown');
  });

  it('throws when the list is not an array', () => {
    expect(() => parseCerebroList('{}')).toThrow(/not an array/);
  });
});

describe('parseCerebroDoctor', () => {
  it('carries every check and its remedy through', () => {
    const preflight = parseCerebroDoctor(
      JSON.stringify({
        ready: false,
        checks: [
          { id: 'git', label: 'git', state: 'ok', detail: 'git version 2.55.0', remedy: null },
          {
            id: 'git-identity',
            label: 'git identity',
            state: 'fail',
            detail: 'user.name or user.email is unset — commits would be refused',
            remedy: 'git config --global user.name "Your Name"',
          },
          { id: 'gh', label: 'GitHub CLI (optional)', state: 'warn', detail: 'not on PATH', remedy: 'brew install gh' },
        ],
      }),
    );
    expect(preflight.ready).toBe(false);
    expect(preflight.checks).toHaveLength(3);
    expect(preflight.checks[1]).toEqual({
      id: 'git-identity',
      label: 'git identity',
      state: 'fail',
      detail: 'user.name or user.email is unset — commits would be refused',
      remedy: 'git config --global user.name "Your Name"',
    });
  });

  it('drops a check whose state the protocol does not name', () => {
    const preflight = parseCerebroDoctor(
      JSON.stringify({
        ready: true,
        checks: [
          { id: 'git', label: 'git', state: 'ok', detail: 'fine', remedy: null },
          { id: 'future', label: 'Something new', state: 'skipped', detail: 'from a newer CLI' },
        ],
      }),
    );
    expect(preflight.checks.map((entry) => entry.id)).toEqual(['git']);
    expect(preflight.ready).toBe(true);
  });

  it('treats a missing ready flag as not ready', () => {
    expect(parseCerebroDoctor(JSON.stringify({ checks: [] })).ready).toBe(false);
  });
});

/**
 * The master switch, read from disk.
 *
 * Every case here is the same claim from a different angle: **absent evidence
 * is not consent.** No file, an unreadable file, a file that says something
 * else, a process that was never told where to look — each has to answer no,
 * because the yes is what starts writing to a repository the team shares and
 * spends every run's context describing it.
 */
describe('the Cerebro master switch', () => {
  function freshDir(): string {
    return mkdtempSync(join(tmpdir(), 'artemis-cerebro-'));
  }

  it('is off on a machine that has never thrown it', () => {
    configureCerebro(freshDir());
    expect(isCerebroEnabled()).toBe(false);
  });

  it('is on once the file says so', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'cerebro.json'), JSON.stringify({ version: 1, enabled: true }));
    configureCerebro(dir);
    expect(isCerebroEnabled()).toBe(true);
  });

  it('reads an explicit false as off, not as absent', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'cerebro.json'), JSON.stringify({ version: 1, enabled: false }));
    configureCerebro(dir);
    expect(isCerebroEnabled()).toBe(false);
  });

  it('refuses to guess from a file it cannot read', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'cerebro.json'), 'not json at all');
    configureCerebro(dir);
    expect(isCerebroEnabled()).toBe(false);
  });

  it('refuses to guess from a truthy stand-in', () => {
    // The file is a user-editable JSON document, so `"yes"` and `1` are things
    // it can genuinely contain. Only the boolean counts.
    const dir = freshDir();
    writeFileSync(join(dir, 'cerebro.json'), JSON.stringify({ version: 1, enabled: 'yes' }));
    configureCerebro(dir);
    expect(isCerebroEnabled()).toBe(false);
  });

  it('re-reads when it is pointed somewhere else', () => {
    // The cache exists because this is read on the path of every run. It must
    // not outlive the answer it was caching.
    const on = freshDir();
    writeFileSync(join(on, 'cerebro.json'), JSON.stringify({ version: 1, enabled: true }));
    configureCerebro(on);
    expect(isCerebroEnabled()).toBe(true);

    configureCerebro(freshDir());
    expect(isCerebroEnabled()).toBe(false);
  });
});
