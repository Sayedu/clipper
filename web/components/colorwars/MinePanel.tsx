'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { colorwarsApi, pollJob } from '@/lib/colorwarsApi';
import type { Job, MineFilters, MineTopRow, QuickCheckResult } from '@/lib/colorwarsTypes';
import { Button, Field, Select, TextInput, Toggle } from '@/components/ui';
import type { StudioState } from './useStudioState';

const PRIMARY_KEYS = new Set(['seed', 'winner', 'mvp', 'duration_sec', 'score']);

export function MinePanel({ studio }: { studio: StudioState }) {
  const { schema, setSeed, buildRunConfig } = studio;

  const [runs, setRuns] = useState(300);
  const [top, setTop] = useState(10);
  const [filters, setFilters] = useState<MineFilters>({});
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);

  const [loadedSeed, setLoadedSeed] = useState<number | null>(null);
  const [loadedCheck, setLoadedCheck] = useState<QuickCheckResult | null>(null);
  const [loadBusy, setLoadBusy] = useState(false);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      if (startRef.current) setElapsed(Math.round((Date.now() - startRef.current) / 1000));
    }, 500);
    return () => clearInterval(t);
  }, [busy]);

  const startMine = useCallback(async () => {
    setBusy(true);
    setJob(null);
    setElapsed(0);
    startRef.current = Date.now();
    try {
      const cfg = buildRunConfig();
      const { job: j } = await colorwarsApi.createMineJob({
        event_id: cfg.event_id, runs, top, start_seed: 1, filters, episode_overrides: cfg.episode_overrides,
        finale: cfg.finale,
      });
      setJob(j);
      pollJob(j.id, (updated) => {
        setJob(updated);
        if (updated.status !== 'queued' && updated.status !== 'running') setBusy(false);
      });
    } catch (e) {
      setBusy(false);
      alert('mining failed to start: ' + (e as Error).message);
    }
  }, [buildRunConfig, runs, top, filters]);

  const loadRow = useCallback(
    async (row: MineTopRow) => {
      setSeed(row.seed);
      setLoadedSeed(row.seed);
      setLoadBusy(true);
      try {
        setLoadedCheck(await colorwarsApi.quickCheck({ ...buildRunConfig(), seed: row.seed }));
      } catch {
        setLoadedCheck(null);
      } finally {
        setLoadBusy(false);
      }
    },
    [setSeed, buildRunConfig],
  );

  const result = job?.result as { top_rows?: MineTopRow[]; total_valid?: number } | null;

  return (
    <div className="space-y-6">
      <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
        <h2 className="text-[15px] font-semibold">Story director</h2>
        <p className="mt-1 text-[13px] text-[color:var(--color-muted)]">
          Simulate many seeds headless (no rendering) and rank them by how dramatic the run was.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Runs">
            <TextInput type="number" min={1} value={runs} onChange={(e) => setRuns(Math.max(1, Number(e.target.value) || 1))} />
          </Field>
          <Field label="Top N to keep">
            <TextInput type="number" min={1} value={top} onChange={(e) => setTop(Math.max(1, Number(e.target.value) || 1))} />
          </Field>
          <Field label="Winner must be">
            <Select value={filters.winner ?? ''} onChange={(e) => setFilters((f) => ({ ...f, winner: e.target.value || undefined }))}>
              <option value="">Any team</option>
              {schema?.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Winner must not be">
            <Select value={filters.not_winner ?? ''} onChange={(e) => setFilters((f) => ({ ...f, not_winner: e.target.value || undefined }))}>
              <option value="">No restriction</option>
              {schema?.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Minimum lead changes">
            <TextInput
              type="number"
              min={0}
              value={filters.min_lead_changes ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, min_lead_changes: e.target.value ? Number(e.target.value) : undefined }))}
            />
          </Field>
          <div className="flex items-center gap-6 pt-6">
            <Toggle checked={Boolean(filters.comeback)} onChange={(v) => setFilters((f) => ({ ...f, comeback: v || undefined }))} label="Comeback" />
            <Toggle checked={Boolean(filters.photo_finish)} onChange={(v) => setFilters((f) => ({ ...f, photo_finish: v || undefined }))} label="Photo finish" />
          </div>
        </div>
        <Button variant="primary" size="lg" className="mt-5" onClick={startMine} loading={busy}>
          {busy ? `Mining… ${elapsed}s` : 'Start mining'}
        </Button>
      </div>

      {job?.status === 'error' && (
        <p className="text-[13px] text-[color:var(--color-danger)]">{job.error}</p>
      )}

      {result?.top_rows && (
        <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
          <h2 className="text-[15px] font-semibold">
            Top {result.top_rows.length} of {result.total_valid} valid seeds
          </h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-[color:var(--color-muted)]">
                  <th className="py-1.5 pr-3">Seed</th>
                  <th className="py-1.5 pr-3">Winner</th>
                  <th className="py-1.5 pr-3">MVP</th>
                  <th className="py-1.5 pr-3">Length</th>
                  <th className="py-1.5 pr-3">Drama</th>
                  <th className="py-1.5 pr-3">Other stats</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-hairline)]">
                {result.top_rows.map((row) => {
                  const extras = Object.entries(row).filter(([k]) => !PRIMARY_KEYS.has(k));
                  return (
                    <tr key={row.seed}>
                      <td className="py-2 pr-3 tabular-nums">{row.seed}</td>
                      <td className="py-2 pr-3">{row.winner}</td>
                      <td className="py-2 pr-3">{row.mvp}</td>
                      <td className="py-2 pr-3 tabular-nums">{row.duration_sec?.toFixed?.(1) ?? row.duration_sec}</td>
                      <td className="py-2 pr-3 tabular-nums">{row.score?.toFixed?.(1) ?? row.score}</td>
                      <td className="py-2 pr-3 text-[11px] text-[color:var(--color-muted)]">
                        {extras.map(([k, v]) => `${k}=${v}`).join(', ')}
                      </td>
                      <td className="py-2">
                        <Button variant="secondary" onClick={() => loadRow(row)}>
                          Load into Setup
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {loadedSeed != null && (
        <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
          <h2 className="text-[15px] font-semibold">Quick check — seed {loadedSeed}</h2>
          {loadBusy && <p className="mt-2 text-[13px] text-[color:var(--color-muted)]">Checking…</p>}
          {!loadBusy && loadedCheck && (
            <p className="mt-2 text-[13px]">
              Winner <strong>{loadedCheck.winner}</strong>, MVP {loadedCheck.mvp}, {loadedCheck.duration_sec?.toFixed(1)}s
              {loadedCheck.in_window ? '' : ' (outside the target window)'}. Seed loaded into Setup — switch tabs to
              preview or render it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
