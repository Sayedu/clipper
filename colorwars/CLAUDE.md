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

Not started. Waiting on the Phase 1 prompt.

## Decisions log

(nothing yet — filled in at the end of each phase)
