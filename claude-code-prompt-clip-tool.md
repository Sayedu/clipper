# Build: Personal YouTube Auto-Clipper Dashboard

## What I'm building

A single-user, local-only web app that automates turning viral YouTube videos into short 9:16 TikTok-ready clips with auto-captions and sound effects. I click one button, watch each step run live, then preview the result and choose to save it or regenerate it.

This is for personal use only, not a public product. No auth, no multi-tenancy needed. Assume it runs on my own machine.

The output quality matters to me. For every stage below, use the best free/open-source tool or technique available for that job, not just the easiest one, as long as it stays free and runs locally. I'd rather the pipeline take a bit more setup than produce mediocre clips.

## Tech stack

- Frontend: Next.js (App Router) + TypeScript + Tailwind
- Backend: Node.js, either Next.js API routes or a small separate Express/Node service if the job runner needs to be long-lived and separate from the web server
- Real-time progress: Server-Sent Events (SSE) or a WebSocket (socket.io), whichever is simpler to wire up cleanly with Next.js
- Video/audio processing: ffmpeg (spawned via child_process, must be installed locally or via Docker)
- YouTube download: yt-dlp (spawned via child_process)
- YouTube search and metadata: YouTube Data API v3 (I'll provide an API key in .env, free quota tier)
- Captions/transcription: faster-whisper with a large-v3 model, run locally, no paid transcription API (best accuracy among free options; whisper.cpp is an acceptable fallback if faster-whisper is awkward to set up)
- Scene/cut detection: PySceneDetect (open source) to find natural cut points in the source video, so clip boundaries land on real edits/scene changes instead of arbitrary timestamps
- Smart segment selection: use the Whisper transcript plus a local open-source LLM run through Ollama (e.g. Llama 3.1 8B or similar) to identify the strongest, most self-contained segment near my target length, rather than just grabbing the first N seconds. This same local LLM step can also draft a short hook/title for the clip.
- Smart reframe to 9:16: use OpenCV or MediaPipe (both free) for face/person detection so the vertical crop can track and follow the speaker, rather than a fixed static center crop
- Animated captions: burn captions in using ffmpeg's ASS/libass subtitle rendering with karaoke-style word-by-word highlighting (TikTok/CapCut look), not plain static drawtext
- Audio quality: use ffmpeg's `loudnorm` filter (EBU R128) so dialogue, music, and sound effects sit at consistent, professional loudness levels; use noise reduction (e.g. ffmpeg's `afftdn` or RNNoise) if source audio is noisy
- Storage: local filesystem for video files, SQLite (via better-sqlite3 or Prisma) for job history and saved clip metadata. No need for cloud storage.
- Sound effects: a small local folder of free/CC0 sound effect files that ffmpeg mixes in, not an external paid API

Do not introduce paid third-party APIs or paid cloud AI services anywhere in this pipeline unless I explicitly ask. Everything, including the LLM step, should run locally with free, open-source tools.

## The pipeline (each step must be visible and independently trackable in the UI)

