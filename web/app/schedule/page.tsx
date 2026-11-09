'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, clipThumbUrl, clipVideoUrl } from '@/lib/api';
import type { Clip } from '@/lib/types';
import { mmss } from '@/lib/format';
import { TopBar } from '@/components/TopBar';
import { Button, Spinner } from '@/components/ui';

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export default function SchedulePage() {
  const [rows, setRows] = useState<Clip[] | null>(null);
  const [rules, setRules] = useState<{ cap: number; spacing: number } | null>(null);
  const [libraryCount, setLibraryCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Clip | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = () =>
    api
      .getSchedule()
      .then((r) => {
        setRows(r.schedule);
        setRules({ cap: r.dailyPostCap, spacing: r.minPostSpacingHours });
      })
      .catch(() => setRows([]));

  useEffect(() => {
    load();
    api.listClips().then((r) => setLibraryCount(r.clips.length)).catch(() => {});
  }, []);

  const unscheduledCount = Math.max(0, libraryCount - (rows?.length ?? 0));

  const queuedCount = rows?.filter((c) => c.postStatus === 'queued').length ?? 0;

  const groups = useMemo(() => {
    const out: Array<{ day: string; items: Clip[] }> = [];
    for (const c of rows ?? []) {
      if (!c.scheduledAt) continue;
      const day = dayLabel(c.scheduledAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(c);
      else out.push({ day, items: [c] });
    }
    return out;
  }, [rows]);

  const reflow = async () => {
    setBusy(true);
    try {
      const r = await api.reflowSchedule();
      setRows(r.schedule);
    } finally {
      setBusy(false);
    }
  };

  const togglePosted = async (c: Clip) => {
    const next = c.postStatus === 'posted' ? false : true;
    setRows((rs) => rs?.map((x) => (x.id === c.id ? { ...x, postStatus: next ? 'posted' : 'queued' } : x)) ?? null);
    await api.markPosted(c.id, next).catch(() => {});
    load();
  };

  const moveTime = async (c: Clip, localValue: string) => {
    const iso = new Date(localValue).toISOString();
    setEditing(null);
    setRows((rs) => rs?.map((x) => (x.id === c.id ? { ...x, scheduledAt: iso } : x)) ?? null);
    await api.moveSchedule(c.id, iso).catch(() => {});
    load();
  };

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-[680px] px-6 pb-32 pt-8">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[28px] font-semibold tracking-tight">Schedule</h1>
            <p className="mt-1.5 text-[15px] text-[color:var(--color-muted)]">
              {rows == null
                ? 'Loading…'
                : rows.length === 0
                  ? 'Nothing queued yet.'
                  : `${queuedCount} queued${rules ? ` · ${rules.cap}/day, ${rules.spacing}h apart` : ''}`}
            </p>
          </div>
          {((rows && rows.length > 0) || unscheduledCount > 0) && (
            <Button variant="secondary" onClick={reflow} loading={busy}>
              {unscheduledCount > 0 && (!rows || rows.length === 0) ? `Schedule ${unscheduledCount} clip${unscheduledCount > 1 ? 's' : ''}` : 'Reflow queued'}
            </Button>
          )}
        </header>

        {rows && rows.length > 0 && unscheduledCount > 0 && (
          <p className="mb-6 text-[13px] text-[color:var(--color-muted)]">
            {unscheduledCount} saved clip{unscheduledCount > 1 ? 's aren’t' : ' isn’t'} on the schedule yet — Reflow adds{' '}
            {unscheduledCount > 1 ? 'them' : 'it'}.
          </p>
        )}

        {rows == null && (
          <div className="flex justify-center py-16 text-[color:var(--color-muted)]">
            <Spinner className="h-5 w-5" />
          </div>
        )}

        {rows && rows.length === 0 && (
          <div className="rounded-[var(--radius)] border border-dashed border-[color:var(--color-hairline-strong)] px-6 py-14 text-center text-[14px] text-[color:var(--color-muted)]">
            {unscheduledCount > 0
              ? `${unscheduledCount} saved clip${unscheduledCount > 1 ? 's' : ''} not scheduled yet — hit “Schedule ${unscheduledCount} clip${unscheduledCount > 1 ? 's' : ''}” above.`
              : 'Clips you save get a suggested post time and show up here.'}
          </div>
        )}

        {groups.map((g) => (
          <section key={g.day} className="mb-7">
            <h2 className="mb-2.5 text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-faint)]">
              {g.day}
            </h2>
            <ul className="space-y-1.5">
              {g.items.map((c) => {
                const posted = c.postStatus === 'posted';
                return (
                  <li
                    key={c.id}
                    className="flex items-center gap-3.5 rounded-[var(--radius)] p-2 transition hover:bg-[color:var(--color-surface)]"
                  >
                    <div className="w-[76px] shrink-0 text-[13px] tabular-nums">
                      {editing === c.id ? (
                        <input
                          type="datetime-local"
                          autoFocus
                          defaultValue={toLocalInput(c.scheduledAt!)}
                          onBlur={(e) => moveTime(c, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') moveTime(c, (e.target as HTMLInputElement).value);
                            if (e.key === 'Escape') setEditing(null);
                          }}
                          className="w-full rounded-[6px] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] px-1.5 py-1 text-[12px]"
                        />
                      ) : (
                        <button
                          onClick={() => setEditing(c.id)}
                          className={posted ? 'text-[color:var(--color-faint)]' : 'text-[color:var(--color-text)] hover:text-[color:var(--color-accent)]'}
                        >
                          {timeLabel(c.scheduledAt!)}
                        </button>
                      )}
                    </div>

                    <button onClick={() => setOpen(c)} className="shrink-0">
                      <img
                        src={clipThumbUrl(c.id)}
                        alt=""
                        className={`h-[64px] w-[36px] rounded-[5px] bg-black object-cover ${posted ? 'opacity-50' : ''}`}
                      />
                    </button>

                    <button onClick={() => setOpen(c)} className="min-w-0 flex-1 text-left">
                      <span className={`block truncate text-[14px] font-medium ${posted ? 'text-[color:var(--color-muted)]' : ''}`}>
                        {c.title}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-[color:var(--color-muted)]">
                        {c.meta.provider === 'twitch' && (
                          <span className="rounded bg-[color:var(--color-accent-soft)] px-1 py-px text-[10px] font-medium text-[color:var(--color-accent-hover)]">
                            Twitch
                          </span>
                        )}
                        {mmss(c.durationSec)}
                        {c.meta.creatorHandle ? ` · ${c.meta.creatorHandle}` : ''}
                      </span>
                    </button>

                    <button
                      onClick={() => togglePosted(c)}
                      className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium transition ${
                        posted
                          ? 'text-[color:var(--color-ok)]'
                          : 'border border-[color:var(--color-hairline-strong)] text-[color:var(--color-muted)] hover:text-[color:var(--color-text)]'
                      }`}
                    >
                      {posted ? '✓ posted' : 'mark posted'}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </main>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={() => setOpen(null)}>
          <div
            className="flex w-full max-w-[320px] flex-col items-center rounded-[var(--radius-lg)] bg-[color:var(--color-surface)] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <video src={clipVideoUrl(open.id)} controls autoPlay loop playsInline className="aspect-[9/16] w-full rounded-[var(--radius)] bg-black" />
            <p className="mt-4 text-center text-[15px] font-medium">{open.title}</p>
            {open.meta.caption && (
              <p className="mt-2 text-center text-[12px] text-[color:var(--color-muted)]">{open.meta.caption}</p>
            )}
            {open.meta.hashtags && open.meta.hashtags.length > 0 && (
              <p className="mt-1 text-center text-[12px] text-[color:var(--color-faint)]">
                {open.meta.hashtags.map((t) => `#${t}`).join(' ')}
              </p>
            )}
            <div className="mt-4 flex items-center gap-4 text-[13px]">
              <a
                href={clipVideoUrl(open.id)}
                download={`${open.title.replace(/[^\w]+/g, '-')}.mp4`}
                className="font-medium text-[color:var(--color-accent)] hover:text-[color:var(--color-accent-hover)]"
              >
                Download
              </a>
              {open.source.url && (
                <a href={open.source.url} target="_blank" rel="noreferrer" className="text-[color:var(--color-muted)] hover:text-[color:var(--color-text)]">
                  Source
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
