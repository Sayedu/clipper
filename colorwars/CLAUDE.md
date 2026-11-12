# colorwars

A new section of the clipping website/app (same repo, same project) — a
Python engine that renders physics-simulation videos for the TikTok series
**Color Wars League**. Four color teams (Red, Blue, Green, Yellow) compete in
a different physics event every episode. Results feed season standings, the
standings leader wears a crown, and viewers get their names onto the balls by
commenting. Every video is 1080x1920, 60 fps, 61-70 seconds long, with fully
synthesized sound.

This lives at `colorwars/` inside the main `clipping` repo — not a separate
project or git repo. It will eventually get its own section in the web
dashboard, the same way Color War / Follow The Ball / Eye Test / Pause Game
each have theirs, but that wiring happens in a later phase, not now.

## Plan (built one phase at a time — only the phase currently assigned gets built)

1. Core engine plus the first event, **Ring of Doom**: the last ball left inside a spinning ring wins. (done)
2. League layer (standings, crown, storylines, a viewer name queue) and a story director that simulates hundreds of seeds headless and picks the most dramatic real run. (done)
3. **Shell Shuffle**: a cup shuffle game where viewers track their team's ball. (done)
4. **Disaster Drop**: a vertical obstacle race with disasters and a crusher chasing the pack.
5. **Turf War**, **Great Escape** and **Champion Duel**.

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
The league layer, storylines, the names queue and the story director
(`mine`) are all in. `render` and `find-seed` now build the episode from
`league/season.json` automatically; `colorwars commit <episode_id>` is the
only thing that writes it. Shell Shuffle is a second full event (a cup
shuffle game) on the same render/audio/league/packaging pipeline, with its
own drama scoring. See `README.md` for every command, `docs/phase-1.md` /
`docs/phase-2.md` / `docs/event-shell-shuffle.md` for the full briefs.

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

## Decisions log

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
