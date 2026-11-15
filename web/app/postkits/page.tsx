'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { postKitFileUrl, postKitsApi, type PostKit, type PostKitSource, type PostKitTask } from '@/lib/api';
import { relativeDate } from '@/lib/format';
import { TopBar } from '@/components/TopBar';
import { Button, Spinner } from '@/components/ui';

const NAMES: Record<string, string> = {
  colorwar: 'Color War', ringofdoom: 'Ring of Doom', hotpotato: 'Hot Potato',
  followball: 'Follow The Ball', eyetest: 'Eye Test', findthecat: 'Find The Cat',
};

function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); })}
      className="text-[12px] font-medium text-[color:var(--color-accent)] hover:text-[color:var(--color-accent-hover)]"
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export default function PostKitsPage() {
  const [sources, setSources] = useState<PostKitSource[] | null>(null);
  const [kits, setKits] = useState<PostKit[]>([]);
  const [task, setTask] = useState<PostKitTask | null>(null);
  const [queue, setQueue] = useState<Array<{ id: string; format: string; caption: string; backToBack: boolean }>>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() =>
    postKitsApi.list().then((r) => {
      setSources(r.sources);
      setKits(r.kits);
      setTask(r.task);
      setQueue(r.queue);
    }).catch((e: Error) => setError(e.message)), []);

  useEffect(() => { load(); }, [load]);
  // poll while a run is going
  useEffect(() => {
    if (!task?.running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [task?.running, load]);

  const unpackaged = useMemo(() => (sources ?? []).filter((s) => !s.kitId), [sources]);
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const make = async () => {
    setError(null);
    try {
      const r = await postKitsApi.make([...picked]);
      setTask(r.task);
      setPicked(new Set());
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const posted = async (id: string) => {
    await postKitsApi.markPosted(id).catch(() => {});
    load();
  };

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-[680px] px-6 pb-32 pt-8">
        <header className="mb-8">
          <h1 className="text-[28px] font-semibold tracking-tight">Post kits</h1>
          <p className="mt-1.5 text-[15px] text-[color:var(--color-muted)]">
            Repackage renders so every post looks different from the last ten: a new opening hook, background,
            border, zoom and sound bed, plus a caption, hashtags, cover and pinned comment written from what happens
            in that video. The game itself is never changed.
          </p>
        </header>

        {error && <p className="mb-6 rounded-[var(--radius)] bg-[color:var(--color-danger-soft)] px-4 py-3 text-[14px] text-[color:var(--color-danger)]">{error}</p>}

        {task?.running && (
          <div className="mb-8 flex items-center gap-3 rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] px-4 py-3 text-[14px]">
            <Spinner className="h-4 w-4" />
            <span>
              Packaging {task.done.length + task.failed.length + 1} of {task.total}
              <span className="text-[color:var(--color-muted)]"> · {task.current}</span>
            </span>
          </div>
        )}
        {task && !task.running && task.failed.length > 0 && (
          <div className="mb-8 rounded-[var(--radius)] bg-[color:var(--color-danger-soft)] px-4 py-3 text-[13px] text-[color:var(--color-danger)]">
            {task.failed.map((f) => <p key={f.source}>{f.source}: {f.error}</p>)}
          </div>
        )}

        {/* ---------------- renders */}
        <section className="mb-12">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[17px] font-semibold">Renders</h2>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                onClick={() => setPicked(new Set(unpackaged.slice(0, 5).map((s) => s.id)))}
                disabled={!unpackaged.length}
              >
                Newest 5 without a kit
              </Button>
              <Button variant="primary" onClick={make} disabled={!picked.size || !!task?.running}>
                Make post kits{picked.size ? ` (${picked.size})` : ''}
              </Button>
            </div>
          </div>
          {sources == null ? (
            <div className="flex justify-center py-10 text-[color:var(--color-muted)]"><Spinner className="h-5 w-5" /></div>
          ) : sources.length === 0 ? (
            <p className="text-[14px] text-[color:var(--color-muted)]">No finished renders of the posted games yet.</p>
          ) : (
            <ul className="max-h-[320px] space-y-1 overflow-auto rounded-[var(--radius)] border border-[color:var(--color-hairline)] p-2">
              {sources.map((s) => (
                <li key={s.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-[6px] px-2 py-1.5 text-[14px] hover:bg-[color:var(--color-surface)]">
                    <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} />
                    <span className="w-[120px] shrink-0 font-medium">{NAMES[s.format] ?? s.format}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[color:var(--color-muted)]">{s.id}</span>
                    <span className="shrink-0 text-[12px] text-[color:var(--color-muted)]">
                      {s.kitId ? 'has a kit · ' : ''}{relativeDate(s.renderedAt)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---------------- posting order */}
        {queue.length > 0 && (
          <section className="mb-12">
            <h2 className="mb-1 text-[17px] font-semibold">Posting order</h2>
            <p className="mb-3 text-[13px] text-[color:var(--color-muted)]">Kits not posted yet, ordered so the same game never goes out twice in a row.</p>
            <ol className="space-y-1.5 text-[14px]">
              {queue.map((q, i) => (
                <li key={q.id} className="flex gap-3">
                  <span className="w-5 shrink-0 text-right text-[color:var(--color-muted)]">{i + 1}.</span>
                  <span className="w-[120px] shrink-0 font-medium">{NAMES[q.format] ?? q.format}</span>
                  <span className="min-w-0 flex-1 truncate text-[color:var(--color-muted)]">
                    {q.backToBack ? '(same game as the one before: not enough other games queued) ' : ''}{q.caption}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* ---------------- kits */}
        <section>
          <h2 className="mb-3 text-[17px] font-semibold">Kits</h2>
          {kits.length === 0 && <p className="text-[14px] text-[color:var(--color-muted)]">No post kits yet. Pick renders above and press Make post kits.</p>}
          <ul className="space-y-6">
            {kits.map((k) => (
              <li key={k.id} className="flex gap-4 rounded-[var(--radius)] border border-[color:var(--color-hairline)] p-3">
                {k.exists ? (
                  <a href={postKitFileUrl(k.id, 'cover.png')} target="_blank" rel="noreferrer" className="shrink-0">
                    <img src={postKitFileUrl(k.id, 'cover.png')} alt="" className="h-[178px] w-[100px] rounded-[6px] bg-black object-cover" />
                  </a>
                ) : (
                  <div className="h-[178px] w-[100px] shrink-0 rounded-[6px] bg-[color:var(--color-surface)]" />
                )}
                <div className="min-w-0 flex-1 text-[13px]">
                  <p className="text-[14px] font-medium">
                    {NAMES[k.format] ?? k.format}
                    <span className="font-normal text-[color:var(--color-muted)]"> · {relativeDate(k.createdAt)} · {k.posted ? 'posted' : 'not posted'}</span>
                  </p>
                  <p className="mt-2 whitespace-pre-line">{k.caption}</p>
                  <p className="mt-1 text-[color:var(--color-accent)]">{k.hashtags.map((t) => `#${t}`).join(' ')}</p>
                  <div className="mt-1"><Copy text={`${k.caption}\n\n${k.hashtags.map((t) => `#${t}`).join(' ')}`} label="Copy caption" /></div>
                  <p className="mt-2"><span className="text-[color:var(--color-muted)]">Pinned: </span>{k.pinned} <Copy text={k.pinned} /></p>
                  <p className="mt-2 text-[color:var(--color-muted)]">
                    Hook “{k.hook.lines.join(' ')}” · cover “{k.cover.lines.join(' ')}” · {k.look.bg} background · {k.look.border} border · {k.sound.track} sound
                  </p>
                  {k.exists && (
                    <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-medium">
                      <a className="text-[color:var(--color-accent)]" href={postKitFileUrl(k.id, 'video.mp4', true)}>Video</a>
                      <a className="text-[color:var(--color-accent)]" href={postKitFileUrl(k.id, 'video_sfx_only.mp4', true)}>SFX only</a>
                      <a className="text-[color:var(--color-accent)]" href={postKitFileUrl(k.id, 'cover.png', true)}>Cover</a>
                      <a className="text-[color:var(--color-accent)]" href={postKitFileUrl(k.id, 'caption.txt', true)}>caption.txt</a>
                      <a className="text-[color:var(--color-accent)]" href={postKitFileUrl(k.id, 'pinned_comment.txt', true)}>pinned_comment.txt</a>
                      {!k.posted && <button onClick={() => posted(k.id)} className="text-[color:var(--color-muted)] hover:text-[color:var(--color-text)]">Mark posted</button>}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </>
  );
}
