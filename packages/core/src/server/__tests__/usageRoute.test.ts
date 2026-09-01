/**
 * `GET /api/v0/usage`: the gauges, scoped and shaped like everything else.
 */

import { describe, expect, it } from 'vitest';

import type { ServerProfile } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import type { Catalogue } from '../catalogue.js';
import { handleServerRequest, type UsageSource } from '../http.js';

const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz';
const CONNECTION = {
  id: 'conn-1',
  label: 'Test',
  workspace: { kind: 'directory' as const, path: '/w' },
  token: TOKEN,
  createdAt: 0,
};

const PROFILES: readonly ServerProfile[] = [
  {
    id: 'prof-a' as ServerProfile['id'],
    slug: 'work',
    label: 'Work',
    provider: { id: 'claude', label: 'Claude', kind: 'hosted' },
    available: true,
    disabled: false,
    live: true,
    capabilities: NO_CAPABILITIES,
    models: [],
  },
];

const catalogue: Catalogue = { read: async () => PROFILES, invalidate: () => undefined };

function ask(usage?: UsageSource): ReturnType<typeof handleServerRequest> {
  return handleServerRequest(
    { method: 'GET', url: '/api/v0/usage', headers: { host: '127.0.0.1:6472', authorization: `Bearer ${TOKEN}` } },
    {
      connections: [CONNECTION],
      version: '1',
      catalogue,
      startedAt: 0,
      ...(usage === undefined ? {} : { usage }),
    },
  );
}

describe('the usage route', () => {
  it('answers one row per readable account, asked for exactly the visible ids', async () => {
    const askedFor: string[][] = [];
    const reply = await ask({
      read: async ({ profileIds }) => {
        askedFor.push([...profileIds]);
        return [
          {
            profileId: 'prof-a',
            label: 'Work',
            usage: { available: true, windows: [], fetchedAt: 5 },
          },
        ];
      },
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      object: 'artemis.usage',
      accounts: [{ profileId: 'prof-a', label: 'Work' }],
    });
    expect(askedFor).toEqual([['prof-a']]);
  });

  it('answers 501 from a build that reads no gauges', async () => {
    expect((await ask()).status).toBe(501);
  });
});
