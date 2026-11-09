'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, candidatePreviewUrl, jobDownloadUrl, laserDuelPreviewSrc } from '@/lib/api';
import { useJobStream } from '@/lib/useJobStream';
import { Button, Select } from '@/components/ui';

type Winner = 'A' | 'B' | 'random';

type LNApi = {
  restart: () => void;
  duel: boolean;
  countryList: () => string[];
  getMatchup: () => { a: string; b: string } | null;
  setMatchup: (a: string, b: string) => void;
  // read-only live sim state — used only to show a "how long is this fight
  // so far / how long did it end up" stopwatch in the STUDIO. Nothing here
  // ever gets drawn into the actual video (the on-screen clock was removed
  // from the render on purpose — this is for your eyes only, while building).
  game: { t: number; state: string; finishAt: number } | null;
};

/**
 * Laser Nations: Duel — the 1v1 fight mode's preview studio. Pick two
 * fighters (or randomize the matchup), preview the feel live, then either
 * render that exact preview (only possible when you're leaving the winner
 * to chance) or kick off a search-and-render for a chosen winner — that
 * always needs its own server-side search, so the live preview can't show
 * the exact outcome in advance. It never *looks* decided though: the sim
 * itself has no idea who's supposed to win, the search just keeps whichever
 * random seed happened to produce that outcome with a genuinely close,
 * back-and-forth fight. No length control either way — a fight has no fixed
 * duration, it always runs until a fighter hits 0 hp.
 */
