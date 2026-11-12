/* Domain types shared across the worker. The web app re-declares a subset in web/lib/types.ts. */

// --- Pipeline steps --------------------------------------------------------

export const STEP_ORDER = [
  'search',
  'score',
  'thumbcheck',
  'download',
  'transcribe',
  'filter',
  'select',
  'reframe',
  'captions',
  'sfx',
  'render',
] as const;

export type Step = (typeof STEP_ORDER)[number];

export const STEP_LABEL: Record<Step, string> = {
  search: 'Search',
  score: 'Score & rank',
  thumbcheck: 'Thumbnail check',
  download: 'Download',
  transcribe: 'Transcribe',
  filter: 'Content filter',
  select: 'Select & write',
  reframe: 'Reframe 9:16',
  captions: 'Burn captions',
  sfx: 'Sound & audio',
  render: 'Render',
};

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'awaiting_input'
  | 'awaiting_review'
  | 'saved'
  | 'discarded'
  | 'failed'
  | 'canceled';

// --- Settings ------------------------------------------------------------

export type CaptionStyle = 'clean' | 'bold' | 'karaoke-pop';
/** 'creators' = a channel list; 'search' = keywords; 'trending' = whatever's hot on YouTube. */
export type SourceMode = 'creators' | 'search' | 'trending';
/** Which platform(s) to pull candidate clips from. Twitch skips 'search' mode (no free-text clip API). */
export type SourcePlatform = 'youtube' | 'twitch' | 'both';
/** Which service a candidate clip came from. */
export type ClipProvider = 'youtube' | 'twitch';
/** 'auto' = YouTube captions if present else Whisper; 'youtube' = captions only; 'whisper' = always Whisper. */
export type TranscriptSource = 'auto' | 'youtube' | 'whisper';
export type ReframeMode = 'auto' | 'always-crop' | 'always-letterbox';
/**
 * 'single' = one best moment; 'top5' = a #5→#1 countdown; 'auto' = the AI decides per video;
 * 'question' = a big engagement question on a designed background (no source video);
 * 'story' = a made-up story over muted halal gameplay, top/bottom split.
 */
export type ClipFormat = 'single' | 'top5' | 'auto' | 'question' | 'story';

/** What kind of moment to clip: anything, people talking (IRL/Just Chatting), or gameplay. */
export type ClipContentStyle = 'any' | 'talking' | 'gaming';

