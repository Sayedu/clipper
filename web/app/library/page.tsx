'use client';

import { useEffect, useState } from 'react';
import { api, clipThumbUrl, clipVideoUrl } from '@/lib/api';
import type { Clip } from '@/lib/types';
import { mmss, relativeDate } from '@/lib/format';
import { TopBar } from '@/components/TopBar';
import { Spinner } from '@/components/ui';

export default function LibraryPage() {
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [open, setOpen] = useState<Clip | null>(null);

  useEffect(() => {
    api.listClips().then((r) => setClips(r.clips)).catch(() => setClips([]));
  }, []);

  const remove = async (id: string) => {
    await api.deleteClip(id).catch(() => {});
    setClips((c) => c?.filter((x) => x.id !== id) ?? null);
    setOpen(null);
  };

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-[680px] px-6 pb-32 pt-8">
        <header className="mb-10">
          <h1 className="text-[28px] font-semibold tracking-tight">Library</h1>
          <p className="mt-1.5 text-[15px] text-[color:var(--color-muted)]">
            {clips == null ? 'Loading…' : clips.length ? `${clips.length} saved clip${clips.length > 1 ? 's' : ''}` : 'Nothing saved yet.'}
          </p>
        </header>

        {clips == null && (
          <div className="flex justify-center py-16 text-[color:var(--color-muted)]">
            <Spinner className="h-5 w-5" />
          </div>
        )}

        {clips && clips.length > 0 && (
          <ul className="space-y-3">
            {clips.map((clip) => (
              <li key={clip.id}>
                <button
                  onClick={() => setOpen(clip)}
                  className="flex w-full items-center gap-4 rounded-[var(--radius)] p-2 text-left transition hover:bg-[color:var(--color-surface)]"
                >
                  <img
                    src={clipThumbUrl(clip.id)}
                    alt=""
                    className="h-[76px] w-[43px] shrink-0 rounded-[6px] bg-black object-cover"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{clip.title}</span>
                    <span className="mt-0.5 block truncate text-[13px] text-[color:var(--color-muted)]">
                      {clip.source.channel || clip.source.title} · {mmss(clip.durationSec)} · {relativeDate(clip.createdAt)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {clips && clips.length === 0 && (
          <div className="rounded-[var(--radius)] border border-dashed border-[color:var(--color-hairline-strong)] px-6 py-14 text-center text-[14px] text-[color:var(--color-muted)]">
            Clips you save from a run show up here.
          </div>
        )}
      </main>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
          onClick={() => setOpen(null)}
        >
          <div
            className="flex w-full max-w-[320px] flex-col items-center rounded-[var(--radius-lg)] bg-[color:var(--color-surface)] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <video
              src={clipVideoUrl(open.id)}
              controls
              autoPlay
              loop
              playsInline
              className="aspect-[9/16] w-full rounded-[var(--radius)] bg-black"
            />
            <p className="mt-4 text-center text-[15px] font-medium">{open.title}</p>
            {open.meta.transcriptExcerpt && (
              <p className="mt-2 max-h-24 overflow-auto text-center text-[12px] text-[color:var(--color-muted)]">
                “{open.meta.transcriptExcerpt}”
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
              <button onClick={() => remove(open.id)} className="text-[color:var(--color-muted)] hover:text-[color:var(--color-danger)]">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
