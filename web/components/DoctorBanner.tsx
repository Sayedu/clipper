'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { DoctorReport } from '@/lib/types';

export function DoctorBanner() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    api.doctor().then(setReport).catch(() => setReport(null));
  }, []);

  if (!report || dismissed) return null;
  const problems = report.checks.filter((c) => c.status !== 'ok');
  if (!problems.length) return null;

  const blocking = problems.some((c) => c.critical && c.status === 'fail');

  return (
    <div className="mb-10 rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
      <div className="flex items-start justify-between gap-4">
        <p className="text-[14px] font-medium">
          {blocking ? 'Setup needs attention before you can run the pipeline' : 'A couple of optional things aren’t set up'}
        </p>
        {!blocking && (
          <button
            onClick={() => setDismissed(true)}
            className="text-[13px] text-[color:var(--color-muted)] hover:text-[color:var(--color-text)]"
          >
            Dismiss
          </button>
        )}
      </div>
      <ul className="mt-3 space-y-2.5">
        {problems.map((c) => (
          <li key={c.name} className="text-[13px]">
            <span className={c.status === 'fail' ? 'text-[color:var(--color-danger)]' : 'text-[color:var(--color-muted)]'}>
              {c.status === 'fail' ? '✗' : '!'} {c.name}
            </span>{' '}
            <span className="text-[color:var(--color-muted)]">— {c.detail}</span>
            {c.fix && (
              <code className="mt-1 block w-fit rounded bg-[color:var(--color-bg)] px-2 py-1 text-[12px] text-[color:var(--color-text)]">
                {c.fix}
              </code>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
