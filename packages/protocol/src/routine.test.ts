/**
 * The minute math a scheduler bets on.
 *
 * Dates in these tests are built with the local-time constructor on purpose —
 * schedules are written in the machine's local time, and a test that pinned
 * UTC would pass or fail by the timezone of the machine running it.
 */

import { describe, expect, it } from 'vitest';

import {
  cronProblem,
  describeSchedule,
  lastFireBetween,
  nextFireAt,
  parseTimeOfDay,
  scheduleMatchesMinute,
  scheduleProblem,
  timeOfDayProblem,
} from './routine.js';

/** Monday 2026-03-02, 09:00 local. `new Date(...).getDay()` is 1. */
const monday9 = new Date(2026, 2, 2, 9, 0);

describe('parseTimeOfDay', () => {
  it('reads the strict HH:MM forms and refuses the rest', () => {
    expect(parseTimeOfDay('09:00')).toEqual({ hour: 9, minute: 0 });
    expect(parseTimeOfDay('9:05')).toEqual({ hour: 9, minute: 5 });
    expect(parseTimeOfDay('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseTimeOfDay('24:00')).toBeUndefined();
    expect(parseTimeOfDay('12:60')).toBeUndefined();
    expect(parseTimeOfDay('noon')).toBeUndefined();
    expect(timeOfDayProblem('noon')).toContain('HH:MM');
  });
});

describe('scheduleMatchesMinute', () => {
  it('manual never fires on its own', () => {
    expect(scheduleMatchesMinute({ kind: 'manual' }, monday9)).toBe(false);
  });

  it('hourly matches its minute of every hour', () => {
    expect(scheduleMatchesMinute({ kind: 'hourly', minute: 0 }, monday9)).toBe(true);
    expect(scheduleMatchesMinute({ kind: 'hourly', minute: 30 }, monday9)).toBe(false);
  });

  it('daily matches its time of day', () => {
    expect(scheduleMatchesMinute({ kind: 'daily', at: '09:00' }, monday9)).toBe(true);
    expect(scheduleMatchesMinute({ kind: 'daily', at: '09:01' }, monday9)).toBe(false);
  });

  it('weekdays skips the weekend', () => {
    const saturday9 = new Date(2026, 2, 7, 9, 0);
    expect(scheduleMatchesMinute({ kind: 'weekdays', at: '09:00' }, monday9)).toBe(true);
    expect(scheduleMatchesMinute({ kind: 'weekdays', at: '09:00' }, saturday9)).toBe(false);
  });

  it('weekly matches its one day', () => {
    expect(scheduleMatchesMinute({ kind: 'weekly', day: 1, at: '09:00' }, monday9)).toBe(true);
    expect(scheduleMatchesMinute({ kind: 'weekly', day: 2, at: '09:00' }, monday9)).toBe(false);
  });

  it('cron reads the classic forms', () => {
    const at = (expression: string) =>
      scheduleMatchesMinute({ kind: 'cron', expression }, monday9);
    expect(at('* * * * *')).toBe(true);
    expect(at('0 9 * * *')).toBe(true);
    expect(at('0 9 * * 1')).toBe(true);
    expect(at('0 9 * * 2')).toBe(false);
    expect(at('*/15 * * * *')).toBe(true);
    expect(at('5-10 * * * *')).toBe(false);
    expect(at('0 8-10/1 * * *')).toBe(true);
    expect(at('0,30 9 2 3 *')).toBe(true);
  });

  it('cron combines restricted day-of-month and day-of-week with OR', () => {
    // Vixie's rule: monday9 is Monday the 2nd. dom=15 misses, dow=1 hits —
    // both restricted, so the day passes.
    expect(scheduleMatchesMinute({ kind: 'cron', expression: '0 9 15 * 1' }, monday9)).toBe(true);
    // Only dom restricted: it alone decides.
    expect(scheduleMatchesMinute({ kind: 'cron', expression: '0 9 15 * *' }, monday9)).toBe(false);
  });
});

describe('cronProblem / scheduleProblem', () => {
  it('names what is wrong, field by field', () => {
    expect(cronProblem('* * * *')).toContain('five fields');
    expect(cronProblem('61 * * * *')).toContain('minute');
    expect(cronProblem('* * * * 7')).toContain('day of week');
    expect(cronProblem('*/0 * * * *')).toContain('step');
    expect(cronProblem('* * * * *')).toBeNull();
    expect(cronProblem('*/5 9-17 1,15 * 1-5')).toBeNull();
  });

  it('checks the presets too', () => {
    expect(scheduleProblem({ kind: 'hourly', minute: 60 })).toContain('0 to 59');
    expect(scheduleProblem({ kind: 'weekly', day: 7, at: '09:00' })).toContain('Sunday');
    expect(scheduleProblem({ kind: 'daily', at: '25:00' })).toContain('HH:MM');
    expect(scheduleProblem({ kind: 'manual' })).toBeNull();
  });
});

describe('nextFireAt', () => {
  it('answers the next minute the schedule names, strictly after now', () => {
    const from = new Date(2026, 2, 2, 8, 59, 30).getTime();
    expect(nextFireAt({ kind: 'daily', at: '09:00' }, from)).toBe(monday9.getTime());
    // Asking from 09:00 sharp answers tomorrow, not this minute again.
    expect(nextFireAt({ kind: 'daily', at: '09:00' }, monday9.getTime())).toBe(
      new Date(2026, 2, 3, 9, 0).getTime(),
    );
  });

  it('answers nothing for manual and for schedules that never occur', () => {
    expect(nextFireAt({ kind: 'manual' }, monday9.getTime())).toBeUndefined();
    // February 30th does not exist in any year the walk visits.
    expect(nextFireAt({ kind: 'cron', expression: '0 9 30 2 *' }, monday9.getTime())).toBeUndefined();
  });
});

describe('lastFireBetween', () => {
  it('finds the newest missed appointment in the window', () => {
    const sleptFrom = new Date(2026, 2, 2, 8, 0).getTime();
    const wokeAt = new Date(2026, 2, 2, 11, 30).getTime();
    // 09:00 and 10:00-hourly both passed; the newest hourly hit is 11:00.
    expect(lastFireBetween({ kind: 'hourly', minute: 0 }, sleptFrom, wokeAt)).toBe(
      new Date(2026, 2, 2, 11, 0).getTime(),
    );
    expect(lastFireBetween({ kind: 'daily', at: '09:00' }, sleptFrom, wokeAt)).toBe(
      monday9.getTime(),
    );
  });

  it('answers nothing when the window holds no appointment', () => {
    const from = new Date(2026, 2, 2, 9, 5).getTime();
    const to = new Date(2026, 2, 2, 9, 45).getTime();
    expect(lastFireBetween({ kind: 'daily', at: '09:00' }, from, to)).toBeUndefined();
    expect(lastFireBetween({ kind: 'manual' }, from, to)).toBeUndefined();
  });

  it('never reaches past the seven-day catch-up window', () => {
    const sleptFrom = new Date(2026, 0, 1, 0, 0).getTime();
    const wokeAt = new Date(2026, 2, 2, 12, 0).getTime();
    const found = lastFireBetween({ kind: 'daily', at: '09:00' }, sleptFrom, wokeAt);
    // The newest hit is today's 09:00 — comfortably inside the window — but
    // the point is the walk was bounded, not that it found nothing.
    expect(found).toBe(monday9.getTime());
  });
});

describe('describeSchedule', () => {
  it('writes the one-liners the list rows show', () => {
    expect(describeSchedule({ kind: 'manual' })).toContain('Manual');
    expect(describeSchedule({ kind: 'hourly', minute: 5 })).toBe('Hourly at :05');
    expect(describeSchedule({ kind: 'weekdays', at: '09:00' })).toBe('Weekdays at 09:00');
    expect(describeSchedule({ kind: 'weekly', day: 1, at: '17:30' })).toBe('Monday at 17:30');
    expect(describeSchedule({ kind: 'cron', expression: '*/5 * * * *' })).toContain('*/5');
  });
});
