'use client';

import { QuotesStudio } from '@/components/QuotesStudio';
import { TopBar } from '@/components/TopBar';

/**
 * Standalone route for the Reminders studio. The same studio also lives on
 * the dashboard ( / ) whenever "Reminders" is the selected content type —
 * this page is just a direct link to it.
 */
export default function QuotesStudioPage() {
  return (
    <div className="min-h-dvh bg-[color:var(--color-bg)]">
      <TopBar />
      <main className="mx-auto max-w-[1000px] px-6 pb-24">
        <header className="pt-6 pb-5">
          <h1 className="text-[22px] font-semibold tracking-tight">Reminders Studio</h1>
          <p className="mt-1 text-[14px] text-[color:var(--color-muted)]">
            Reroll seeds until you like the line, then render it — silent, dark, 15 seconds, with
            the TikTok-safe framing and a ready-to-paste caption baked in.
          </p>
        </header>
        <QuotesStudio />
      </main>
    </div>
  );
}
