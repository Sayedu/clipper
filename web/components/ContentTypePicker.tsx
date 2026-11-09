'use client';

import type { ContentType } from '@/lib/types';

const CONTENT_TYPES: Array<{ value: ContentType; label: string }> = [
  { value: 'colorrace', label: 'Color race' },
  { value: 'escaperace', label: 'Escape race' },
  { value: 'lasernations', label: 'Laser nations' },
  { value: 'colorwar', label: 'Color war' },
  { value: 'followball', label: 'Follow the ball' },
  { value: 'eyetest', label: 'Eye test' },
  { value: 'quotes', label: 'Reminders' },
];

const BLURB: Record<ContentType, string> = {
  colorrace:
    'A "which marble wins?" race down one of five obstacle courses — pick a course or leave it random. New map, new winner, a chase camera and a photo finish every time.',
  escaperace:
    'A "which color escapes first?" race — colored balls start caged in a stack of spinning neon rings and climb out one gap at a time. Constant near-misses, a new winner every run.',
  lasernations:
    'Four nations bounce around a neon arena leaving glowing laser trails and slicing each other’s — whoever holds the most territory when the clock runs out wins. Flags on the balls, a winner card at the end. Want a 1v1 fight instead — health bars, power-ups, pick who wins? Open "Laser Duel" in the top nav.',
  colorwar:
    'Four colors fight for a grid — every hit paints a stripe, paint-bomb pickups blow holes in the map, and a color that gets squeezed out is wiped. Last one alive wins. Reroll seeds in the studio below, then render and download the one you like.',
  followball:
    'The shell game — the ball is shown under a cup, the cups shuffle, you call the cup, the correct one lifts. Faster and more cups every round, and a score card at the end so viewers comment their score. Reroll seeds in the studio below, then render and download the one you like.',
  eyetest:
    'Ghost Object Tracker — identical balls in a neon arena, one flashes gold as the target, then they all bounce off each other for real while the arena spins. Freeze hits, numbers fade in, and you find out if you actually tracked it. Set your own rounds, balls per round, and mix length in the studio below, reroll seeds, then render and download the one you like.',
  quotes:
    'A silent, 15-second reminder card — a short setup line settles in, a beat of pause, then a punch line lands. Original, hard-hitting advice inspired by broad Quranic/Hadith themes (not literal ayahs or hadith), over a dark warm background with drifting light. No sound. Reroll seeds in the studio below for a different line, then render and download the one you like.',
};

/**
 * The content-type grid + blurb, shared by the Settings form and the dashboard's
 * Color War studio view (so you can switch away from the studio).
 */
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
    <div>
      <div className="mb-3 text-[14px] font-medium">Content type</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {CONTENT_TYPES.map((c) => {
          const on = value === c.value;
          return (
            <button
              key={c.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(c.value)}
              className={`rounded-[var(--radius)] border px-3 py-2.5 text-[13px] font-semibold transition-colors disabled:opacity-50 ${
                on
                  ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent-hover)]'
                  : 'border-[color:var(--color-hairline-strong)] text-[color:var(--color-muted)] hover:border-[color:var(--color-muted)]'
              }`}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      <p className="mt-4 rounded-[var(--radius)] bg-[color:var(--color-surface)] px-4 py-3 text-[13px] text-[color:var(--color-muted)]">
        {BLURB[value]}
      </p>
    </div>
  );
}
