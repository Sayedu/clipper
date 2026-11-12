# colorwars

Deterministic 2D physics engine that renders Color Wars League episodes.
Phase 1: the core engine + Ring of Doom. Phase 2: the league layer (season
standings, crown, storylines, a viewer names queue) and the story director
(drama mining). See `docs/phase-1.md` / `docs/phase-2.md` for the full
briefs and `CLAUDE.md` for the project plan, rules and decisions made so far.

## Setup

```bash
cd colorwars
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

ffmpeg must be reachable at the path set in `config/settings.yaml`
(`ffmpeg_path`) -- defaults to `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`,
the known-working build already used elsewhere in this repo (the bare
`ffmpeg` on PATH on this machine is broken, see CLAUDE.md).

## Commands

Run everything from the `colorwars/` directory with `.venv/bin/python`.

### Find a valid seed

A run is only "valid" if it leaves a single ball by the 66s sim deadline.

```bash
.venv/bin/python -m colorwars find-seed --event ring_of_doom
# -> prints the first valid seed, e.g. "2"

.venv/bin/python -m colorwars find-seed --event ring_of_doom --start 100 --max-tries 50
```

### Render the full episode (1080x1920, 60fps, with sound)

```bash
.venv/bin/python -m colorwars render --event ring_of_doom --seed 2
```

Writes to `out/<episode_id>/` (episode id comes from `config/episode.yaml`):
- `final.mp4` -- the finished video (61-70s)
- `cover.png` -- the closest near-miss frame in the final two (or the
  freeze-frame if there was no near miss)
- `meta.json` -- seed, duration, placements, MVP, stats

```bash
# ~127s on this machine for a full 65.5s episode
```

### Fast preview (540x960, 30fps)

```bash
.venv/bin/python -m colorwars render --event ring_of_doom --seed 2 --preview
# ~28s on this machine
```

### Render to a specific directory

```bash
.venv/bin/python -m colorwars render --event ring_of_doom --seed 2 --out /tmp/my-render
```

### The episode is league driven by default (Phase 2)

`render` and `find-seed` now build the episode (number, crown team, last
place, hook line, teaser, standings) from `league/season.json`
automatically, instead of the hand-edited `config/episode.yaml`. Pass
`--legacy-episode` to use the static YAML file directly instead. A finale
episode's points count double:

```bash
.venv/bin/python -m colorwars render --event ring_of_doom --seed 2 --finale
```

### Mine for a dramatic seed (the story director)

Simulates many seeds in parallel processes (no rendering, so this is fast)
and ranks them by a drama score -- see `docs/phase-2.md` for the exact
formula.

```bash
.venv/bin/python -m colorwars mine --event ring_of_doom --runs 500 --top 5
# ~30s on this machine, ~400/500 seeds typically valid

# story flags narrow the field before ranking:
.venv/bin/python -m colorwars mine --event ring_of_doom --runs 500 \
  --winner green --comeback --min-lead-changes 3 --photo-finish
```

Writes every valid+matching seed to `out/mine_<event>.csv` (score-
descending). Then render the top one directly:

```bash
.venv/bin/python -m colorwars render --event ring_of_doom --best
```

### Commit an episode to the league (run this AFTER actually posting it)

The only command that writes `league/season.json`. Updates standings,
records, head-to-head, and dequeues the names.txt entries that episode
actually used into `league/names_used.txt`.

```bash
.venv/bin/python -m colorwars commit ep001
```

### Names queue

`config/names.txt` is a FIFO queue, one `<Team> <Name>` per line --
`render` peeks the next N per team (read-only, so re-rendering the same
seed is idempotent); only `commit` actually dequeues them.

### Tests

```bash
.venv/bin/python -m pytest -v
```

Covers: `simulate()` determinism (same seed -> byte-identical physics
across an independent run) and render determinism (3 seconds of frames,
rendered twice independently, hash-identical).

### Exporting safe-area check frames (what each phase's review step uses)

```bash
.venv/bin/python -m colorwars render --event ring_of_doom --seed 2
DUR=$(python3 -c "import json; print(json.load(open('out/ep001/meta.json'))['duration_sec'])")
mkdir -p out/ep001/frames
for i in 0 1 2 3 4 5; do
  T=$(python3 -c "print($DUR * $i / 5 * 0.98 if $i > 0 else 0.1)")
  /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg -y -ss $T -i out/ep001/final.mp4 \
    -frames:v 1 -q:v 2 out/ep001/frames/frame_$i.png
done
```

## Layout

```
colorwars/
  config/                  settings, teams, names, blocklist, episode, per-event tunables
  league/
    season.json            the one piece of persistent state -- only `commit` writes this
    names_used.txt          log of consumed names.txt entries -- only `commit` writes this
  colorwars/
    engine/                shared: rng, config loading, records, the Event interface, pipeline,
                            drama.py (shared drama stats), mining.py (parallel seed scoring)
    league/                season.py (state + points/streaks/records), storylines.py, names_queue.py
    events/ring_of_doom/   sim.py (physics), direct.py (the edit), draw.py (skia), sound.py, event.py
    render/video.py        shared: raw RGBA frames -> ffmpeg -> mp4
    audio/                 shared: synthesis primitives (synth.py) + mixing (mix.py)
    cli.py                 `python -m colorwars ...`
  tests/test_determinism.py
  assets/fonts/            Anton (heavy display) + Chakra Petch (labels), both OFL -- OFL.txt included
  out/                     gitignored -- rendered episodes (+ mine_<event>.csv) land here
```

Adding a second event (phase 3+) means a new `colorwars/events/<name>/`
package plus a new `config/events/<name>.yaml` -- nothing in `engine/`,
`render/`, or `audio/` changes.
