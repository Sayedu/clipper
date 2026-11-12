# colorwars

Deterministic 2D physics engine that renders Color Wars League episodes.
Phase 1: the core engine + Ring of Doom. Phase 2: the league layer (season
standings, crown, storylines, a viewer names queue) and the story director
(drama mining). Phase 3: a second event, Shell Shuffle. Phase 4: a third
event, Disaster Drop, a real-physics vertical obstacle race. Events batch
2: three more events -- Turf War (grid territory), Great Escape (rotating-
ring escape, with a season theme song), Champion Duel (1v1, with its own
`balance` auto-tuner and a 3-episode `bracket` mode). See `docs/phase-1.md`
/ `docs/phase-2.md` / `docs/event-shell-shuffle.md` /
`docs/event-disaster-drop.md` / `docs/events-batch-2.md` for the full
briefs and `CLAUDE.md` for the project plan, rules and decisions made so
far.

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
.venv/bin/python -m colorwars render --event shell_shuffle --seed 1
.venv/bin/python -m colorwars render --event disaster_drop --seed 1
.venv/bin/python -m colorwars render --event turf_war --seed 1
.venv/bin/python -m colorwars render --event great_escape --seed 1
.venv/bin/python -m colorwars render --event champion_duel --seed 1
# champion_duel without --legacy-episode picks its own 2-of-4 matchup by
# seed; episode["duel_matchup"] overrides this (bracket mode sets it)
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

# story flags narrow the field before ranking (Ring of Doom specific --
# a field a given event's drama_stats() doesn't have just never filters):
.venv/bin/python -m colorwars mine --event ring_of_doom --runs 500 \
  --winner green --comeback --min-lead-changes 3 --photo-finish

.venv/bin/python -m colorwars mine --event shell_shuffle --runs 500 --top 5
# ~2s on this machine (no physics to simulate), typically 500/500 valid

.venv/bin/python -m colorwars mine --event disaster_drop --runs 300 --top 5
# ~30s on this machine, typically ~25% valid (a real course-congestion risk with 12
# balls, not just a rare edge case -- is_valid() filters it, mine() just tries more seeds)

.venv/bin/python -m colorwars mine --event turf_war --runs 300 --top 5
# ~2s on this machine (no physics), typically 300/300 valid

.venv/bin/python -m colorwars mine --event great_escape --runs 300 --top 5
# ~10s on this machine, typically 300/300 valid -- a rotating gap always
# eventually sweeps past any position, so no anti-trap reject is needed

.venv/bin/python -m colorwars mine --event champion_duel --runs 300 --top 5
# <1s on this machine, typically 300/300 valid
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

### Balance Champion Duel's teams (tunes config/teams.yaml)

Runs every matchup many times (seed varies, everything else held fixed)
and nudges each team's single `duel_power` trait until no matchup wins
more than 60% for either side, then patches the tuned numbers into
`teams.yaml` in place (a targeted text patch, not a YAML round-trip --
that would strip the file's comments).

```bash
.venv/bin/python -m colorwars balance --runs 2000
# several minutes depending on --max-rounds (default 20) and core count
```

Exits 0 if every matchup converged under 60%, 1 otherwise -- and prints
which matchups didn't, rather than silently reporting success either way.
**Known limitation, found by actually running it, not assumed:** with
this event's current signature powers, the 4-team matchup web doesn't
fully converge within a reasonable round count -- Yellow (pure speed, no
damage or defense of its own) stays structurally weak against both Red's
ranged poke and Green's twins even at its power's practical extremes. The
tool still measures honestly and tunes every round; this is a property of
the power design space, not a bug in the tuner. See `CLAUDE.md`'s
decisions log for the full story (what was tried, what helped, what made
a different matchup worse instead).

### Bracket mode (3 Champion Duel episodes: 2 semifinals + a final)

Seeds the semifinal pairings by current standings (1st vs 4th, 2nd vs
3rd; teams.yaml order if the season has no episodes yet). Semifinal
winners come straight off each render's own meta.json -- nothing is
committed to league/season.json by this, same as a normal render.

```bash
.venv/bin/python -m colorwars bracket --preview
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
                            registry.py (event id -> Event instance), drama.py (Ring of Doom's
                            drama stats, the default Event.drama_stats()), mining.py (parallel
                            seed scoring), balance.py (Champion Duel's auto-tuner),
                            bracket.py (Champion Duel's 3-episode bracket orchestration)
    league/                season.py (state + points/streaks/records), storylines.py,
                            names_queue.py, theme.py (one 32-note melody per season,
                            for Great Escape's collision sounds)
    events/ring_of_doom/   sim.py (physics), direct.py (the edit), draw.py (skia), sound.py, event.py
    events/shell_shuffle/  sim.py (choreography, no physics engine), direct.py, draw.py, sound.py,
                            drama.py (its own drama_stats()/is_valid(), too different from Ring of
                            Doom's to share), event.py
    events/disaster_drop/  sim.py (real pymunk physics -- 12 balls, a crusher, 6 disaster types),
                            course.py (seeded module generation + a render_geometry() extraction
                            helper draw.py uses), direct.py (a smoothed/zooming camera, the one
                            thing unique to this event's edit), draw.py, sound.py, drama.py (adds
                            to analyze_drama's score rather than overriding it -- this event's
                            "alive" flag lines up with the generic vocabulary), event.py
    events/turf_war/       sim.py (no physics engine -- constant-speed grid bouncing), direct.py,
                            draw.py (reconstructs the 784-cell grid from a sparse event log),
                            sound.py, event.py (reuses analyze_drama's default directly)
    events/great_escape/   sim.py (real pymunk physics -- 6 rotating ring gaps), direct.py (Ring
                            of Doom-style adaptive speed + a slow-mo window on the winning
                            escape), draw.py (replays ring rotation speeds analytically, never
                            stored), sound.py (plays league/theme.json's season melody, one note
                            per collision), event.py (reuses analyze_drama's default directly)
    events/champion_duel/  sim.py (1v1, no physics engine -- 4 distinct signature powers, each a
                            pure function of hits-landed and one teams.yaml trait), direct.py
                            (adaptive speed + big-hit slow-mo + a literal instant replay of the
                            finishing blow, built by resampling an earlier sim-time window again),
                            draw.py, sound.py, drama.py (its own 1v1-shaped drama_stats()), event.py
    render/video.py        shared: raw RGBA frames -> ffmpeg -> mp4
    audio/                 shared: synthesis primitives (synth.py) + mixing (mix.py)
    cli.py                 `python -m colorwars ...`
  tests/test_determinism.py
  assets/fonts/            Anton (heavy display) + Chakra Petch (labels), both OFL -- OFL.txt included
  out/                     gitignored -- rendered episodes (+ mine_<event>.csv) land here
```

Adding an event means a new `colorwars/events/<name>/` package plus a new
`config/events/<name>.yaml` -- nothing in `engine/`, `render/`, or `audio/`
changes. `colorwars/engine/registry.py` is the one place that lists known
event ids for both `cli.py` and `mining.py`'s worker processes.