1. **Search**: query the YouTube Data API for videos matching a keyword/niche I provide, within a configurable upload date range.
2. **Score and rank**: pull view count, like count, and publish date for each result, and compute a simple "virality score" such as views-per-day-since-upload. Rank candidates and pick the top one (or top N if I've asked for multiple clips).
3. **Download**: pull the chosen video locally with yt-dlp at a reasonable resolution (1080p is enough, no need for 4K).
4. **Transcribe**: run the audio through local Whisper to get word-level timestamps.
5. **Select segment**: run PySceneDetect for candidate cut points, and use the local LLM (via Ollama) reading the transcript to pick the strongest, most self-contained segment near my target clip length, snapped to natural sentence/scene boundaries. Also have it draft a short hook/title for the clip.
6. **Reframe to 9:16**: use OpenCV/MediaPipe face or person detection to drive a dynamic crop window that follows the main subject, smoothed so it doesn't jitter, rather than a static center crop.
7. **Burn captions**: overlay TikTok-style captions with word-by-word highlighting, rendered via ffmpeg's ASS/libass subtitle support using the Whisper word timestamps.
8. **Add sound effects and audio polish**: mix in a sound effect at points I configure (e.g. at the start, or on a caption trigger word) from the local SFX folder, then run `loudnorm` (and noise reduction if needed) so the final mix sounds consistent and professional.
9. **Render final output** with ffmpeg.
10. **Preview**: show the finished vertical video in an in-browser player.
11. **Save or regenerate**: I can either save the clip (moves it into a permanent output folder and logs it in the local history/library) or discard and regenerate with the same or tweaked settings.

## Dashboard requirements

- **Settings panel** (persisted between runs, editable before each generation):
  - Niche/keyword(s) to search
  - Desired clip length (seconds)
  - Number of clips to generate per run
  - Minimum view count / upload date range filter
  - Captions on/off, and a basic style choice
  - Sound effects on/off, and which SFX pack/file to use
- **Run button**: kicks off the full pipeline for the current settings.
- **Live progress view**: a step-by-step list (e.g. Search → Score → Download → Transcribe → Reframe → Captions → SFX → Render → Done) where each step shows pending / in-progress / done / failed status in real time as the backend works through it. If a step fails, show the error inline rather than failing silently.
- **Preview screen**: once rendering finishes, show the final 9:16 video in a player.
- **Post-preview actions**: "Save" (persist to output library) and "Regenerate" (re-run, optionally with adjusted settings).
- **Library/history view** (simple list is fine): past saved clips with thumbnail, source video title, and date, so I can find and re-download anything I've saved before.

## Visual design direction

I want this to feel clean, calm, and high-end, not like a generic admin dashboard. Specifically:

- Generous white space throughout. Don't pack the screen; let sections breathe, and use spacing rather than borders or boxes to separate things wherever possible.
- A restrained, mostly neutral palette (whites/near-whites and soft grays) with a single accent color used sparingly for primary actions and status (e.g. the "running" state, the save button). Avoid busy gradients or multiple competing accent colors.
- One clean, modern sans-serif typeface with a clear type scale (a noticeably larger weight for headings/section titles, a comfortable body size, and a muted smaller size for secondary text like timestamps or metadata).
- Only one primary action visible at a time per screen: the "Run" button should be the obvious focal point when idle; the progress view should be the focal point while running; the preview and Save/Regenerate should be the focal point once done. Don't show everything at once.
- The live pipeline steps should read as a simple, quiet checklist (icon or subtle color change per state: pending/running/done/failed), not a dense log or terminal-style output.
- The settings panel should feel like a short, well-spaced form, not a control panel packed with fields. Group related settings with spacing, not heavy borders/cards everywhere.
- Avoid generic templated AI-dashboard look and feel (default component-library styling, heavy drop shadows, gradient hero banners). Aim for something that feels considered, like a well-designed small SaaS product, not a scaffolded admin template.
- It's a single-user local tool, so it doesn't need marketing polish like a landing page, but the actual working screens (settings, run, progress, preview, library) should still look intentional and high quality, not just functional.

## Build approach

Since this touches several moving pieces (external API, two CLI tools, local ML transcription, real-time UI updates), please:

1. First propose a concrete file/folder structure and confirm the SSE-vs-WebSocket choice and the full list of local dependencies I need to install (ffmpeg, yt-dlp, faster-whisper, PySceneDetect, OpenCV/MediaPipe, Ollama plus which local model) before writing code.
2. Build the backend pipeline pieces first as standalone, testable functions/scripts (search+score, download, transcribe, scene-detect + LLM segment selection, smart reframe, ASS caption burn, sfx-mix + loudnorm, render), starting with a simple end-to-end version of each so the whole pipeline runs, then upgrading each stage to the full technique described above once the plumbing works.
3. Then build the dashboard UI and connect it to the pipeline via the real-time progress mechanism.
4. It's fine to sequence the work this way, but the finished v1 should include the smart segment selection, smart reframe, and animated captions described above, not the naive fallbacks. If any of these (e.g. Ollama setup, MediaPipe) turns out to be genuinely impractical to get working locally, tell me and we'll figure out a substitute rather than silently downgrading to the naive version.
5. Ask me before adding any new external dependency or API beyond what's listed here.

## Environment

- I have a YouTube Data API v3 key I'll provide via `.env`.
- I'm comfortable with TypeScript, React, Next.js, and Node; feel free to lean on idiomatic patterns for those rather than over-explaining basics.
