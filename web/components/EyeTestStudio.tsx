'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, candidatePreviewUrl, eyetestPreviewSrc, jobDownloadUrl } from '@/lib/api';
import { useJobStream } from '@/lib/useJobStream';
import { Button, SegmentedControl, TextInput, Toggle } from '@/components/ui';

type ETApi = {
  replay: (seed?: number | string) => void;
  again: () => void;
  setPlan: (ballsPerRound: number[], shuffleSec: number) => void;
  setSpeed: (s: number) => void;
  setSound: (on: boolean) => void;
  setAutoReplay: (on: boolean) => void;
  revealNow: () => void;
  getSeed: () => number;
  getPlan: () => { balls: number[]; shuffleSec: number };
  readout: () => {
    seed: number; rounds: number; ballsPerRound: number[]; shuffleSec: number;
    round: number; phase: string; answers: number[]; done: boolean; roundSec: number;
  };
};

const MIN_ROUNDS = 1, MAX_ROUNDS = 6;
const MIN_BALLS = 4, MAX_BALLS = 10;
const MIN_SHUFFLE = 3, MAX_SHUFFLE = 15;
const clampBalls = (n: number) => Math.max(MIN_BALLS, Math.min(MAX_BALLS, Math.round(n) || MIN_BALLS));
const clampShuffle = (n: number) => Math.max(MIN_SHUFFLE, Math.min(MAX_SHUFFLE, n || MIN_SHUFFLE));
// mirrors game.js's estimateDurationSec(): 7.35s of fixed beats/round (3s
// lock-in + 0.25s flash + 2.6s freeze-hold + 1.5s reveal-hold) + the
// shuffle, then a one-time 3.5s score card + 1s render-completion buffer.
const estimateSec = (balls: number[], shuffleSec: number) => balls.length * (7.35 + shuffleSec) + 4.5;

/**
 * The Eye Test preview studio — a deterministic <iframe> preview you can
 * reroll until you like a run, then render that exact seed + round plan
 * through the full pipeline (TikTok-safe framing, sound, caption) and
 * download the mp4. Rendered both on the dashboard (when "Eye test" is the
 * content type) and at /eyetest.
 *
 * No preset modes — you author the plan directly: how many rounds, how many
 * balls in each one, and how long the real-physics shuffle runs (shared by
 * every round).
 */
