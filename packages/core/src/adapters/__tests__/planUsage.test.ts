/**
 * Plan-usage mapping.
 *
 * The behaviour worth pinning here is mostly about *degrading well*: the
 * underlying provider API is explicitly experimental, so every one of these
 * cases is a way it can let us down without the status line breaking.
 */

import { describe, expect, it } from 'vitest';
import { mapPlanUsage, readPlanUsage } from '../planUsage.js';

const NOW = 1_700_000_000_000;
const RESET_ISO = '2026-08-10T22:00:00.000Z';

describe('mapPlanUsage', () => {
  it('maps the windows a subscription reports, in display order', () => {
    const usage = mapPlanUsage(
      {
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          // Deliberately out of order on the wire.
          seven_day: { utilization: 12, resets_at: RESET_ISO },
          five_hour: { utilization: 63, resets_at: RESET_ISO },
        },
      },
      NOW,
    );

    expect(usage.available).toBe(true);
    expect(usage.subscriptionType).toBe('max');
    expect(usage.windows.map((w) => w.id)).toEqual(['five_hour', 'seven_day']);
    expect(usage.windows[0]).toMatchObject({ label: '5 hours', utilization: 63 });
    expect(usage.windows[0]!.resetsAt).toBe(Date.parse(RESET_ISO));
  });

  it('reports unavailable for metered billing rather than an empty meter', () => {
    // API-key, Bedrock and Vertex profiles have no plan to be limited by. That
    // is a correct answer, and it must read differently from "0% used".
    const usage = mapPlanUsage({ rate_limits_available: false, rate_limits: null }, NOW);

    expect(usage.available).toBe(false);
    expect(usage.windows).toEqual([]);
    expect(usage.unavailableReason).toMatch(/no plan limits reported/i);
  });

  it('passes through a window it has never heard of', () => {
    // The provider adds windows over time. Hiding one the user is actually
    // being held to would be worse than showing it with an ugly label.
    const usage = mapPlanUsage(
      {
        rate_limits_available: true,
        rate_limits: { some_new_window: { utilization: 5, resets_at: null } },
      },
      NOW,
    );

    expect(usage.windows.map((w) => w.id)).toEqual(['some_new_window']);
    expect(usage.windows[0]!.label).toBe('some new window');
  });

  it('tolerates missing, null and malformed fields', () => {
    const usage = mapPlanUsage(
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: null, resets_at: 'not-a-date' },
          seven_day: null,
        },
      },
      NOW,
    );

    expect(usage.windows).toHaveLength(1);
    expect(usage.windows[0]).toMatchObject({ utilization: null, resetsAt: null });
  });

  it('clamps a percentage into 0-100 instead of letting a meter overflow', () => {
    const usage = mapPlanUsage(
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 140 },
          seven_day: { utilization: -3 },
        },
      },
      NOW,
    );

    expect(usage.windows[0]!.utilization).toBe(100);
    expect(usage.windows[1]!.utilization).toBe(0);
  });

  it('treats a completely empty response as unavailable, not as zero usage', () => {
    expect(mapPlanUsage({}, NOW).available).toBe(false);
    expect(mapPlanUsage(null, NOW).available).toBe(false);
  });

  /*
   * `model_scoped` is an ARRAY of per-model buckets, unlike every one of its
   * siblings. Reading it as a single `{ utilization, resets_at }` object is
   * what produced one row labelled "Model" reporting `null` on every account
   * with per-model limits — a limit that looked broken while hiding the real
   * numbers inside it. These pin the array handling.
   */
  it('expands model_scoped into one window per model bucket', () => {
    const usage = mapPlanUsage(
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 10, resets_at: RESET_ISO },
          model_scoped: [
            { display_name: 'Fable', utilization: 81, resets_at: RESET_ISO },
            { display_name: 'Opus', utilization: 30, resets_at: null },
          ],
        },
      },
      NOW,
    );

    const buckets = usage.windows.filter((w) => w.id.startsWith('model_scoped:'));
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toEqual({
      id: 'model_scoped:Fable',
      label: '7 days · Fable',
      utilization: 81,
      resetsAt: Date.parse(RESET_ISO),
    });
    expect(buckets[1]!.id).toBe('model_scoped:Opus');
    expect(buckets[1]!.resetsAt).toBeNull();

    // And it must never surface as a single window of its own.
    expect(usage.windows.some((w) => w.id === 'model_scoped')).toBe(false);
  });

  it('drops a model bucket with no display name rather than showing an anonymous limit', () => {
    const usage = mapPlanUsage(
      {
        rate_limits_available: true,
        rate_limits: {
          model_scoped: [
            { utilization: 55, resets_at: RESET_ISO },
            { display_name: '', utilization: 60, resets_at: RESET_ISO },
            { display_name: 'Fable', utilization: 12, resets_at: RESET_ISO },
          ],
        },
      },
      NOW,
    );

    expect(usage.windows.map((w) => w.id)).toEqual(['model_scoped:Fable']);
  });

  it('does not render an unfamiliar array window as a row of nulls', () => {
    const usage = mapPlanUsage(
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 10, resets_at: RESET_ISO },
          // A shape this file has never seen, arriving as a list.
          some_future_buckets: [{ utilization: 5, resets_at: RESET_ISO }],
        },
      },
      NOW,
    );

    expect(usage.windows.map((w) => w.id)).toEqual(['five_hour']);
  });
});

describe('readPlanUsage', () => {
  it('finds the method under its current experimental name', async () => {
    const query = {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 40, resets_at: RESET_ISO } },
      }),
    };

    const usage = await readPlanUsage(query, NOW);
    expect(usage.available).toBe(true);
    expect(usage.windows[0]!.utilization).toBe(40);
  });

  it('prefers a stabilised name when the SDK grows one', async () => {
    // Both present: the newer name wins, so a future rename needs no coordination.
    const query = {
      usage: async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 1 } } }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 99 } },
      }),
    };

    const usage = await readPlanUsage(query, NOW);
    expect(usage.windows[0]!.utilization).toBe(1);
  });

  it('degrades to unavailable when the SDK exposes no usage method at all', async () => {
    // The scenario this file exists for: the experimental API is withdrawn or
    // renamed to something unrecognised. The status line must not break.
    const usage = await readPlanUsage({ someOtherMethod: async () => ({}) }, NOW);

    expect(usage.available).toBe(false);
    expect(usage.unavailableReason).toMatch(/does not report plan usage/i);
  });

  it('degrades to unavailable when the call throws', async () => {
    const query = {
      usage: async () => {
        throw new Error('control channel closed');
      },
    };

    const usage = await readPlanUsage(query, NOW);
    expect(usage.available).toBe(false);
    expect(usage.unavailableReason).toContain('control channel closed');
  });

  it('never throws, whatever it is handed', async () => {
    await expect(readPlanUsage(null, NOW)).resolves.toMatchObject({ available: false });
    await expect(readPlanUsage(undefined, NOW)).resolves.toMatchObject({ available: false });
    await expect(readPlanUsage('nonsense', NOW)).resolves.toMatchObject({ available: false });
  });
});
