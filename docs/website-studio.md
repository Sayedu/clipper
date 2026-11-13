# Website Studio brief

You built the colorwars engine in this project (all 5 phases). Now add all of it to my website, which is in this same project, as a studio page where I can set up, randomize, preview and render simulations as many times as I want.

BEFORE YOU START
Commit everything to git so it can all be undone. Tell me your plan in 3 lines, then build it without waiting for me.

HOW IT CONNECTS
- Do not rewrite the engine in JavaScript. Python stays the single source of truth.
- Add a small local API (FastAPI or similar) that imports the engine directly. If my site already has a Python backend, add the routes there instead.
- The website calls that API. Everything binds to localhost only.
- Renders run as background jobs, one at a time by default, with job state saved to disk so a page refresh never loses a job.
- Never build shell commands from user input. Pass arguments as lists.
- Serve videos and images only from the engine's out folder, with range requests so the video player can seek.
- One command starts the site and the API together. Document it in the README.

THE STUDIO PAGE
Add it to my site's navigation, reuse my site's layout and styling, and do not change my existing pages.

1. Setup
- Pick any of the six events.
- Give the Event interface a params schema if it does not have one: name, label, type, default, min, max, options, help text and whether it can be randomized. Build the form from the schema so future events get controls automatically.
- Every setting gets a lock toggle. Randomize picks a new seed and random values for every unlocked setting within its allowed range. Also add Reroll seed only and Reset to defaults.
- Cover at least: seed, ball counts, team trait strengths, hazard and disaster frequency, hook line (auto storyline or custom text), crown team (from standings or override), names (from the queue or typed in), target length window, slow motion amounts and audio volumes. If any of these is hardcoded, move it into the event's config. Expose every other setting the engine already supports.
- Do not add new gameplay features in this task. List any you think are missing and I will decide.
- Save and load named presets as JSON files in a presets folder.

2. Preview before rendering
- Quick check: run only the simulation and show the result within seconds: winner, placements, MVP, final video length, drama score, lead changes, near misses and a timeline of key moments. Flag any run outside 61 to 70 seconds.
- Filmstrip: 6 real still frames from across the video, rendered by the engine.
- Preview video: the engine's 540x960 preview mode, playing in the page.
- Preview and final render use the identical config and seed, so the final shows exactly the same outcome at full quality.

3. Find the best run
- A story director panel: number of runs plus the story flags (winner, not winner, comeback, minimum lead changes, photo finish). Show progress, then a table of the top seeds with their stats. Clicking a row loads it into Setup and runs a quick check.

4. Render
- Render final adds the current config to the queue. Show frames done and time left, allow cancel, and allow queuing more.
- Make N: randomize, mine and render N different episodes in a row.

5. Library
- A card for every render: video player, cover, caption and pinned comment with copy buttons, plus seed, event, length, placements, MVP and drama score.
- Buttons: Render again with these settings, Load into setup, Download, Delete (with a confirm).

6. League
- Standings, crown team, top storyline candidates and head to head records.
- Names queue: paste raw TikTok comments, parse them into team plus name, show accepted and rejected names with the reason (blocklist, too long, bad characters), then save to the queue. Show used names too.
- Commit episode with a confirm step, because it changes the standings. Never commit automatically.

TESTS
- API tests with pytest.
- A Playwright end to end test: open the studio, pick Ring of Doom, randomize, run a quick check, make a preview with a short test length, render in a fast test mode and confirm the new card appears in the library.
- My existing pages and tests must still work.

DONE WHEN
From my site I can pick any event, lock or randomize every setting, see the quick check, filmstrip and preview, mine for the best run, queue final renders, copy captions from the library, and manage the names queue and standings. All tests pass and nothing already on my site is broken. Save this brief to docs/website-studio.md and update CLAUDE.md.