export function EyeTestStudio() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const etRef = useRef<ETApi | null>(null);
  const [ready, setReady] = useState(false);

  const [seed, setSeed] = useState(0);
  const [ballsPerRound, setBallsPerRound] = useState<number[]>([8, 8, 8]);
  const [shuffleSec, setShuffleSec] = useState(6);
  const [speed, setSpeed] = useState<'0.5' | '1' | '2' | '4'>('1');
  const [sound, setSound] = useState(false);
  const [auto, setAuto] = useState(false);
  const [readout, setReadout] = useState<ReturnType<ETApi['readout']> | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const stream = useJobStream(jobId);

  // grab the iframe's ET API once game.js has booted
  useEffect(() => {
    let stop = false;
    const poll = () => {
      if (stop) return;
      const w = iframeRef.current?.contentWindow as (Window & { ET?: ETApi }) | undefined;
      if (w?.ET?.replay) {
        etRef.current = w.ET;
        w.ET.setSound(false);
        setReady(true);
        setSeed(w.ET.getSeed());
        const p = w.ET.getPlan();
        setBallsPerRound(p.balls);
        setShuffleSec(p.shuffleSec);
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
      const r = etRef.current?.readout();
      if (r) {
        setReadout(r);
        setSeed((s) => (document.activeElement === document.getElementById('et-seed') ? s : r.seed));
      }
    }, 120);
    return () => clearInterval(t);
  }, [ready]);

  const et = () => etRef.current;
  const doReplay = () => et()?.replay();
  const doAgain = () => et()?.again();
  const doReveal = () => et()?.revealNow();
  const doSetSeed = () => {
    if (seed > 0) et()?.replay(seed);
  };
  const applyPlan = (balls: number[], sec: number) => {
    setBallsPerRound(balls);
    setShuffleSec(sec);
    et()?.setPlan(balls, sec);
  };
  const setRoundBalls = (i: number, n: number) => {
    const next = ballsPerRound.slice();
    next[i] = n;
    setBallsPerRound(next);
  };
  const addRound = () => {
    if (ballsPerRound.length >= MAX_ROUNDS) return;
    setBallsPerRound([...ballsPerRound, 8]);
  };
  const removeRound = (i: number) => {
    if (ballsPerRound.length <= MIN_ROUNDS) return;
    setBallsPerRound(ballsPerRound.filter((_, k) => k !== i));
  };
  const randomizePlan = () => {
    const n = MIN_ROUNDS + Math.floor(Math.random() * (4 - MIN_ROUNDS + 1)); // 1-4 rounds, keeps it watchable
    const balls = Array.from({ length: n }, () => clampBalls(MIN_BALLS + Math.floor(Math.random() * (MAX_BALLS - MIN_BALLS + 1))));
    const sec = clampShuffle(MIN_SHUFFLE + Math.floor(Math.random() * (MAX_SHUFFLE - MIN_SHUFFLE + 1)));
    applyPlan(balls, sec);
  };
  const onSpeed = (s: '0.5' | '1' | '2' | '4') => {
    setSpeed(s);
    et()?.setSpeed(Number(s));
  };
  const onSound = (v: boolean) => {
    setSound(v);
    et()?.setSound(v);
  };
  const onAuto = (v: boolean) => {
    setAuto(v);
    et()?.setAutoReplay(v);
  };

  const render = useCallback(async () => {
    const r = et()?.readout();
    if (!r) return;
    setRendering(true);
    try {
      const { jobId: id } = await api.eyetestRender(r.seed, r.ballsPerRound, r.shuffleSec);
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

  const planDirty = readout ? JSON.stringify(readout.ballsPerRound) !== JSON.stringify(ballsPerRound) || readout.shuffleSec !== shuffleSec : false;

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,300px)_1fr]">
      {/* ── live preview ── */}
      <div className="mx-auto w-full max-w-[300px]">
        <div className="relative aspect-[9/16] overflow-hidden rounded-[20px] border border-[color:var(--color-hairline-strong)] bg-black">
          <iframe
            ref={iframeRef}
            src={eyetestPreviewSrc}
            title="Eye Test preview"
            className="absolute inset-0 h-full w-full border-0"
          />
          {!ready && (
            <div className="absolute inset-0 grid place-items-center text-[13px] text-[color:var(--color-muted)]">
              loading preview…
            </div>
          )}
        </div>
        <div className="mt-3 rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] px-3.5 py-3 text-[13px] tabular-nums">
          {readout?.done ? (
            <span>
              <b style={{ color: '#ffd700' }}>Answers: {readout.answers.join('  ')}</b>
            </span>
          ) : readout ? (
            <span>
              Round <b>{readout.round}/{readout.rounds}</b> · {readout.roundSec.toFixed(1)}s
              {readout.answers.length > 0 && (
                <span className="text-[color:var(--color-faint)]"> · so far {readout.answers.join(' ')}</span>
              )}
            </span>
          ) : (
            '…'
          )}
          <div className="mt-0.5 text-[11px] text-[color:var(--color-faint)]">
            seed {readout?.seed ?? seed} · {(readout?.ballsPerRound ?? ballsPerRound).join(',')} balls · {readout?.shuffleSec ?? shuffleSec}s shuffle
          </div>
        </div>
        <Button
          variant="secondary"
          onClick={doReveal}
          disabled={!ready || readout?.phase !== 'freeze'}
          className="mt-2 w-full"
          style={{ color: '#ffd700', borderColor: 'rgba(255,215,0,.4)' }}
          title="Flash the true target back to gold — for recording the answer key"
        >
          👁 Reveal answer now
        </Button>
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

        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
            Seed
          </span>
          <div className="flex gap-2 sm:max-w-[240px]">
            <TextInput
              id="et-seed"
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

        {/* ── round plan — the whole point of this rewrite: author your own
            rounds, balls per round, and shuffle length instead of a preset ── */}
        <div className="rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
              Round plan
            </span>
            <button
              className="text-[12px] text-[color:var(--color-accent)] hover:underline disabled:opacity-40"
              onClick={randomizePlan}
              disabled={!ready}
            >
              🎲 randomize
            </button>
          </div>

          <div className="space-y-2">
            {ballsPerRound.map((n, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-[13px] text-[color:var(--color-muted)]">Round {i + 1}</span>
                <input
                  type="range"
                  min={MIN_BALLS}
                  max={MAX_BALLS}
                  value={n}
                  onChange={(e) => setRoundBalls(i, clampBalls(Number(e.target.value)))}
                  className="h-1.5 flex-1 accent-[color:var(--color-accent)]"
                />
                <span className="w-16 shrink-0 text-right text-[13px] tabular-nums">{n} balls</span>
                <button
                  className="text-[color:var(--color-faint)] hover:text-[color:var(--color-danger)] disabled:opacity-25"
                  onClick={() => removeRound(i)}
                  disabled={ballsPerRound.length <= MIN_ROUNDS}
                  title="Remove this round"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <button
            className="mt-3 text-[12px] text-[color:var(--color-accent)] hover:underline disabled:opacity-40 disabled:no-underline"
            onClick={addRound}
            disabled={ballsPerRound.length >= MAX_ROUNDS}
          >
            + add round{ballsPerRound.length >= MAX_ROUNDS ? ` (max ${MAX_ROUNDS})` : ''}
          </button>

          <div className="mt-4 flex items-center gap-3 border-t border-[color:var(--color-hairline)] pt-4">
            <span className="text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
              Mix (every round)
            </span>
            <input
              type="range"
              min={MIN_SHUFFLE}
              max={MAX_SHUFFLE}
              value={shuffleSec}
              onChange={(e) => setShuffleSec(clampShuffle(Number(e.target.value)))}
              className="h-1.5 flex-1 accent-[color:var(--color-accent)]"
            />
            <span className="w-20 shrink-0 text-right text-[13px] tabular-nums">{shuffleSec}s shuffle</span>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <span className="text-[12px] text-[color:var(--color-faint)]">
              ≈ {estimateSec(ballsPerRound, shuffleSec).toFixed(0)}s total · {ballsPerRound.length} round{ballsPerRound.length > 1 ? 's' : ''}
            </span>
            <Button variant="primary" onClick={() => applyPlan(ballsPerRound, shuffleSec)} disabled={!ready || !planDirty}>
              Apply plan
            </Button>
          </div>
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
                  Rendering seed <b className="tabular-nums">{readout?.seed}</b> ({readout?.rounds ?? ballsPerRound.length} round{(readout?.rounds ?? ballsPerRound.length) > 1 ? 's' : ''})…
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
