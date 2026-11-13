# colorwars

A new section of the clipping website/app (same repo, same project) — a
Python engine that renders physics-simulation videos for the TikTok series
**Color Wars League**. Four color teams (Red, Blue, Green, Yellow) compete in
a different physics event every episode. Results feed season standings, the
standings leader wears a crown, and viewers get their names onto the balls by
commenting. Every video is 1080x1920, 60 fps, 61-70 seconds long, with fully
synthesized sound.

This lives at `colorwars/` inside the main `clipping` repo — not a separate
project or git repo. It now has its own section in the web dashboard (the
Studio, at `/colorwars`) the same way Color War / Follow The Ball / Eye Test /
Pause Game each have theirs — see "Website Studio" below.

## Plan (built one phase at a time — only the phase currently assigned gets built)

1. Core engine plus the first event, **Ring of Doom**: the last ball left inside a spinning ring wins. (done)
2. League layer (standings, crown, storylines, a viewer name queue) and a story director that simulates hundreds of seeds headless and picks the most dramatic real run. (done)
3. **Shell Shuffle**: a cup shuffle game where viewers track their team's ball. (done)
4. **Disaster Drop**: a vertical obstacle race with disasters and a crusher chasing the pack. (done)
5. **Turf War**, **Great Escape** and **Champion Duel** (events batch 2). (done)
6. **Website Studio**: all six events exposed as a page on the main dashboard — setup/randomize/preview/mine/render/library/league. (done)

## Rules for the whole project

- Only build the phase currently assigned. Design each phase so later phases plug in cleanly: every event is a plugin behind one shared `Event` interface, and every event reuses the same pipeline: **simulate → direct (the edit) → render → mix audio**.
- Everything is deterministic: the same event and seed always produce the identical video.
- Settings live in YAML/JSON config files, not hardcoded.
- A prior Three.js attempt failed on three fronts — no thrill, too short, marbles passing through obstacles. Prevent all three with small fixed physics steps, drama designed on purpose, and a hard 61-70 second length.
- One event that looks and feels great beats three that half work.
- End of every phase: run the tests, render a preview, export 6 still frames spread across the video and check them for layout, readability and text inside the safe area. Then commit to git and update this file with what's done and any decisions made.
- If a phase prompt conflicts with good engineering, flag it before changing anything.

## Decisions made before Phase 1

- ffmpeg: the project's shared ffmpeg binary should point at
  `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg` in config, not the bare `ffmpeg`
  on PATH — the PATH one is currently broken (missing libx265 dylib after a
  Homebrew upgrade). Same binary the rest of this repo already uses.
- Physics: custom fixed-step 2D physics (not pymunk/Chipmunk2D) — Chipmunk2D's
  solver isn't guaranteed bit-identical run to run, which would undermine the
  hard determinism requirement. More code up front, but a real guarantee
  instead of a hope.
- Renderer: Pillow + numpy by default (no display server, no GPU, simple
  install). pycairo is the fallback if nicer anti-aliasing/gradients turn out
  to matter once something is actually on screen.
- Determinism scope: same machine / same code reproducing identically — not
  claiming bit-identical output across different machines (float
  non-associativity would make that a much harder, likely unnecessary bar).
- Overlap with existing games elsewhere in this app (e.g. Shell Shuffle vs.
  the existing "Follow The Ball" shell game, Turf War vs. "Color War"): build
  it fresh in Python inside colorwars regardless — a different version, not
  a reuse or port of the existing JS/Canvas implementation. They can share a
  theme without sharing code.

## Status

**Phase 1: done.** **Phase 2: done.** **Phase 3 (Shell Shuffle): done.**
**Phase 4 (Disaster Drop): done.** **Events batch 2 (Turf War, Great
Escape, Champion Duel): done.** The league layer, storylines, the names
queue and the story director (`mine`) are all in. `render` and `find-seed`
build the episode from `league/season.json` automatically; `colorwars
commit <episode_id>` is the only thing that writes it. Six full events now
share the one render/audio/league/packaging pipeline -- Ring of Doom (real
physics, speed-stretched to fit the 61-70s window), Shell Shuffle (pure
choreography, no physics), Disaster Drop (real physics, course *length*
is the duration knob instead of a speed stretch), Turf War (no physics,
constant-speed grid bouncing), Great Escape (real physics, adaptive speed
like Ring of Doom, plus a season-wide theme song), Champion Duel (1v1, no
physics, its own `balance` auto-tuner and 3-episode `bracket` mode). See
`README.md` for every command, `docs/phase-1.md` / `docs/phase-2.md` /
`docs/event-shell-shuffle.md` / `docs/event-disaster-drop.md` /
`docs/events-batch-2.md` for the full briefs.

Real numbers on this machine, Phase 1: `find-seed` found seed 2 valid on
the 2nd try. Full render: 127s. `--preview` render: 28s.

