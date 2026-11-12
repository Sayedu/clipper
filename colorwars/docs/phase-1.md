# Phase 1 brief

Build a Python project called colorwars: a deterministic 2D physics engine that renders vertical TikTok videos. Save this brief to docs/phase-1.md before writing code, and keep a short README of every command.

## GOAL
One command renders a finished 1080x1920, 60 fps MP4 with sound for an event called Ring of Doom, 61 to 70 seconds long:
```
python -m colorwars render --event ring_of_doom --seed 42
```
The same seed must always produce the identical video.

## STACK
- Python 3.11+, pymunk for physics, skia-python for drawing (fall back to pycairo only if skia will not install), numpy for audio synthesis, PyYAML for config, the ffmpeg binary via subprocess.
- Pin exact versions in requirements.txt. Check the installed pymunk version's collision callback API before writing handlers.

## ARCHITECTURE (keep these four parts separate)
1. `simulate(config, seed) -> SimRecord`. Headless physics at a fixed 240 Hz step, no wall clock. Record every step: each ball's position, angle, velocity and alive flag, the ring angle, and an event log of collisions (with impulse), eliminations, hazards, near misses and lead changes.
2. `direct(record) -> Timeline`. Decides the edit: hook overlay, slow motion segments, a 0.5x replay of the best near miss, toasts, the winner moment and the outro card. Video time maps to sim time through this timeline, so slow motion never re-simulates.
3. `render(record, timeline) -> raw RGBA frames piped into ffmpeg` (libx264, yuv420p, crf 18, preset veryfast).
4. `mix_audio(record, timeline) -> a 48 kHz stereo WAV` built only from synthesized sounds, muxed as AAC 192k with ffmpeg loudnorm at about -14 LUFS.

## DETERMINISM RULES
- Seed one random generator per run and pass it everywhere. Never read the clock, never iterate over sets of shapes (use lists), never rely on dict order you did not create.
- Add a test that renders 3 seconds twice and compares frame hashes.

## PHYSICS QUALITY (this prevents balls passing through walls or getting stuck)
- 240 Hz steps, ball speed capped at 2400 px/s, wall segments at least 6 px thick, and the ring as a kinematic body so contacts pick up its spin.
- Anti-stuck: if a ball moves less than 30 px in 1.5 s, give it a small seeded nudge.

## RING OF DOOM RULES
- Ring radius 400 px centered at (540, 820), built from 96 segments with gap angle ranges. Rotates at 0.6 rad/s, 4% faster each phase, and reverses direction once at a random phase.
- Gravity 900 px/s^2 down. 16 balls of radius 30, 4 per team, spawned inside with seeded positions and velocities. Elasticity 0.88, friction 0.4.
- Team traits: Red mass x1.15, Blue elasticity +0.08, Green radius x0.9, Yellow gets a random burst impulse every 4 to 7 s.
- Gaps: start with one 16 degree gap. Every 8 s show a 1 s warning, then widen the gaps by 6 degrees or open a new one (max 3). After 48 s, do this every 4 s.
- A ball whose center passes radius 440 is eliminated: remove it from physics, let it fall off screen and fade.
- Hazards every 9 to 13 s, announced 1 s early: Lightning (a big impulse to one ball, crown team picked with double weight), Center Bumper (5 s), Spinner bar (6 s).
- Lead = the team with the most balls alive (ties keep the previous leader). Placements = order in which each team's last ball went out; the surviving team is 1st. MVP = the last ball's name.
- A run is valid only if a single ball is left by 66 s of sim time and the final video, with slow motion and the outro, lands between 61 and 70 s (direct() may trim slow motion to fit). Add: `python -m colorwars find-seed --event ring_of_doom`, which returns the first valid seed.

## TEAMS AND NAMES
- teams.yaml: name, hex color, personality line, trait numbers. Red #FF4D5E, Blue #3DA5FF, Green #3DDC84, Yellow #FFD23F.
- names.txt with lines like: Blue Sam. Clean every name: letters, digits and underscore only, max 12 characters, drop anything on blocklist.txt. Fill empty slots with defaults like Red 3.
- episode.yaml holds the episode number, crown team, hook storyline line, standings and next-episode teaser (filled by hand in this phase).

## LOOK
- Background #0B1020 with a soft vignette. Ring light gray with a glow; gap edges pulse red during warnings.
- Balls in team color with glow, short motion trails, particle bursts on hard hits and eliminations, 3 px screen shake on eliminations. Pre-render glow sprites once per color and size; never blur per frame.
- Two eyes per ball: pupils lean toward the velocity, eyes widen within 60 px of a gap, X eyes when eliminated.
- Name label under each ball, bold 22 px with a dark outline.
- Crown icon above the crown team's balls.
- All HUD text inside the safe area x 120 to 960, y 160 to 1440: event title and episode on top, an N LEFT counter, a team strip with alive dots at the bottom of the safe area, toasts like SAM IS OUT.
- Use an OFL-licensed heavy font saved in assets/fonts.

## EPISODE ARC (video time)
- 0 to 1 s: action already running, big text ONLY 1 SURVIVES and four team chips with PICK YOUR TEAM.
- 1 to 3 s: the storyline line from episode.yaml.
- Near misses at 0.5x speed. With two balls left, zoom the camera to 1.25x on the action.
- Last elimination at 0.35x, a 0.5 s freeze, winner confetti in team color, BLUE WINS and MVP: SAM.
- Last 5 s: standings card with points animating in, then the teaser line. The final frame should match the opening composition so the loop feels seamless.

## SOUND (all synthesized: no samples, no songs)
- Collisions: Karplus-Strong plucks from the C major pentatonic scale, volume from impulse, panned by x position, max 12 plucks per 100 ms. The pitch range climbs through the episode.
- Eliminations: pop plus a short whoosh. Warnings: two ticks. Hazards: crackle or thud.
- Final 15 s: a rising drone, then a heartbeat under the final two. Last elimination: bass drop, 0.5 s of silence, then a win sting (arpeggiated major chord).

## OUTPUT
`out/<episode_id>/final.mp4`, `cover.png` (the frame with the closest near miss in the final two), `meta.json` (seed, duration, placements, MVP, stats).

## DONE WHEN
`find-seed` returns a valid seed, `render` produces a 61 to 70 s video for it, the determinism test passes, and `--preview` renders a fast 540x960 30 fps version.
