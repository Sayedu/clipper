'use client';

import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { STEP_ORDER, STEP_LABEL, type Step } from '@/lib/types';
import { fmtDuration } from '@/lib/eta';
import type { JobStreamState, StepState } from '@/lib/useJobStream';
import { Spinner } from './ui';

function stepDuration(s: StepState, now: number): string | null {
  if (!s.startedAt) return null;
  const end = s.endedAt ?? (s.status === 'running' ? now : null);
  if (!end) return null;
  const sec = (end - s.startedAt) / 1000;
  return sec >= 1 ? fmtDuration(sec) : null;
}

function Glyph({ state }: { state: StepState }) {
  if (state.status === 'done')
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[color:var(--color-accent)] text-white">
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3.5">
          <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  if (state.status === 'failed')
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[color:var(--color-danger)] text-white">
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3.5">
          <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
        </svg>
      </span>
    );
  if (state.status === 'running')
    return <Spinner className="h-5 w-5 text-[color:var(--color-accent)]" />;
  if (state.status === 'skipped')
    return <span className="h-5 w-5 rounded-full border border-dashed border-[color:var(--color-faint)]" />;
  return <span className="h-5 w-5 rounded-full border border-[color:var(--color-hairline-strong)]" />;
}

export function PipelineChecklist({ stream }: { stream: JobStreamState }) {
  const [showLog, setShowLog] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const anyRunning = STEP_ORDER.some((s) => stream.steps[s].status === 'running');
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyRunning]);

  return (
    <div>
      <ol className="space-y-3.5">
        {STEP_ORDER.map((step: Step) => {
          const s = stream.steps[step];
          const active = s.status === 'running';
          const dur = stepDuration(s, now);
          return (
            <li key={step} className="flex items-start gap-3.5">
              <span className="mt-0.5 shrink-0">
                <Glyph state={s} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span
                    className={clsx(
                      'text-[15px]',
                      s.status === 'pending' && 'text-[color:var(--color-faint)]',
                      s.status === 'skipped' && 'text-[color:var(--color-faint)] line-through',
                      (s.status === 'done' || active) && 'text-[color:var(--color-text)]',
                      s.status === 'failed' && 'text-[color:var(--color-danger)]',
                    )}
                  >
                    {STEP_LABEL[step]}
                  </span>
                  {dur && (s.status === 'done' || active) && (
                    <span className="text-[12px] tabular-nums text-[color:var(--color-faint)]">{dur}</span>
                  )}
                </span>
                {s.detail && (s.status === 'running' || s.status === 'done' || s.status === 'failed') && (
                  <span className="mt-0.5 block truncate text-[13px] text-[color:var(--color-muted)]">
                    {s.detail}
                  </span>
                )}
                {active && s.progress > 0 && s.progress < 1 && (
                  <span className="mt-1.5 block h-[3px] w-full max-w-[220px] overflow-hidden rounded-full bg-[color:var(--color-hairline)]">
                    <span
                      className="block h-full rounded-full bg-[color:var(--color-accent)] transition-[width] duration-300"
                      style={{ width: `${Math.round(s.progress * 100)}%` }}
                    />
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      {stream.logs.length > 0 && (
        <div className="mt-6">
          <button
            onClick={() => setShowLog((v) => !v)}
            className="text-[13px] text-[color:var(--color-muted)] hover:text-[color:var(--color-text)]"
          >
            {showLog ? 'Hide' : 'Show'} details
          </button>
          {showLog && (
            <pre className="mt-2 max-h-56 overflow-auto rounded-[var(--radius)] bg-[color:var(--color-bg)] p-3 text-[12px] leading-relaxed text-[color:var(--color-muted)]">
              {stream.logs.map((l, i) => (
                <div key={i}>
                  <span className="text-[color:var(--color-faint)]">{l.step}</span>  {l.line}
                </div>
              ))}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
