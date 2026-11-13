'use client';

import { useCallback, useEffect, useState } from 'react';
import { colorwarsApi, pollJob } from '@/lib/colorwarsApi';
import type { Job } from '@/lib/colorwarsTypes';
import { Button, SegmentedControl } from '@/components/ui';
import type { StudioState } from './useStudioState';

const STATUS_COLOR: Record<Job['status'], string> = {
  queued: 'var(--color-muted)', running: 'var(--color-accent)', done: 'var(--color-ok)',
  error: 'var(--color-danger)', canceled: 'var(--color-faint)',
};

function JobRow({ job, onCancel }: { job: Job; onCancel: () => void }) {
  const pct = job.total_frames ? Math.round(100 * (job.frames_done / Math.max(1, job.total_frames))) : 0;
  const result = job.result as { meta?: { winner?: string; duration_sec?: number } } | null;
  return (
    <div className="flex flex-wrap items-center gap-3 py-2.5 text-[13px]">
      <span className="w-20 shrink-0 tabular-nums text-[color:var(--color-faint)]">seed {job.seed as number}</span>
      <span className="w-20 shrink-0 font-medium" style={{ color: STATUS_COLOR[job.status] }}>
        {job.status}
      </span>
      {(job.status === 'queued' || job.status === 'running') && (
        <>
          <div className="h-1.5 w-32 shrink-0 overflow-hidden rounded-full bg-[color:var(--color-hairline)]">
            <div className="h-full rounded-full bg-[color:var(--color-accent)] transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[12px] text-[color:var(--color-muted)]">
            {job.frames_done}/{job.total_frames ?? '…'}
          </span>
          <Button variant="danger" onClick={onCancel}>
            Cancel
          </Button>
        </>
      )}
      {job.status === 'done' && result?.meta && (
        <span className="text-[12px] text-[color:var(--color-muted)]">
          winner {result.meta.winner}, {result.meta.duration_sec?.toFixed?.(1)}s
        </span>
      )}
      {job.status === 'error' && <span className="truncate text-[12px] text-[color:var(--color-danger)]">{job.error}</span>}
    </div>
  );
}

export function RenderPanel({ studio }: { studio: StudioState }) {
  const { buildRunConfig, randomizeAll, seed, volumeMult } = studio;
  const [mode, setMode] = useState<'final' | 'preview'>('final');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [makeN, setMakeN] = useState(3);
  const [makeNBusy, setMakeNBusy] = useState(false);
  const [makeNStatus, setMakeNStatus] = useState<string | null>(null);

  const refresh = useCallback(() => {
    colorwarsApi.listJobs().then((d) => setJobs(d.jobs.filter((j) => j.kind === 'render'))).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const queueRender = useCallback(async () => {
    try {
      await colorwarsApi.createRenderJob({ ...buildRunConfig(), mode, volume_mult: volumeMult });
      refresh();
    } catch (e) {
      alert('could not queue render: ' + (e as Error).message);
    }
  }, [buildRunConfig, mode, volumeMult, refresh]);

  const cancel = useCallback(
    async (id: string) => {
      await colorwarsApi.cancelJob(id);
      refresh();
    },
    [refresh],
  );

  // Randomize, mine, render -- N times in a row. Randomization needs the
  // schema and lock state, which only this page already has (the backend
  // has no route for this), so it's composed client-side: each iteration
  // mutates the shared Setup state, mines for a dramatic seed, then queues
  // a render with that seed before moving to the next iteration.
  const runMakeN = useCallback(async () => {
    setMakeNBusy(true);
    try {
      for (let i = 0; i < Math.max(1, Math.min(20, makeN)); i++) {
        setMakeNStatus(`Episode ${i + 1} of ${makeN}: randomizing…`);
        randomizeAll();
        await new Promise((r) => setTimeout(r, 50)); // let React commit the new seed/overrides before reading them
        setMakeNStatus(`Episode ${i + 1} of ${makeN}: mining for a dramatic seed…`);
        const cfg = buildRunConfig();
        const { job: mineJob } = await colorwarsApi.createMineJob({
          event_id: cfg.event_id, runs: 150, top: 1, start_seed: 1, filters: {},
          episode_overrides: cfg.episode_overrides, finale: cfg.finale,
        });
        const finished: Job = await new Promise((resolve) => {
          pollJob(mineJob.id, (j) => {
            if (j.status !== 'queued' && j.status !== 'running') resolve(j);
          });
        });
        const topRow = (finished.result as { top_rows?: { seed: number }[] } | null)?.top_rows?.[0];
        const bestSeed = topRow?.seed ?? cfg.seed;
        setMakeNStatus(`Episode ${i + 1} of ${makeN}: queuing render (seed ${bestSeed})…`);
        await colorwarsApi.createRenderJob({ ...cfg, seed: bestSeed, mode, volume_mult: volumeMult });
        refresh();
      }
      setMakeNStatus(`Queued ${makeN} episodes.`);
    } catch (e) {
      setMakeNStatus('Make N failed: ' + (e as Error).message);
    } finally {
      setMakeNBusy(false);
    }
  }, [makeN, randomizeAll, buildRunConfig, mode, volumeMult, refresh]);

  return (
    <div className="space-y-6">
      <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
        <h2 className="text-[15px] font-semibold">Render</h2>
        <div className="mt-3 flex items-center gap-4">
          <SegmentedControl
            value={mode}
            onChange={setMode}
            options={[
              { value: 'final', label: 'Final (1080×1920)' },
              { value: 'preview', label: 'Fast test (540×960)' },
            ]}
          />
          <span className="text-[12px] text-[color:var(--color-muted)]">current seed {seed}</span>
        </div>
        <Button variant="primary" size="lg" className="mt-4" onClick={queueRender}>
          Queue render
        </Button>
      </div>

      <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
        <h2 className="text-[15px] font-semibold">Make N</h2>
        <p className="mt-1 text-[13px] text-[color:var(--color-muted)]">
          Randomize, mine for a dramatic seed, and queue a render — N times in a row.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <input
            type="number"
            min={1}
            max={20}
            value={makeN}
            onChange={(e) => setMakeN(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
            className="h-9 w-20 rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] px-2 text-[14px]"
          />
          <Button variant="secondary" onClick={runMakeN} loading={makeNBusy}>
            Make {makeN}
          </Button>
        </div>
        {makeNStatus && <p className="mt-2 text-[12px] text-[color:var(--color-muted)]">{makeNStatus}</p>}
      </div>

      <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
        <h2 className="text-[15px] font-semibold">Queue</h2>
        {jobs.length === 0 && <p className="mt-2 text-[13px] text-[color:var(--color-muted)]">Nothing queued yet.</p>}
        <div className="mt-2 divide-y divide-[color:var(--color-hairline)]">
          {jobs.map((j) => (
            <JobRow key={j.id} job={j} onCancel={() => cancel(j.id)} />
          ))}
        </div>
      </div>
    </div>
  );
}
