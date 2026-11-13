import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * End-to-end: open the studio (defaults to Ring of Doom), randomize until a
 * seed produces a valid preview, render it, and confirm a new render lands
 * in colorwars/out/ (the studio page itself has no library browser -- it's
 * one page, same shape as the other game studios -- so this checks the
 * engine's own API directly for that last part). Cleans up the episode it
 * creates afterward so repeated runs don't pile up in colorwars/out/.
 */

interface LibraryCard {
  episode_dir: string;
}

async function listLibrary(request: APIRequestContext): Promise<LibraryCard[]> {
  const res = await request.get('/colorwars-api/library');
  const body = await res.json();
  return body.cards as LibraryCard[];
}

interface JobRow {
  status: string;
}

// The page's own background preview render and the test's explicit final
// render are two separate jobs, and jobs run one at a time -- whichever was
// *created* later runs second. Found directly: clicking "Render this seed"
// can win the race against the component's own (slightly later) preview-
// render job creation, so the preview job is still queued/running when the
// final render finishes and the test's cleanup check fires, leaking an
// episode that finishes rendering after the test has already exited.
async function waitForAllJobsToSettle(request: APIRequestContext, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request.get('/colorwars-api/jobs');
    const jobs = (await res.json()).jobs as JobRow[];
    if (!jobs.some((j) => j.status === 'queued' || j.status === 'running')) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

test('studio: randomize, preview, render, lands in the library', async ({ page, request }) => {
  const beforeIds = new Set((await listLibrary(request)).map((c) => c.episode_dir));

  await page.goto('/colorwars');
  await expect(page.getByRole('heading', { name: 'Color Wars League Studio' })).toBeVisible();

  // the event defaults to Ring of Doom and previews itself on load. Not
  // every seed produces a valid run (by design -- same thing the engine's
  // own `find-seed` does on the CLI side), but the page now retries with
  // new seeds on its own until it finds one (found directly: the default
  // starting seed isn't always valid, and the page used to just sit there
  // with nothing to show) -- just wait for it to settle.
  await expect(page.getByText(/Winner|work out/)).toBeVisible({ timeout: 30_000 });
  // "work out" alone, no apostrophe -- the component renders a curly one
  // (&rsquo;) that a plain "didn't" string never matches.
  await expect(page.getByText('work out')).not.toBeVisible();

  // --- Render: full quality (this page has no separate fast-test mode --
  // generous timeout instead, matching the other studios' own render step).
  await page.getByRole('button', { name: 'Render this seed' }).click();
  await expect(page.getByRole('button', { name: 'Download to your computer' })).toBeVisible({ timeout: 240_000 });
  await expect(page.locator('video').first()).toBeVisible();

  // --- confirm it actually landed in the engine's own library -----------
  await expect(async () => {
    const after = await listLibrary(request);
    expect(after.some((c) => !beforeIds.has(c.episode_dir))).toBe(true);
  }).toPass({ timeout: 10_000, intervals: [500] });

  // cleanup -- the page itself also auto-renders a background preview clip
  // (on load and on every reroll), which lands its own episode in out/ just
  // like the final render does; delete everything new, not just the one
  // the assertion above found, so repeated runs don't pile up. Wait for
  // every job (not just the final render) to actually finish first -- see
  // waitForAllJobsToSettle's own comment for why that race is real.
  await waitForAllJobsToSettle(request);
  const after = await listLibrary(request);
  for (const card of after) {
    if (!beforeIds.has(card.episode_dir)) {
      await request.delete(`/colorwars-api/library/${card.episode_dir}`);
    }
  }
});
