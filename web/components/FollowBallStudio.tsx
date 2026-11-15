'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, candidatePreviewUrl, findthecatPreviewSrc, followballPreviewSrc, jobDownloadUrl } from '@/lib/api';
import { useJobStream } from '@/lib/useJobStream';
import { Button, SegmentedControl, TextInput, Toggle } from '@/components/ui';

type Variant = 'classic' | 'findthecat';

type ClassicApi = {
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
    round: number; rounds: number; answers: number[]; cups: number[];
    done: boolean; roundSec: number;
  };
};

// Find The Cat is a single fixed-length (~20.9s) shuffle round, not a
// multi-round game — its FTB readout shape is correspondingly simpler.
type FtcApi = {
  replay: (seed?: number | string) => void;
  again: () => void;
  setCups: (n: number) => void;
  setDifficulty: (d: string) => void;
  setRound: (r: number) => void;
  setTheme: (t: string) => void;
  setSpeed: (s: number) => void;
  setSound: (on: boolean) => void;
  setAutoReplay: (on: boolean) => void;
  getSeed: () => number;
  readout: () => {
    seed: number; cups: number; difficulty: string; round: number; theme: string;
    phase: string; t: number; totalSec: number; win: number; done: boolean;
  };
};

const MODES = [
  { id: 'sprint', label: 'Sprint · 3 rounds · ~18s' },
  { id: 'classic', label: 'Classic · 5 rounds · ~40s' },
  { id: 'insane', label: 'Insane · 5 rounds · brutal' },
  { id: 'random', label: 'Surprise me' },
];

const FTC_CUPS: Array<{ value: '3' | '4' | '5'; label: string }> = [
  { value: '3', label: '3' },
  { value: '4', label: '4' },
  { value: '5', label: '5' },
];
const FTC_DIFFS: Array<{ value: 'easy' | 'medium' | 'hard'; label: string }> = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
];
const FTC_THEMES: Array<{ value: 'candy' | 'neon' | 'sunset'; label: string }> = [
  { value: 'candy', label: 'Candy' },
  { value: 'neon', label: 'Neon' },
  { value: 'sunset', label: 'Sunset' },
];

/**
 * The Follow The Ball preview studio — a deterministic <iframe> preview you can
 * reroll until you like a shuffle, then render that exact seed through the full
 * pipeline (TikTok-safe framing, sound, caption) and download the mp4. Rendered
 * both on the dashboard (when "Follow the ball" is the content type) and at
 * /followball.
 *
 * Also hosts "Find The Cat" — the same shell-game mechanic with a cat-face
 * ball, picked via the Variant toggle below. It's a separate deterministic
 * <iframe> page (render/findthecat/), not a mode of the classic game, so
 * switching variants swaps both the iframe src and the control panel.
 */
