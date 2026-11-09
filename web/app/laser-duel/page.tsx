'use client';

import { LaserNationsStudio } from '@/components/LaserNationsStudio';
import { TopBar } from '@/components/TopBar';

/**
 * Standalone route for the Laser Nations: Duel studio. The same studio also
 * lives on the dashboard ( / ) whenever "Laser nations" is the selected
 * content type and duel mode is on — this page is just a direct link to it.
 */
export default function LaserDuelStudioPage() {
  return (
    <div className="min-h-dvh bg-[color:var(--color-bg)]">
      <TopBar />
      <main className="mx-auto max-w-[1000px] px-6 pb-24">
        <header className="pt-6 pb-5">
          <h1 className="text-[22px] font-semibold tracking-tight">Laser Nations: Duel</h1>
          <p className="mt-1 text-[14px] text-[color:var(--color-muted)]">
            Pick two fighters, decide who wins (or let it play out), then render — health
            bars, power-ups, and a fight-poster cover come free.
          </p>
        </header>
        <LaserNationsStudio />
      </main>
    </div>
  );
}
