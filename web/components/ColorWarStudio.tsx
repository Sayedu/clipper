'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, candidatePreviewUrl, colorwarPreviewSrc, jobDownloadUrl } from '@/lib/api';
import { useJobStream } from '@/lib/useJobStream';
import { Button, SegmentedControl, TextInput, Toggle } from '@/components/ui';
import { COLOR_DOTS } from '@/lib/types';
import Link from 'next/link';

type CWApi = {
  replay: (seed?: number | string) => void;
  again: () => void;
  setMode: (m: string) => void;
  setSpeed: (s: number) => void;
  setSound: (on: boolean) => void;
  setAutoReplay: (on: boolean) => void;
  getSeed: () => number;
  getMode: () => string;
  readout: () => {
    seed: number; mode: string; modeName: string; phase: string;
    roundSec: number; alive: string[]; elimOrder: string[];
    winner: string | null; finalSec: number | null;
  };
};

const MODES = [
  { id: 'classic', label: 'Classic · ~42s · wild duel' },
  { id: 'sprint', label: 'Sprint · ~16s · fastest' },
  { id: 'bigtiles', label: 'Big Tiles · ~41s · wild duel' },
  { id: 'finegrain', label: 'Fine Grain · ~43s' },
  { id: 'stripes', label: 'Stripes · ~42s' },
];
const DOT: Record<string, string> = COLOR_DOTS;

/**
 * The Color War preview studio — a deterministic <iframe> preview you can reroll
 * until you like a seed, then render that exact seed through the full pipeline
 * ("Watch till the end" + who-wins text, TikTok-safe framing, sound, caption)
 * and download the mp4.
 * Rendered both on the dashboard (when "Color war" is the content type) and at
 * /colorwar.
 */
