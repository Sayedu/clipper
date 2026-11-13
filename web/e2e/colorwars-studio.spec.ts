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

test('studio: randomize, preview, render, lands in the library', async ({ page, request }) => {
  const beforeIds = new Set((await listLibrary(request)).map((c) => c.episode_dir));

  await page.goto('/colorwars');
  await expect(page.getByRole('heading', { name: 'Color Wars League Studio' })).toBeVisible();

  // the event defaults to Ring of Doom and previews itself on load -- just
  // wait for that first preview, then reroll if this particular seed didn't
  // produce a valid run (by design, not every seed does -- same thing the
  // engine's own `find-seed` does on the CLI side).
  let validSeedFound = false;
  for (let attempt = 0; attempt < 15 && !validSeedFound; attempt++) {
    await expect(page.getByText(/Winner|didn.t work out/)).toBeVisible({ timeout: 30_000 });
    const invalid = await page.getByText("didn't work out").isVisible();
    if (!invalid) {
      validSeedFound = true;
    } else {
      await page.getByRole('button', { name: 'Randomize — new seed' }).click();
    }
  }
  expect(validSeedFound).toBe(true);

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
  // the assertion above found, so repeated runs don't pile up.
  const after = await listLibrary(request);
  for (const card of after) {
    if (!beforeIds.has(card.episode_dir)) {
      await request.delete(`/colorwars-api/library/${card.episode_dir}`);
    }
  }
});
