/**
 * The pure half of `memoryBanks.ts` — parsing the CLI's `--json` output and
 * its registry file into the protocol's shapes. Fixtures mirror real output
 * from `bin/cerebro` 0.6.0 (the first multi-bank version), including the
 * cases the numbers hide: profiles that symlink one shared projects store,
 * project entries stamped with a `bank` versus legacy unstamped ones, and the
 * pre-multi-bank `{"bank": path}` registry.
 */

import { describe, expect, it } from 'vitest';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configureMemoryBanks,
  isMasterEnabled,
  parseBanksStatus,
  parseDoctor,
  parseMemories,
  parseRegistry,
} from './memoryBanks';

const STATUS_FIXTURE = JSON.stringify({
  repo: '/Users/demo/Documents/cerebro',
  source: 'cerebro@52a0a32',
  remote: 'https://github.com/Rx-Ventures/cerebro.git',
  artemis_root: '/Users/demo/Library/Application Support/Artemis',
  bank: { memories: 3, errors: 0, warnings: 0 },
  banks: [
    {
      slug: 'cerebro',
      path: '/Users/demo/Documents/cerebro',
      role: 'readwrite',
      enabled: true,
      default: true,
      exists: true,
      source: 'cerebro@52a0a32',
      remote: 'https://github.com/Rx-Ventures/cerebro.git',
      bank: { memories: 3, errors: 0, warnings: 0 },
    },
    {
      slug: 'client-docs',
      path: '/Users/demo/Documents/client-docs',
      role: 'readonly',
      enabled: false,
      default: false,
      exists: true,
      source: 'cerebro@1a2b3c4',
      remote: null,
      bank: { memories: 5, errors: 1, warnings: 0 },
    },
  ],
  profiles: [
    {
      name: 'storrence-dev',
      label: 'storrence.dev',
      enabled: true,
      hook: true,
      banks: { cerebro: true, 'client-docs': false },
      projects: [
        // Legacy entries carry no `bank` stamp and belong to the legacy slug…
        { key: '-Users-demo-Documents-app', memories: 3, source: 'cerebro@52a0a32' },
        { key: '-Users-demo-Documents-api', memories: 3, source: 'cerebro@52a0a32' },
        // …stamped entries belong to theirs.
        { key: '-Users-demo-Documents-app', bank: 'client-docs', memories: 5, source: 'cerebro@1a2b3c4' },
      ],
      shared_with: null,
    },
    {
      name: 'work',
      label: 'Work – Team',
      enabled: true,
      hook: false,
      banks: { cerebro: true, 'client-docs': false },
      projects: [],
      shared_with: 'storrence-dev',
    },
  ],
});

describe('parseBanksStatus', () => {
  it('rebuilds the protocol shape from real status output', () => {
    const status = parseBanksStatus(STATUS_FIXTURE, true, true);
    expect(status.cliAvailable).toBe(true);
    expect(status.masterEnabled).toBe(true);
    expect(status.banks).toHaveLength(2);

    const [cerebro, docs] = status.banks;
    expect(cerebro).toEqual({
      slug: 'cerebro',
      path: '/Users/demo/Documents/cerebro',
      remote: 'https://github.com/Rx-Ventures/cerebro.git',
      role: 'readwrite',
      enabled: true,
      isDefault: true,
      exists: true,
      source: 'cerebro@52a0a32',
      memories: 3,
      validationErrors: 0,
      projects: 2,
    });
    expect(docs).toMatchObject({
      slug: 'client-docs',
      role: 'readonly',
      enabled: false,
      isDefault: false,
      remote: null,
      memories: 5,
      validationErrors: 1,
      projects: 1,
    });

    expect(status.profiles).toHaveLength(2);
    expect(status.profiles[0]).toEqual({
      name: 'storrence-dev',
      label: 'storrence.dev',
      hook: true,
      banks: { cerebro: true, 'client-docs': false },
    });
  });

  it('masterEnabled is the caller`s fact, not the CLI`s', () => {
    expect(parseBanksStatus(STATUS_FIXTURE, false, true).masterEnabled).toBe(false);
  });

  it('drops a bank whose slug is not in the banks` own grammar', () => {
    const status = parseBanksStatus(
      JSON.stringify({
        banks: [{ slug: '../escape', path: '/x', role: 'readwrite', enabled: true }],
        profiles: [],
      }),
      true,
      true,
    );
    expect(status.banks).toHaveLength(0);
  });

  it('refuses output that is not JSON, in its own words', () => {
    expect(() => parseBanksStatus('warning: something\n{', true, true)).toThrow(/not JSON/);
  });
});