export function FollowBallStudio() {
  const [variant, setVariant] = useState<Variant>('classic');

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const fbRef = useRef<ClassicApi | null>(null);
  const ftcRef = useRef<FtcApi | null>(null);
  const [ready, setReady] = useState(false);

  const [seed, setSeed] = useState(0);
  const [mode, setMode] = useState('sprint');
  const [cups, setCupsState] = useState<'3' | '4' | '5'>('5');
  const [difficulty, setDifficultyState] = useState<'easy' | 'medium' | 'hard'>('easy');
  const [round, setRoundState] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [theme, setThemeState] = useState<'candy' | 'neon' | 'sunset'>('candy');
  const [speed, setSpeed] = useState<'0.5' | '1' | '2' | '4'>('1');
  const [sound, setSound] = useState(false);
  const [auto, setAuto] = useState(false);
  const [classicReadout, setClassicReadout] = useState<ReturnType<ClassicApi['readout']> | null>(null);
  const [ftcReadout, setFtcReadout] = useState<ReturnType<FtcApi['readout']> | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const stream = useJobStream(jobId);

  // grab the iframe's FTB API once its game.js has booted. Re-runs whenever the
  // variant changes, since swapping the iframe src remounts a fresh page with
  // its own window.FTB.
  useEffect(() => {
    let stop = false;
    setReady(false);
    fbRef.current = null;
    ftcRef.current = null;
    const poll = () => {
      if (stop) return;
      const w = iframeRef.current?.contentWindow as (Window & { FTB?: ClassicApi | FtcApi }) | undefined;
      if (w?.FTB?.replay) {
        if (variant === 'findthecat') {
          const api2 = w.FTB as FtcApi;
          ftcRef.current = api2;
          api2.setSound(false);
        } else {
          const api1 = w.FTB as ClassicApi;
          fbRef.current = api1;
          api1.setSound(false);
        }
        setReady(true);
      } else {
        setTimeout(poll, 120);
      }
    };
    poll();
    return () => {
      stop = true;
    };
  }, [variant]);

  // live readout while previewing
  useEffect(() => {
    if (!ready) return;
    const t = setInterval(() => {
      if (variant === 'findthecat') {
        const r = ftcRef.current?.readout();
        if (r) {
          setFtcReadout(r);
          setSeed((s) => (document.activeElement === document.getElementById('fb-seed') ? s : r.seed));
        }
      } else {
        const r = fbRef.current?.readout();
        if (r) {
          setClassicReadout(r);
          setSeed((s) => (document.activeElement === document.getElementById('fb-seed') ? s : r.seed));
        }
      }
    }, 120);
    return () => clearInterval(t);
  }, [ready, variant]);

  const onVariant = (v: Variant) => {
    setVariant(v);
    setJobId(null);
    setRendering(false);
  };

  const doReplay = () => (variant === 'findthecat' ? ftcRef.current?.replay() : fbRef.current?.replay());
  const doAgain = () => (variant === 'findthecat' ? ftcRef.current?.again() : fbRef.current?.again());
  const doSetSeed = () => {
    if (seed <= 0) return;
    if (variant === 'findthecat') ftcRef.current?.replay(seed);
    else fbRef.current?.replay(seed);
  };
  const onMode = (m: string) => {
    setMode(m);
    fbRef.current?.setMode(m);
  };
  const onCups = (v: '3' | '4' | '5') => {
    setCupsState(v);
    ftcRef.current?.setCups(Number(v));
  };
  const onDifficulty = (v: 'easy' | 'medium' | 'hard') => {
    setDifficultyState(v);
    ftcRef.current?.setDifficulty(v);
  };
  const onTheme = (v: 'candy' | 'neon' | 'sunset') => {
    setThemeState(v);
    ftcRef.current?.setTheme(v);
  };
  const onRound = (v: '1' | '2' | '3' | '4' | '5') => {
    setRoundState(Number(v) as 1 | 2 | 3 | 4 | 5);
    ftcRef.current?.setRound(Number(v));
  };
  const onSpeed = (s: '0.5' | '1' | '2' | '4') => {
    setSpeed(s);
    (variant === 'findthecat' ? ftcRef.current : fbRef.current)?.setSpeed(Number(s));
  };
  const onSound = (v: boolean) => {
    setSound(v);
    (variant === 'findthecat' ? ftcRef.current : fbRef.current)?.setSound(v);
  };
  const onAuto = (v: boolean) => {
    setAuto(v);
    (variant === 'findthecat' ? ftcRef.current : fbRef.current)?.setAutoReplay(v);
  };

  const render = useCallback(async () => {
    setRendering(true);
    try {
      if (variant === 'findthecat') {
        const r = ftcRef.current?.readout();
        if (!r) {
          setRendering(false);
          return;
        }
        const { jobId: id } = await api.findTheCatRender(r.seed, r.cups, r.difficulty, r.round, r.theme);
        setJobId(id);
      } else {
        const r = fbRef.current?.readout();
        if (!r) {
          setRendering(false);
          return;
        }
        const { jobId: id } = await api.followballRender(r.seed, r.mode);
        setJobId(id);
      }
    } catch (e) {
      setRendering(false);
      alert('render failed: ' + (e as Error).message);
    }
  }, [variant]);

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
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <span className="text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
          Variant
        </span>
        <SegmentedControl<Variant>
          value={variant}
          onChange={onVariant}
          options={[
            { value: 'classic', label: 'Classic' },
            { value: 'findthecat', label: 'Find The Cat' },
          ]}
        />
      </div>

      <div className="grid gap-6 md:grid-cols-[minmax(0,300px)_1fr]">
        {/* ── live preview ── */}
        <div className="mx-auto w-full max-w-[300px]">
          <div className="relative aspect-[9/16] overflow-hidden rounded-[20px] border border-[color:var(--color-hairline-strong)] bg-black">
            <iframe
              ref={iframeRef}
              src={variant === 'findthecat' ? findthecatPreviewSrc : followballPreviewSrc}
              title={variant === 'findthecat' ? 'Find The Cat preview' : 'Follow The Ball preview'}
              className="absolute inset-0 h-full w-full border-0"
            />
            {!ready && (
              <div className="absolute inset-0 grid place-items-center text-[13px] text-[color:var(--color-muted)]">
                loading preview…
              </div>
            )}
          </div>
          <div className="mt-3 rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] px-3.5 py-3 text-[13px] tabular-nums">
            {variant === 'findthecat' ? (
              ftcReadout?.done ? (
                <span>
                  <b className="text-[color:var(--color-accent)]">Cup {ftcReadout.win}</b>
                </span>
              ) : ftcReadout ? (
                <span>
                  {ftcReadout.phase} · {ftcReadout.t.toFixed(1)}s / {ftcReadout.totalSec.toFixed(1)}s
                </span>
              ) : (
                '…'
              )
            ) : classicReadout?.done ? (
              <span>
                <b className="text-[color:var(--color-accent)]">Answers: {classicReadout.answers.join('  ')}</b>
              </span>
            ) : classicReadout ? (
              <span>
                Round <b>{classicReadout.round}/{classicReadout.rounds}</b> · {classicReadout.roundSec.toFixed(1)}s
                {classicReadout.answers.length > 0 && (
                  <span className="text-[color:var(--color-faint)]"> · so far {classicReadout.answers.join(' ')}</span>
                )}
              </span>
            ) : (
              '…'
            )}
            <div className="mt-0.5 text-[11px] text-[color:var(--color-faint)]">
              {variant === 'findthecat'
                ? `${ftcReadout?.difficulty ?? difficulty} · ${ftcReadout?.cups ?? cups} cups · seed ${ftcReadout?.seed ?? seed}`
                : `${classicReadout?.modeName ?? mode} · seed ${classicReadout?.seed ?? seed}`}
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
                  id="fb-seed"
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

            {variant === 'classic' ? (
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
                  Mode
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
            ) : (
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
                  Difficulty
                </span>
                <SegmentedControl<'easy' | 'medium' | 'hard'> value={difficulty} onChange={onDifficulty} options={FTC_DIFFS} />
              </label>
            )}
          </div>

          {variant === 'findthecat' && (
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
                  Cups
                </span>
                <SegmentedControl<'3' | '4' | '5'> value={cups} onChange={onCups} options={FTC_CUPS} />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
                  Theme
                </span>
                <SegmentedControl<'candy' | 'neon' | 'sunset'> value={theme} onChange={onTheme} options={FTC_THEMES} />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
                  Round label
                </span>
                <SegmentedControl<'1' | '2' | '3' | '4' | '5'>
                  value={String(round) as '1' | '2' | '3' | '4' | '5'}
                  onChange={onRound}
                  options={[
                    { value: '1', label: '1' },
                    { value: '2', label: '2' },
                    { value: '3', label: '3' },
                    { value: '4', label: '4' },
                    { value: '5', label: '5' },
                  ]}
                />
              </label>
            </div>
          )}

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
                  Full 4K render — takes ~3 minutes. Same output the pipeline produces.
                </p>
              </>
            )}

            {jobId && !done && !failed && (
              <div>
                <div className="mb-2 flex items-center justify-between text-[13px]">
                  <span>
                    Rendering seed <b className="tabular-nums">{variant === 'findthecat' ? ftcReadout?.seed : classicReadout?.seed}</b>
                    {variant === 'classic' ? ` (${mode})` : ` (${difficulty})`}…
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