export function LaserNationsStudio() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const lnRef = useRef<LNApi | null>(null);
  const [ready, setReady] = useState(false);
  const [countries, setCountries] = useState<string[]>([]);

  const [nationA, setNationA] = useState('');
  const [nationB, setNationB] = useState('');
  const [winner, setWinner] = useState<Winner>('random');
  const [fightTime, setFightTime] = useState<{ sec: number; final: boolean } | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const stream = useJobStream(jobId);

  const ln = () => lnRef.current;

  useEffect(() => {
    let stop = false;
    const poll = () => {
      if (stop) return;
      const w = iframeRef.current?.contentWindow as (Window & { LaserNations?: LNApi }) | undefined;
      if (w?.LaserNations?.duel) {
        lnRef.current = w.LaserNations;
        const list = w.LaserNations.countryList();
        setCountries(list);
        const m = w.LaserNations.getMatchup();
        if (m) { setNationA(m.a); setNationB(m.b); }
        setReady(true);
      } else {
        setTimeout(poll, 120);
      }
    };
    poll();
    return () => { stop = true; };
  }, []);

  // a stopwatch for YOU while previewing — never baked into the render.
  useEffect(() => {
    if (!ready) return;
    const t = setInterval(() => {
      const g = ln()?.game;
      if (!g) return;
      const over = g.state === 'over';
      setFightTime({ sec: over ? g.finishAt : g.t, final: over });
    }, 150);
    return () => clearInterval(t);
  }, [ready]);

  const applyMatchup = (a: string, b: string) => {
    setNationA(a); setNationB(b);
    ln()?.setMatchup(a, b);
  };
  const onNationA = (v: string) => applyMatchup(v, nationB === v ? '' : nationB);
  const onNationB = (v: string) => applyMatchup(nationA === v ? '' : nationA, v);
  const randomize = () => {
    if (countries.length < 2) return;
    const i = Math.floor(Math.random() * countries.length);
    let j = Math.floor(Math.random() * countries.length);
    while (j === i) j = Math.floor(Math.random() * countries.length);
    applyMatchup(countries[i]!, countries[j]!);
  };
  const replay = () => ln()?.restart();

  // rendering a preview-faithful seed is only honest when nothing needs a
  // server-side search — i.e. the winner is left to chance. Otherwise the
  // button explicitly searches instead.
  const needsSearch = winner !== 'random';

  const render = useCallback(async () => {
    setRendering(true);
    try {
      const { jobId: id } = await api.laserDuelRender({ nationA, nationB, winner });
      setJobId(id);
    } catch (e) {
      setRendering(false);
      alert('render failed: ' + (e as Error).message);
    }
  }, [nationA, nationB, winner]);

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
            src={laserDuelPreviewSrc}
            title="Laser Nations Duel preview"
            className="absolute inset-0 h-full w-full border-0"
          />
          {!ready && (
            <div className="absolute inset-0 grid place-items-center text-[13px] text-[color:var(--color-muted)]">
              loading preview…
            </div>
          )}
        </div>
        <p className="mt-3 text-center text-[12px] text-[color:var(--color-faint)]">
          {needsSearch
            ? 'Preview shows the feel — the real render searches for your chosen outcome.'
            : 'What you see here is exactly what renders.'}
        </p>
        {fightTime && (
          <p className="mt-1 text-center text-[13px] tabular-nums text-[color:var(--color-muted)]">
            ⏱ {fightTime.sec.toFixed(1)}s{fightTime.final ? ' — final fight length' : ' so far'}
            <span className="block text-[11px] text-[color:var(--color-faint)]">(for you only — never shown in the actual video)</span>
          </p>
        )}
      </div>

      {/* ── controls + output ── */}
      <div className="space-y-6">
        <div className="rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
              Matchup
            </span>
            <button className="text-[12px] text-[color:var(--color-accent)] hover:underline disabled:opacity-40" onClick={randomize} disabled={!ready}>
              🎲 random matchup
            </button>
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
            <Select value={nationA} onChange={(e) => onNationA(e.target.value)} disabled={!ready} className="h-10">
              {countries.map((c) => (
                <option key={c} value={c} disabled={c === nationB}>{c}</option>
              ))}
            </Select>
            <span className="text-[13px] font-bold text-[color:var(--color-faint)]">VS</span>
            <Select value={nationB} onChange={(e) => onNationB(e.target.value)} disabled={!ready} className="h-10">
              {countries.map((c) => (
                <option key={c} value={c} disabled={c === nationA}>{c}</option>
              ))}
            </Select>
          </div>
          <Button variant="secondary" onClick={replay} disabled={!ready} className="mt-3 w-full">
            ↻ Replay this matchup
          </Button>
        </div>

        <div className="rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-4">
          <span className="mb-3 block text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
            Who wins
          </span>
          <div className="grid grid-cols-3 gap-2">
            {([
              { v: 'A' as Winner, label: nationA || 'Fighter A' },
              { v: 'random' as Winner, label: 'Let it play out' },
              { v: 'B' as Winner, label: nationB || 'Fighter B' },
            ]).map((o) => (
              <button
                key={o.v}
                onClick={() => setWinner(o.v)}
                className={`truncate rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium transition-colors ${
                  winner === o.v
                    ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent-hover)]'
                    : 'border-[color:var(--color-hairline-strong)] text-[color:var(--color-muted)] hover:border-[color:var(--color-muted)]'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-[color:var(--color-faint)]">
            The fight itself never knows the outcome in advance — a forced winner just keeps searching random attempts until one plays out as a real, close comeback win for them.
          </p>
        </div>

        <div className="rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-4">
          {!jobId && (
            <>
              <Button variant="primary" size="lg" onClick={render} loading={rendering} disabled={!ready} className="w-full">
                {needsSearch ? '🔎 Search & render' : '▶ Render this preview'}
              </Button>
              <p className="mt-2 text-[12px] text-[color:var(--color-faint)]">
                Full 4K render with a fight-poster thumbnail — takes ~3 minutes{needsSearch ? ' (plus a quick search first)' : ''}.
              </p>
            </>
          )}

          {jobId && !done && !failed && (
            <div>
              <div className="mb-2 flex items-center justify-between text-[13px]">
                <span>Rendering {nationA || '?'} vs {nationB || '?'}…</span>
                <span className="tabular-nums text-[color:var(--color-muted)]">{Math.round(renderPct * 100)}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-[color:var(--color-hairline)]">
                <div className="h-full rounded-full bg-[color:var(--color-accent)] transition-[width]" style={{ width: `${renderPct * 100}%` }} />
              </div>
              <p className="mt-2 text-[12px] text-[color:var(--color-faint)]">
                {stream.steps.render?.detail ?? 'searching for a seed, rendering frames, scoring the sound, compositing 4K'}
              </p>
              <button
                className="mt-3 text-[12px] text-[color:var(--color-muted)] underline hover:text-[color:var(--color-text)]"
                onClick={() => { if (jobId) void api.cancelJob(jobId); setJobId(null); setRendering(false); }}
              >
                cancel
              </button>
            </div>
          )}

          {failed && (
            <div className="text-[13px] text-[color:var(--color-danger)]">
              Render failed{stream.error ? `: ${stream.error.message}` : ''}.{' '}
              <button className="underline" onClick={() => setJobId(null)}>try again</button>
            </div>
          )}

          {done && stream.review && (
            <div className="space-y-4">
              <video
                src={candidatePreviewUrl(jobId!, 0)}
                controls loop autoPlay muted playsInline
                className="mx-auto max-h-[62dvh] rounded-[12px] bg-black"
              />
              <div className="flex flex-wrap gap-3">
                <a href={jobDownloadUrl(jobId!, 0)} download>
                  <Button variant="primary" size="lg">⤓ Download to your computer</Button>
                </a>
                <Button variant="secondary" onClick={() => setJobId(null)}>Render another</Button>
              </div>
              {stream.review.draftText?.caption && (
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">Caption</span>
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
