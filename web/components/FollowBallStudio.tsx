'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  candidatePreviewUrl,
  findthecatPreviewSrc,
  followballPreviewSrc,
  jobDownloadUrl,
  jobExtraUrl,
  type FindTheCatOptions,
} from '@/lib/api';
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

// Find The Cat is a real multi-round game — the user picks how many rounds
// (always starting at round 1) and difficulty escalates by round index
// inside game.js (easy, medium, hard, hard, ...). readout() reports the
// RESOLVED theme (e.g. "neon" when "Surprise me" is picked), so "render
// this seed" reproduces exactly what was previewed.
type FtcApi = {
  replay: (seed?: number | string) => void;
  again: () => void;
  setRounds: (n: number) => void;
  setTheme: (t: string) => void;
  setSpeed: (s: number) => void;
  setSound: (on: boolean) => void;
  setOptions: (o: Partial<{ hook: string; hookSec: number; label: string; twists: boolean }>) => void;
  setSafeZone: (on: boolean) => void;
  getSeed: () => number;
  readout: () => {
    seed: number; roundCount: number; round: number; cups: number; difficulty: string;
    theme: string; themeChoice: string; twist: string; backdrop?: string;
    phase: string; t: number; totalSec: number; win: number; done: boolean;
  };
};

type FtcTheme = 'random' | 'candy' | 'neon' | 'sunset' | 'colorblind';
type LengthChoice = 'short' | 'long' | 'custom';
type RoundsStr = '1' | '2' | '3' | '4' | '5' | '6';

const MODES = [
  { id: 'sprint', label: 'Sprint · 3 rounds · ~18s' },
  { id: 'classic', label: 'Classic · 5 rounds · ~40s' },
  { id: 'insane', label: 'Insane · 5 rounds · brutal' },
  { id: 'random', label: 'Surprise me' },
];

const FTC_THEMES: Array<{ id: FtcTheme; label: string }> = [
  { id: 'random', label: 'Surprise me (varies per video)' },
  { id: 'candy', label: 'Candy' },
  { id: 'neon', label: 'Neon' },
  { id: 'sunset', label: 'Sunset' },
  { id: 'colorblind', label: 'Colorblind safe' },
];
// short = 1 round (~19s), long = 4 rounds (~75s, always over 60s)
const LENGTH_ROUNDS: Record<Exclude<LengthChoice, 'custom'>, number> = { short: 1, long: 4 };

const labelCls = 'mb-1.5 block text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]';
const selectCls =
  'h-9 w-full rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] px-2 text-[14px]';

