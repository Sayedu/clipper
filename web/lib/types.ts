/* Mirror of the worker's public types (worker/src/types.ts). Keep in sync. */

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
  reframe: 'Reframe to 9:16',
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

export type CaptionStyle = 'clean' | 'bold' | 'karaoke-pop';
export type SourceMode = 'creators' | 'search' | 'trending';
export type SourcePlatform = 'youtube' | 'twitch' | 'both';
export type ClipProvider = 'youtube' | 'twitch';
export type TranscriptSource = 'auto' | 'youtube' | 'whisper';
export type ReframeMode = 'auto' | 'always-crop' | 'always-letterbox';
export type ClipFormat = 'single' | 'top5' | 'auto' | 'question' | 'story';
export type ContentType = 'colorrace' | 'escaperace' | 'lasernations' | 'colorwar' | 'followball' | 'eyetest' | 'quotes';
export type ClipContentStyle = 'any' | 'talking' | 'gaming';
export type ColorRaceMap = 'random' | 'zigzag' | 'pegstorm' | 'spinner' | 'fork' | 'bumper';
export type ColorWarMode = 'sprint' | 'random' | 'classic' | 'bigtiles' | 'finegrain' | 'stripes';
export type FollowBallMode = 'sprint' | 'classic' | 'insane' | 'random';

export const COLOR_RACE_MAPS: Array<{ id: ColorRaceMap; name: string; tag: string }> = [
  { id: 'random', name: 'Surprise me', tag: 'A different course every generation' },
  { id: 'zigzag', name: 'Zigzag Rush', tag: 'Slalom ramps · trampolines · boost bands' },
  { id: 'pegstorm', name: 'Peg Storm', tag: 'Deep Plinko field · pure luck' },
  { id: 'spinner', name: 'Spinner Gauntlet', tag: 'Rotating blades · big swings' },
  { id: 'fork', name: 'The Fork', tag: 'The track splits · one lane is a trap' },
  { id: 'bumper', name: 'Bumper Park', tag: 'Giant bumpers · pinball chaos' },
];

export const COLOR_WAR_MODES: Array<{ id: ColorWarMode; name: string; tag: string }> = [
  { id: 'classic', name: 'Classic', tag: '16×26 grid · wild survival duel · ~42s' },
  { id: 'sprint', name: 'Sprint', tag: '~16s · cold open · fastest' },
  { id: 'bigtiles', name: 'Big Tiles', tag: 'Chunky · wild survival duel · ~41s' },
  { id: 'finegrain', name: 'Fine Grain', tag: 'Dense grid · wild survival duel · ~43s' },
  { id: 'stripes', name: 'Stripes', tag: 'Four bands · wild survival duel · ~42s' },
  { id: 'random', name: 'Surprise me', tag: 'A different ~42s board each run' },
];

export const FOLLOW_BALL_MODES: Array<{ id: FollowBallMode; name: string; tag: string }> = [
  { id: 'sprint', name: 'Sprint', tag: '3 rounds · ~18s · best retention' },
  { id: 'classic', name: 'Classic', tag: '5 rounds · ramps up · ~40s' },
  { id: 'insane', name: 'Insane', tag: '5 rounds · 6 cups · brutal' },
  { id: 'random', name: 'Surprise me', tag: 'A different mode each run' },
];

export interface Settings {
  contentType: ContentType;
  sourceMode: SourceMode;
  sourcePlatform: SourcePlatform;
  creators: string[];
  keywords: string[];
  clipFormat: ClipFormat;
  clipContentStyle: ClipContentStyle;
  clipLengthSec: number;
  clipsPerRun: number;
  candidatesPerVideo: number;
  maxSourceMinutes: number;
  minViewCount: number;
  publishedWithinDays: number | null;
  transcriptSource: TranscriptSource;
  preciseCaptions: boolean;
  reframeMode: ReframeMode;
  tone: string;
  blockedKeywords: string[];
  captionStyle: CaptionStyle;
  captionsEnabled: boolean;
  sfxEnabled: boolean;
  sfxPack: string;
  sfxAtStart: boolean;
  whisperModel: string;
  creditCreator: boolean;
  dailyPostCap: number;
  minPostSpacingHours: number;
  storyGenre: string;
  storyLengthSec: number;
  ttsVoice: string;
  backgroundFootageQueries: string[];
  storyMusic: boolean;
  colorRaceBalls: number;
  colorRaceTargetSec: number;
  colorRaceMap: ColorRaceMap;
  colorRaceShape: 'circle' | 'square';
  marbleRaceMarbles: number;
  marbleRaceTargetSec: number;
  escapeRaceBalls: number;
  escapeRaceRings: number;
  escapeRaceTargetSec: number;
  laserNationsMatchSec: number;
  laserNationsBlackHole: boolean;
  laserNationsMode: 'territory' | 'duel';
  laserNationsDuelA: string;
  laserNationsDuelB: string;
  laserNationsDuelWinner: 'A' | 'B' | 'random';
  laserNationsSeed?: number;
  colorWarMode: ColorWarMode;
  colorWarShape: 'circle' | 'square';
  colorWarFlipSound: 'pluck' | 'bubble';
  colorWarSeed?: number;
  colorWarSeasonNumber?: number;
  colorWarEpisodeIndex?: number;
  colorWarTotalEpisodes?: number;
  colorWarScoresBefore?: [number, number, number, number];
  followBallMode: FollowBallMode;
  followBallSeed?: number;
  eyeTestBallsPerRound: number[];
  eyeTestShuffleSec: number;
  eyeTestSeed?: number;
  quotesSeed?: number;
}

