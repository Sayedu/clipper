'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, candidatePreviewUrl, jobDownloadUrl } from '@/lib/api';
import { useJobStream } from '@/lib/useJobStream';
import { Button, TextInput } from '@/components/ui';
import { COLOR_DOTS, COLOR_NAMES, type ColorWarSeason, type ColorWarSeasonEpisode } from '@/lib/types';

const MIN_EPISODES = 8;
const MAX_EPISODES = 30;
const MIN_PER_EPISODE = 4; // matches the studio's own "~4 minutes" render estimate

function fmtEta(episodes: number): string {
  const mins = episodes * MIN_PER_EPISODE;
  if (mins < 60) return `~${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `~${h}h${m ? ` ${m}m` : ''}`;
}

function badge(text: string, color: string) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{ background: `${color}22`, color }}
    >
      {text}
    </span>
  );
}

const STATUS_LABEL: Record<ColorWarSeasonEpisode['status'], string> = {
  planned: 'Planned', searching: 'Finding a seed…', queued: 'Queued',
  rendering: 'Rendering…', done: 'Done', failed: 'Failed',
};
const STATUS_COLOR: Record<ColorWarSeasonEpisode['status'], string> = {
  planned: 'var(--color-faint)', searching: 'var(--color-accent)', queued: 'var(--color-muted)',
  rendering: 'var(--color-accent)', done: 'var(--color-ok)', failed: 'var(--color-danger)',
};

/**
 * Color War Season Mode: plan a whole season's episode outcomes (every episode
 * a nail-biter or a comeback, standings tight until the last couple), review
 * the plan, then render every episode back-to-back. Lives at /colorwar-season,
 * alongside (not instead of) the single-video ColorWarStudio.
 */
export function ColorWarSeasonStudio() {
  const [phase, setPhase] = useState<'form' | 'plan' | 'progress'>('form');
  const [seasonNumber, setSeasonNumber] = useState(1);
  const [totalEpisodes, setTotalEpisodes] = useState(12);
  const [season, setSeason] = useState<ColorWarSeason | null>(null);
  const [busy, setBusy] = useState<'plan' | 'reroll' | 'confirm' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Test Mode — a single sample episode, no season attached ──
  const [testJobId, setTestJobId] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const testStream = useJobStream(testJobId);
  const testDone = testStream.jobStatus === 'awaiting_review' && testStream.review;
  const testFailed = testStream.jobStatus === 'failed';
  useEffect(() => {
    if (testDone || testFailed) setTestBusy(false);
  }, [testDone, testFailed]);
  const runTest = useCallback(async () => {
    setTestBusy(true);
    setTestJobId(null);
    try {
      const { jobId } = await api.colorwarEpisodeTest();
      setTestJobId(jobId);
    } catch (e) {
      setTestBusy(false);
      alert('test episode failed: ' + (e as Error).message);
    }
  }, []);

  const planSeason = useCallback(async () => {
    setBusy('plan');
    setError(null);
    try {
      const { season: s } = await api.createColorWarSeason(seasonNumber, totalEpisodes);
      setSeason(s);
      setPhase('plan');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [seasonNumber, totalEpisodes]);

  const reroll = useCallback(async () => {
    if (!season) return;
    setBusy('reroll');
    setError(null);
    try {
      setSeason((await api.rerollColorWarSeasonPlan(season.id)).season);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [season]);

  const confirm = useCallback(async () => {
    if (!season) return;
    setBusy('confirm');
    setError(null);
    try {
      const { season: s } = await api.confirmColorWarSeason(season.id);
      setSeason(s);
      setPhase('progress');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [season]);

  const cancelAll = useCallback(async () => {
    if (!season) return;
    setBusy('cancel');
    try {
      setSeason((await api.cancelColorWarSeason(season.id)).season);
    } finally {
      setBusy(null);
    }
  }, [season]);

  // poll the season's coarse progress while episodes render — one small GET
  // every few seconds is plenty; the currently-rendering episode gets its own
  // fine-grained live stream below via useJobStream, same hook the single-clip
  // studio already uses.
  useEffect(() => {
    if (phase !== 'progress' || !season) return;
    let stopped = false;
    const tick = () => {
      api
        .getColorWarSeason(season.id)
        .then(({ season: s }) => !stopped && setSeason(s))
        .catch(() => {});
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [phase, season?.id]);

  const renderingEpisode = season?.episodes.find((e) => e.status === 'rendering');
  const liveStream = useJobStream(renderingEpisode?.jobId ?? null);
  const livePct = (() => {
    const s = liveStream.steps.render;
    if (!s || s.status === 'pending') return 0;
    return s.status === 'done' ? 1 : Math.max(0.02, s.progress);
  })();

  const [saving, setSaving] = useState(false);
  const saveAll = useCallback(async () => {
    if (!season) return;
    setSaving(true);
    try {
      for (const ep of season.episodes) {
        if (ep.status === 'done' && ep.jobId) await api.saveJob(ep.jobId).catch(() => {});
      }
      alert('Saved every finished episode to your library.');
    } finally {
      setSaving(false);
    }
  }, [season]);

  const startOver = () => {
    setSeason(null);
    setPhase('form');
    setError(null);
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-[var(--radius)] border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger-soft)] px-4 py-3 text-[13px] text-[color:var(--color-danger)]">
          {error}
        </div>
      )}

      {phase === 'form' && (
        <div className="space-y-8">
          <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
            <h2 className="text-[15px] font-semibold">Create a season</h2>
            <p className="mt-1 text-[13px] text-[color:var(--color-muted)]">
              Every episode is guaranteed a close finish or a comeback — never a blowout. The whole
              season&rsquo;s outcomes are planned up front so the standings stay tight until the last episode.
            </p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
                  Season number
                </span>
                <TextInput
                  type="number"
                  min={1}
                  value={seasonNumber}
                  onChange={(e) => setSeasonNumber(Math.max(1, Number(e.target.value) || 1))}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
                  Episodes ({MIN_EPISODES}-{MAX_EPISODES})
                </span>
                <TextInput
                  type="number"
                  min={MIN_EPISODES}
                  max={MAX_EPISODES}
                  value={totalEpisodes}
                  onChange={(e) =>
                    setTotalEpisodes(Math.max(MIN_EPISODES, Math.min(MAX_EPISODES, Number(e.target.value) || MIN_EPISODES)))
                  }
                />
              </label>
            </div>
            <p className="mt-3 text-[12px] text-[color:var(--color-faint)]">
              {totalEpisodes} episodes, rendered back-to-back once you approve the plan — {fmtEta(totalEpisodes)} of
              unattended render time (~{MIN_PER_EPISODE} min each; the worker renders one at a time).
            </p>
            <Button variant="primary" size="lg" className="mt-5 w-full" onClick={planSeason} loading={busy === 'plan'}>
              Plan season
            </Button>
          </div>

          <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
            <h2 className="text-[15px] font-semibold">Test 1 episode</h2>
            <p className="mt-1 text-[13px] text-[color:var(--color-muted)]">
              Preview the intro card, the score chips, and the outro badge/confetti on one sample episode —
              no season plan needed, nothing gets committed.
            </p>
            {!testJobId && (
              <Button variant="secondary" size="lg" className="mt-4 w-full" onClick={runTest} loading={testBusy}>
                ▶ Render a test episode
              </Button>
            )}
            {testJobId && !testDone && !testFailed && (
              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between text-[13px]">
                  <span>Rendering…</span>
                  <span className="tabular-nums text-[color:var(--color-muted)]">
                    {Math.round(
                      (() => {
                        const s = testStream.steps.render;
                        if (!s || s.status === 'pending') return 0;
                        return s.status === 'done' ? 1 : Math.max(0.02, s.progress);
                      })() * 100,
                    )}
                    %
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-[color:var(--color-hairline)]">
                  <div
                    className="h-full rounded-full bg-[color:var(--color-accent)] transition-[width]"
                    style={{
                      width: `${
                        (() => {
                          const s = testStream.steps.render;
                          if (!s || s.status === 'pending') return 0;
                          return (s.status === 'done' ? 1 : Math.max(0.02, s.progress)) * 100;
                        })()
                      }%`,
                    }}
                  />
                </div>
              </div>
            )}
            {testFailed && (
              <p className="mt-3 text-[13px] text-[color:var(--color-danger)]">
                Test render failed{testStream.error ? `: ${testStream.error.message}` : ''}.
              </p>
            )}
            {testDone && testStream.review && (
              <div className="mt-4 space-y-3">
                <video
                  src={candidatePreviewUrl(testJobId!, 0)}
                  controls
                  loop
                  autoPlay
                  muted
                  playsInline
                  className="mx-auto max-h-[62dvh] rounded-[12px] bg-black"
                />
                <div className="flex gap-3">
                  <a href={jobDownloadUrl(testJobId!, 0)} download>
                    <Button variant="primary">⤓ Download</Button>
                  </a>
                  <Button variant="ghost" onClick={() => setTestJobId(null)}>
                    Try another
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {phase === 'plan' && season && (
        <div className="space-y-5">
          <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">
                Season {season.seasonNumber} plan — {season.totalEpisodes} episodes
              </h2>
              <StandingsStrip season={season} />
            </div>
            <div className="mt-4 divide-y divide-[color:var(--color-hairline)] overflow-x-auto">
              {season.plan.map((p) => {
                const name = COLOR_NAMES[p.winnerColorIndex];
                return (
                  <div key={p.episodeIndex} className="flex items-center gap-3 py-2 text-[13px]">
                    <span className="w-14 shrink-0 tabular-nums text-[color:var(--color-faint)]">
                      Ep {p.episodeIndex}
                    </span>
                    <span className="flex flex-1 items-center gap-2">
                      <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: COLOR_DOTS[name] }} />
                      <span className="font-medium">{name}</span>
                    </span>
                    <span className="flex gap-1.5">
                      {p.isStreakEntry && badge('losing streak', 'var(--color-danger)')}
                      {p.isRecoveryWin && badge('recovery', 'var(--color-accent)')}
                      {p.isClinch && badge('clinches title', 'var(--color-ok)')}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button variant="primary" size="lg" onClick={confirm} loading={busy === 'confirm'}>
                Approve &amp; render all {season.totalEpisodes}
              </Button>
              <Button variant="secondary" onClick={reroll} loading={busy === 'reroll'}>
                ↻ Reroll plan
              </Button>
              <Button variant="ghost" onClick={startOver}>
                Start over
              </Button>
            </div>
            <p className="mt-3 text-[12px] text-[color:var(--color-faint)]">
              Rendering starts only once you approve — {fmtEta(season.totalEpisodes)} of unattended render time.
            </p>
          </div>
        </div>
      )}

      {phase === 'progress' && season && (
        <div className="space-y-5">
          <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">Season {season.seasonNumber} — rendering</h2>
              <StandingsStrip season={season} />
            </div>
            <div className="mt-4 divide-y divide-[color:var(--color-hairline)]">
              {season.episodes.map((ep) => {
                const plan = season.plan.find((p) => p.episodeIndex === ep.episodeIndex);
                const name = plan ? COLOR_NAMES[plan.winnerColorIndex] : '';
                return (
                  <div key={ep.episodeIndex} className="flex flex-wrap items-center gap-3 py-2.5 text-[13px]">
                    <span className="w-14 shrink-0 tabular-nums text-[color:var(--color-faint)]">
                      Ep {ep.episodeIndex}
                    </span>
                    <span className="flex w-24 shrink-0 items-center gap-2">
                      {name && <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: COLOR_DOTS[name] }} />}
                      <span className="font-medium">{name}</span>
                    </span>
                    <span className="w-28 shrink-0 text-[12px] font-medium" style={{ color: STATUS_COLOR[ep.status] }}>
                      {STATUS_LABEL[ep.status]}
                    </span>
                    {ep.status === 'rendering' && ep.jobId === renderingEpisode?.jobId && (
                      <div className="h-1.5 w-32 shrink-0 overflow-hidden rounded-full bg-[color:var(--color-hairline)]">
                        <div
                          className="h-full rounded-full bg-[color:var(--color-accent)] transition-[width]"
                          style={{ width: `${livePct * 100}%` }}
                        />
                      </div>
                    )}
                    {ep.usedFallback && badge('closest match', 'var(--color-danger)')}
                    {ep.status === 'done' && ep.jobId && (
                      <span className="flex gap-3">
                        <a
                          className="text-[12px] text-[color:var(--color-accent)] hover:underline"
                          href={jobDownloadUrl(ep.jobId, 0)}
                          download
                        >
                          download
                        </a>
                        <a
                          className="text-[12px] text-[color:var(--color-muted)] hover:underline"
                          href={candidatePreviewUrl(ep.jobId, 0)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          preview
                        </a>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button
                variant="primary"
                onClick={saveAll}
                loading={saving}
                disabled={!season.episodes.some((e) => e.status === 'done')}
              >
                Save all finished episodes to library
              </Button>
              {season.status !== 'done' && season.status !== 'canceled' && (
                <Button variant="danger" onClick={cancelAll} loading={busy === 'cancel'}>
                  Cancel remaining
                </Button>
              )}
              {(season.status === 'done' || season.status === 'canceled') && (
                <Button variant="ghost" onClick={startOver}>
                  New season
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StandingsStrip({ season }: { season: ColorWarSeason }) {
  const tally = [0, 0, 0, 0];
  for (const p of season.plan) tally[p.winnerColorIndex]!++;
  return (
    <div className="flex gap-3 text-[12px] tabular-nums">
      {COLOR_NAMES.map((name, i) => (
        <span key={name} className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: COLOR_DOTS[name] }} />
          {tally[i]}
        </span>
      ))}
    </div>
  );
}