/**
 * 'colorrace' = a procedurally-generated "which colour will win?" Marble Rush race
 *   (five 2D courses, chase camera, HUD, photo finish).
 * 'escaperace' = a "which colour escapes first?" ring-escape race — balls climb out
 *   of a stack of spinning neon rings through rotating gaps (2D, fixed camera).
 * 'lasernations' = a neon "territory capture" sim — four flagged balls bounce leaving
 *   glowing laser trails, cutting each other's trails; most territory when the clock
 *   runs out wins (2D Canvas, rendered headlessly in Chrome).
 * 'colorwar' = a grid "last colour alive" fight — four balls paint a band every time
 *   they strike an enemy cell, paint-bomb pickups blow holes in the map, and a colour
 *   squeezed under a threshold is wiped out (2D Canvas, rendered headlessly in Chrome).
 * 'followball' = a shell game / "call the cup" ability test — the ball is shown under
 *   a cup, the cups shuffle, the correct cup lifts, and a score card lists every round's
 *   answer so viewers self-score in the comments (2D Canvas, rendered headlessly).
 * 'eyetest' = "Ghost Object Tracker" — identical balls in a circular neon arena, one
 *   briefly flashes gold as "the target," then they launch into real elastic-collision
 *   motion while the arena spins; everything freezes, numbers fade in, and the target
 *   re-flashes gold for the reveal. User-authored round plan (how many rounds, how many
 *   balls each, how long each shuffle runs) — a score card lists every round's answer
 *   at the end (2D Canvas, headless).
 * 'pausegame' = "Pause Game" — a single neon needle sweeps a dial forever at a fixed
 *   speed; a thin green win-margin sits fixed at 12 o'clock. The needle's own color IS
 *   the feedback — it snaps to green the instant it's inside the zone, everywhere else
 *   it shows a seed-picked neon accent. No tap/pause logic in the clip itself: the
 *   viewer uses TikTok's own native pause control, and whatever color the needle is
 *   frozen on tells them if they caught it. Zero randomness in the physics (pure time
 *   → angle) — the seed only picks the accent color. Engineered to loop seamlessly
 *   after a fixed number of rotations (2D Canvas, headless).
 * 'quotes' = "Reminders" — a silent, 15-second card: a short setup line settles in, a
 *   beat of pause, then a punch line lands with a soft flash (the silent stand-in for a
 *   hit sound, since this content type is intentionally silent). The line comes from a
 *   curated bank of original, hard-hitting advice inspired by broad Quranic/Hadith
 *   themes (sabr, tawakkul, shukr, istighfar...) — NOT literal ayahs/hadith, never
 *   written as if God or the Prophet ﷺ is being directly quoted. Dark warm background,
 *   drifting motes, soft rotating light (2D Canvas, headless).
 *
 * The original sourced-video pipeline ('clip'), the narrated-story mode
 * ('storyteller') and the 3D Three.js marble run ('marblerace') were removed
 * as selectable content types 2026-09-04 — the pipeline code behind 'clip'/
 * 'storyteller' is still present (dead code) but never invoked; 'marblerace'
 * is superseded by 'colorrace' (the 2D Marble Rush) for this purpose.
 */
export type ContentType =
  | 'colorrace'
  | 'escaperace'
  | 'lasernations'
  | 'colorwar'
  | 'followball'
  | 'eyetest'
  | 'pausegame'
  | 'quotes';

/** Which Follow-the-ball mode runs. 'random' = a fresh pick each generation. */
export type FollowBallMode = 'sprint' | 'classic' | 'insane' | 'random';

/** The Follow-the-ball modes, for the Settings picker. */
export const FOLLOW_BALL_MODES: Array<{ id: FollowBallMode; name: string; tag: string }> = [
  { id: 'sprint', name: 'Sprint', tag: '3 rounds · ~18s · best retention' },
  { id: 'classic', name: 'Classic', tag: '5 rounds · ramps up · ~40s' },
  { id: 'insane', name: 'Insane', tag: '5 rounds · 6 cups · brutal' },
  { id: 'random', name: 'Surprise me', tag: 'A different mode each run' },
];

/** Which Color War board mode runs. 'random' = a fresh pick each generation. */
export type ColorWarMode = 'sprint' | 'random' | 'classic' | 'bigtiles' | 'finegrain' | 'stripes';

/** The Color War board modes, for the Settings picker. */
export const COLOR_WAR_MODES: Array<{ id: ColorWarMode; name: string; tag: string }> = [
  { id: 'classic', name: 'Classic', tag: '16×26 grid · wild survival duel · ~42s' },
  { id: 'sprint', name: 'Sprint', tag: '~16s · cold open · fastest' },
  { id: 'bigtiles', name: 'Big Tiles', tag: 'Chunky · wild survival duel · ~41s' },
  { id: 'finegrain', name: 'Fine Grain', tag: 'Dense grid · wild survival duel · ~43s' },
  { id: 'stripes', name: 'Stripes', tag: 'Four bands · wild survival duel · ~42s' },
  { id: 'random', name: 'Surprise me', tag: 'A different ~42s board each run' },
];

/** Which Marble Rush course the color race runs. 'random' = a fresh pick each generation. */
export type ColorRaceMap = 'random' | 'zigzag' | 'pegstorm' | 'spinner' | 'fork' | 'bumper';