// --- Color War Season Mode ---------------------------------------------

export interface ColorWarEpisodePlan {
  episodeIndex: number;
  winnerColorIndex: 0 | 1 | 2 | 3;
  isClinch: boolean;
  isStreakEntry: boolean;
  isRecoveryWin: boolean;
}

export type ColorWarSeasonEpisodeStatus = 'planned' | 'searching' | 'queued' | 'rendering' | 'done' | 'failed';

export interface ColorWarSeasonEpisode {
  episodeIndex: number;
  status: ColorWarSeasonEpisodeStatus;
  seed?: number;
  jobId?: string;
  usedFallback?: boolean;
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

export const COLOR_NAMES = ['BLUE', 'RED', 'GREEN', 'YELLOW'] as const;
export const COLOR_DOTS: Record<(typeof COLOR_NAMES)[number], string> = {
  BLUE: '#2f6bff', RED: '#ff2f3d', GREEN: '#1fd645', YELLOW: '#ffd21f',
};

export interface FootageStatus {
  count: number;
  totalMinutes: number;
  clips: Array<{ id: string; title: string | null; channel: string | null; minutes: number }>;
}

export const TTS_VOICES: Array<{ id: string; label: string }> = [
  { id: 'am_michael', label: 'Michael — US male, warm (default)' },
  { id: 'am_fenrir', label: 'Fenrir — US male, deep' },
  { id: 'bm_george', label: 'George — UK male, storytime' },
  { id: 'bm_lewis', label: 'Lewis — UK male' },
  { id: 'af_heart', label: 'Heart — US female' },
  { id: 'af_bella', label: 'Bella — US female' },
  { id: 'bf_emma', label: 'Emma — UK female' },
];

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
  provider?: ClipProvider;
  category?: string;
  creatorHandle?: string;
  creatorUrl?: string;
  faceFrac?: number;
}

export interface JobCandidate {
  index: number;
  segment: [number, number];
  hookTitle: string;
  reason: string;
  score: number;
  durationSec: number;
  previewUrl: string;
  thumbUrl: string;
  method: 'llm' | 'heuristic-fallback' | 'source-clip';
  reframeMode: 'crop' | 'letterbox';
}

export interface SkippedCandidate {
  videoId: string;
  title: string;
  channel: string;
  rank: number;
  reason: string;
}

export interface DraftText {
  hook: string;
  overlays: string[];
  caption?: string;
  hashtags?: string[];
}

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
      openingLine: string;
      openingCandidates: string[];
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

/** `Omit` distributed across each union member, so member-specific keys survive. */
export type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** An `InputResponse` without the `requestId` the caller fills in. */
export type InputResponseBody = DistributiveOmit<InputResponse, 'requestId'>;

export interface Job {
  id: string;
  status: JobStatus;
  settings: Settings;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  source: SourceVideo | null;
  viralityScore: number | null;
  candidates: JobCandidate[];
  chosenIndex: number;
  skipped: SkippedCandidate[];
  draftText: DraftText | null;
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

export interface Clip {
  id: string;
  jobId: string;
  title: string;
  source: SourceVideo;
  durationSec: number;
  filePath: string;
  thumbPath: string;
  createdAt: string;
  scheduledAt: string | null;
  postStatus: PostStatus;
  postedAt: string | null;
  meta: {
    segment: [number, number];
    captionStyle: CaptionStyle;
    transcriptExcerpt: string;
    viralityScore: number | null;
    hook?: string;
    overlays?: string[];
    reframeMode?: 'crop' | 'letterbox';
    caption?: string;
    hashtags?: string[];
    provider?: ClipProvider;
    creatorHandle?: string;
    creatorUrl?: string;
    faceFrac?: number;
  };
}

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
      source: SourceVideo | null;
      transcriptVia: 'youtube' | 'whisper' | null;
      draftText: DraftText | null;
    }
  | { type: 'job:error'; jobId: string; step: Step; message: string };

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
  critical: boolean;
}
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  generatedAt: string;
}
