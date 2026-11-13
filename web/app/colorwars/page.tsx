'use client';

import { useState } from 'react';
import { TopBar } from '@/components/TopBar';
import { SegmentedControl } from '@/components/ui';
import { useStudioState } from '@/components/colorwars/useStudioState';
import { SetupPanel } from '@/components/colorwars/SetupPanel';
import { PreviewPanel } from '@/components/colorwars/PreviewPanel';
import { MinePanel } from '@/components/colorwars/MinePanel';
import { RenderPanel } from '@/components/colorwars/RenderPanel';
import { LibraryPanel } from '@/components/colorwars/LibraryPanel';
import { LeaguePanel } from '@/components/colorwars/LeaguePanel';

type Tab = 'setup' | 'preview' | 'mine' | 'render' | 'library' | 'league';

const TABS: { value: Tab; label: string }[] = [
  { value: 'setup', label: 'Setup' },
  { value: 'preview', label: 'Preview' },
  { value: 'mine', label: 'Story director' },
  { value: 'render', label: 'Render' },
  { value: 'library', label: 'Library' },
  { value: 'league', label: 'League' },
];

/**
 * Color Wars League Studio — set up, randomize, preview and render any of
 * the six colorwars events as many times as you like. The Python engine
 * (colorwars/) stays the single source of truth; this page only talks to
 * its local API at /colorwars-api (proxied, same-origin, see next.config.ts).
 */
export default function ColorwarsStudioPage() {
  const [tab, setTab] = useState<Tab>('setup');
  const studio = useStudioState();

  return (
    <div className="min-h-dvh bg-[color:var(--color-bg)]">
      <TopBar />
      <main className="mx-auto max-w-[900px] px-6 pb-24">
        <header className="pt-6 pb-5">
          <h1 className="text-[22px] font-semibold tracking-tight">Color Wars League — Studio</h1>
          <p className="mt-1 text-[14px] text-[color:var(--color-muted)]">
            Set up, randomize, preview and render any event as many times as you like.
          </p>
        </header>

        <div className="mb-6 overflow-x-auto">
          <SegmentedControl value={tab} onChange={setTab} options={TABS} />
        </div>

        {tab === 'setup' && <SetupPanel studio={studio} />}
        {tab === 'preview' && <PreviewPanel studio={studio} />}
        {tab === 'mine' && <MinePanel studio={studio} />}
        {tab === 'render' && <RenderPanel studio={studio} />}
        {tab === 'library' && <LibraryPanel studio={studio} />}
        {tab === 'league' && <LeaguePanel studio={studio} />}
      </main>
    </div>
  );
}
