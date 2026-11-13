'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { colorwarsApi, colorwarsMediaUrl, pollJob } from '@/lib/colorwarsApi';
import type { EventInfo, EventSchema, FilmstripResult, Job, QuickCheckResult } from '@/lib/colorwarsTypes';
import { Button, SegmentedControl, Toggle } from '@/components/ui';

function randomSeed(): number {
  return 1 + Math.floor(Math.random() * 999_999);
}

/**
 * Color Wars League studio — one page, same shape as FollowBallStudio /
 * EyeTestStudio: pick an event, reroll until a preview looks good, hit
 * Render, get a video + download + caption. No tabs, no per-setting lock
 * toggles, no presets panel -- Randomize already covers everything the
 * engine supports under the hood (colorwars/colorwars/engine/params.py),
 * this page just doesn't surface each of those knobs individually.
 */
export function ColorwarsStudio() {
  const [events, setEvents] = useState<EventInfo[]>([]);
  const [eventId, setEventId] = useState('ring_of_doom');
  const [schema, setSchema] = useState<EventSchema | null>(null);
  const [seed, setSeed] = useState(1);
  const [finale, setFinale] = useState(false);

  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<QuickCheckResult | null>(null);
  const [filmstrip, setFilmstrip] = useState<FilmstripResult | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  // a real, playing preview clip (540x960) -- the filmstrip alone is just
  // 6 still frames, not something that actually plays; rendered in the
  // background right after a valid quick check so there's something to
  // watch while deciding whether to keep this seed.
  const [previewVideoUrl, setPreviewVideoUrl] = useState<string | null>(null);
  // if the browser ever fails to actually load the preview clip (seen for
  // real, cause unconfirmed -- possibly load on this machine during heavy
  // concurrent rendering), fall back to the filmstrip instead of leaving a
  // broken, stuck-at-0:00 player on screen with nothing else to look at.
  const [previewVideoFailed, setPreviewVideoFailed] = useState(false);
  const [previewJob, setPreviewJob] = useState<Job | null>(null);
  const previewRendering = previewJob != null && previewJob.status !== 'done' && previewJob.status !== 'error' && previewJob.status !== 'canceled';
  const previewJobIdRef = useRef<string | null>(null);
  // a generation counter, not the seed itself -- preview() now retries with
  // several different seeds *inside* one call (see below), so "is this call
  // still the active one" can't be answered by comparing seed values anymore.
  const latestGenRef = useRef(0);

  const [mining, setMining] = useState(false);

  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [rendering, setRendering] = useState(false);

  useEffect(() => {
    colorwarsApi.listEvents().then((d) => setEvents(d.events)).catch(() => {});
  }, []);

  useEffect(() => {
    let stop = false;
    setSchema(null);
    setCheck(null);
    setFilmstrip(null);
    colorwarsApi
      .getSchema(eventId)
      .then((d) => !stop && setSchema(d))
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, [eventId]);

  const preview = useCallback(
    async (initialSeed: number) => {
      const myGen = ++latestGenRef.current;
      setChecking(true);
      setCheckError(null);
      setPreviewVideoUrl(null);
      setPreviewVideoFailed(false);
      // a reroll while the last preview clip was still rendering would
      // otherwise queue up behind it (jobs run one at a time) and waste
      // real render time on a seed nobody's looking at anymore.
      if (previewJobIdRef.current) {
        void colorwarsApi.cancelJob(previewJobIdRef.current).catch(() => {});
        previewJobIdRef.current = null;
      }
      setPreviewJob(null);
      try {
        // not every seed produces a valid run (Ring of Doom's own design:
        // no single survivor by the deadline, independent of the config) --
        // keep trying new seeds automatically instead of leaving the page
        // dead-ended on whichever seed it happened to land on (found
        // directly: the default starting seed, 1, isn't always valid, and
        // the page just sat there with nothing to show). Same thing the
        // engine's own `find-seed` does on the CLI side.
        let seedToUse = initialSeed;
        let checkRes: QuickCheckResult | null = null;
        let filmRes: FilmstripResult | null = null;
        for (let attempt = 0; attempt < 15; attempt++) {
          if (latestGenRef.current !== myGen) return; // superseded by a newer call while this was in flight
          if (attempt > 0) setSeed(seedToUse);
          const cfg = { event_id: eventId, seed: seedToUse, overrides: {}, episode_overrides: {}, finale };
          [checkRes, filmRes] = await Promise.all([colorwarsApi.quickCheck(cfg), colorwarsApi.filmstrip(cfg)]);
          if (latestGenRef.current !== myGen) return;
          if (checkRes.valid) break;
          seedToUse = randomSeed();
        }
        if (!checkRes || !filmRes) return;
        setCheck(checkRes);
        setFilmstrip(filmRes);
        if (checkRes.valid) {
          const cfg = { event_id: eventId, seed: seedToUse, overrides: {}, episode_overrides: {}, finale };
          const { job } = await colorwarsApi.createRenderJob({ ...cfg, mode: 'preview' });
          if (latestGenRef.current !== myGen) {
            void colorwarsApi.cancelJob(job.id).catch(() => {});
            return;
          }
          previewJobIdRef.current = job.id;
          setPreviewJob(job);
          pollJob(job.id, (j) => {
            if (latestGenRef.current !== myGen) return; // a later reroll already took over
            setPreviewJob(j);
            if (j.status === 'done') {
              const outDir = (j.result as { out_dir?: string } | null)?.out_dir?.split('/').pop();
              if (outDir) setPreviewVideoUrl(colorwarsMediaUrl(`/media/${outDir}/final.mp4`));
            }
          });
        }
      } catch (e) {
        setCheckError((e as Error).message);
      } finally {
        setChecking(false);
      }
    },
    [eventId, finale],
  );

  // a fresh preview as soon as an event's schema is ready (first load, or
  // after switching events) -- mirrors the other studios' preview booting
  // on its own, nothing to click first.
  useEffect(() => {
    if (schema) void preview(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);

  const reroll = useCallback(() => {
    const s = randomSeed();
    setSeed(s);
    void preview(s);
  }, [preview]);

  const findGreatSeed = useCallback(async () => {
    setMining(true);
    try {
      const { job: mineJob } = await colorwarsApi.createMineJob({
        event_id: eventId, runs: 250, top: 1, start_seed: 1, filters: {}, episode_overrides: {}, finale,
      });
      const finished: Job = await new Promise((resolve) => {
        pollJob(mineJob.id, (j) => {
          if (j.status !== 'queued' && j.status !== 'running') resolve(j);
        });
      });
      const top = (finished.result as { top_rows?: { seed: number }[] } | null)?.top_rows?.[0];
      if (top) {
        setSeed(top.seed);
        await preview(top.seed);
      } else if (finished.status === 'error') {
        alert('could not find a seed: ' + finished.error);
      }
    } catch (e) {
      alert('could not find a seed: ' + (e as Error).message);
    } finally {
      setMining(false);
    }
  }, [eventId, finale, preview]);

  const render = useCallback(async () => {
    setRendering(true);
    setJob(null);
    try {
      const { job: j } = await colorwarsApi.createRenderJob({
        event_id: eventId, seed, overrides: {}, episode_overrides: {}, finale, mode: 'final',
      });
      setJobId(j.id);
      setJob(j);
      pollJob(j.id, (updated) => {
        setJob(updated);
        if (updated.status !== 'queued' && updated.status !== 'running') setRendering(false);
      });
    } catch (e) {
      setRendering(false);
      alert('render failed to start: ' + (e as Error).message);
    }
  }, [eventId, seed, finale]);

  const cancelRender = useCallback(async () => {
    if (jobId) await colorwarsApi.cancelJob(jobId);
    setJobId(null);
    setJob(null);
    setRendering(false);
  }, [jobId]);

  const done = job?.status === 'done';
  const failed = job?.status === 'error';
  const result = job?.result as { out_dir?: string; meta?: { winner?: string; mvp?: string; duration_sec?: number } } | null;
  const outDirName = result?.out_dir?.split('/').pop();
  const videoUrl = outDirName ? colorwarsMediaUrl(`/media/${outDirName}/final.mp4`) : null;
  const renderPct = job?.total_frames ? Math.round(100 * (job.frames_done / Math.max(1, job.total_frames))) : 0;
  const previewPct = previewJob?.total_frames
    ? Math.round(100 * (previewJob.frames_done / Math.max(1, previewJob.total_frames)))
    : 0;

  const drama = check?.drama as { score?: number } | undefined;

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,300px)_1fr]">
      {/* ── preview ── */}
      <div className="mx-auto w-full max-w-[300px]">
        <div className="relative aspect-[9/16] overflow-hidden rounded-[20px] border border-[color:var(--color-hairline-strong)] bg-black">
          {videoUrl ? (
            <video src={videoUrl} controls loop autoPlay muted playsInline className="absolute inset-0 h-full w-full object-contain" />
          ) : previewVideoUrl && !previewVideoFailed ? (
            <video
              src={previewVideoUrl}
              controls
              loop
              autoPlay
              muted
              playsInline
              onError={() => setPreviewVideoFailed(true)}
              className="absolute inset-0 h-full w-full object-contain"
            />
          ) : filmstrip?.valid ? (
            <div className="absolute inset-0 grid grid-cols-2 grid-rows-3 gap-px bg-black">
              {filmstrip.frame_urls.map((url, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={colorwarsMediaUrl(url)} alt="" className="h-full w-full object-cover" />
              ))}
            </div>
          ) : (
            <div className="absolute inset-0 grid place-items-center text-[13px] text-[color:var(--color-muted)]">
              {checking
                ? 'checking…'
                : checkError
                  ? 'preview unavailable'
                  : check && !check.valid
                    ? "couldn't find a valid seed — try Randomize again"
                    : 'loading preview…'}
            </div>
          )}
          {!videoUrl && previewRendering && (
            <div className="absolute inset-x-0 bottom-0 bg-black/70 px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between text-[11px] text-white">
                <span>rendering preview…</span>
                <span className="tabular-nums">{previewPct}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/20">
                <div
                  className="h-full rounded-full bg-[color:var(--color-accent)] transition-[width]"
                  style={{ width: `${previewPct}%` }}
                />
              </div>
            </div>
          )}
        </div>
        <div className="mt-3 rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] px-3.5 py-3 text-[13px] tabular-nums">
          {checkError && <span className="text-[color:var(--color-danger)]">{checkError}</span>}
          {!checkError && check && !check.valid && (
            <span className="text-[color:var(--color-danger)]">This seed didn&rsquo;t work out — try another.</span>
          )}
          {!checkError && check?.valid && (
            <span>
              Winner <b className="text-[color:var(--color-accent)]">{check.winner}</b> · MVP {check.mvp} ·{' '}
              {check.duration_sec?.toFixed(0)}s
              {drama?.score != null && <span className="text-[color:var(--color-faint)]"> · drama {drama.score.toFixed(0)}</span>}
            </span>
          )}
          {!checkError && !check && <span>…</span>}
          <div className="mt-0.5 text-[11px] text-[color:var(--color-faint)]">
            {schema ? events.find((e) => e.id === eventId)?.display_name : '…'} · seed {seed}
          </div>
        </div>
      </div>

      {/* ── controls + output ── */}
      <div className="space-y-6">
        <div>
          <span className="mb-1.5 block text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
            Event
          </span>
          <SegmentedControl
            value={eventId}
            onChange={setEventId}
            options={events.map((e) => ({ value: e.id, label: e.display_name }))}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Button variant="primary" size="lg" onClick={reroll} disabled={!schema || checking}>
            ↻ Randomize — new seed
          </Button>
          <Button variant="secondary" size="lg" onClick={findGreatSeed} loading={mining} disabled={!schema || checking}>
            ★ Find a great seed
          </Button>
        </div>

        <Toggle checked={finale} onChange={setFinale} label="Finale episode" />

        <div className="rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-4">
          {!jobId && (
            <>
              <Button variant="primary" size="lg" onClick={render} loading={rendering} disabled={!check?.valid} className="w-full">
                ▶ Render this seed
              </Button>
              <p className="mt-2 text-[12px] text-[color:var(--color-faint)]">
                Full 1080×1920 render with sound — takes a couple of minutes. Same seed and settings the preview just showed.
              </p>
            </>
          )}

          {jobId && !done && !failed && (
            <div>
              <div className="mb-2 flex items-center justify-between text-[13px]">
                <span>
                  Rendering seed <b className="tabular-nums">{seed}</b>…
                </span>
                <span className="tabular-nums text-[color:var(--color-muted)]">{renderPct}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-[color:var(--color-hairline)]">
                <div className="h-full rounded-full bg-[color:var(--color-accent)] transition-[width]" style={{ width: `${renderPct}%` }} />
              </div>
              <button
                className="mt-3 text-[12px] text-[color:var(--color-muted)] underline hover:text-[color:var(--color-text)]"
                onClick={cancelRender}
              >
                cancel
              </button>
            </div>
          )}

          {failed && (
            <div className="text-[13px] text-[color:var(--color-danger)]">
              Render failed.{' '}
              <button className="underline" onClick={() => setJobId(null)}>
                try again
              </button>
            </div>
          )}

          {done && videoUrl && (
            <div className="space-y-3">
              <p className="text-[13px]">
                Winner <b>{result?.meta?.winner}</b>, MVP {result?.meta?.mvp}, {result?.meta?.duration_sec?.toFixed(0)}s.
              </p>
              <div className="flex flex-wrap gap-3">
                <a href={videoUrl} download>
                  <Button variant="primary" size="lg">
                    ⤓ Download to your computer
                  </Button>
                </a>
                <Button variant="secondary" onClick={() => setJobId(null)}>
                  Render another
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
