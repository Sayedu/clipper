'use client';

import Link from 'next/link';
import type { ContentType } from '@/lib/types';
import { ContentTypeIcon } from './ContentTypeIcons';

const CONTENT_TYPES: Array<{ value: ContentType; label: string; hint: string }> = [
  { value: 'colorwar', label: 'Color war', hint: 'Four colors fight for a grid — last one alive wins.' },
  { value: 'followball', label: 'Follow the ball', hint: 'Shell game — call the cup, see if you were right.' },
  { value: 'eyetest', label: 'Eye test', hint: 'Track the gold ball through real collisions.' },
  { value: 'pausegame', label: 'Pause game', hint: 'Pause the needle the instant it turns green.' },
  { value: 'quotes', label: 'Reminders', hint: 'A silent 15s reminder card.' },
  { value: 'colorrace', label: 'Color race', hint: 'A marble race down a neon obstacle course.' },
  { value: 'escaperace', label: 'Escape race', hint: 'Balls climb out of spinning neon rings.' },
  { value: 'lasernations', label: 'Laser nations', hint: 'Four nations battle for territory, or 1v1 duel.' },
];

/** The content-type grid — icon + label, a one-line hint on hover. Shared by
 *  the Settings form and the dashboard's studio view. */
export function ContentTypePicker({
  value,
  onChange,
  disabled,
}: {
  value: ContentType;
  onChange: (v: ContentType) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {CONTENT_TYPES.map((c) => {
        const on = value === c.value;
        return (
          <button
            key={c.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(c.value)}
            title={c.hint}
            className={`flex flex-col items-center gap-2 rounded-[var(--radius)] border px-3 py-3.5 text-[12.5px] font-semibold transition-colors disabled:opacity-50 ${
              on
                ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent-hover)]'
                : 'border-[color:var(--color-hairline-strong)] text-[color:var(--color-muted)] hover:border-[color:var(--color-muted)]'
            }`}
          >
            <ContentTypeIcon type={c.value} className="h-5 w-5" />
            {c.label}
          </button>
        );
      })}
      {/* Follow the Target has its own page (a self-contained generator), so it
          is a link, not a selectable content type */}
      <Link
        href="/follow-the-target"
        title="Shuffle-video generator: cups, cars, jets, eggs, coins. Opens its own page."
        className="flex flex-col items-center gap-2 rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] px-3 py-3.5 text-[12.5px] font-semibold text-[color:var(--color-muted)] transition-colors hover:border-[color:var(--color-muted)]"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="3.2" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
        </svg>
        Follow the target
      </Link>
    </div>
  );
}
