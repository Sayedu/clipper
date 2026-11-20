'use client';

import { TopBar } from '@/components/TopBar';

/**
 * Follow the Target: a self-contained 9:16 shuffle-video generator. The whole
 * tool (canvas renderer, procedural Web Audio, recorder) is one HTML file in
 * public/generators, shown here in a same-origin frame so its Record button
 * can download the finished video straight from the browser.
 */
export default function FollowTheTargetPage() {
  return (
    <div className="min-h-dvh bg-[color:var(--color-bg)]">
      <TopBar />
      <main className="mx-auto max-w-[1240px] px-4 pb-10 sm:px-6">
        <header className="pb-4 pt-5">
          <h1 className="text-[22px] font-semibold tracking-tight">Follow the Target</h1>
          <p className="mt-1 max-w-[760px] text-[14px] text-[color:var(--color-muted)]">
            Generates a new shuffle challenge every time: cups, parked cars, jets, eggs or boxes, vault coins, or Infinite, which uses any object you can think of. The target
            is shown for two seconds, the shuffle runs, and the video ends on numbered items with no reveal. Press
            Record &amp; Download to save a 1080 × 1920 video with sound. Keep this tab in front while it records.
          </p>
        </header>
        <iframe
          src="/generators/follow-the-target.html"
          title="Follow the Target generator"
          allow="autoplay; clipboard-write"
          className="block w-full rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[#080a0f]"
          style={{ height: 'max(780px, calc(100dvh - 150px))' }}
        />
      </main>
    </div>
  );
}
