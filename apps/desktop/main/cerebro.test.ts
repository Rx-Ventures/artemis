/**
 * The pure half of `cerebro.ts` — parsing the CLI's `--json` output into the
 * protocol's shapes. Fixtures mirror real output from `bin/cerebro` 0.2.0,
 * including the case the numbers hide: profiles that symlink one shared
 * projects store, where only the first profile lists projects and the rest
 * say `shared_with`.
 */

import { describe, expect, it } from 'vitest';

import { parseCerebroList, parseCerebroStatus } from './cerebro';

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
    const status = parseCerebroStatus(STATUS_FIXTURE, '/Users/demo/Documents/cerebro');
    expect(status).toEqual({
      installed: true,
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
    const status = parseCerebroStatus(JSON.stringify({ bank: {}, profiles: [] }), '/tmp/x');
    expect(status.remote).toBeNull();
    expect(status.source).toBeNull();
    expect(status.memories).toBe(0);
    expect(status.projects).toBe(0);
  });

  it('throws on output that is not JSON', () => {
    expect(() => parseCerebroStatus('fatal: not a git repository', '/tmp/x')).toThrow(/not JSON/);
  });

  it('throws on JSON of the wrong shape', () => {
    expect(() => parseCerebroStatus('[1, 2, 3]', '/tmp/x')).toThrow(/not an object/);
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