export function ColorWarStudio() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const cwRef = useRef<CWApi | null>(null);
  const [ready, setReady] = useState(false);

  const [seed, setSeed] = useState(0);
  const [mode, setMode] = useState('classic');
  const [speed, setSpeed] = useState<'0.5' | '1' | '2' | '4'>('1');
  const [sound, setSound] = useState(false);
  const [auto, setAuto] = useState(false);
  const [shape, setShape] = useState<'circle' | 'square'>('circle');
  const [flipSound, setFlipSound] = useState<'pluck' | 'bubble'>('bubble');
  const [readout, setReadout] = useState<ReturnType<CWApi['readout']> | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const stream = useJobStream(jobId);

  const iframeSrc = colorwarPreviewSrc(shape, flipSound);

  // load the saved ball-shape / flip-sound once (the render reads them from settings)
  useEffect(() => {
    let stop = false;
    api
      .getSettings()
      .then(({ settings }) => {
        if (stop) return;
        if (settings.colorWarShape === 'square' || settings.colorWarShape === 'circle') setShape(settings.colorWarShape);
        if (settings.colorWarFlipSound === 'pluck' || settings.colorWarFlipSound === 'bubble')
          setFlipSound(settings.colorWarFlipSound);
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, []);

  // grab the iframe's CW API once game.js has booted (re-runs if the iframe reloads
  // because the shape/flip-sound query changed)
  useEffect(() => {
    let stop = false;
    setReady(false);
    cwRef.current = null;
    const poll = () => {
      if (stop) return;
      const w = iframeRef.current?.contentWindow as (Window & { CW?: CWApi }) | undefined;
      if (w?.CW?.replay) {
        cwRef.current = w.CW;
        w.CW.setSound(sound);
        w.CW.setSpeed(Number(speed));
        w.CW.setAutoReplay(auto);
        setReady(true);
        setSeed(w.CW.getSeed());
        setMode(w.CW.getMode());
      } else {
        setTimeout(poll, 120);
      }
    };
    poll();
    return () => {
      stop = true;
    };
  }, [iframeSrc]); // eslint-disable-line react-hooks/exhaustive-deps

  // live readout while previewing
  useEffect(() => {
    if (!ready) return;
    const t = setInterval(() => {
      const r = cwRef.current?.readout();
      if (r) {
        setReadout(r);
        setSeed((s) => (document.activeElement === document.getElementById('cw-seed') ? s : r.seed));
      }
    }, 120);
    return () => clearInterval(t);
  }, [ready]);

  const cw = () => cwRef.current;
  const doReplay = () => cw()?.replay();
  const doAgain = () => cw()?.again();
  const doSetSeed = () => {
    if (seed > 0) cw()?.replay(seed);
  };
  const onMode = (m: string) => {
    setMode(m);
    cw()?.setMode(m);
  };
  const onSpeed = (s: '0.5' | '1' | '2' | '4') => {
    setSpeed(s);
    cw()?.setSpeed(Number(s));
  };
  const onSound = (v: boolean) => {
    setSound(v);
    cw()?.setSound(v);
  };
  const onAuto = (v: boolean) => {
    setAuto(v);
    cw()?.setAutoReplay(v);
  };
  const onShape = (v: 'circle' | 'square') => {
    setShape(v);
    void api.saveSettings({ colorWarShape: v }).catch(() => {});
  };
  const onFlipSound = (v: 'pluck' | 'bubble') => {
    setFlipSound(v);
    void api.saveSettings({ colorWarFlipSound: v }).catch(() => {});
  };

  const render = useCallback(async () => {
    const r = cw()?.readout();
    if (!r) return;
    setRendering(true);
    try {
      const { jobId: id } = await api.colorwarRender(r.seed, r.mode);
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
    <div className="space-y-4">
      <Link
        href="/colorwar-season"
        className="inline-flex items-center gap-1 text-[13px] text-[color:var(--color-accent)] hover:underline"
      >
        Want a whole season instead of one clip? Try Season Mode →
      </Link>
      <div className="grid gap-6 md:grid-cols-[minmax(0,300px)_1fr]">
        {/* ── live preview ── */}
      <div className="mx-auto w-full max-w-[300px]">
        <div className="relative aspect-[9/16] overflow-hidden rounded-[20px] border border-[color:var(--color-hairline-strong)] bg-black">
          <iframe
            key={iframeSrc}
            ref={iframeRef}
            src={iframeSrc}
            title="Color War preview"
            className="absolute inset-0 h-full w-full border-0"
          />
          {!ready && (
            <div className="absolute inset-0 grid place-items-center text-[13px] text-[color:var(--color-muted)]">
              loading preview…
            </div>
          )}
        </div>
        <div className="mt-3 rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] px-3.5 py-3 text-[13px] tabular-nums">
          {readout?.winner ? (
            <span>
              <b style={{ color: DOT[readout.winner] }}>{readout.winner} won</b> · final{' '}
              {readout.finalSec?.toFixed(2)}s
            </span>
          ) : readout ? (
            <span>
              {readout.roundSec.toFixed(1)}s ·{' '}
              {readout.alive.map((c) => (
                <span key={c} className="mr-1.5 inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: DOT[c] }} />
                  {c[0]}
                </span>
              ))}
            </span>
          ) : (
            '…'
          )}
          <div className="mt-0.5 text-[11px] text-[color:var(--color-faint)]">
            {readout?.modeName ?? mode} · seed {readout?.seed ?? seed}
            {readout && readout.elimOrder.length > 0 && ` · out: ${readout.elimOrder.join(' → ')}`}
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
                id="cw-seed"
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
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
              Board
            </span>
            <select
              value={mode}
              onChange={(e) => onMode(e.target.value)}
              disabled={!ready}
              className="h-9 w-full rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] px-2 text-[14px]"
            >
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="flex items-center gap-3">
            <span className="text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
              Speed
            </span>
            <SegmentedControl<'0.5' | '1' | '2' | '4'>
              value={speed}
              onChange={onSpeed}
              options={[
                { value: '0.5', label: '0.5×' },
                { value: '1', label: '1×' },
                { value: '2', label: '2×' },
                { value: '4', label: '4×' },
              ]}
            />
          </label>
          <Toggle checked={sound} onChange={onSound} label="Sound" />
          <Toggle checked={auto} onChange={onAuto} label="Auto-reroll" />
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="flex items-center gap-3">
            <span className="text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
              Ball
            </span>
            <SegmentedControl<'circle' | 'square'>
              value={shape}
              onChange={onShape}
              options={[
                { value: 'circle', label: 'Circle' },
                { value: 'square', label: 'Square' },
              ]}
            />
          </label>
          <label className="flex items-center gap-3">
            <span className="text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
              Flip
            </span>
            <SegmentedControl<'pluck' | 'bubble'>
              value={flipSound}
              onChange={onFlipSound}
              options={[
                { value: 'pluck', label: 'Pluck' },
                { value: 'bubble', label: 'Bubble' },
              ]}
            />
          </label>
        </div>

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
                Full 4K render — takes ~4 minutes. Same output the pipeline produces.
              </p>
            </>
          )}

          {jobId && !done && !failed && (
            <div>
              <div className="mb-2 flex items-center justify-between text-[13px]">
                <span>
                  Rendering seed <b className="tabular-nums">{readout?.seed}</b> ({mode})…
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
    </div>
  );
}

function captionBlock(d: { caption?: string; hashtags?: string[] } | null): string {
  if (!d) return '';
  const tags = (d.hashtags ?? []).map((t) => `#${t}`).join(' ');
  return [d.caption?.trim(), tags].filter(Boolean).join('\n\n');
}
