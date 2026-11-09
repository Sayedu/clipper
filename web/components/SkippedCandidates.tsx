'use client';

import type { SkippedCandidate } from '@/lib/types';

export function SkippedCandidates({
  skipped,
  considering,
}: {
  skipped: SkippedCandidate[];
  considering: { title: string; rank: number; total: number } | null;
}) {
  if (!skipped.length && !considering) return null;

  return (
    <div className="mb-8 rounded-[var(--radius)] border border-[color:var(--color-hairline)] px-4 py-3.5">
      <p className="mb-2.5 text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-faint)]">
        Looking for a video that fits
      </p>
      <ul className="space-y-2">
        {skipped.map((s) => (
          <li key={s.videoId} className="flex items-start gap-2.5 text-[13px]">
            <span className="mt-[3px] text-[color:var(--color-faint)]">✕</span>
            <span className="min-w-0">
              <span className="text-[color:var(--color-muted)] line-through">{s.title}</span>
              <span className="ml-1.5 text-[color:var(--color-muted)]">— {s.reason}</span>
            </span>
          </li>
        ))}
        {considering && (
          <li className="flex items-start gap-2.5 text-[13px]">
            <span className="mt-[5px] inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-[color:var(--color-accent)]" />
            <span className="min-w-0 text-[color:var(--color-text)]">
              <span className="font-medium">Trying:</span> {considering.title}
              <span className="ml-1.5 text-[color:var(--color-muted)]">
                (video {considering.rank + 1} of {considering.total})
              </span>
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}
