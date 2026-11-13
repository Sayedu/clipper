import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * End-to-end: open the studio, pick Ring of Doom, randomize, run a quick
 * check, make a preview with a short test length, render in a fast test
 * mode, and confirm the new card appears in the library. Cleans up the
 * episode it creates afterward so repeated runs don't pile up in
 * colorwars/out/.
 */

interface LibraryCard {
  episode_dir: string;
}

async function listLibrary(request: APIRequestContext): Promise<LibraryCard[]> {
  const res = await request.get('/colorwars-api/library');
  const body = await res.json();
  return body.cards as LibraryCard[];
}

test('studio: setup, randomize, quick check, preview, fast render, library', async ({ page, request }) => {
  await page.goto('/colorwars');
  await expect(page.getByRole('heading', { name: 'Color Wars League — Studio' })).toBeVisible();

  // --- Setup: pick Ring of Doom, randomize, shorten the target window so
  // the render below stays fast -----------------------------------------
  await page.getByLabel('Event').selectOption({ label: 'Ring of Doom' });
  await page.getByRole('button', { name: 'Randomize' }).click();

  await page.getByLabel('Target length window (sec)').first().fill('18');
  await page
    .locator('label:has-text("Target length window")')
    .locator('input[type="number"]')
    .nth(1)
    .fill('26');

  // --- Preview: quick check -------------------------------------------
  // Not every seed produces a valid run (Ring of Doom's own design: by
  // construction some seeds have no single survivor by the sim deadline,
  // independent of the duration window above) -- reroll until one does,
  // the same thing the engine's own `find-seed` does on the CLI side.
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  let validSeedFound = false;
  for (let attempt = 0; attempt < 15 && !validSeedFound; attempt++) {
    await page.getByRole('button', { name: 'Run quick check' }).click();
    await expect(page.getByText('Winner', { exact: true })).toBeVisible({ timeout: 30_000 });
    const invalid = await page.getByText('did not produce a valid run').isVisible();
    if (!invalid) {
      validSeedFound = true;
    } else {
      await page.getByRole('button', { name: 'Setup', exact: true }).click();
      await page.getByRole('button', { name: 'Reroll seed' }).click();
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
    }
  }
  expect(validSeedFound).toBe(true);

  // library cards created by this test, tracked from before the FIRST
  // render (the Preview tab's own "Render preview" also lands a card in
  // out/ -- found directly: the Render tab's own before/after diff only
  // ever caught the second render, silently orphaning the first one every
  // single run) so everything this test creates gets cleaned up at the end.
  const beforeAnyRender = await listLibrary(request);
  const beforeIds = new Set(beforeAnyRender.map((c) => c.episode_dir));

  // --- Preview: a short preview-quality video ------------------------
  // Randomized ball counts/speeds can make some configs genuinely slower to
  // simulate and render than others -- generous, not tight, timeouts here.
  await page.getByRole('button', { name: 'Render preview' }).click();
  await expect(page.locator('video').first()).toBeVisible({ timeout: 180_000 });

  // --- Render: fast test mode, queue, wait for completion ------------
  // captured again right here (not reusing beforeIds from above) so the
  // diff below isolates only THIS render's card, not the preview one too.
  const beforeFinalRender = await listLibrary(request);
  const beforeFinalIds = new Set(beforeFinalRender.map((c) => c.episode_dir));

  await page.getByRole('button', { name: 'Render', exact: true }).click();
  await page.getByRole('button', { name: 'Fast test (540×960)' }).click();
  await page.getByRole('button', { name: 'Queue render' }).click();
  await expect(page.getByText('queued').or(page.getByText('running'))).toBeVisible({ timeout: 10_000 });

  await expect(async () => {
    const after = await listLibrary(request);
    expect(after.some((c) => !beforeFinalIds.has(c.episode_dir))).toBe(true);
  }).toPass({ timeout: 180_000, intervals: [2000] });

  // --- Library: the new card is actually visible in the UI -----------
  // The render already finished (confirmed via the API poll above), so the
  // Library panel's mount-time fetch picks it up without needing a reload.
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.getByText('Seed').first()).toBeVisible({ timeout: 15_000 });

  // cleanup -- delete everything this test created (both the preview render
  // and the final one), not just the last one, so repeated runs don't pile
  // up in the real colorwars/out/.
  const final = await listLibrary(request);
  for (const card of final) {
    if (!beforeIds.has(card.episode_dir)) {
      await request.delete(`/colorwars-api/library/${card.episode_dir}`);
    }
  }
});
