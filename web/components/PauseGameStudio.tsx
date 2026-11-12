'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, candidatePreviewUrl, pausegamePreviewSrc, jobDownloadUrl } from '@/lib/api';
import { useJobStream } from '@/lib/useJobStream';
import { Button, TextInput, Toggle } from '@/components/ui';

type PGApi = {
  replay: (seed?: number | string) => void;
  again: () => void;
  setParams: (targetDeg: number, rotationMs: number, laps: number) => void;
  setSound: (on: boolean) => void;
  getSeed: () => number;
  getParams: () => { targetDeg: number; rotationMs: number; laps: number };
  readout: () => {
    seed: number; targetDeg: number; rotationMs: number; laps: number;
    lap: number; elapsedSec: number; inZone: boolean;
  };
};

const MIN_TARGET = 5, MAX_TARGET = 30;
const MIN_ROTATION = 600, MAX_ROTATION = 2500;
const MIN_LAPS = 4, MAX_LAPS = 20;
const clampTarget = (n: number) => Math.max(MIN_TARGET, Math.min(MAX_TARGET, Math.round(n) || MIN_TARGET));
const clampRotation = (n: number) => Math.max(MIN_ROTATION, Math.min(MAX_ROTATION, Math.round(n) || MIN_ROTATION));
const clampLaps = (n: number) => Math.max(MIN_LAPS, Math.min(MAX_LAPS, Math.round(n) || MIN_LAPS));

/**
 * The Pause Game preview studio — a deterministic <iframe> preview you can
 * reroll (for a different neon accent color) and tune (target size, sweep
 * speed, lap count) until it feels right, then render that exact
 * configuration through the full pipeline (caption, sound) and download the
 * mp4. Rendered both on the dashboard (when "Pause game" is the content
 * type) and at /pausegame.
 *
 * Unlike the other studios, there's no "answer" to preview here — the needle
 * never stops on its own. The preview's live readout just shows whether the
 * needle is currently inside the win zone, for tuning difficulty.
 */
