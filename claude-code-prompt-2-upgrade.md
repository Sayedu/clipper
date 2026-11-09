# Upgrade: Personal YouTube Auto-Clipper Dashboard — Phase 2

## Context

The app already works end-to-end from a previous build: search → score → download → transcribe → basic segment selection → static center-crop reframe → basic captions → sound effects → render → preview → save/regenerate, with a working settings dashboard and live progress view.

Now that the pipeline runs, upgrade it in place with everything below. Don't rebuild what already works; replace or extend specific stages. The output quality matters to me, so for each area below use the best free/open-source tool or technique available, not just the easiest one, as long as it stays free and runs locally. I'd rather this take more setup than produce mediocre results.

Do not introduce paid third-party APIs or paid cloud AI services anywhere in this pipeline unless I explicitly ask. Everything, including any LLM step, should run locally with free, open-source tools.

## 1. Upgrade to best-in-class free/open-source tools per stage

- Captions/transcription: move to faster-whisper with a large-v3 model if not already using it (best accuracy among free options; whisper.cpp is an acceptable fallback if faster-whisper is awkward to set up).
- Scene/cut detection: add PySceneDetect to find natural cut points in the source video, so clip boundaries land on real edits/scene changes instead of arbitrary timestamps.
- Smart segment selection: replace the naive "first N seconds" logic with the Whisper transcript plus a local open-source LLM run through Ollama (e.g. Llama 3.1 8B or similar) to identify the strongest, most self-contained segment near my target length.
- Smart reframe to 9:16: replace the static center crop with OpenCV or MediaPipe (both free) face/person detection so the vertical crop tracks and follows the speaker, smoothed so it doesn't jitter. Cropping isn't always the right call though: if the detected subjects/content can't reasonably stay in frame (wide shots, multiple people spread across the frame, gameplay UI, slides, etc.), fall back to fitting the entire original frame into the 9:16 canvas uncropped, accepting black bars top and bottom rather than cutting something important off. Use the same person/content detection already run for the crop decision to judge which mode a given segment needs.
- Animated captions: replace the basic caption overlay with ffmpeg's ASS/libass subtitle rendering using karaoke-style word-by-word highlighting (TikTok/CapCut look). This is also where the hook/title/overlay text drafted in section 3 gets burned in: if the reframe step used the letterbox fallback for this segment, place that text in the empty bar space instead of over the video, since it's otherwise wasted space; if it was a normal crop with no bars, place it as an overlay near the top or bottom safe area like usual.
- Audio quality: add ffmpeg's `loudnorm` filter (EBU R128) so dialogue, music, and sound effects sit at consistent, professional loudness levels; add noise reduction (e.g. ffmpeg's `afftdn` or RNNoise) if source audio is noisy.
- Audio stem separation: add Demucs (free, open source, Meta AI) to split downloaded audio into vocal and music/instrumental stems, used for the music filtering in section 2 below.

## 2. Content filtering (Islamic guidelines: no music, no women shown, clean content)

I only want to work with source videos that fit my own content standards. Build this as a configurable filter, not hard-coded rules. I'll be the one defining exactly what's disallowed; your job is to make the mechanism work well.

- **Music**: after transcription, run the downloaded audio through Demucs to separate vocal and music/instrumental stems. Add a settings toggle with two modes: "strip music" (rebuild the audio track from the vocal stem only, before any sound effects are added) and "reject the video" (treat any detected music as a failed candidate and move on). Default to "strip music" but let me switch it per run.
- **No women shown**: sample frames across the candidate video and run face/person detection (reuse the OpenCV/MediaPipe setup from section 1) plus an open-source gender classification model on any detected faces. If a woman is detected, flag the candidate. Automated gender classification from video isn't fully reliable (angle, age, clothing, and image quality all affect it), so treat a flag as "needs my review" rather than an automatic hard reject: pause and show me the flagged frame(s) so I can confirm skip or keep, the same way the segment/text step already pauses for my approval. Give me a settings option for how strict this is (e.g. "flag any appearance" vs "flag only if a woman is a main subject, not incidental background").
- **General clean content**: extend the transcript screening below to also cover this, and add a general open-source image content classifier run on the same sampled frames to catch other visual content I wouldn't want, beyond just whether a woman appears.
- **Prohibited content (transcript)**: let me maintain an editable list of disallowed words/topics in settings. Screen the Whisper transcript against this list two ways: a direct keyword match, and a semantic check using the same local LLM (Ollama) used for segment selection, since phrasing varies and exact keyword matching alone will miss things.
- **Thumbnail pre-check**: before downloading the full video, run the same visual checks (women shown, general clean content) on the video's thumbnail image, which is already available from the YouTube Data API search results. If the thumbnail alone disqualifies a candidate, skip it and move to the next one without spending time downloading it.
- **Fallback behavior**: if a candidate fails the filter (automatically, or after my review) and can't be auto-fixed, don't stop the run. Go back to the ranked candidate list from the Score step and try the next one automatically, and show in the live progress view which candidates were tried and skipped, with a short reason (e.g. "Skipped: background music, could not cleanly remove," "Skipped: flagged for [term]," or "Skipped: woman shown in thumbnail").
- Run the thumbnail check right after scoring, before downloading. Run the full audio/visual/transcript checks right after transcription and before the heavier editing steps (segment selection, reframe, captions, render), so time isn't wasted processing a video that's going to get rejected anyway.