describe('parseRegistry', () => {
  it('reads the multi-bank shape, defaulting role and enabled', () => {
    const { banks, defaultSlug } = parseRegistry(
      JSON.stringify({
        banks: [
          { slug: 'cerebro', path: '/a' },
          { slug: 'docs', path: '/b', role: 'readonly', enabled: false },
        ],
        default: 'cerebro',
      }),
    );
    expect(banks).toEqual([
      { slug: 'cerebro', path: '/a', role: 'readwrite', enabled: true },
      { slug: 'docs', path: '/b', role: 'readonly', enabled: false },
    ]);
    expect(defaultSlug).toBe('cerebro');
  });

  it('reads the pre-multi-bank shape as one legacy bank', () => {
    const { banks, defaultSlug } = parseRegistry(JSON.stringify({ bank: '/Users/demo/Documents/cerebro' }));
    expect(banks).toEqual([
      { slug: 'cerebro', path: '/Users/demo/Documents/cerebro', role: 'readwrite', enabled: true },
    ]);
    expect(defaultSlug).toBe('cerebro');
  });

  it('falls back to the first bank when the default names nobody', () => {
    const { defaultSlug } = parseRegistry(
      JSON.stringify({ banks: [{ slug: 'a', path: '/a' }], default: 'gone' }),
    );
    expect(defaultSlug).toBe('a');
  });

  it('drops malformed entries and survives garbage whole', () => {
    expect(parseRegistry('not json')).toEqual({ banks: [], defaultSlug: null });
    const { banks } = parseRegistry(
      JSON.stringify({ banks: [{ slug: 'ok', path: '/a' }, { slug: 'NO CAPS', path: '/b' }, { path: '/c' }, 42] }),
    );
    expect(banks.map((bank) => bank.slug)).toEqual(['ok']);
  });
});

const LIST_FIXTURE = JSON.stringify([
  {
    name: 'deploy-approval-flow',
    description: 'When deploying to production',
    metadata: { type: 'project', added: '2026-08-14', author: 'demo@example.com' },
    body: 'Deploys need approval in #deploys first.',
    file: 'memories/deploy-approval-flow.md',
    errors: [],
    warnings: [],
  },
  // A file the bank could not parse: name-less, carried for the error count.
  { file: 'memories/broken.md', errors: ['no frontmatter'] },
]);

describe('parseMemories', () => {
  it('maps parseable entries and drops the name-less', () => {
    const memories = parseMemories(LIST_FIXTURE);
    expect(memories).toHaveLength(1);
    expect(memories[0]).toEqual({
      name: 'deploy-approval-flow',
      type: 'project',
      description: 'When deploying to production',
      body: 'Deploys need approval in #deploys first.',
      added: '2026-08-14',
      author: 'demo@example.com',
    });
  });

  it('refuses a non-array, in its own words', () => {
    expect(() => parseMemories('{}')).toThrow(/not an array/);
  });
});

describe('parseDoctor', () => {
  it('rebuilds checks and drops unknown states', () => {
    const preflight = parseDoctor(
      JSON.stringify({
        ready: false,
        checks: [
          { id: 'git', label: 'git', state: 'ok', detail: 'git version 2.55.0', remedy: null },
          { id: 'weird', label: 'Future', state: 'exploded', detail: 'x', remedy: null },
          {
            id: 'git-identity',
            label: 'git identity',
            state: 'fail',
            detail: 'unset',
            remedy: 'git config --global …',
          },
        ],
      }),
    );
    expect(preflight.ready).toBe(false);
    expect(preflight.checks.map((check) => check.id)).toEqual(['git', 'git-identity']);
    expect(preflight.checks[1]?.remedy).toBe('git config --global …');
  });
});

describe('the master switch', () => {
  it('reads as off until configured, and off when the file is absent', () => {
    configureMemoryBanks(mkdtempSync(join(tmpdir(), 'artemis-banks-')));
    expect(isMasterEnabled()).toBe(false);
  });

  it('reads the historical cerebro.json, so an upgrade keeps the yes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artemis-banks-'));
    writeFileSync(join(dir, 'cerebro.json'), JSON.stringify({ version: 1, enabled: true }));
    configureMemoryBanks(dir);
    expect(isMasterEnabled()).toBe(true);
  });

  it('treats anything but `enabled: true` as off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artemis-banks-'));
    writeFileSync(join(dir, 'cerebro.json'), JSON.stringify({ version: 1, enabled: 'yes' }));
    configureMemoryBanks(dir);
    expect(isMasterEnabled()).toBe(false);
  });
});
