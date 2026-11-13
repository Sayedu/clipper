# Personal YouTube Auto-Clipper

A single-user, local-only web app that turns viral YouTube videos into 9:16 TikTok-ready
clips — **checked against a fixed Islamic content standard**, subject-tracked reframe (or
letterbox), karaoke captions, an engagement-baiting hook burned on, sound + loudness polish
— from one button, **fully automatic** (no approval steps), with every stage visible live.

Everything runs on your machine with free / open-source tools. No paid APIs anywhere except
the YouTube Data API's free quota tier.

---

## What it does

```
Search → Score → Thumb check → Download → Transcribe → Content filter → Select & write → Reframe → Captions → Sound → Render
        └────────────── it tries video after video until one fits the guideline ──────────────┘
```

Each candidate video is taken all the way to a written, guideline-checked clip inside the
loop. A video that fails **any** guideline check is dropped silently and the run moves to the
next-ranked one. (For a long stream/VOD, *Download* pulls captions only, finds the moment,
then downloads just that ~90 s clip.)

The live view shows a ticking clock, an ETA, per-step timings, and a running **"looking for a
video that fits"** panel — the video it's on ("video 3 of 8") and every video it skipped with
the reason. There are no pauses; you only see finished clips to save or bin.

| Step | Tool |
|---|---|
| Search + rank | **Creators** (channel list) · **Keyword** search · **Trending** (YouTube's chart → the local model picks a halal, kid-appropriate topic). Deep pagination; date range up to *any time*. Old back-catalogue searches rank by total views instead of views/day. Videos you've already saved or discarded are excluded. |
| Thumb check | open_clip + InsightFace on the YouTube thumbnail before download — a dominant woman or a high-confidence forbidden scene skips the video for free |
| Download | `yt-dlp` (≤1080p mp4) + caption tracks. Real duration is probed first; a long stream fetches captions only. |
| Transcribe | YouTube's word-timed captions when present (instant); else `faster-whisper` (skipped if the video is long and caption-less) |
| Content filter | **Transcript**: the built-in forbidden-word list + your extras, then a lenient LLM topic scan. **Media**: Demucs music probe (strip, or reject if it's mostly music) · InsightFace — any woman persistently on screen · open_clip against the fixed forbidden-scene list. |
| Select & write | PySceneDetect + an **engagement score** (energy, hype words, questions, laughter, stakes) rank candidate windows; the LLM re-ranks; then a **strict halal judgement** on the exact chosen clip (unsure ⇒ skip the video); then it writes a comment-baiting **hook** + 1–2 overlays. No approval step. |
| Reframe | YuNet face tracking → smoothed crop, **or letterbox** when there's no subject big enough to crop to. A source that's already vertical (Shorts) gets a centred fill crop. |
| Captions | Whisper refines the chosen clip's timing, then a word-by-word ASS/libass render (3 styles) with the hook burned **lower and large** (upper third / letterbox bar) and any overlays timed to the beats. |
| Sound | music → rebuild the mix from the Demucs vocal stem; then SFX, `afftdn` denoise, 2-pass `loudnorm` to −14 LUFS. |
| Render | one `ffmpeg` pass per clip → H.264 1080×1920, faststart. |

### Clip formats (Settings → Format)

- **Single best moment** — one clip, with a couple of alternative cuts to choose between.
- **Top 5 countdown** — the pipeline finds a guideline-passing moment in **five different
  videos**, stitches them #5 → #1 with a big rank badge on each, one clip out. (Slow — it's
  five full runs — plan on ~15 min.)
- **AI decides** (default) — a countdown for trending topics, a single moment otherwise.

### Content guideline (hard-wired)

The Islamic standard is **not a setting** — it always runs and can't be turned off. It lives
in one file, `worker/src/guidelines.ts`:

- no background music (instrumental)
- no woman shown on screen
- no alcohol, drugs, smoking, vaping or other intoxicants
- no gambling / betting / lottery / casino
- no profanity, slurs or crude language
- no dating, flirting or romance as the topic
- no astrology, horoscopes, tarot, "manifesting", or promotion of other faiths' rituals
- no mockery of Islam, the Prophets or the Qur'an

Enforced in layers — thumbnail screen → face/scene screen on sampled frames → transcript word
list → a lenient LLM topic scan → a **strict LLM judgement on the exact chosen clip** (unsure
⇒ reject). Any hit drops the video silently and the run tries the next one (up to 8). The
only knob is **extra words to skip on** (Settings) — added on top, never removed.

---

## Setup (one time)

**macOS** — requires [Homebrew](https://brew.sh), Node ≥ 20, `uv`, `python@3.12`:

```bash
bash scripts/setup.sh
```

**Linux / a cloud VM** — use `scripts/cloud-setup.sh` instead (Ubuntu 24.04 / ARM). See
[CLOUD.md](CLOUD.md).

This installs `ffmpeg-full` (the slim `ffmpeg` formula has no libass), `yt-dlp`, `ollama`
+ `llama3.1:8b`, a Python 3.12 venv with the ML packages (`faster-whisper`, `scenedetect`,
`opencv`, plus `torch` / `demucs` / `insightface` / `open_clip` for the content filter),
pre-downloads the Whisper, Demucs, face and CLIP models (~2 GB, one time), fetches the caption
fonts + face model, and synthesizes a CC0 sound-effect pack.

Then add your **YouTube Data API v3 key** to `.env`:

```
YT_API_KEY=AIza...
```

(Google Cloud Console → enable *YouTube Data API v3* → Credentials → API key. Free tier is
~100 searches/day.)

Check everything:

```bash
npm run doctor
```

---

## Run

```bash
npm run dev
```

- Dashboard: **http://localhost:3100**
- Worker API: http://localhost:8787 (the browser never talks to it directly — the dashboard
  proxies `/worker/*`)

`npm run dev` starts **Ollama** for you if it isn't already running, and stops it again on
Ctrl-C (only if this run started it). Ollama's login auto-start is left off — the dev launcher
owns its lifecycle.

### Use a hosted LLM instead of local Ollama

Ollama's 8B model is the heaviest thing running locally. Swap it for a **free-tier hosted
model** (Google Gemini, Groq, …) — faster, smarter, no local compute. In `.env`:

```ini
LLM_PROVIDER=openai
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_MODEL=gemini-2.5-flash
LLM_API_KEY=...        # aistudio.google.com/apikey
```

`npm run dev` then skips Ollama entirely. Any OpenAI-compatible endpoint works — see
[`.env.example`](.env.example).

### Run the whole thing on a free cloud VM

To offload *everything* (LLM + Whisper + Demucs + ffmpeg) to an Oracle Cloud Always-Free
instance and just view the dashboard from your laptop — see **[CLOUD.md](CLOUD.md)**. One
provisioning script (`scripts/cloud-setup.sh`), systemd services, and a private link back to
your machine via Tailscale.

Set a **source** (Creators / Keyword / Trending — or leave both blank for trending), hit
**Run pipeline**, and watch it work. It runs start to finish with no input from you. When
it's done:

- **Save to library** — copies the clip to `data/library/<clipId>/` and deletes the job folder.
- **New take** — same source video, re-cut and re-written from scratch.
- **Different video** — marks this source rejected and finds a fresh candidate.
- **Discard** — throws it away. Either way, that source video won't come back.

Saved clips live in **Library** and on disk under `data/library/`. Toggle **light / dark /
system** from the top bar.

### Creators mode

Default. Settings ships a list of streamers with big teen/kid audiences — edit it freely
(one channel per line, handle or name). **Check** verifies each resolves. Each run pulls their
recent uploads, ranks by views/day, and clips the top pick. An optional **topic filter**
narrows to uploads whose title mentions a keyword.

**Long streams / VODs are fine.** When a source is longer than *How much of a video to use*
(Settings, default 45 min), the pipeline pulls only its captions, uses them to find the single
best moment anywhere in the video, then downloads just that ~90-second clip at full quality.
So a 5-hour Kai Cenat stream still turns into a clip in a few minutes. (Multi-candidate review
is skipped for these — you get the one best moment.)

### Transcript source (Settings)

- **Auto** (default) — use YouTube's captions to find the moment, then re-transcribe only the
  chosen clip(s) with Whisper for tight burned-in captions. A run is ~4–7 min (the content
  filter adds ~1 min: a Demucs music probe + frame screen per candidate).
- **YouTube captions only** — fastest (~3 min); burned captions inherit YouTube ASR errors.
- **Whisper always** — most accurate, but transcription takes ≈ 1× the video length on CPU
  (use `large-v3-turbo`, pre-cached, for ~5× speed).

---

## Iterating on the pipeline (no UI)

```bash
npm run step  -- search "stoicism" "marcus aurelius"     # rank candidates
npm run smoke -- "https://youtube.com/watch?v=VIDEO_ID"  # full pipeline, pinned URL
npm run step  -- transcribe <video.mp4>
npm run step  -- select <transcript.json> <video.mp4>
npm run step  -- reframe <video.mp4> <start> <end>
npm run step  -- captions <transcript.json> <start> <end> [clean|bold|karaoke-pop]

python/.venv/bin/python python/screen.py --video <mp4> --sample-fps 0.3 --concepts "a woman"
python/.venv/bin/python python/demucs_split.py --audio <wav> --mode detect
```

`smoke` uses a deterministic work dir per video, so re-runs reuse the cached download +
transcript and only re-do selection → render (~30s). Set `DEBUG=1` for per-step logs.

```bash
npm test          # vitest (scoring, segment, ASS, crop, migration runner, cooldown math,
                  #  keyword matcher) + python asserts for the letterbox decision
```

---

## Color Wars Studio

A second, separate section of the same dashboard at **http://localhost:3100/colorwars**
("Color Wars" in the top nav) for the `colorwars/` engine — six physics-sim TikTok events
(Ring of Doom, Shell Shuffle, Disaster Drop, Turf War, Great Escape, Champion Duel). Set up any
event, lock or randomize settings, preview before rendering, mine hundreds of seeds for the
most dramatic run, queue full renders, and manage the library/standings/names queue — all from
the browser.

`npm run dev` starts this too, no second command: it launches a small local FastAPI service
(`colorwars/colorwars/studio_api`) alongside the worker and the dashboard, bound to
`127.0.0.1` only. The dashboard reaches it the same way it reaches the worker — a same-origin
Next.js rewrite (`/colorwars-api/*`), never a direct browser request to another port. It's
skipped automatically (with a note in the log) if `colorwars/.venv` doesn't exist yet:

```bash
cd colorwars
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Engine-level details (events, CLI, phases) are in [`colorwars/CLAUDE.md`](colorwars/CLAUDE.md)
and [`colorwars/README.md`](colorwars/README.md). Studio-specific tests:

```bash
colorwars/.venv/bin/python -m pytest colorwars/tests/      # API + engine tests
cd web && npx playwright test e2e/colorwars-studio.spec.ts  # end-to-end (needs npm run dev running)
```

---

## Layout

```
web/        Next.js dashboard (UI only; proxies to the worker and the colorwars API)
worker/     long-lived job runner — HTTP + SSE, SQLite + migrations, the 11-step pipeline
python/     ML helpers (transcribe · scene-detect · reframe · screen · demucs_split), 3.12 venv
colorwars/  physics-sim video engine + its own local Studio API (own venv, own tests)
assets/     caption fonts · face model · SFX packs
data/       SQLite db · per-job scratch · saved clip library   (gitignored)
scripts/    setup.sh · make-sfx.sh · dev.mjs (launches worker + web + colorwars API together)
```

## Notes

- **One job at a time.** Whisper + OpenCV + ffmpeg are each hungry.
- **Disk:** `data/work/<jobId>/` holds the downloaded video and every intermediate. On **Save**
  the chosen clip is copied to `data/library/<clipId>/` and the whole job folder is deleted.
  **Discard** deletes it too. On startup the worker also sweeps stale folders (saved/discarded
  now; failed after a day; anything after a week). Only `data/library/` persists.
- **Ollama** is started/stopped by `npm run dev` (see Run). Login auto-start is off.
- **Used videos never come back.** Once a source has been through the pipeline and you've
  saved or discarded the result, it's excluded from every future run. A guideline-rejected
  video sits out 30 days; a transient failure is released right away.
- **New take** reuses the cached source + transcript + filter verdict — only select → render
  re-runs.
- If the LLM selection / hook / halal-check step can't reach Ollama it falls back to a
  heuristic and says so in the step detail + log — it never silently downgrades. (A missing
  halal check lets the clip through; the other layers still ran.)
- SD sources (old videos) upscale soft; feed it 1080p niches for crisp output.
- **Top-5 runs are slow** (~15 min) — it's five full pipeline passes. Single-moment runs are
  ~4–8 min, longer if it has to skip several videos to find one that fits the guideline.
- **"Confirm you're not a bot" on download** — YouTube throttles yt-dlp, especially after a
  burst of runs. Set `YTDLP_COOKIES_FROM_BROWSER=chrome` (or `safari`, `firefox`) in `.env`
  and restart `npm run dev`. `YTDLP_COOKIES_FILE` takes an exported `cookies.txt` instead.
- **Everything getting skipped?** The guideline is strict by design — group/collab content
  (women on screen), music-heavy edits, and podcasts about off-limits topics all get dropped.
  Solo gaming / sports / science / challenge creators fare best. Widen the date range or try
  a different topic.