## 3. Trend-aware, funny on-screen text

I want the hook/title and any on-screen text to sound like something a real person online would say right now, not stiff or generic.

- Before the LLM drafts any hook/title/on-screen text, feed it current context: the titles and top comments from the batch of candidate videos pulled in that same search (via the YouTube Data API's comment endpoint, still within the free quota), and optionally trending search terms for the niche via a free tool like pytrends (Google Trends). Ground the writing in that real, current material rather than the model's own static training knowledge, which has a cutoff and won't know this week's slang or memes on its own.
- Add a "tone" field in settings (free text, e.g. "sarcastic," "hype," "deadpan," "wholesome") that gets folded into the LLM's writing prompt so I can steer the style per run.
- Add a toggle for "extra on-screen text overlays" beyond the literal word-by-word captions of what's spoken, for punchy one-line text moments, separate from the transcript captions.
- Since this text is cheap to produce compared to a full render, pause and show me the drafted hook/title/overlay text as soon as it's generated, with approve/edit/regenerate actions, before the pipeline moves on to reframing, captioning, and rendering.
- Write the hook/title specifically to drive retention and engagement: open with something that creates a reason to keep watching (a question, an unresolved setup, a "wait for it" style tease) rather than summarizing the whole clip upfront, and where it fits naturally, invite a reaction (asking a question people would want to answer in the comments). Fold this intent into the LLM's writing prompt alongside the tone and trend context. Note the actual on-screen placement of this text is decided later, at the caption-burn step, once reframe mode is known (see section 1).
- Keep it short: instruct the LLM to write a single punchy line, not a paragraph, roughly under 8 words / 50 characters for the hook and similarly brief for any extra overlay text, so it reads at a glance and fits cleanly in the letterbox bar or overlay space without wrapping. If a draft comes back too long, have it regenerate shorter automatically before it ever reaches me for review, rather than shrinking the font to force it to fit.
- One honest limitation to plan around: a local open-source model's grasp of "current" is only as good as the real context fed to it. Its own training knowledge has a cutoff and won't reliably know this week's trends on its own, so the video/comment context is doing the real work here, not the model's innate sense of humor.

## 4. Avoid repeating source videos

Right now nothing stops the same top-ranked video from getting picked again on a later run, since scoring is deterministic and nothing tracks what's already been used. Fix this:

- Keep a persisted record in the existing SQLite history of every source video ID that's already gone through the pipeline, not just the ones I saved.
- At the Score and rank step, exclude any candidate whose video ID is already in that record before ranking, so the top of the resulting list is always a video I haven't generated a clip from before.
- Add a settings toggle: "avoid reusing previously used source videos" (on by default), with an option to set a cooldown instead of a permanent exclusion (e.g. "don't reuse for 30 days") in case a video is worth revisiting later rather than excluding it forever.
- Replace the single "Regenerate" action on the preview screen with two distinct options, since that ambiguity is probably part of why the same video keeps coming back: **"New take"** (re-run segment selection, reframe, and text on the same source video, for when I liked the source but not this specific cut) and **"Different video"** (exclude this video too and pick a fresh candidate).

## Updated pipeline order

With the above changes, the pipeline should now run as:

1. Search
2. Score and rank (exclude previously-used video IDs per section 4, then keep the full remaining ranked list so later steps can fall through to the next-best candidate)
3. **Thumbnail pre-check** (new — see section 2): quick visual screen of the top candidate's thumbnail before spending time downloading; skip and try the next candidate if it's disqualified
4. Download (top surviving candidate)
5. Transcribe
6. **Content filter** (upgraded — see section 2): music, transcript, and full video visual screening. Pause for my review if a visual flag isn't clear-cut
7. **Select segment & draft text** (upgraded — see sections 1 and 3), pausing for my approval of the drafted text
8. Reframe to 9:16 (upgraded — smart crop, with letterbox fallback when cropping would cut off important content)
9. Burn captions (upgraded — includes placing the hook/title text in the letterbox bar when one was used, or as a normal overlay when not)
10. Add sound effects and audio polish (upgraded)
11. Render final output
12. Preview
13. Save, "New take," or "Different video" (see section 4)

## Updated dashboard settings

Add these to the existing settings panel:

- Music handling: "strip music" vs "reject video outright"
- Visual filter strictness: "flag any appearance of a woman" vs "flag only if a main subject"
- Reframe mode: "auto (smart crop, fall back to letterbox when needed)" vs "always crop" vs "always letterbox"
- Avoid reusing previously used source videos: on/off, with an optional cooldown period
- Disallowed words/topics list (add/remove entries)
- Tone/style for generated text (free text field)
- Extra on-screen text overlays: on/off

Update the live progress view to reflect the new step list, show skipped candidates with their reason when the content filter rejects one (including "already used" skips), pause and show me the flagged frame(s) when a visual check needs my confirmation, and pause on the segment/text step to show the drafted hook/title/overlay text with approve/edit/regenerate actions.

## Visual design overhaul

I want this to feel clean, calm, and high-end, not like a generic admin dashboard. Specifically:

- Generous white space throughout. Don't pack the screen; let sections breathe, and use spacing rather than borders or boxes to separate things wherever possible.
- A restrained, mostly neutral palette (whites/near-whites and soft grays) with a single accent color used sparingly for primary actions and status (e.g. the "running" state, the save button). Avoid busy gradients or multiple competing accent colors.
- One clean, modern sans-serif typeface with a clear type scale (a noticeably larger weight for headings/section titles, a comfortable body size, and a muted smaller size for secondary text like timestamps or metadata).
- Only one primary action visible at a time per screen: the "Run" button should be the obvious focal point when idle; the progress view should be the focal point while running; the preview and Save/Regenerate should be the focal point once done. Don't show everything at once.
- The live pipeline steps should read as a simple, quiet checklist (icon or subtle color change per state: pending/running/done/failed), not a dense log or terminal-style output.
- The settings panel should feel like a short, well-spaced form, not a control panel packed with fields. Group related settings with spacing, not heavy borders/cards everywhere.
- Avoid generic templated AI-dashboard look and feel (default component-library styling, heavy drop shadows, gradient hero banners). Aim for something that feels considered, like a well-designed small SaaS product, not a scaffolded admin template.
- It's a single-user local tool, so it doesn't need marketing polish like a landing page, but the actual working screens (settings, run, progress, preview, library) should still look intentional and high quality, not just functional.

## Build approach for this phase

1. First propose an integration plan: which existing files/modules each upgrade touches, and the full list of new local dependencies I need to install (PySceneDetect, OpenCV/MediaPipe, an open-source gender/content classifier model for the visual filter, Ollama plus which local model, Demucs, pytrends) before changing code.
2. Upgrade one stage at a time, keeping the full pipeline runnable end-to-end after each swap, rather than changing everything at once. It's fine to keep the old and new version of a stage behind a flag temporarily while testing, if that makes it easier to verify nothing broke.
3. Don't remove the old v1 behavior for a stage until its replacement is confirmed working.
4. Apply the visual design overhaul last, once the functional upgrades are in and working, so the design pass isn't fighting a moving target.
5. Ask me before adding any new dependency or API beyond what's listed here.

## Environment

- I have a YouTube Data API v3 key already set up via `.env`.
- I'm comfortable with TypeScript, React, Next.js, and Node; feel free to lean on idiomatic patterns for those rather than over-explaining basics.
