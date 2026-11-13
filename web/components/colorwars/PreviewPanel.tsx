'use client';

import { useCallback, useState } from 'react';
import { colorwarsApi, colorwarsMediaUrl, pollJob } from '@/lib/colorwarsApi';
import type { FilmstripResult, Job, QuickCheckResult } from '@/lib/colorwarsTypes';
import { Button } from '@/components/ui';
import type { StudioState } from './useStudioState';

function StatPill({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-[color:var(--color-muted)]">{label}</div>
      <div className="text-[15px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function PreviewPanel({ studio }: { studio: StudioState }) {
  const { buildRunConfig, volumeMult } = studio;

  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<QuickCheckResult | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  const [filmstripBusy, setFilmstripBusy] = useState(false);
  const [filmstrip, setFilmstrip] = useState<FilmstripResult | null>(null);

  const [previewJob, setPreviewJob] = useState<Job | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const runQuickCheck = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    try {
      setCheck(await colorwarsApi.quickCheck(buildRunConfig()));
    } catch (e) {
      setCheckError((e as Error).message);
      setCheck(null);
    } finally {
      setChecking(false);
    }
  }, [buildRunConfig]);

  const runFilmstrip = useCallback(async () => {
    setFilmstripBusy(true);
    try {
      setFilmstrip(await colorwarsApi.filmstrip(buildRunConfig()));
    } catch {
      setFilmstrip(null);
    } finally {
      setFilmstripBusy(false);
    }
  }, [buildRunConfig]);

  const runPreviewVideo = useCallback(async () => {
    setPreviewBusy(true);
    setPreviewJob(null);
    try {
      const { job } = await colorwarsApi.createRenderJob({ ...buildRunConfig(), mode: 'preview', volume_mult: volumeMult });
      setPreviewJob(job);
      pollJob(job.id, (j) => {
        setPreviewJob(j);
        if (j.status !== 'queued' && j.status !== 'running') setPreviewBusy(false);
      });
    } catch (e) {
      setPreviewBusy(false);
      alert('preview render failed to start: ' + (e as Error).message);
    }
  }, [buildRunConfig, volumeMult]);

  const progressPct =
    previewJob && previewJob.total_frames
      ? Math.round(100 * (previewJob.frames_done / Math.max(1, previewJob.total_frames)))
      : 0;

  const previewOutDir = (previewJob?.result as { out_dir?: string } | null)?.out_dir;
  const previewVideoUrl = previewOutDir ? colorwarsMediaUrl(`/media/${previewOutDir.split('/').pop()}/final.mp4`) : null;

  return (
    <div className="space-y-6">
      <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">Quick check</h2>
          <Button variant="primary" onClick={runQuickCheck} loading={checking}>
            Run quick check
          </Button>
        </div>
        {checkError && <p className="mt-3 text-[13px] text-[color:var(--color-danger)]">{checkError}</p>}
        {check && (
          <div className="mt-4 space-y-4">
            {!check.valid && (
              <p className="text-[13px] text-[color:var(--color-danger)]">
                This seed did not produce a valid run (no single survivor by the deadline) — try another seed.
              </p>
            )}
            {check.valid && !check.in_window && (
              <p className="text-[13px] text-[color:var(--color-danger)]">
                Runs {check.duration_sec?.toFixed(1)}s — outside the {check.duration_min_sec}–{check.duration_max_sec}s
                window.
              </p>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatPill label="Winner" value={check.winner ?? '—'} />
              <StatPill label="MVP" value={check.mvp ?? '—'} />
              <StatPill label="Length" value={check.duration_sec ? `${check.duration_sec.toFixed(1)}s` : '—'} />
              <StatPill label="Drama score" value={String((check.drama as { score?: number })?.score ?? '—')} />
              <StatPill label="Lead changes" value={String((check.drama as { lead_changes?: number })?.lead_changes ?? '—')} />
              <StatPill label="Near misses" value={String((check.drama as { near_misses?: number })?.near_misses ?? '—')} />
              <StatPill label="Placements" value={check.placements.join(' → ')} />
              <StatPill label="Crown team" value={check.crown_team ?? '—'} />
            </div>
            {check.teaser && <p className="text-[13px] text-[color:var(--color-muted)]">{check.hook_line}</p>}
            <details>
              <summary className="cursor-pointer text-[13px] font-medium">
                Timeline — {check.timeline_events.length} key moments
              </summary>
              <div className="mt-2 max-h-64 overflow-y-auto divide-y divide-[color:var(--color-hairline)] text-[12px]">
                {check.timeline_events.map((e, i) => (
                  <div key={i} className="flex gap-3 py-1.5">
                    <span className="w-14 shrink-0 tabular-nums text-[color:var(--color-faint)]">{e.t.toFixed(1)}s</span>
                    <span className="font-medium">{e.kind}</span>
                    <span className="truncate text-[color:var(--color-muted)]">{JSON.stringify(e.data)}</span>
                  </div>
                ))}
              </div>
            </details>
          </div>
        )}
      </div>

      <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">Filmstrip</h2>
          <Button variant="secondary" onClick={runFilmstrip} loading={filmstripBusy}>
            Render 6 frames
          </Button>
        </div>
        {filmstrip && !filmstrip.valid && (
          <p className="mt-3 text-[13px] text-[color:var(--color-danger)]">This seed is not valid.</p>
        )}
        {filmstrip && filmstrip.valid && (
          <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
            {filmstrip.frame_urls.map((url, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={colorwarsMediaUrl(url)} alt={`frame ${i}`} className="w-full rounded-[8px] border border-[color:var(--color-hairline)]" />
            ))}
          </div>
        )}
      </div>

      <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">Preview video (540×960)</h2>
          <Button variant="secondary" onClick={runPreviewVideo} loading={previewBusy}>
            Render preview
          </Button>
        </div>
        {previewJob && (previewJob.status === 'queued' || previewJob.status === 'running') && (
          <div className="mt-4">
            <div className="h-2 w-full overflow-hidden rounded-full bg-[color:var(--color-hairline)]">
              <div className="h-full rounded-full bg-[color:var(--color-accent)] transition-[width]" style={{ width: `${progressPct}%` }} />
            </div>
            <p className="mt-2 text-[12px] text-[color:var(--color-muted)]">
              {previewJob.frames_done} / {previewJob.total_frames ?? '…'} frames
            </p>
          </div>
        )}
        {previewJob?.status === 'error' && (
          <p className="mt-3 text-[13px] text-[color:var(--color-danger)]">{previewJob.error}</p>
        )}
        {previewJob?.status === 'done' && previewVideoUrl && (
          <video
            src={previewVideoUrl}
            controls
            loop
            playsInline
            className="mx-auto mt-4 max-h-[62dvh] rounded-[12px] bg-black"
          />
        )}
        <p className="mt-3 text-[12px] text-[color:var(--color-faint)]">
          Preview and final render use the identical config and seed — the final will show exactly this outcome at
          full quality.
        </p>
      </div>
    </div>
  );
}