/** The color-race courses, for the Settings picker. */
export const COLOR_RACE_MAPS: Array<{ id: ColorRaceMap; name: string; tag: string }> = [
  { id: 'random', name: 'Surprise me', tag: 'A different course every generation' },
  { id: 'zigzag', name: 'Zigzag Rush', tag: 'Slalom ramps · trampolines · boost bands' },
  { id: 'pegstorm', name: 'Peg Storm', tag: 'Deep Plinko field · pure luck' },
  { id: 'spinner', name: 'Spinner Gauntlet', tag: 'Rotating blades · big swings' },
  { id: 'fork', name: 'The Fork', tag: 'The track splits · one lane is a trap' },
  { id: 'bumper', name: 'Bumper Park', tag: 'Giant bumpers · pinball chaos' },
];

/**
 * The user-facing settings. The Islamic content standard is NOT here — it's
 * hard-wired in `guidelines.ts` and always enforced. These are the knobs on top.
 */
export interface Settings {
  /** Which kind of video this run makes. */
  contentType: ContentType;
  sourceMode: SourceMode;
  /** Which platform(s) to search. */
  sourcePlatform: SourcePlatform;
  /** Channel handles / names (creators mode). e.g. "MrBeast", "@IShowSpeed". */
  creators: string[];
  /** Search keywords (search mode). */
  keywords: string[];
  clipFormat: ClipFormat;
  /** Prefer people-talking moments, gameplay, or anything. Twitch filters by category; YouTube by video category. */
  clipContentStyle: ClipContentStyle;
  clipLengthSec: number;
  /** How many top-ranked videos to process in one run. */
  clipsPerRun: number;
  /** For a single-moment run: how many alternative cuts to render so you can pick (1–5). */
  candidatesPerVideo: number;
  /** For a long stream/VOD: how many minutes of it to consider (captions-first, clip-download). */
  maxSourceMinutes: number;
  minViewCount: number;
  /** Upload-date window counting back from now. `null` = any time. */
  publishedWithinDays: number | null;
  transcriptSource: TranscriptSource;
  preciseCaptions: boolean;
  reframeMode: ReframeMode;
  /** Free-text style hint for the hook writer (e.g. "deadpan", "hype"). */
  tone: string;
  /** Optional extra words to skip on top of the built-in guideline list. */
  blockedKeywords: string[];
  captionStyle: CaptionStyle;
  captionsEnabled: boolean;
  sfxEnabled: boolean;
  sfxPack: string; // folder name under assets/sfx/
  sfxAtStart: boolean;
  whisperModel: string; // large-v3 | large-v3-turbo | medium | small
  /** Credit the original clip's creator in the generated caption/hashtags. */
  creditCreator: boolean;
  /** Post-schedule: how many clips to post per day, and hours between posts. */
  dailyPostCap: number;
  minPostSpacingHours: number;

  // --- Storyteller mode ---
  /** Free-text genre / theme, e.g. "supernatural horror", "moral fiction". */
  storyGenre: string;
  /** Target spoken length of the narration, in seconds. */
  storyLengthSec: number;
  /** Kokoro voice id, e.g. "am_michael". */
  ttsVoice: string;
  /** YouTube search terms used to fill the local background-footage library. */
  backgroundFootageQueries: string[];
  /** Opt-in ambient music bed under the narration (off = no-music standard). */
  storyMusic: boolean;

  // --- Color race (2D Marble Rush) ---
  /** How many coloured marbles race (3–6). */
  colorRaceBalls: number;
  /** Roughly how long the race should last, seconds (12–60). A fresh map every run. */
  colorRaceTargetSec: number;
  /** Which course to run. 'random' picks a fresh one each generation. */
  colorRaceMap: ColorRaceMap;
  /** Marble shape. */
  colorRaceShape: 'circle' | 'square';

  // --- Marble race (3D) ---
  /** How many marbles race (3–6). */
  marbleRaceMarbles: number;
  /** Roughly how long the race should last, seconds (12–60). A fresh course every run. */
  marbleRaceTargetSec: number;

