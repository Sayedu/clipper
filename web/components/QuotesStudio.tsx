'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, candidatePreviewUrl, jobDownloadUrl, quotesPreviewSrc } from '@/lib/api';
import { useJobStream } from '@/lib/useJobStream';
import { Button, TextInput, Toggle } from '@/components/ui';

type RMApi = {
  replay: (seed?: number | string) => void;
  again: () => void;
  setAutoReplay: (on: boolean) => void;
  getSeed: () => number;
  readout: () => {
    seed: number; tag: string; setup: string; punch: string;
    elapsed: number; duration: number; done: boolean;
  };
};

/**
 * The Reminders preview studio — a deterministic <iframe> preview (one seed =
 * one bank line + one background drift) you can reroll until you like it, then
 * render that exact seed through the full pipeline (silent 4K mp4, caption) and
 * download it. Rendered both on the dashboard (when "Reminders" is the content
 * type) and at /quotes.
 */
export function QuotesStudio() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const rmRef = useRef<RMApi | null>(null);
  const [ready, setReady] = useState(false);

  const [seed, setSeed] = useState(0);
  const [auto, setAuto] = useState(false);
  const [readout, setReadout] = useState<ReturnType<RMApi['readout']> | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const stream = useJobStream(jobId);

  // grab the iframe's RM API once game.js has booted
  useEffect(() => {
    let stop = false;
    const poll = () => {
      if (stop) return;
      const w = iframeRef.current?.contentWindow as (Window & { RM?: RMApi }) | undefined;
      if (w?.RM?.replay) {
        rmRef.current = w.RM;
        setReady(true);
        setSeed(w.RM.getSeed());
      } else {
        setTimeout(poll, 120);
      }
    };
    poll();
    return () => {
      stop = true;
    };
  }, []);

  // live readout while previewing
  useEffect(() => {
    if (!ready) return;
    const t = setInterval(() => {
      const r = rmRef.current?.readout();
      if (r) {
        setReadout(r);
        setSeed((s) => (document.activeElement === document.getElementById('qt-seed') ? s : r.seed));
      }
    }, 120);
    return () => clearInterval(t);
  }, [ready]);

  const rm = () => rmRef.current;
  const doReplay = () => rm()?.replay();
  const doAgain = () => rm()?.again();
  const doSetSeed = () => {
    if (seed > 0) rm()?.replay(seed);
  };
  const onAuto = (v: boolean) => {
    setAuto(v);
    rm()?.setAutoReplay(v);
  };

  const render = useCallback(async () => {
    const r = rm()?.readout();
    if (!r) return;
    setRendering(true);
    try {
      const { jobId: id } = await api.quotesRender(r.seed);
      setJobId(id);
    } catch (e) {
      setRendering(false);
      alert('render failed: ' + (e as Error).message);
    }
  }, []);

  const done = stream.jobStatus === 'awaiting_review' && stream.review;
  const failed = stream.jobStatus === 'failed';
  useEffect(() => {
    if (done || failed) setRendering(false);
  }, [done, failed]);

  const renderPct = (() => {
    const s = stream.steps.render;
    if (!s || s.status === 'pending') return 0;
    if (s.status === 'done') return 1;
    return Math.max(0.02, s.progress);
  })();

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,300px)_1fr]">
      {/* ── live preview ── */}
      <div className="mx-auto w-full max-w-[300px]">
        <div className="relative aspect-[9/16] overflow-hidden rounded-[20px] border border-[color:var(--color-hairline-strong)] bg-black">
          <iframe
            ref={iframeRef}
            src={quotesPreviewSrc}
            title="Reminders preview"
            className="absolute inset-0 h-full w-full border-0"
          />
          {!ready && (
            <div className="absolute inset-0 grid place-items-center text-[13px] text-[color:var(--color-muted)]">
              loading preview…
            </div>
          )}
        </div>
        <div className="mt-3 rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] px-3.5 py-3 text-[13px]">
          {readout ? (
            <span className="font-medium text-[color:var(--color-accent)]">{readout.tag}</span>
          ) : (
            '…'
          )}
          <div className="mt-0.5 tabular-nums text-[11px] text-[color:var(--color-faint)]">
            {readout ? `${readout.elapsed.toFixed(1)}s / ${readout.duration}s` : ''} · seed {readout?.seed ?? seed}
          </div>
        </div>
      </div>

      {/* ── controls + output ── */}
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2">
          <Button variant="primary" size="lg" onClick={doReplay} disabled={!ready}>
            ↻ Replay — new seed
          </Button>
          <Button variant="secondary" size="lg" onClick={doAgain} disabled={!ready}>
            Again — same seed
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
              Seed
            </span>
            <div className="flex gap-2">
              <TextInput
                id="qt-seed"
                inputMode="numeric"
                value={seed || ''}
                onChange={(e) => setSeed(Number(e.target.value.replace(/\D/g, '')) || 0)}
                onKeyDown={(e) => e.key === 'Enter' && doSetSeed()}
              />
              <Button variant="secondary" onClick={doSetSeed} disabled={!ready || !seed}>
                set
              </Button>
            </div>
          </label>
          <div className="flex items-end pb-1.5">
            <Toggle checked={auto} onChange={onAuto} label="Auto-reroll (cycle the bank)" />
          </div>
        </div>

        {readout && (
          <div className="rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] px-4 py-3 text-[14px] leading-relaxed">
            <div className="text-[color:var(--color-muted)]">{readout.setup}</div>
            <div className="mt-1 font-semibold">{readout.punch}</div>
          </div>
        )}

        <div className="rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-4">
          {!jobId && (
            <>
              <Button
                variant="primary"
                size="lg"
                onClick={render}
                loading={rendering}
                disabled={!ready}
                className="w-full"
              >
                ▶ Render this seed
              </Button>
              <p className="mt-2 text-[12px] text-[color:var(--color-faint)]">
                Full silent 4K render — takes ~1 minute. Same output the pipeline produces.
              </p>
            </>
          )}

          {jobId && !done && !failed && (
            <div>
              <div className="mb-2 flex items-center justify-between text-[13px]">
                <span>
                  Rendering seed <b className="tabular-nums">{readout?.seed}</b>…
                </span>
                <span className="tabular-nums text-[color:var(--color-muted)]">
                  {Math.round(renderPct * 100)}%
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-[color:var(--color-hairline)]">
                <div
                  className="h-full rounded-full bg-[color:var(--color-accent)] transition-[width]"
                  style={{ width: `${renderPct * 100}%` }}
                />
              </div>
              <p className="mt-2 text-[12px] text-[color:var(--color-faint)]">
                {stream.steps.render?.detail ?? 'drawing the card, compositing 4K'}
              </p>
              <button
                className="mt-3 text-[12px] text-[color:var(--color-muted)] underline hover:text-[color:var(--color-text)]"
                onClick={() => {
                  if (jobId) void api.cancelJob(jobId);
                  setJobId(null);
                  setRendering(false);
                }}
              >
                cancel
              </button>
            </div>
          )}

          {failed && (
            <div className="text-[13px] text-[color:var(--color-danger)]">
              Render failed{stream.error ? `: ${stream.error.message}` : ''}.{' '}
              <button className="underline" onClick={() => setJobId(null)}>
                try again
              </button>
            </div>
          )}

          {done && stream.review && (
            <div className="space-y-4">
              <video
                src={candidatePreviewUrl(jobId!, 0)}
                controls
                loop
                autoPlay
                muted
                playsInline
                className="mx-auto max-h-[62dvh] rounded-[12px] bg-black"
              />
              <div className="flex flex-wrap gap-3">
                <a href={jobDownloadUrl(jobId!, 0)} download>
                  <Button variant="primary" size="lg">
                    ⤓ Download to your computer
                  </Button>
                </a>
                <Button variant="secondary" onClick={() => setJobId(null)}>
                  Render another
                </Button>
              </div>
              {stream.review.draftText?.caption && (
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
                      Caption
                    </span>
                    <button
                      className="text-[12px] text-[color:var(--color-accent)] hover:underline"
                      onClick={() => navigator.clipboard?.writeText(captionBlock(stream.review!.draftText))}
                    >
                      copy
                    </button>
                  </div>
                  <pre className="whitespace-pre-wrap rounded-[10px] border border-[color:var(--color-hairline)] bg-[color:var(--color-bg)] p-3 text-[13px] leading-relaxed">
                    {captionBlock(stream.review.draftText)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function captionBlock(d: { caption?: string; hashtags?: string[] } | null): string {
  if (!d) return '';
  const tags = (d.hashtags ?? []).map((t) => `#${t}`).join(' ');
  return [d.caption?.trim(), tags].filter(Boolean).join('\n\n');
}
