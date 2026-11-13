'use client';

import { ColorwarsStudio } from '@/components/ColorwarsStudio';
import { TopBar } from '@/components/TopBar';

/**
 * Standalone route for the Color Wars League studio. Pick one of the six
 * events, reroll until the preview looks good, then render it — the engine
 * (colorwars/) stays the single source of truth; this page only talks to
 * its local API at /colorwars-api (proxied, same-origin, see next.config.ts).
 */
export default function ColorwarsStudioPage() {
  return (
    <div className="min-h-dvh bg-[color:var(--color-bg)]">
      <TopBar />
      <main className="mx-auto max-w-[1000px] px-6 pb-24">
        <header className="pt-6 pb-5">
          <h1 className="text-[22px] font-semibold tracking-tight">Color Wars League Studio</h1>
          <p className="mt-1 text-[14px] text-[color:var(--color-muted)]">
            Pick an event, reroll until the preview looks good, then render it — same physics
            engine, same seed, full quality.
          </p>
        </header>
        <ColorwarsStudio />
      </main>
    </div>
  );
}