  // --- Escape race (ring escape) ---
  /** How many coloured balls race (3–6). */
  escapeRaceBalls: number;
  /** How many rings each ball has to break out of (3–14). More = more layers to watch. */
  escapeRaceRings: number;
  /** Roughly how long the video should last, seconds (12–45). A fresh race every run. */
  escapeRaceTargetSec: number;

  // --- Laser Nations (neon territory sim) ---
  /** Match length in seconds (35–65). The grow / rotate / zoom finale scales to it. */
  laserNationsMatchSec: number;
  /** Optional black-hole sudden-death finish. Off = decided on the clock by most territory. */
  laserNationsBlackHole: boolean;

  // --- Laser Nations: Duel (1v1 fight mode) ---
  /** 'territory' = the original 4-way game above. 'duel' = a 1v1 fight with
   *  health bars + a spinning weapon + perks; see laserNationsDuel* below.
   *  No timer either way in duel — the fight ends purely when a fighter
   *  hits 0 hp. */
  laserNationsMode: 'territory' | 'duel';
  /** Pin the two fighters by country name. '' = the sim/search picks randomly. */
  laserNationsDuelA: string;
  laserNationsDuelB: string;
  /** Who wins. 'random' = let the sim decide, no forced outcome — still
   *  searched for a dramatic (not necessarily one-sided) fight. The sim
   *  itself never knows which nation is "supposed" to win either way; a
   *  requested winner is honored purely by keeping a seed that produced it
   *  (see worker/src/pipeline/laserDuelSearch.ts). */
  laserNationsDuelWinner: 'A' | 'B' | 'random';
  /** Pin the sim to an exact seed (the preview studio's "render this seed" —
   *  only offered when duelWinner is 'random', since a forced outcome always
   *  needs its own search server-side).
   *  0 / undefined = a fresh search or random seed each render. */
  laserNationsSeed?: number;

  // --- Color War (grid "last colour alive" fight) ---
  // No explicit length control. SPRINT is a ~16s cold-open; the other boards
  // ('classic' is the default) resolve in ~42s — a long 4-way, then a ~15s
  // final-two "survival duel": each colour is repeatedly crushed to ~15-20% and
  // storms all the way back before one finally pulls clear and wins.
  /** Which board mode runs. 'random' = a fresh pick each generation. */
  colorWarMode: ColorWarMode;
  /** Ball shape (design tweak). */
  colorWarShape: 'circle' | 'square';
  /** The flip note voice — a dry pluck or a wet bubble (design tweak). */
  colorWarFlipSound: 'pluck' | 'bubble';
  /** Pin the sim to an exact seed (the preview studio's "render this seed",
   *  and Season Mode — every season episode is a pinned, pre-verified seed).
   *  0 / undefined = a fresh random seed each render. */
  colorWarSeed?: number;
  /** Season Mode display/caption settings — all set together by
   *  colorwarSeason.ts when it creates an episode's job, never by the user
   *  directly. Absent on every ordinary (non-season) colorwar job. */
  colorWarSeasonNumber?: number;
  colorWarEpisodeIndex?: number;
  colorWarTotalEpisodes?: number;
  /** Wins so far for [BLUE, RED, GREEN, YELLOW], NOT counting this episode. */
  colorWarScoresBefore?: [number, number, number, number];

  // --- Follow the ball (shell game) ---
  /** Which mode runs. 'random' = a fresh pick each generation. */
  followBallMode: FollowBallMode;
  /** Pin the sim to an exact seed (the preview studio's "render this seed").
   *  0 / undefined = a fresh random seed each render. */
  followBallSeed?: number;

  // --- Eye Test ("Ghost Object Tracker" visual focus test) ---
  // Fully user-authored, no preset modes: each round runs the same 3s
  // lock-in countdown -> real elastic-collision shuffle -> instant freeze ->
  // numbered reveal (the true target re-flashes gold), then the next round
  // starts; a short score card lists every round's answer at the very end.
  /** How many balls in each round, in order — array length = round count
   *  (1-6 rounds, 4-10 balls each). */
  eyeTestBallsPerRound: number[];
  /** How long the shuffle (real-physics scatter) phase runs, in seconds,
   *  the SAME for every round (3-15). */
  eyeTestShuffleSec: number;
  /** Pin the sim to an exact seed (the preview studio's "render this seed").
   *  0 / undefined = a fresh random seed each render. */
  eyeTestSeed?: number;

