import { describe, expect, it } from 'vitest';
import { nextSlot } from '../src/schedule.ts';

// Fixed reference point: Mon 2026-03-02, 09:00 local.
const MON_9AM = new Date(2026, 2, 2, 9, 0, 0).getTime();
const rules = { cap: 2, spacingMs: 4 * 3600_000 };

describe('nextSlot', () => {
  it('places the first clip inside the posting window, at least an hour out', () => {
    const t = nextSlot([], rules, MON_9AM);
    expect(t.getHours()).toBeGreaterThanOrEqual(11);
    expect(t.getHours()).toBeLessThan(22);
    expect(t.getTime()).toBeGreaterThanOrEqual(MON_9AM + 60 * 60_000);
  });

  it('honours the minimum spacing between consecutive slots', () => {
    const first = nextSlot([], rules, MON_9AM);
    const second = nextSlot([first], rules, MON_9AM);
    expect(second.getTime() - first.getTime()).toBeGreaterThanOrEqual(rules.spacingMs);
  });

  it('rolls to the next day once the daily cap is hit', () => {
    const a = nextSlot([], rules, MON_9AM);
    const b = nextSlot([a], rules, MON_9AM);
    const c = nextSlot([a, b], rules, MON_9AM);
    // cap is 2 → the third clip must land on a later calendar day
    expect(c.getDate()).not.toBe(a.getDate());
    expect(c.getHours()).toBeGreaterThanOrEqual(11);
  });

  it('never schedules in the past', () => {
    const evening = new Date(2026, 2, 2, 23, 30, 0).getTime();
    const t = nextSlot([], rules, evening);
    expect(t.getTime()).toBeGreaterThan(evening);
    expect(t.getDate()).toBe(3); // next day
  });

  it('fills a full week without violating cap or spacing', () => {
    const taken: Date[] = [];
    for (let i = 0; i < 10; i++) {
      const t = nextSlot(taken, rules, MON_9AM);
      for (const prev of taken) {
        expect(Math.abs(t.getTime() - prev.getTime())).toBeGreaterThanOrEqual(rules.spacingMs);
      }
      const sameDay = taken.filter((x) => x.toDateString() === t.toDateString()).length;
      expect(sameDay).toBeLessThan(rules.cap);
      taken.push(t);
    }
  });
});