export function PauseGameStudio() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pgRef = useRef<PGApi | null>(null);
  const [ready, setReady] = useState(false);

  const [seed, setSeed] = useState(0);
  const [targetDeg, setTargetDeg] = useState(9);
  const [rotationMs, setRotationMs] = useState(1100);
  const [laps, setLaps] = useState(10);
  const [sound, setSound] = useState(false);
  const [readout, setReadout] = useState<ReturnType<PGApi['readout']> | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const stream = useJobStream(jobId);

  // grab the iframe's PG API once game.js has booted
  useEffect(() => {
    let stop = false;
    const poll = () => {
      if (stop) return;
      const w = iframeRef.current?.contentWindow as (Window & { PG?: PGApi }) | undefined;
      if (w?.PG?.replay) {
        pgRef.current = w.PG;
        w.PG.setSound(false);
        setReady(true);
        setSeed(w.PG.getSeed());
        const p = w.PG.getParams();
        setTargetDeg(p.targetDeg);
        setRotationMs(p.rotationMs);
        setLaps(p.laps);
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
      const r = pgRef.current?.readout();
      if (r) {
        setReadout(r);
        setSeed((s) => (document.activeElement === document.getElementById('pg-seed') ? s : r.seed));
      }
    }, 110);
    return () => clearInterval(t);
  }, [ready]);

  const pg = () => pgRef.current;
  const doReplay = () => pg()?.replay();
  const doAgain = () => pg()?.again();
  const doSetSeed = () => {
    if (seed > 0) pg()?.replay(seed);
  };
  const applyParams = () => pg()?.setParams(targetDeg, rotationMs, laps);
  const onSound = (v: boolean) => {
    setSound(v);
    pg()?.setSound(v);
  };

  const render = useCallback(async () => {
    const r = pg()?.readout();
    if (!r) return;
    setRendering(true);
    try {
      const { jobId: id } = await api.pausegameRender(r.seed, r.targetDeg, r.rotationMs, r.laps);
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

  const paramsDirty = readout
    ? readout.targetDeg !== targetDeg || readout.rotationMs !== rotationMs || readout.laps !== laps
    : false;

  const durationSec = (laps * rotationMs) / 1000;

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,300px)_1fr]">
      {/* ── live preview ── */}
      <div className="mx-auto w-full max-w-[300px]">
        <div className="relative aspect-[9/16] overflow-hidden rounded-[20px] border border-[color:var(--color-hairline-strong)] bg-black">
          <iframe
            ref={iframeRef}
            src={pausegamePreviewSrc}
            title="Pause Game preview"
            className="absolute inset-0 h-full w-full border-0"
          />
          {!ready && (
            <div className="absolute inset-0 grid place-items-center text-[13px] text-[color:var(--color-muted)]">
              loading preview…
            </div>
          )}
        </div>
        <div className="mt-3 rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] px-3.5 py-3 text-[13px] tabular-nums">
          {readout ? (
            <span>
              Lap <b>{readout.lap}/{readout.laps}</b> · {readout.elapsedSec.toFixed(1)}s
              {readout.inZone && <span style={{ color: '#00ff66' }}> · IN ZONE</span>}
            </span>
          ) : (
            '…'
          )}
          <div className="mt-0.5 text-[11px] text-[color:var(--color-faint)]">
            seed {readout?.seed ?? seed} · {readout?.targetDeg ?? targetDeg}° target · {readout?.rotationMs ?? rotationMs}ms/rotation
          </div>
        </div>
      </div>

      {/* ── controls + output ── */}
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2">
          <Button variant="primary" size="lg" onClick={doReplay} disabled={!ready}>
            ↻ Replay — new accent color
          </Button>
          <Button variant="secondary" size="lg" onClick={doAgain} disabled={!ready}>
            Again — same seed
          </Button>
        </div>

        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
            Seed
          </span>
          <div className="flex gap-2 sm:max-w-[240px]">
            <TextInput
              id="pg-seed"
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

        <div className="rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-4">
          <div className="mb-3 text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
            Difficulty
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-[13px] text-[color:var(--color-muted)]">Target size</span>
              <input
                type="range"
                min={MIN_TARGET}
                max={MAX_TARGET}
                value={targetDeg}
                onChange={(e) => setTargetDeg(clampTarget(Number(e.target.value)))}
                className="h-1.5 flex-1 accent-[color:var(--color-accent)]"
              />
              <span className="w-24 shrink-0 text-right text-[13px] tabular-nums">{targetDeg}° wide</span>
            </div>

            <div className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-[13px] text-[color:var(--color-muted)]">Sweep speed</span>
              <input
                type="range"
                min={MIN_ROTATION}
                max={MAX_ROTATION}
                step={50}
                value={rotationMs}
                onChange={(e) => setRotationMs(clampRotation(Number(e.target.value)))}
                className="h-1.5 flex-1 accent-[color:var(--color-accent)]"
              />
              <span className="w-24 shrink-0 text-right text-[13px] tabular-nums">{rotationMs}ms/rev</span>
            </div>

            <div className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-[13px] text-[color:var(--color-muted)]">Laps</span>
              <input
                type="range"
                min={MIN_LAPS}
                max={MAX_LAPS}
                value={laps}
                onChange={(e) => setLaps(clampLaps(Number(e.target.value)))}
                className="h-1.5 flex-1 accent-[color:var(--color-accent)]"
              />
              <span className="w-24 shrink-0 text-right text-[13px] tabular-nums">{laps} laps</span>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-[color:var(--color-hairline)] pt-4">
            <span className="text-[12px] text-[color:var(--color-faint)]">
              ≈ {durationSec.toFixed(0)}s · loops seamlessly on TikTok's own replay
            </span>
            <Button variant="primary" onClick={applyParams} disabled={!ready || !paramsDirty}>
              Apply
            </Button>
          </div>
        </div>

        <Toggle checked={sound} onChange={onSound} label="Sound" />

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
                Full 4K render — takes a minute or two. Same output the pipeline produces.
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
                {stream.steps.render?.detail ?? 'rendering frames, scoring the sound, compositing 4K'}
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
