/**
 * Post-schedule over the saved-clip library. Saving a clip assigns it a suggested
 * post time from two knobs in Settings — a daily cap and a minimum spacing — and
 * the dashboard shows the queue. Nothing is auto-published; marking a clip
 * "posted" and nudging times is manual. Times are handled in the machine's local
 * timezone (this is a single-user local app).
 */
import { getSettings, listClips, updateClipSchedule } from './db.ts';
import { log } from './lib/log.ts';
import type { Clip } from './types.ts';

/** Clips only go out inside this local-time window (prime short-form hours). */
const WINDOW_START_HOUR = 11;
const WINDOW_END_HOUR = 22;
const MIN_LEAD_MS = 60 * 60_000; // never schedule anything less than an hour out

interface SlotRules {
  cap: number; // posts per calendar day
  spacingMs: number; // minimum gap between consecutive posts
}

function rules(): SlotRules {
  const s = getSettings();
  return {
    cap: Math.max(1, s.dailyPostCap),
    spacingMs: Math.max(1, s.minPostSpacingHours) * 3600_000,
  };
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Move `d` forward to the next moment that falls inside the posting window. */
function intoWindow(d: Date): Date {
  const out = new Date(d);
  if (out.getHours() < WINDOW_START_HOUR) {
    out.setHours(WINDOW_START_HOUR, 0, 0, 0);
  } else if (out.getHours() >= WINDOW_END_HOUR) {
    out.setDate(out.getDate() + 1);
    out.setHours(WINDOW_START_HOUR, 0, 0, 0);
  }
  return out;
}

function startOfNextDayWindow(d: Date): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + 1);
  out.setHours(WINDOW_START_HOUR, 0, 0, 0);
  return out;
}

/**
 * Earliest posting slot that respects the window, the daily cap and the spacing,
 * given the times already taken. Pure — exported for tests.
 */
export function nextSlot(taken: Date[], r: SlotRules, from = Date.now()): Date {
  const sorted = [...taken].sort((a, b) => a.getTime() - b.getTime());
  let t = intoWindow(new Date(from + MIN_LEAD_MS));

  for (let guard = 0; guard < 800; guard++) {
    t = intoWindow(t);

    // spacing: not within `spacingMs` of any already-taken slot (either side)
    const clash = sorted.find((x) => Math.abs(x.getTime() - t.getTime()) < r.spacingMs);
    if (clash) {
      t = new Date(clash.getTime() + r.spacingMs);
      continue;
    }

    // daily cap: count taken slots on the same local day
    const onDay = sorted.filter((x) => sameLocalDay(x, t)).length;
    if (onDay >= r.cap) {
      t = startOfNextDayWindow(t);
      continue;
    }

    return t;
  }
  return t; // give up gracefully — return the best we have
}

/** Saved clips that hold a schedule slot (queued or already posted), earliest first. */
export function getSchedule(): Clip[] {
  return listClips()
    .filter((c) => c.scheduledAt)
    .sort((a, b) => (a.scheduledAt! < b.scheduledAt! ? -1 : 1));
}

/** Assign the next open slot to a freshly-saved clip. Returns the ISO time chosen. */
export function assignSlot(clipId: string): string {
  const taken = getSchedule()
    .filter((c) => c.id !== clipId)
    .map((c) => new Date(c.scheduledAt!));
  const when = nextSlot(taken, rules());
  updateClipSchedule(clipId, { scheduledAt: when.toISOString() });
  log.info(`scheduled clip ${clipId} for ${when.toISOString()}`);
  return when.toISOString();
}

/**
 * Recompute every *queued* clip's slot from now, in their current order. Posted
 * clips keep their (historical) times and still count against the cap/spacing.
 * Also picks up any saved clip that has no slot yet (e.g. saved before scheduling
 * existed), oldest first.
 */
export function reflowSchedule(): Clip[] {
  const r = rules();
  const scheduled = getSchedule();
  const taken = scheduled.filter((c) => c.postStatus === 'posted').map((c) => new Date(c.scheduledAt!));

  const unscheduled = listClips()
    .filter((c) => !c.scheduledAt && c.postStatus !== 'posted')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const queue = [...scheduled.filter((c) => c.postStatus === 'queued'), ...unscheduled];

  for (const clip of queue) {
    const when = nextSlot(taken, r);
    updateClipSchedule(clip.id, { scheduledAt: when.toISOString() });
    taken.push(when);
  }
  log.info(`reflowed the post schedule (${queue.length} clip(s))`);
  return getSchedule();
}

/** Toggle a clip's posted state. Posting stamps `postedAt`; un-posting clears it. */
export function setPosted(clipId: string, posted: boolean): void {
  updateClipSchedule(
    clipId,
    posted ? { postStatus: 'posted', postedAt: new Date().toISOString() } : { postStatus: 'queued', postedAt: null },
  );
}

/** Move one clip to an explicit time (from the dashboard's time field). */
export function moveSlot(clipId: string, isoTime: string): void {
  const t = new Date(isoTime);
  if (Number.isNaN(t.getTime())) {
    const e = new Error('invalid schedule time') as Error & { status: number };
    e.status = 400;
    throw e;
  }
  updateClipSchedule(clipId, { scheduledAt: t.toISOString() });
}
