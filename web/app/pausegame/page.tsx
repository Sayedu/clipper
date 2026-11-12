'use client';

import { PauseGameStudio } from '@/components/PauseGameStudio';
import { TopBar } from '@/components/TopBar';

/**
 * Standalone route for the Pause Game studio. The same studio also lives on
 * the dashboard ( / ) whenever "Pause game" is the selected content type —
 * this page is just a direct link to it.
 */
export default function PauseGameStudioPage() {
  return (
    <div className="min-h-dvh bg-[color:var(--color-bg)]">
      <TopBar />
      <main className="mx-auto max-w-[1000px] px-6 pb-24">
        <header className="pt-6 pb-5">
          <h1 className="text-[22px] font-semibold tracking-tight">Pause Game Studio</h1>
          <p className="mt-1 text-[14px] text-[color:var(--color-muted)]">
            Tune the target size and sweep speed, reroll for a different neon accent, then
            render it — the finished clip loops seamlessly, with a chime baked in each time
            the needle crosses the green.
          </p>
        </header>
        <PauseGameStudio />
      </main>
    </div>
  );
}
