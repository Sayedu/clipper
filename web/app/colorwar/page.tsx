'use client';

import { ColorWarStudio } from '@/components/ColorWarStudio';
import { TopBar } from '@/components/TopBar';

/**
 * Standalone route for the Color War studio. The same studio also lives on the
 * dashboard ( / ) whenever "Color war" is the selected content type — this page
 * is just a direct link to it.
 */
export default function ColorWarStudioPage() {
  return (
    <div className="min-h-dvh bg-[color:var(--color-bg)]">
      <TopBar />
      <main className="mx-auto max-w-[1000px] px-6 pb-24">
        <header className="pt-6 pb-5">
          <h1 className="text-[22px] font-semibold tracking-tight">Color War Studio</h1>
          <p className="mt-1 text-[14px] text-[color:var(--color-muted)]">
            Reroll seeds until you like one, then render it — the finished clip has the
            &ldquo;Who Will Win?&rdquo; text, the TikTok-safe framing, sound, and a caption.
          </p>
        </header>
        <ColorWarStudio />
      </main>
    </div>
  );
}