Real numbers, Phase 2: `mine --runs 500` finished in **30.4s** (876% CPU,
~9 cores) and found **406 valid seeds** — the done-when bar was 5 in under
5 minutes. Full validation loop run for real: `mine` → `render --best`
(seed 194, score 38.4) → `commit ep001` → `render` again for ep002, which
correctly showed the real post-ep001 standings, crown (blue, the actual
winner), and a freshly generated storyline ("BLUE holds the crown by just
4 points.") instead of the Phase 1 placeholder text. Test episodes/season
state were reset afterward — the repo ships with a fresh, empty
`league/season.json` (real schema, zero episodes) rather than my test run's
results.

Real numbers, Phase 3: `mine --event shell_shuffle --runs 500` finished in
**1.7s** (no physics to simulate, just choreography) and found **500/500
valid seeds** — far above the done-when bar. Same full validation loop run
for real as Phase 2: `mine` → `render --best` (seed 19, score 18.0, winner
yellow, an upset against the default crown) → `commit ep001` → `render`
again for ep002, which correctly showed the post-ep001 standings and a
freshly generated crown-pressure storyline. Test episode/season/names-queue
state was reset afterward, same as Phase 2.

Real numbers, Phase 4: `mine --event disaster_drop --runs 300` finished in
**29.7s** and found **76/300 valid** (~25% -- see the decisions log on why
that rate, not Ring of Doom's ~80%+, is still the right call here), far
above the done-when bar. Top-ranked seeds showed real drama by design, not
luck: 10-13 lead changes, winning margins as tight as 0.66s. Same full
validation loop as the other phases: `mine` → `render --best` (seed 97,
score 54.5, winner blue) → `commit ep001` → `render` again for ep002,
which correctly showed the post-ep001 standings and a crown-pressure
storyline. Test state reset afterward.

Real numbers, events batch 2: all three events found **300/300 (or
500/500) valid seeds** in mining (Turf War ~2s, Great Escape ~10s,
Champion Duel <1s -- none of the three needed pymunk except Great
Escape's rotating rings, so most of this batch mines even faster than
Phase 3). Full `mine` → `render --best` → `commit` → `render` validation
loop run for real on all three, including confirming `league/theme.json`
(Great Escape's season melody) persists correctly across two separate
renders in the same season. `bracket` verified for real: a 3-episode run
produced the right semifinal pairings, correctly derived the final's
matchup from each semifinal's own meta.json (not from any premature
season.json write), and correctly bracket-specific hook lines
("SEMIFINAL 1: RED VS YELLOW", "THE FINAL: RED VS GREEN"). `balance` was
run for real at increasing scale (100 → 200 → 150 runs/matchup, up to 20
rounds) across several rounds of actual mechanical fixes -- see the
decisions log for the full story, including the one it didn't fully
solve.

Website Studio: a FastAPI service (`colorwars/studio_api/`) imports the
engine directly and exposes it as `/colorwars` on the main dashboard,
backed by a disk-saved, one-at-a-time render/mine job queue. The page
itself is deliberately **one page, no tabs** -- pick an event, Randomize
(or Find a great seed, a one-click mining run with no exposed filters),
check the preview strip + outcome readout, hit Render, get a video +
download, same shape as every other single-game studio in this app
(FollowBallStudio etc.) rather than the much deeper tabbed Setup/Preview/
Story-director/Render/Library/League design built first and then cut back
after it proved too complex to actually use comfortably. The full generic
params schema, presets, locks, mining filters, and the library/league API
routes still exist server-side (nothing was removed from `studio_api/`)
-- they're just not surfaced by this simplified page; a future pass could
expose any of them again behind something less overwhelming than a form
with 30+ visible fields. `npm run dev` launches the API alongside the
worker and the dashboard; the browser never talks to it directly (a same-
origin Next.js rewrite, same pattern as `/worker`). 34 Python tests pass
(17 engine + 17 API tests) and the Playwright E2E spec (randomize → wait
for a valid preview → render → confirm it lands in the engine's own
library) passes reliably. Several real bugs were found and fixed by
actually using the finished thing, not just by building it -- see the
decisions log.

## Decisions log

### Website Studio

- **The first version of this page was one page too many: a 6-tab Setup/
  Preview/Story-director/Render/Library/League design, built exactly to
  the original brief's letter.** Told directly it was too hard to use and
  should be "one page, easy like the others" (the other single-game
  studios in this app). Rebuilt as one page, no tabs, modeled directly on
  `FollowBallStudio.tsx`'s actual shape rather than re-deriving "easy"
  from first principles -- a small preview column, two or three primary
  buttons, one render action that shows progress inline then the result
  in place. The deep version's backend (full params schema, presets,
  locks, mining filters, library/league routes) was left alone and still
  works -- only the frontend was cut back, since none of that capability
  was the problem, the six-tab *surface* was.
- **`JobStore._write()` crashed with an opaque `FileNotFoundError` if
  `out/_studio_jobs/` didn't exist at write time** -- it's only created
  once, in `__init__`, which only ever runs once for the long-running API
  process. Found for real: an `out/` cleanup mid-session (while the API
  was still up) removed that directory, and the very next render/mine job
  creation crashed. The frontend's own `alert()` on that failure made it
  worse in an automated test specifically -- Playwright auto-dismisses JS
  dialogs it isn't told to handle, so the real error silently vanished
  and the test just looked like the render button did nothing. Fixed by
  making `_write()` recreate the directory defensively on every write,
  not just trust it was already there.
- **A test cleanup fixture deleted a real render a person had just made
  through the UI.** `test_studio_api.py`'s teardown matched episode
  directories by NAME PATTERN (`ep*_<8-char-id>`) to decide what to
  delete -- the exact same pattern every real render also uses, since
  real and test renders are created the same way. Running the pytest
  suite after a manual render destroyed it. Fixed by snapshotting
  `out/`'s contents before each test and diffing after, so teardown only
  ever removes directories that specific test actually created, never a
  name-pattern guess -- verified directly with a planted fake "real"
  render that survived a full test run only after the fix.
- **A real, user-reported bug, found the day this shipped: Ring of Doom
  balls visually passing straight through a "solid" section of the
  wall.** Root cause was structural, not a one-off: `draw_frame()` never
  received the `event_cfg` that `simulate()`/`direct()` actually ran
  with -- every event's renderer either hardcoded geometry constants that
  duplicated the YAML (`RING_RADIUS`/`RING_CENTER`/a bare `96` for Ring of
  Doom's segment count; `GRID_SIZE` for Turf War, which even had a comment
  flagging it; `CUP_RADIUS`/`LIFT_HEIGHT` for Shell Shuffle) or reloaded
  the config fresh from disk with a cache keyed by seed alone (Disaster
  Drop, Great Escape) or forever (Champion Duel's cache was never
  invalidated at all, for the life of the process). None of this mattered
  before this phase -- nothing could override an event's config at
  render time until the Studio's Randomize existed. Fixed by adding
  `event_cfg: dict` to the shared `Event.draw_frame()` signature (and
  `render_video()`'s), threading the real cfg through every call site
  (the CLI render path, `studio_api/filmstrip.py`, and all 6 determinism
  tests), and having each event's draw.py read ring/grid/course/arena
  geometry from it instead of a stale value. Verified directly, not just
  by re-running tests: overrode `ring.radius`/`ring.segments` via the API
  and confirmed the rendered wall now sits exactly where the balls
  physically are, by rendering and visually inspecting a frame before and
  after the fix.
- **Randomize could hand Ring of Doom a config no seed could ever satisfy
  -- found by the Playwright E2E test itself, not assumed safe.** Two
  distinct causes, both from the same root (the generic Advanced-group
  param walker ranges every leaf independently, with no notion of which
  leaves are related): (1) `_heuristic_range()` floors every positive
  leaf's range at 0, so an int field like `ring.segments` could Randomize
  down to exactly 0 -- an unconditional `ZeroDivisionError` in both
  sim.py and draw.py (`360.0 / segments`). Fixed generically in
  `params.py`: any int whose own default isn't already 0 gets its floor
  raised to 1, covering every count/segments/Hz-like field across all six
  events at once, not just Ring of Doom's. (2) `elimination_radius` and
  `ring.radius` are randomized independently with overlapping ranges;
  landing `elimination_radius <= ring.radius` eliminates balls at the
  wall instead of past it, making a clean single-survivor outcome
  rare-to-impossible for every seed, not just an unlucky one -- no amount
  of "Reroll seed" fixes a bad *config*. Same failure mode existed for
  `timing.sim_deadline_sec` (the sim's only real stopping condition)
  randomized down near 0, leaving no time to ever resolve. Fixed by
  curating these three fields for Ring of Doom with ranges chosen so
  `elimination_radius > ring.radius` always holds and the deadline always
  leaves real time to play out, rather than leaving them to the generic
  fallback. This was found through an actual stress-test loop (reroll up
  to 15 times on an invalid quick-check, mirroring the engine's own
  `find-seed`), not by reasoning about ranges on paper -- a raw
  before/after comparison script is what proved the fix (0/5 clean runs
  before, 8/8 after for the segment fix, then a further fix after the
  E2E test still intermittently failed on the deadline/elimination-radius
  case).
- **Removed Ring of Doom's glow effects (the ring's blurred glow stroke,
  each ball's soft halo sprite) on request, for a sharper/crisper look.**
  Scoped to Ring of Doom only, not applied to the other five events --
  flagged to the user as something to extend on request rather than
  assumed to be wanted everywhere.
- **The Library's "render again with these settings" needs the original
  Setup overrides back, and `meta.json` never stored them** (only
  derived outcomes -- seed, winner, placements). Rather than cross-
  referencing the job store (job files aren't kept forever the way
  `out/<episode>/` is), `render_worker.py` now folds the job's own
  `overrides`/`episode_overrides` into `meta.json` itself right after
  `run_render()` returns, so the full config is always recoverable
  directly from the episode's own folder.
- **Render jobs can't be named after the season's next episode id.**
  `episode["id"]` comes from `len(season["episodes"]) + 1`, which doesn't
  change until `commit` -- two renders queued back to back (exactly what
  "Make N" does) would otherwise both resolve to the same `out/ep004`
  folder and overwrite each other mid-render. Each render job's folder is
  suffixed with its own (always-unique) job id instead; the human-
  readable episode id still lives inside `meta.json`/the caption for
  `commit` to use.
- **A canceled render now deletes its own output directory.** Canceling
  mid-render previously left a half-written `_video_only.mp4` and an
  empty folder behind every time -- this job system expects to be run
  and canceled often, so that would have accumulated as real clutter, not
  a one-off.
- **"Make N" has no backend route.** Randomizing needs the params schema
  and the Setup form's lock state, which only the frontend has -- it
  composes the existing `/jobs/mine` and `/jobs/render` building blocks
  itself (randomize, mine, read the top seed, queue a render, repeat),
  rather than duplicating that logic server-side.
- **`/league/commit` is never called by anything automated, including
  this project's own tests.** The brief's "never commit automatically"
  rule was read literally: the pytest suite exercises the route's 404
  path only, never a real commit, since that would mutate the real
  season standings as a side effect of running tests.
- **The Setup form was initially missing an audio volume control** --
  `run_render()`/`build_bus()` already supported a `volume_mult`
  multiplier (added this phase for exactly this), but nothing in the UI
  ever set it to anything but the 1.0 default, missing the brief's own
  "cover at least: ... audio volumes" line. Fixed: a volume slider (with
  its own lock toggle, included in Randomize like every other setting)
  now lives in Setup and is threaded through every render-job-creating
  call (Preview's preview render, Render's queue button, Make N).
- **Known limitations, not fixed this phase:** the same hardcoded-
  geometry risk this phase found and fixed for Ring of Doom's wall (and
  Disaster Drop / Great Escape / Champion Duel's disk-reload caches)
  likely has smaller-scale cousins in the other events' decorative
  constants that don't move ball positions (e.g. Shell Shuffle's
  `table.center`, Turf War's `grid.origin`) -- left alone because they're
  lists, which the generic param walker never exposes as randomizable, so
  they're not reachable from the Studio today. The heuristic-range audit
  above covered Ring of Doom specifically (where it was found); the other
  five events' Advanced-group fields weren't individually re-audited for
  the same zero/incoherent-pair risk -- the same class of bug (a field
  that can zero out or invert against a related field) could in principle
  still exist for e.g. Disaster Drop's `course.modules_min`/`modules_max`
  or Champion Duel's `champion.hp`/`contact_damage`, just not found yet.

### Gameplay features noticed as missing while building the Studio (not built -- per "do not add new gameplay features in this task," flagged for a decision)

- **No way to preview or render a Champion Duel bracket (3-episode semis
  + final) from the Studio** -- `colorwars bracket` only exists as a CLI
  command; the Studio's Setup/Render flow is built around one episode at
  a time.
- **No UI for `colorwars balance`** (Champion Duel's auto-tuner for
  `teams.yaml`'s `duel_power` per team) -- still CLI-only.
- **No per-event validity/duration-window diagnostics beyond the raw
  pass/fail quick check** -- e.g. Disaster Drop's own ~25% seed-validity
  rate (real, by design -- see Phase 4's decisions) gives no on-screen
  hint to a Studio user about *why* several rerolls in a row failed,
  unlike the targeted fix this phase made for Ring of Doom's specific
  failure modes.
- **No cross-field validation at the schema level** -- Setup can't
  express "these two numbers must stay in this relationship" generically;
  each case (like Ring of Doom's elimination_radius > ring.radius) has to
  be hand-curated per event as it's found, not caught automatically.
- **Mining only supports Ring of Doom's drama vocabulary of filters**
  (winner / not winner / comeback / min lead changes / photo finish) --
  `MineFilters`' fields are the same across all events, but a filter like
  "comeback" is meaningless for e.g. Shell Shuffle's drama_stats(), the
  same cross-event-filter gap Phase 3 already flagged for the CLI.
- **No audio preview** (hearing cue sounds/music before committing to a
  full render) -- only the rendered video itself carries audio.

### Events batch 2 (Turf War, Great Escape, Champion Duel)

- **Turf War and Champion Duel need no physics engine at all** -- both
  are constant-speed, direction-only simulations (bouncing off cells /
  steering toward an opponent), the same style Shell Shuffle established.
  Great Escape does need pymunk (gravity, real ball-wall collision
  response against the rotating rings), closer to Ring of Doom/Disaster
  Drop. Deciding per event rather than defaulting to pymunk everywhere
  kept two of these three noticeably simpler to build and faster to mine.
- **A ring's gap needs no per-step tracking at all.** Great Escape's gap
  is fixed at local angle 0 in the ring's own kinematic body frame; the
  body's own rotation sweeps that gap through every world angle once per
  revolution for free. "Did a ball escape through the gap" is then just a
  before/after radial-distance comparison -- if there were no gap there,
  pymunk's own collision response would already have stopped the ball
  from crossing, so no angle-alignment math is needed to detect it.
  Verified directly that this also means no ball can be permanently
  trapped (the gap always eventually reaches any position), so unlike
  Disaster Drop this event needed no anti-trap hard reject.
- **`Timeline` frames don't have to be monotonic, and Champion Duel's
  literal instant replay leans on that directly.** The sim stops the
  instant a champion's HP hits zero, so a first attempt at the replay
  (a window centered on the finishing hit, clamped to sim_total) got cut
  short on the right and barely reached the actual impact -- confirmed by
  tracing the replay's own sampled HP values, which never reached zero.
  Fixed by anchoring the window's END at the real last instant and holding
  there briefly, which only worked because nothing in the shared render or
  audio-mixing code assumes frame_sim_time is non-decreasing -- a "go back
  and show that again" replay is just more frames with earlier sim times.
- **`league/theme.json` is new shared infrastructure, not Great-Escape-
  only.** `build_episode_from_season()` generates/loads it alongside
  crown_team and standings since "a season-wide thing every episode reads"
  is exactly what it already does for those -- even though only Great
  Escape's sound.py consumes it so far. Seeded off the season number
  (`9000 + season_number`) so a new season gets a new melody automatically
  without needing a separate command.
- **`peek_names()` had a real bug, exposed (not introduced) by Champion
  Duel's 1v1 format:** called with `count=0` (the two teams NOT fighting
  this episode), the function still appended one name before its own
  `len(picked) >= count` check ever ran, since that check fires after the
  append. Champion Duel is the first event where a team can legitimately
  need zero names in an episode, which is what surfaced it. Fixed with an
  early return; `pipeline.py`'s per-team name count also had to stop
  defaulting missing teams to 1 (now 0) for the same reason.
- **Champion Duel's `drama_stats()` is a full override, like Shell
  Shuffle, not an addition like Disaster Drop/Turf War/Great Escape.** A
  1v1 HP race has no "team count alive across a field" concept for
  `analyze_drama`'s wipeout/lead-change vocabulary to attach to.
- **`colorwars balance` is a real, working tool that honestly reports it
  didn't fully converge -- this was not treated as good enough to leave
  alone, but also not chased to a result that doesn't actually exist.**
  Two real mechanical bugs were found and fixed by actually running it,
  not by reasoning about the numbers on paper:
  - Red's spike damage was a fixed config constant (10) that `duel_power`
    (which only moved spike *reach*) couldn't meaningfully touch -- Red
    stayed at 95-100% win rate across 3 full rounds regardless of how far
    its power was pushed. Fixed by making spike damage scale with current
    reach, so the one tunable number now moves both.
  - Yellow (pure speed, no damage or defense of its own) lost ~98-100% of
    logged runs against Red's ranged poke specifically, with no amount of
    power adjustment moving that number -- a fast target has no answer to
    an attack it never needs to be close for. A first fix (reduce ALL
    non-contact damage taken by a faster Yellow) overcorrected and made
    Yellow nearly immune to Green's twins instead, flipping that matchup
    to 90%+ the other way (found by re-running balance again, not
    assumed safe) -- narrowed to Red's spikes specifically, which helped
    that one matchup without visibly breaking the Green one.
  - The fixed 5%-per-round adjustment step oscillated rather than
    converging (one real run had Red-vs-Yellow at 98% in round 9 and 72%
    in round 17, swinging back toward 84% by round 20) -- added a decaying
    step size and made `tune()` return the least-imbalanced round actually
    seen across the whole run, not just whatever the last round happened
    to land on, both standard fixes for this exact oscillation pattern.
  - **Still not fully converged after these fixes, reported honestly, not
    hidden:** a real 20-round, 150-runs/round pass left Red-vs-Yellow and
    Green-vs-Yellow both still outside 60% at a stable (non-oscillating)
    equilibrium. This reads as a property of a 2-teams-pull-Yellow's-one-
    power-number-in-opposite-directions situation that a single scalar
    per team may not be able to fully resolve, not a tuning failure --
    `balance` prints exactly which matchups remain unbalanced and exits
    with status 1 rather than claiming success, which is the honest
    contract this tool should keep regardless of whether a future pass
    adds a real second lever (e.g. a defensive stat Yellow actually has)
    to try to finish the job.
- **Known limitation, not fixed this phase:** the tuned `duel_power`
  values that ship with the repo come from a real best-effort `balance`
  run, not hand-picked defaults, which means Red's reach-growth (and so
  its damage) ended up tuned noticeably down and rarely crosses the
  8-damage slow-mo threshold anymore -- the "big hit" slow-mo moment and
  the final-blow replay still work correctly, they just trigger less
  often post-tuning than they did with the original untuned numbers. A
  real tension between "balanced" and "consistently spectacular" that a
  future pass could address with a drama-aware constraint inside
  `balance` itself, not attempted here.

### Phase 4

- **The validity rate (~25%) is lower than Ring of Doom's (~80%+), and
  that's an accepted trade-off, not a bug left unfixed.** 12 balls funneling
  through a 7-module obstacle course genuinely do jam at chokepoints
  sometimes -- found directly (an isolated trap turned out to be a pile of
  7+ balls within 200px of each other), not assumed. Real fixes landed for
  three module types that were outright broken (see below), plus wider
  gaps, a smaller ball radius, and a stronger/smarter anti-stuck nudge, but
  pushing congestion-with-12-balls to near-zero would cost much more tuning
  time than the payoff: `find-seed`/`mine` exist precisely to try many
  cheap seeds and keep the good ones, and 76 valid seeds out of 300 in
  29.7s is nowhere near a practical bottleneck.
- **Three real course-geometry bugs, found by actually dropping balls
  through each module in isolation rather than trusting the code:**
  `trapdoor_floor` and `bumper_maze`'s flat horizontal resting surfaces let
  a ball settle with zero net horizontal force and sit forever (one test
  showed 9+ seconds motionless) -- fixed by sloping them toward their gap,
  steeply enough that gravity clearly beats friction (a first, shallower
  slope just produced a ~35px/s equilibrium creep, slow enough to dodge the
  anti-stuck check without ever truly stopping -- caught by tracing one
  ball's actual recorded velocity, not by re-running the same shallow test).
  `split_paths`' divider had the identical bug in a new shape: a
  *symmetric* roof cap just relocated the zero-net-force point to the
  cap's apex. Fixed with an asymmetric lean (no symmetric balance point to
  land on) instead of another symmetric shape.
- **`zigzag_ramp`'s gap was 57px wide -- barely wider than two ball radii
  -- a near-guaranteed jam with 12 balls funneling through nearly single
  file.** Found by tracing a real stuck ball back to this exact module.
  Widened to 230px, and funnel/trapdoor/bumper_maze gaps were widened too
  once the same class of risk was recognized.
- **Course geometry isn't stored on SimRecord.** Disaster Drop's course is
  a seeded sequence of 7 possible module types with real pymunk shapes --
  far more data than a generic dataclass should carry for one event. Since
  `generate_course()` has no physics to step (pure geometry construction),
  draw.py just reruns it from `record.seed` the same way `simulate()` did
  originally, through a small `render_geometry()` extraction helper that
  turns pymunk shapes into plain (segment/circle/spinner) data, cached per
  seed. This leans on the same determinism guarantee the whole project is
  built on rather than widening the shared data contract for one event.
- **Timeline gained `frame_camera_x`/`frame_camera_y`.** `frame_zoom`
  already existed (Ring of Doom zooms toward a fixed point), but nothing
  needed the camera to actually *move* until this event's "follow the
  leading ball, zoom out as the pack spreads" requirement. Ring of Doom and
  Shell Shuffle now set these to a constant every frame (one line each) --
  real work, not just a stub, since Timeline's fields have no defaults and
  skipping either event would have broken its Timeline construction.
- **A real correctness bug found only by looking at a rendered frame, not
  by reading the code:** `BallState.alive` is repurposed here (documented
  in sim.py) to mean "still an active racer," which is `False` for *both*
  a ball that finished and one the crusher eliminated -- not enough on its
  own to draw them differently. draw.py used `alive` alone to decide the
  death-eyes mark, so the eventual winner's own ball showed up crossed out
  dead in its own victory shot. Fixed by reconstructing each ball's real
  outcome (`finished` vs `eliminated`, with the time it happened) from
  `record.events`, cached per seed.
- **`is_valid()` requires a real finish, not just "a team got resolved."**
  A team resolves either by finishing or by being fully wiped out: without
  checking which one actually happened, a race where the crusher
  eliminated all 12 balls before anyone crossed the line still produced a
  "winner" (whoever's best ball got furthest before dying) -- caught by
  the same rendered-frame inspection that found the X-eyes bug above, not
  assumed fixed by that bug alone.
- **`event.drama_stats()` takes the brief's own wording ("DRAMA SCORE
  ADDITIONS") literally: this event *adds to* `engine.drama.analyze_drama`'s
  score rather than overriding it, unlike Shell Shuffle.** Its repurposed
  `alive` flag ("still an active racer") lines up well enough with Ring of
  Doom's generic vocabulary (lead_change/near_miss/elimination, all real
  SimEvents this event actually logs) that reusing it as a base is
  genuinely meaningful here, not misleading the way it was for a cup game.
  `near_miss` specifically reuses Ring of Doom's exact armed/resolved
  threshold-crossing pattern, tracking the crusher's closing gap on
  whichever ball is currently furthest behind -- which also directly
  answers the brief's own "how close the crusher got to the last ball."
- **Duration is controlled by course length (module count), not a speed
  stretch, on purpose, not just because it was simpler.** The brief says
  "the miner may change the number of modules so the final video lands
  between 61 and 70s" -- read as: module count is itself seeded (already
  true, needed no new code), so different seeds naturally land at
  different durations, and `find-seed`/`mine`'s existing duration check
  filters for ones that land well, the same mechanism Ring of Doom already
  has. Speed-stretching a race the way Ring of Doom stretches Ring of Doom
  would undercut the "race" framing (viewers expect real-time physics, not
  arbitrarily paced ones) -- flagged as a deliberate design choice, not
  just the easy path.
- **A damping bug, found by directly measuring open-space terminal
  velocity rather than trusting the configured number:** `space.damping`
  is a PER-SECOND decay constant that Chipmunk already raises to `dt`
  internally -- applying `** dt` again in code (an easy mistake to make
  reasoning from first principles) nearly cancelled it, so balls fell at
  essentially undamped free-fall speed regardless of the configured value.
  Confirmed and fixed by dropping a single ball with no obstacles and
  measuring its actual terminal velocity before and after.
- **Hammer is an instant impulse, not a literal animated swinging body
  balls collide with** -- a deliberate scope trade-off given everything
  else this phase needed (course generation, the crusher, 6 disaster
  types, a moving camera), flagged the same way Phase 2 flagged the
  shield's velocity-damping approximation. The *sound and overlay card*
  still sell "a bar swings across a lane"; only the physics is simplified.
- **Known limitation, not fixed this phase:** round 1/2-style anti-repeat
  logic doesn't exist for module type selection (consecutive modules of
  the same kind are excluded, but beyond that it's a flat seeded pick), and
  the crusher's speed curve is a simple linear acceleration rather than
  anything that reacts to how the actual pack is doing. Both are
  reasonable follow-ups if a future pass wants tighter pacing control, not
  required for this phase's done-when bar.

### Phase 3

- **Shell Shuffle is pure choreography, not physics.** Every move (swap,
  double swap, fake swap, orbit, lift tease) is a deterministic function of
  a seeded plan plus elapsed time within the move — no pymunk body, no
  collision resolution. This also means the video's total length is a pure
  function of config (seed only picks *which* pair swaps or *which* trick
  plays, never changes how long anything takes), unlike Ring of Doom where
  raw sim length varies by seed. `direct()` is correspondingly simple: a
  flat 1:1 frame-to-sim-time mapping, no adaptive base-speed solve needed.
- **`Event.drama_stats()` replaces a hardcoded call to `engine.drama.
  analyze_drama()`, found necessary while building this, not assumed up
  front.** analyze_drama's vocabulary (lead changes, near misses, wiped-out
  teams) is meaningless for a cup game — worse, actually tried it first and
  it produced actively wrong numbers (e.g. "wiped out before 15s" firing
  constantly, since Shell Shuffle's `alive` flag means "ball currently
  visible," which is false almost the entire episode). `drama_stats()` is
  now a method on the shared `Event` interface with a concrete default
  (Ring of Doom's `analyze_drama`, unchanged behavior) that an event
  overrides when its own drama signal doesn't fit. `is_valid()` was already
  a de facto requirement (both events implement it, mining/find_seed both
  call it) but was never actually declared on the `Event` ABC until now —
  formalized it as abstract instead of relying on duck typing.
- **A second real architecture bug found and fixed while integrating, not
  just while building the new event:** `cover.png` selection lived as
  Ring-of-Doom-specific logic (near-miss hunting) hardcoded directly in the
  shared `pipeline.py`, silently ignoring the `Timeline.cover_frame_index`
  field that already existed for exactly this purpose. Shell Shuffle set
  `cover_frame_index` correctly (the win moment) but the shared pipeline
  never read it, so its first real cover.png came out picking an
  undramatic mid-transition frame — caught by actually looking at the
  rendered cover image, not by reading the code. Fixed by moving the near-
  miss search into Ring of Doom's own `direct.py` (which already computes
  the pieces it needs) and having the shared pipeline just honor
  `timeline.cover_frame_index` for any event.
- **Round 3's "reject if any cup sits still" is a hard constraint in
  `is_valid()`, not a scoring penalty** — matches the brief's wording
  exactly ("reject", not "reward less") and keeps `is_valid()` as the one
  place both `find-seed` and `mine` agree on "is this seed usable at all."
  Measured as total on-screen travel distance per cup during round 3 only
  (reset at the round boundary so the jump into/out of the window never
  counts), with a 6px floor — chosen conservatively small since even a
  lift tease or a fake swap, which never changes a cup's resting slot,
  still moves it visibly by a few pixels.
- **"Orbit" is not a literal circular path.** With all 4 rest positions
  collinear (a single row on a table — true to "4 cups on a table," per the
  brief), polar interpolation around any fixed pivot collapses to only two
  possible angles, giving no usable spread to animate through. Each cup
  instead lerps straight from its current slot to the next one in rotation
  order, with a shared outward bulge (away from the table center,
  magnitude from config) layered on top — visually reads as the group
  swinging around the center together without needing true circular
  geometry.
- **"One cup passes in front" is decided by scale, not screen position.**
  `BallState.angle` is repurposed to hold each cup's current draw scale
  (documented in `sim.py`'s module docstring); `draw.py` sorts cups
  ascending by that value each frame and draws in that order, so the
  bigger (closer) cup in a swap is always drawn last/on top — this also
  covers the orbit and static cases for free, since their scale stays near
  1.0 and draw order among them doesn't visually matter.
- **Mining's story-director filters (`--winner`, `--comeback`, `--min-lead-
  changes`, `--photo-finish`) stayed Ring of Doom specific rather than
  generalizing to a cross-event filter system** — the brief only asked for
  Shell Shuffle's own reward signal to land in its *score*, not new CLI
  flags. `_passes()` and the CLI's result printer were still made
  defensive (`.get()` with safe defaults) so running `mine` against an
  event whose `drama_stats()` doesn't have a given key degrades to "that
  filter doesn't apply" instead of crashing.
- **"Drumroll" has no literal precedent in Phase 1** — the brief said
  "plus the drumroll and win sting from phase 1," but Phase 1 never built
  anything literally named drumroll; its closest relative is the heartbeat
  voice (a sequence of thumps that tightens near the end). Reused that
  technique (an accelerating sequence of discrete hits, retuned to noise
  bursts instead of sine thumps) rather than inventing an unrelated sound.
  "Win sting" by contrast *is* reused verbatim — the identical
  `synth.major_chord_arpeggio` call Ring of Doom's sound.py already makes.
- **Known limitation, not fixed this phase:** round 1 and round 2 pick each
  swap's pair independently every beat, with no anti-repeat logic — a pair
  can occasionally swap, then swap right back on the very next beat. Not a
  correctness issue and not uncommon in a real shell game, but flagged as
  a possible visual-variety improvement for a future pass rather than
  silently accepted as deliberate.

### Phase 2

- **Shield mechanic, concretely:** the last-place team's one-time shield is
  per-episode state (not persisted in season.json — it's just "fresh every
  render," derived from *who's* currently last place when the episode is
  built). For lightning (a direct, code-applied impulse) the shield fully
  cancels it. For center-bumper/spinner (continuous pymunk collision
  response, already resolved by the time `post_solve` fires — there's no
  clean pre-solve veto point here) it's approximated by damping the ball's
  post-collision velocity by 60%. Both consume the same one shield and log
  a `shield` SimEvent either way.
- **Names queue replaced the Phase 1 random pool entirely** — `peek_names()`
  (read-only, used by `render`, so re-rendering the same seed stays
  idempotent) walks names.txt in file order with no RNG involved at all;
  only `consume_names()` (called solely by `commit`) actually removes
  entries and logs them to `names_used.txt`. This changed sim.py's RNG
  consumption versus Phase 1, so Phase 1's "seed 2 is valid" no longer
  reliably holds under the new code — re-ran `find-seed` fresh rather than
  assuming it still did. (It happened to still work for the determinism
  test's hardcoded seed 2, but that's coincidence, not a guarantee.)
- **`episode.yaml` is now a bootstrap fallback, not the default.** Phase 2's
  `build_episode_from_season()` is what `render`/`find-seed`/`mine` use
  unless `--legacy-episode` is passed. On a brand-new season (no episodes
  yet) there's no real crown/last-place/storyline history to draw from, so
  it falls back to a generic "A brand new season begins" hook — verified
  this directly rather than assuming it wouldn't crash on an empty season.
- **"Finale" is a manual flag (`--finale` on render), not auto-detected.**
  The brief never said how a finale episode is identified, and a real
  creator filming the season almost certainly knows when they're shooting
  the finale better than any heuristic would guess.
- **Rivalry storyline scoring:** scored by total games played between the
  pair (more shared history = more worth bringing up), not by how lopsided
  the record is — a judgment call where the brief's own example ("7-6 all
  time") reads as a close, long rivalry rather than a dominant one.
- **Mining's duration constraint is real, not assumed trivially satisfied.**
  `direct()`'s adaptive base-speed algorithm (Phase 1) usually lands in
  61-70s regardless of raw sim length, but `mine()` still calls `direct()`
  and checks the actual achieved duration per candidate seed rather than
  trusting that by construction — a seed where the adaptive speed got
  clamped at the sane-range edges could in principle fall outside the
  window.
- **Real bug found and fixed during validation, not left to luck:**
  `longest_losing_streak` tracking captured a reference to the *old*
  records dict before the update loop, then kept comparing against that
  stale snapshot instead of the just-written value — so on a tie, the
  *last* team checked always won instead of the first. Caught by actually
  running `commit` on three teams tied at a 1-loss streak and checking
  which one got picked, not by reading the code and assuming it was right.
- **Real bug found and fixed during the Phase 2 safe-area check:** the
  dynamically generated teaser/storyline text could now run longer than
  Phase 1's hand-written placeholder strings, and the old rendering used a
  fixed character-count truncation (`text[:36]`) that cut sentences off
  mid-word ("...the crown is still up for" instead of "...up for grabs.").
  Replaced with real word-wrap by measured text width in `draw.py`.

### Phase 1

- **Stack superseded the pre-phase-1 guess.** The actual Phase 1 brief
  specified pymunk + skia-python explicitly, overriding my earlier
  (pre-brief) recommendation of custom physics + Pillow. Both installed
  cleanly and work well — no fallback to pycairo was needed. Exact pinned
  versions: `pymunk==7.3.1`, `skia-python==144.1`, `numpy==2.5.4`,
  `PyYAML==6.0.3`, `pytest==9.2.0`.
- **Verified pymunk's collision API before writing handlers, per the
  brief.** pymunk 7.3.1 uses `space.on_collision(type_a, type_b, begin=,
  pre_solve=, post_solve=, separate=, data=)` — callbacks receive
  `(arbiter, space, data)`. Confirmed kinematic-circle-vs-dynamic-circle
  collisions work correctly (an early test of this looked broken, but the
  bug was the test itself placing the dynamic ball on the wrong side of
  gravity, not pymunk).
- **Gap-change rule (brief said "widen... or open a new one," didn't say
  how to choose):** each cycle, if gap count < 3, a 50/50 seeded choice
  between widening a random existing gap or opening a new one; once at 3
  gaps, always widen. "Each phase" (for the rotation speedup) = each gap-
  change event.
- **Near miss defined as:** a ball's radial distance crosses into the
  410-440 band (armed) and later drops back under 390 while still alive
  (resolved) — logged with its peak radius. If it instead crosses 440
  first, that's a real elimination, not a near miss, by design.
- **Duration fitting (61-70s) is adaptive, not fixed-slowmo-amount.** Raw
  sim length varies by seed (observed 20-22s for seed 2's run, well under
  the 66s deadline). `direct()` solves for a single "base" speed multiplier
  so total video time (base-speed stretch of everything outside the
  near-miss/final-elimination windows, + their own fixed extra-slow
  windows, + the fixed freeze/winner-card/outro time) lands near the
  middle of the 61-70s window, then trims/pads by a few frames to land
  exactly inside it. Known side effect: on a very short raw sim, the
  computed base speed can end up close to the final-elimination's own
  0.35x, so that moment doesn't always read as dramatically slower than the
  rest. A future pass could prefer finding a *longer* raw sim via
  `find-seed` over stretching a short one this hard.
- **Placements / lead tie-breaking:** lead ties keep the previous leader if
  it's still part of the tied-max group; otherwise the tie breaks by team
  order in `teams.yaml`. Placements = winner, then losers ordered by their
  own elimination step, most recent first.
- **Fonts:** reused this repo's existing OFL fonts rather than sourcing new
  ones — Anton (heavy display text) and Chakra Petch Bold (name labels),
  both already vendored under the main app's `assets/fonts/`. A proper
  `OFL.txt` is bundled alongside the copies in `colorwars/assets/fonts/`.
- **Known limitation, not fixed this phase:** with 16 balls in a 400px-radius
  ring, name labels overlap heavily once balls cluster (e.g. settling at
  the bottom under gravity). No label-collision-avoidance was built —
  flagged rather than silently accepted, since it's a real readability
  issue the brief cares about, just out of scope for the time this phase
  took.
- **Render stage has zero live randomness,** by construction — anything
  that looks random on screen (confetti layout, particle scatter) is a
  deterministic function of frame index / event data, never an RNG call in
  `draw.py`. This is what makes the render-hash determinism test
  meaningful rather than trivially true.