  // --- Pause Game (sweeping needle / screenshot-pause challenge) ---
  /** Win-zone width in degrees (5-30). Smaller = harder. */
  pauseGameTargetDeg: number;
  /** Milliseconds for one full 360deg sweep (600-2500). Smaller = faster. */
  pauseGameRotationMs: number;
  /** Full rotations before the clip ends (4-20) — the render lands exactly
   *  back on frame 0's angle at that point, so it loops seamlessly on
   *  TikTok's native replay. */
  pauseGameLaps: number;
  /** Pin the sim to an exact seed (the preview studio's "render this seed") —
   *  picks the neon accent color only, physics has no randomness.
   *  0 / undefined = a fresh random seed each render. */
  pauseGameSeed?: number;

  // --- Reminders (silent Quran/Hadith-inspired advice card) ---
  /** Pin which bank entry + background drift renders (the preview studio's
   *  "render this seed"). 0 / undefined = a fresh random seed each render. */
  quotesSeed?: number;
}

/** Upload-date window options (days). `null` = any time. */
export const DATE_WINDOWS: Array<{ days: number | null; label: string }> = [
  { days: 7, label: 'Past week' },
  { days: 30, label: 'Past month' },
  { days: 90, label: 'Past 3 months' },
  { days: 365, label: 'Past year' },
  { days: 365 * 2, label: 'Past 2 years' },
  { days: 365 * 5, label: 'Past 5 years' },
  { days: 365 * 10, label: 'Past 10 years' },
  { days: null, label: 'Any time' },
];

/**
 * Big, English, mostly face-cam creators with huge teen/kid audiences — spread
 * across challenges, pranks, reactions, sports, science and gaming so a run of
 * clips stays varied. Fully editable in Settings.
 */
export const DEFAULT_CREATORS = [
  'MrBeast',
  'IShowSpeed',
  'Kai Cenat',
  'Sidemen',
  'Jynxzi',
  'Dude Perfect',
  'Ryan Trahan',
  'Mark Rober',
  'Zach King',
  'Airrack',
  'LazarBeam',
  'Beast Reacts',
  'Dream',
  'MrBeast Gaming',
];

/** YouTube searches that reliably return clean, no-commentary, no-facecam gameplay. */
export const DEFAULT_FOOTAGE_QUERIES = [
  'minecraft parkour gameplay no commentary',
  'subway surfers gameplay no commentary',
  'geometry dash gameplay no commentary',
  'trackmania gameplay no commentary',
  'temple run 2 gameplay no commentary',
  'roblox obby gameplay no commentary',
];

/** Kokoro voices offered in Settings (id → label). Full set lives in voices-v1.0.bin. */
export const TTS_VOICES: Array<{ id: string; label: string }> = [
  { id: 'am_michael', label: 'Michael — US male, warm (default)' },
  { id: 'am_fenrir', label: 'Fenrir — US male, deep' },
  { id: 'bm_george', label: 'George — UK male, storytime' },
  { id: 'bm_lewis', label: 'Lewis — UK male' },
  { id: 'af_heart', label: 'Heart — US female' },
  { id: 'af_bella', label: 'Bella — US female' },
  { id: 'bf_emma', label: 'Emma — UK female' },
];