type BatchRow = { jobId: string; status: string; reason?: string };

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
  const [speed, setSpeed] = useState<'0.5' | '1' | '2' | '4'>('1');
  const [sound, setSound] = useState(false);
  const [auto, setAuto] = useState(false);

  // Find The Cat options
  const [lengthChoice, setLengthChoice] = useState<LengthChoice>('custom');
  const [rounds, setRoundsState] = useState(3);
  const [theme, setThemeState] = useState<FtcTheme>('random');
  const [hook, setHook] = useState('FIND THE CAT');
  const [hookSec, setHookSec] = useState<'1' | '2' | '3'>('2');
  const [label, setLabel] = useState('');
  const [twists, setTwists] = useState(true);
  const [safeZone, setSafeZone] = useState(false);
  const [batchCount, setBatchCount] = useState('3');
  const [batch, setBatch] = useState<BatchRow[]>([]);
  const [batching, setBatching] = useState(false);

  const [classicReadout, setClassicReadout] = useState<ReturnType<ClassicApi['readout']> | null>(null);
  const [ftcReadout, setFtcReadout] = useState<ReturnType<FtcApi['readout']> | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const stream = useJobStream(jobId);

  // latest Find The Cat settings, for re-applying after the iframe reloads
  const ftcState = useRef({ rounds, theme, hook, hookSec, label, twists, safeZone });
  ftcState.current = { rounds, theme, hook, hookSec, label, twists, safeZone };

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
      const w = iframeRef.current?.contentWindow as (Window & { FTB?: Partial<ClassicApi & FtcApi> }) | undefined;
      const ftb = w?.FTB;
      // Switching variants swaps the iframe's src, but contentWindow briefly
      // still points at the OLD document until it finishes navigating -- its
      // FTB also has `.replay`, so without this shape check we can grab the
      // wrong game's API mid-switch (readout() shapes differ: classic has no
      // `.t`, findthecat has no `.mode`) and crash on the first poll tick.
      const isFindTheCat = typeof ftb?.setTheme === 'function';
      if (ftb?.replay && isFindTheCat === (variant === 'findthecat')) {
        if (variant === 'findthecat') {
          const api2 = ftb as FtcApi;
          ftcRef.current = api2;
          api2.setSound(false);
          const st = ftcState.current;
          api2.setOptions({ hook: st.hook, hookSec: Number(st.hookSec), label: st.label, twists: st.twists });
          api2.setSafeZone(st.safeZone);
          if (st.theme !== 'random') api2.setTheme(st.theme);
          if (st.rounds !== 3) api2.setRounds(st.rounds);
        } else {
          const api1 = ftb as ClassicApi;
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

  // batch job statuses
  useEffect(() => {
    if (!batch.length || batch.every((b) => b.status === 'awaiting_review' || b.status === 'failed')) return;
    const t = setInterval(async () => {
      const next = await Promise.all(
        batch.map(async (b) => {
          if (b.status === 'awaiting_review' || b.status === 'failed') return b;
          try {
            const { job } = await api.getJob(b.jobId);
            return { jobId: b.jobId, status: job.status, reason: job.candidates?.[0]?.reason ?? job.errorMessage ?? undefined };
          } catch {
            return b;
          }
        }),
      );
      setBatch(next);
    }, 3000);
    return () => clearInterval(t);
  }, [batch]);

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
  const onTheme = (v: FtcTheme) => {
    setThemeState(v);
    ftcRef.current?.setTheme(v);
  };
  const applyRounds = (n: number) => {
    setRoundsState(n);
    ftcRef.current?.setRounds(n);
  };
  const onLength = (v: LengthChoice) => {
    setLengthChoice(v);
    if (v === 'custom') {
      if (rounds === 1 || rounds === 4) applyRounds(3);
    } else {
      applyRounds(LENGTH_ROUNDS[v]);
    }
  };
  const onRounds = (v: RoundsStr) => applyRounds(Number(v));
  const onHook = (v: string) => {
    setHook(v);
    ftcRef.current?.setOptions({ hook: v });
  };
  const onHookSec = (v: '1' | '2' | '3') => {
    setHookSec(v);
    ftcRef.current?.setOptions({ hookSec: Number(v) });
  };
  const onLabel = (v: string) => {
    setLabel(v);
    ftcRef.current?.setOptions({ label: v });
  };
  const onTwists = (v: boolean) => {
    setTwists(v);
    ftcRef.current?.setOptions({ twists: v });
  };
  const onSafeZone = (v: boolean) => {
    setSafeZone(v);
    ftcRef.current?.setSafeZone(v);
  };
  const onSpeed = (s: '0.5' | '1' | '2' | '4') => {
    setSpeed(s);
    (variant === 'findthecat' ? ftcRef.current : fbRef.current)?.setSpeed(Number(s));
  };
  const onSound = (v: boolean) => {
    setSound(v);
    (variant === 'findthecat' ? ftcRef.current : fbRef.current)?.setSound(v);
  };
  // classic only -- findthecat always auto-loops into a fresh video on its own
  const onAuto = (v: boolean) => {
    setAuto(v);
    fbRef.current?.setAutoReplay(v);
  };

  const ftcOptions = (themeValue: string): FindTheCatOptions => ({
    rounds, theme: themeValue, hook, hookSec: Number(hookSec), label, twists,
  });

  const render = useCallback(async () => {
    setRendering(true);
    try {
      if (variant === 'findthecat') {
        const r = ftcRef.current?.readout();
        if (!r) {
          setRendering(false);
          return;
        }
        // the RESOLVED theme, so "Surprise me" renders exactly what was shown
        const { jobId: id } = await api.findTheCatRender(r.seed, { ...ftcOptions(r.theme), rounds: r.roundCount });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, rounds, hook, hookSec, label, twists]);

  const renderBatch = async () => {
    setBatching(true);
    try {
      // the CHOSEN theme (not the resolved one): "Surprise me" lets every
      // variant pick its own look, steered away from the last 10 renders
      const { jobIds } = await api.findTheCatBatch(Number(batchCount), ftcOptions(theme));
      setBatch(jobIds.map((id) => ({ jobId: id, status: 'queued' })));
    } catch (e) {
      alert('batch failed: ' + (e as Error).message);
    } finally {
      setBatching(false);
    }
  };

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

  const extraLinks = (id: string) => (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
      <a className="text-[color:var(--color-accent)] hover:underline" href={jobDownloadUrl(id, 0)} download>
        ⤓ Video (full audio)
      </a>
      <a className="text-[color:var(--color-accent)] hover:underline" href={jobExtraUrl(id, 'sfx.0.mp4')} download>
        ⤓ SFX-only version
      </a>
      <a className="text-[color:var(--color-accent)] hover:underline" href={jobExtraUrl(id, 'cover.0.png')} download>
        ⤓ Cover image
      </a>
      <a className="text-[color:var(--color-accent)] hover:underline" href={jobExtraUrl(id, 'postkit.0.txt')} download>
        ⤓ Post kit (.txt)
      </a>
    </div>
  );

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
                  Round <b>{ftcReadout.round}/{ftcReadout.roundCount}</b> · {ftcReadout.phase} · {ftcReadout.t.toFixed(1)}s / {ftcReadout.totalSec.toFixed(1)}s
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
                ? `${ftcReadout?.difficulty ?? ''} · ${ftcReadout?.cups ?? ''} cups · ${ftcReadout?.theme ?? ''} · twist ${ftcReadout?.twist ?? 'none'} · seed ${ftcReadout?.seed ?? seed}`
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
              <span className={labelCls}>Seed</span>
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
                <span className={labelCls}>Mode</span>
                <select value={mode} onChange={(e) => onMode(e.target.value)} disabled={!ready} className={selectCls}>
                  {MODES.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="block">
                <span className={labelCls}>Theme</span>
                <select value={theme} onChange={(e) => onTheme(e.target.value as FtcTheme)} disabled={!ready} className={selectCls}>
                  {FTC_THEMES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {variant === 'findthecat' && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className={labelCls}>Length</span>
                  <SegmentedControl<LengthChoice>
                    value={lengthChoice}
                    onChange={onLength}
                    options={[
                      { value: 'short', label: 'Short ~19s' },
                      { value: 'long', label: 'Long ~75s' },
                      { value: 'custom', label: 'Custom' },
                    ]}
                  />
                </label>
                {lengthChoice === 'custom' && (
                  <label className="block">
                    <span className={labelCls}>Rounds — easy, then medium, then hard</span>
                    <SegmentedControl<RoundsStr>
                      value={String(rounds) as RoundsStr}
                      onChange={onRounds}
                      options={(['1', '2', '3', '4', '5', '6'] as RoundsStr[]).map((v) => ({ value: v, label: v }))}
                    />
                  </label>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
                <label className="block">
                  <span className={labelCls}>Hook text (frame 1)</span>
                  <TextInput value={hook} maxLength={28} onChange={(e) => onHook(e.target.value)} />
                </label>
                <label className="block">
                  <span className={labelCls}>Hook stays up</span>
                  <SegmentedControl<'1' | '2' | '3'>
                    value={hookSec}
                    onChange={onHookSec}
                    options={[
                      { value: '1', label: '1s' },
                      { value: '2', label: '2s' },
                      { value: '3', label: '3s' },
                    ]}
                  />
                </label>
              </div>

              <label className="block">
                <span className={labelCls}>Series label (optional)</span>
                <TextInput value={label} maxLength={40} placeholder="e.g. Find The Cat S1 E3" onChange={(e) => onLabel(e.target.value)} />
              </label>
            </>
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
            {variant === 'classic' && <Toggle checked={auto} onChange={onAuto} label="Auto-reroll" />}
            {variant === 'findthecat' && <Toggle checked={twists} onChange={onTwists} label="Twists" />}
            {variant === 'findthecat' && <Toggle checked={safeZone} onChange={onSafeZone} label="Show safe zone" />}
          </div>

          <div className="rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-4">
            {!jobId && (
              <>
                <Button variant="primary" size="lg" onClick={render} loading={rendering} disabled={!ready} className="w-full">
                  ▶ Render this seed
                </Button>
                <p className="mt-2 text-[12px] text-[color:var(--color-faint)]">
                  Full 4K render — takes a few minutes. Same output the pipeline produces.
                </p>
              </>
            )}

            {jobId && !done && !failed && (
              <div>
                <div className="mb-2 flex items-center justify-between text-[13px]">
                  <span>
                    Rendering seed <b className="tabular-nums">{variant === 'findthecat' ? ftcReadout?.seed : classicReadout?.seed}</b>
                    {variant === 'classic' ? ` (${mode})` : ` (${ftcReadout?.roundCount} rounds)`}…
                  </span>
                  <span className="tabular-nums text-[color:var(--color-muted)]">{Math.round(renderPct * 100)}%</span>
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
                {variant === 'findthecat' && extraLinks(jobId!)}
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
                {stream.review.draftText?.pinnedComment && (
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
                        Pinned comment
                      </span>
                      <button
                        className="text-[12px] text-[color:var(--color-accent)] hover:underline"
                        onClick={() => navigator.clipboard?.writeText(stream.review!.draftText!.pinnedComment!)}
                      >
                        copy
                      </button>
                    </div>
                    <pre className="whitespace-pre-wrap rounded-[10px] border border-[color:var(--color-hairline)] bg-[color:var(--color-bg)] p-3 text-[13px] leading-relaxed">
                      {stream.review.draftText.pinnedComment}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>

          {variant === 'findthecat' && (
            <div className="rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-4">
              <div className="flex flex-wrap items-end gap-3">
                <label className="block">
                  <span className={labelCls}>Batch</span>
                  <select value={batchCount} onChange={(e) => setBatchCount(e.target.value)} className={`${selectCls} w-24`}>
                    {['2', '3', '5', '10'].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <Button variant="secondary" onClick={renderBatch} loading={batching}>
                  ▶ Render {batchCount} variants
                </Button>
              </div>
              <p className="mt-2 text-[12px] text-[color:var(--color-faint)]">
                Fresh seeds with these settings. Each video&apos;s look (palette, backdrop, cup count) is steered away from
                anything used in the last 10 renders. They render one after another.
              </p>
              {batch.length > 0 && (
                <ul className="mt-3 space-y-3">
                  {batch.map((b, i) => (
                    <li key={b.jobId} className="text-[13px]">
                      <div>
                        <b>#{i + 1}</b> <span className="text-[color:var(--color-muted)]">{b.status.replace('_', ' ')}</span>
                        {b.reason && <span className="text-[color:var(--color-faint)]"> · {b.reason}</span>}
                      </div>
                      {b.status === 'awaiting_review' && extraLinks(b.jobId)}
                    </li>
                  ))}
                </ul>
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
