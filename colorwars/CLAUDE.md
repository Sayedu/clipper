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

1. Core engine plus the first event, **Ring of Doom**: the last ball left inside a spinning ring wins.
2. League layer (standings, crown, storylines, a viewer name queue) and a story director that simulates hundreds of seeds headless and picks the most dramatic real run.
3. **Shell Shuffle**: a cup shuffle game where viewers track their team's ball.
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

**Phase 1: done.** `python -m colorwars render --event ring_of_doom --seed 2`
produces a 1080x1920/60fps/65.5s `final.mp4` with synthesized sound;
`find-seed` and `--preview` both work; both tests pass (`simulate()`
determinism and render-hash determinism). See `README.md` for every
command. Full brief in `docs/phase-1.md`.

Real numbers on this machine: `find-seed` found seed 2 valid on the 2nd
try. Full render: 127s. `--preview` render: 28s. Output: `out/ep001/`
(gitignored) — `final.mp4`, `cover.png`, `meta.json`.

## Decisions log

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