export const DEFAULT_SETTINGS: Settings = {
  contentType: 'colorrace',
  sourceMode: 'creators',
  sourcePlatform: 'youtube',
  creators: DEFAULT_CREATORS,
  keywords: [],
  clipFormat: 'auto',
  clipContentStyle: 'any',
  clipLengthSec: 55,
  clipsPerRun: 1,
  candidatesPerVideo: 3,
  maxSourceMinutes: 45,
  minViewCount: 50_000,
  publishedWithinDays: 365,
  transcriptSource: 'auto',
  preciseCaptions: true,
  reframeMode: 'auto',
  tone: '',
  blockedKeywords: [],
  captionStyle: 'bold',
  captionsEnabled: true,
  sfxEnabled: true,
  sfxPack: 'starter',
  sfxAtStart: true,
  whisperModel: 'large-v3-turbo',
  creditCreator: true,
  dailyPostCap: 2,
  minPostSpacingHours: 4,
  storyGenre: 'supernatural horror',
  storyLengthSec: 100,
  ttsVoice: 'am_michael',
  backgroundFootageQueries: DEFAULT_FOOTAGE_QUERIES,
  storyMusic: false,
  colorRaceBalls: 4,
  colorRaceTargetSec: 22,
  colorRaceMap: 'random',
  colorRaceShape: 'circle',
  marbleRaceMarbles: 5,
  marbleRaceTargetSec: 24,
  escapeRaceBalls: 4,
  escapeRaceRings: 8,
  escapeRaceTargetSec: 20,
  laserNationsMatchSec: 55,
  laserNationsBlackHole: false,
  laserNationsMode: 'territory',
  laserNationsDuelA: '',
  laserNationsDuelB: '',
  laserNationsDuelWinner: 'random',
  colorWarMode: 'classic',
  colorWarShape: 'circle',
  colorWarFlipSound: 'bubble',
  followBallMode: 'sprint',
  eyeTestBallsPerRound: [8, 8, 8],
  eyeTestShuffleSec: 6,
  pauseGameTargetDeg: 9,
  pauseGameRotationMs: 1100,
  pauseGameLaps: 10,
};

// --- Records -----------------------------------------------------------

/** One rendered candidate clip from the chosen video. */
export interface JobCandidate {
  index: number;
  segment: [number, number];
  hookTitle: string;
  reason: string;
  score: number; // 0..1, LLM's confidence this makes the strongest short
  durationSec: number;
  previewUrl: string; // /jobs/:id/preview/:index
  thumbUrl: string; // /jobs/:id/thumb/:index
  method: 'llm' | 'heuristic-fallback' | 'source-clip';
  reframeMode: 'crop' | 'letterbox';
}

/** A ranked source video that was tried and dropped before the winning one. */
export interface SkippedCandidate {
  videoId: string;
  title: string;
  channel: string;
  rank: number;
  reason: string; // "already used", "background music", "flagged for 'X'", "woman shown in thumbnail"
}

export interface DraftText {
  hook: string;
  overlays: string[];
  /** Ready-to-paste post caption (hook phrased for the description box + creator credit). */
  caption?: string;
  /** Lowercase, no leading '#'. */
  hashtags?: string[];
}

export interface Job {
  id: string;
  status: JobStatus;
  settings: Settings;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  source: SourceVideo | null;
  viralityScore: number | null;
  /** The candidate segments that were rendered for review. */
  candidates: JobCandidate[];
  /** Which candidate the user chose / is viewing. */
  chosenIndex: number;
  /** Source videos tried and skipped before the winning one. */
  skipped: SkippedCandidate[];
  /** Drafted on-screen text (post text-approval). */
  draftText: DraftText | null;
  /** Pending human review request (when status = awaiting_input). */
  pendingInput: InputRequest | null;
  chosenReframeMode: 'crop' | 'letterbox' | null;
  errorStep: Step | null;
  errorMessage: string | null;
  parentJobId: string | null;
  candidateRank: number;
  transcriptVia: 'youtube' | 'whisper' | null;
}

