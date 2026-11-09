'use client';

import { EyeTestStudio } from '@/components/EyeTestStudio';
import { TopBar } from '@/components/TopBar';

/**
 * Standalone route for the Eye Test studio. The same studio also lives on
 * the dashboard ( / ) whenever "Eye test" is the selected content type —
 * this page is just a direct link to it.
 */
export default function EyeTestStudioPage() {
  return (
    <div className="min-h-dvh bg-[color:var(--color-bg)]">
      <TopBar />
      <main className="mx-auto max-w-[1000px] px-6 pb-24">
        <header className="pt-6 pb-5">
          <h1 className="text-[22px] font-semibold tracking-tight">Eye Test Studio</h1>
          <p className="mt-1 text-[14px] text-[color:var(--color-muted)]">
            Reroll seeds until you like a run, then render it — the finished clip has the
            target highlight, the freeze-and-reveal beat, sound, and a caption baked in.
          </p>
        </header>
        <EyeTestStudio />
      </main>
    </div>
  );
}
