'use client';

import { ColorWarSeasonStudio } from '@/components/ColorWarSeasonStudio';
import { TopBar } from '@/components/TopBar';

/**
 * Color War Season Mode — plan a whole season's episode outcomes (every
 * episode a nail-biter or a comeback, standings tight until the last couple),
 * review the plan, then render every episode back-to-back. Sits alongside the
 * single-video studio at /colorwar, not instead of it.
 */
export default function ColorWarSeasonPage() {
  return (
    <div className="min-h-dvh bg-[color:var(--color-bg)]">
      <TopBar />
      <main className="mx-auto max-w-[720px] px-6 pb-24">
        <header className="pt-6 pb-5">
          <h1 className="text-[22px] font-semibold tracking-tight">Color War — Season Mode</h1>
          <p className="mt-1 text-[14px] text-[color:var(--color-muted)]">
            A whole season of episodes, planned up front — tight standings, a losing-streak comeback
            story, and a title race that comes down to the wire.
          </p>
        </header>
        <ColorWarSeasonStudio />
      </main>
    </div>
  );
}