export interface JobStepRow {
  step: Step;
  status: StepStatus;
  detail: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export type PostStatus = 'queued' | 'posted';

// --- Color War Season Mode ---------------------------------------------

/** One episode's planned outcome, decided up front by planColorWarSeason()
 *  before any seed is searched or any job created. `winnerColorIndex` is
 *  0-3 for BLUE/RED/GREEN/YELLOW. The three booleans are narrative labels
 *  for the plan-review UI, not inputs to the sim. */
export interface ColorWarEpisodePlan {
  episodeIndex: number; // 1-based
  winnerColorIndex: 0 | 1 | 2 | 3;
  isClinch: boolean; // this win mathematically decides the season
  isStreakEntry: boolean; // part of the one color's early-mid losing streak
  isRecoveryWin: boolean; // that color's first win after the streak
}

export type ColorWarSeasonEpisodeStatus = 'planned' | 'searching' | 'queued' | 'rendering' | 'done' | 'failed';

/** An episode's live status once a season is confirmed — `jobId` is set as
 *  soon as its job is created (look the job itself up with getJob(jobId) for
 *  fine-grained progress/candidates/draftText; this table never duplicates
 *  that state). */
export interface ColorWarSeasonEpisode {
  episodeIndex: number;
  status: ColorWarSeasonEpisodeStatus;
  seed?: number;
  jobId?: string;
  usedFallback?: boolean; // the search step didn't find a verified pass in budget
}

export type ColorWarSeasonStatus = 'planned' | 'confirmed' | 'done' | 'canceled';

export interface ColorWarSeason {
  id: string;
  seasonNumber: number;
  totalEpisodes: number;
  planningSeed: number;
  plan: ColorWarEpisodePlan[];
  episodes: ColorWarSeasonEpisode[];
  status: ColorWarSeasonStatus;
  createdAt: string;
}

export interface Clip {
  id: string;
  jobId: string;
  title: string;
  source: SourceVideo;
  durationSec: number;
  filePath: string;
  thumbPath: string;
  createdAt: string;
  meta: ClipMeta;
  /** Post-schedule (assigned on save). */
  scheduledAt: string | null;
  postStatus: PostStatus;
  postedAt: string | null;
}

export interface ClipMeta {
  segment: [number, number];
  captionStyle: CaptionStyle;
  transcriptExcerpt: string;
  viralityScore: number | null;
  hook?: string;
  overlays?: string[];
  reframeMode?: 'crop' | 'letterbox';
  /** Generated post copy. */
  caption?: string;
  hashtags?: string[];
  /** Provenance + face-cam signal, for display. */
  provider?: ClipProvider;
  creatorHandle?: string;
  creatorUrl?: string;
  faceFrac?: number;
}

// --- Pipeline artifacts ------------------------------------------------

export interface SourceVideo {
  videoId: string;
  title: string;
  channel: string;
  url: string;
  publishedAt: string;
  durationSec: number;
  viewCount: number;
  likeCount: number;
  thumbnailUrl?: string;
  /** BCP-47 audio/default language from the YouTube snippet, when the uploader set one. */
  lang?: string;
  /** Which service this came from. Absent = 'youtube' (back-compat). */
  provider?: ClipProvider;
  /** Twitch category / YouTube category name, when known (e.g. "Just Chatting", "Gaming"). */
  category?: string;
  /** Original creator handle for crediting, e.g. "@MrBeast" (YT) or "kai_cenat" (Twitch). */
  creatorHandle?: string;
  creatorUrl?: string;
  /** Fraction of the chosen clip's sampled frames that show a real face (0..1). Set by the media screen. */
  faceFrac?: number;
}

export interface ScoredCandidate extends SourceVideo {
  viralityScore: number; // views/day (single-platform) or 0..1 percentile (mixed platforms)
  ageDays: number;
}

export interface TranscriptWord {
  start: number;
  end: number;
  word: string;
  prob: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
}

export interface Transcript {
  language: string;
  durationSec: number;
  segments: TranscriptSegment[];
}

export interface SelectedSegment {
  start: number;
  end: number;
  hookTitle: string;
  reason: string;
  score: number;
  method: 'llm' | 'heuristic-fallback' | 'source-clip';
}

export interface CropKeyframe {
  t: number; // seconds, segment-relative
  x: number; // top-left of crop window in source pixels
  y: number;
}

export interface CropPlan {
  sourceWidth: number;
  sourceHeight: number;
  cropWidth: number;
  cropHeight: number;
  keyframes: CropKeyframe[];
  method: 'tracked' | 'center-fallback' | 'letterbox';
  /** letterbox only: the scaled-video height and the black-bar height (top = bottom). */
  fitHeight?: number;
  barHeight?: number;
  reason?: string;
}

// --- Content screening --------------------------------------------------

export interface ScreenFace {
  box: [number, number, number, number]; // x,y,w,h in source pixels
  gender: 'male' | 'female';
  genderConf: number;
  areaFrac: number; // face box area / frame area
}

export interface ScreenVerdict {
  frames: Array<{ image: string; faces: ScreenFace[]; concepts: Record<string, number> }>;
  women: Array<{ image: string; box: [number, number, number, number]; conf: number; mainSubject: boolean }>;
  conceptHits: Array<{ concept: string; image: string; score: number }>;
  /** letterbox hint from the same detection pass: fraction of frames with one trackable subject. */
  trackableFrac: number;
  wideOrMultiSubject: boolean;
  screenlikeScore: number; // CLIP "screen recording / slideshow / gameplay HUD"
}

export interface MusicVerdict {
  likelyMusic: boolean;
  musicRatio: number; // energy(other+drums+bass) / energy(total)
  sampleSec: number;
}

// --- Human-in-the-loop review ----------------------------------------

export type InputRequest =
  | {
      id: string;
      type: 'review-frames';
      jobId: string;
      candidate: { videoId: string; title: string; rank: number };
      reason: string;
      question: string;
      frames: Array<{ url: string; note: string }>;
    }
  | {
      id: string;
      type: 'approve-text';
      jobId: string;
      hook: string;
      overlays: string[];
      segment: [number, number];
      contextNote: string;
    }
  | {
      id: string;
      type: 'approve-script';
      jobId: string;
      title: string;
      /** The chosen opening line — the most important 2 seconds, called out on its own. */
      openingLine: string;
      /** Alternative opening lines the model generated. */
      openingCandidates: string[];
      /** The full narration script (opening line included as its first sentence). */
      script: string;
      genre: string;
      estWords: number;
    };

export type InputResponse =
  | { requestId: string; decision: 'keep' | 'skip' }
  | { requestId: string; decision: 'approve' }
  | { requestId: string; decision: 'edit'; hook: string; overlays: string[] }
  | { requestId: string; decision: 'edit-script'; openingLine: string; script: string }
  | { requestId: string; decision: 'regenerate' };

// --- SSE events -------------------------------------------------------

export type JobEvent =
  | { type: 'job:status'; jobId: string; status: JobStatus }
  | { type: 'step:status'; jobId: string; step: Step; status: StepStatus; detail?: string; error?: string }
  | { type: 'step:progress'; jobId: string; step: Step; pct: number; detail?: string }
  | { type: 'log'; jobId: string; step: Step; line: string }
  | { type: 'candidate:considering'; jobId: string; videoId: string; title: string; rank: number; total: number }
  | { type: 'candidate:skipped'; jobId: string; skipped: SkippedCandidate }
  | { type: 'job:input-request'; jobId: string; request: InputRequest }
  | { type: 'job:input-cleared'; jobId: string }
  | {
      type: 'job:candidates';
      jobId: string;
      candidates: JobCandidate[];
      /** null for the 'question' / 'story' post formats — there's no single source video. */
      source: SourceVideo | null;
      transcriptVia: 'youtube' | 'whisper' | null;
      draftText: DraftText | null;
    }
  | { type: 'job:error'; jobId: string; step: Step; message: string };

// --- Errors ----------------------------------------------------------

/** Thrown by a step to reject the current candidate video and fall through to the next. */
export class CandidateRejected extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'CandidateRejected';
  }
}
