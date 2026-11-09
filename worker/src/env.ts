import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Repo root — two levels up from worker/src/. */
export const REPO_ROOT = resolve(here, '..', '..');

/**
 * Find an ffmpeg build that has the `ass` filter (libass) — needed to burn captions.
 * On macOS that means Homebrew's keg-only `ffmpeg-full` (the slim formula lacks it);
 * on Linux the distro `ffmpeg` package (apt) already includes libass.
 * `FFMPEG_BIN` / `FFPROBE_BIN` in `.env` override everything.
 */
function resolveFfmpeg(bin: 'ffmpeg' | 'ffprobe'): string {
  const override = process.env[bin === 'ffmpeg' ? 'FFMPEG_BIN' : 'FFPROBE_BIN'];
  if (override && existsSync(override)) return override;
  for (const p of [
    `/opt/homebrew/opt/ffmpeg-full/bin/${bin}`, // macOS Apple Silicon (keg-only full build)
    `/usr/local/opt/ffmpeg-full/bin/${bin}`, // macOS Intel
    `/usr/bin/${bin}`, // Linux (apt) — ships with libass
    `/usr/local/bin/${bin}`, // Linux (manual install)
  ]) {
    if (existsSync(p)) return p;
  }
  return bin; // fall back to PATH
}

// Node >= 20.12 ships process.loadEnvFile. Load repo-root .env if present;
// real environment variables still win.
const dotenvPath = resolve(REPO_ROOT, '.env');
if (existsSync(dotenvPath)) {
  try {
    process.loadEnvFile(dotenvPath);
  } catch {
    /* malformed .env — fall back to process.env only */
  }
}

const str = (key: string, fallback: string): string => process.env[key]?.trim() || fallback;
const int = (key: string, fallback: number): number => {
  const raw = process.env[key];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

export const env = {
  repoRoot: REPO_ROOT,

  /** YouTube Data API v3 key. Empty string when unset — the Search step reports this clearly. */
  ytApiKey: str('YT_API_KEY', ''),

  /** Twitch Helix app credentials (client-credentials flow). Empty until you register an app. */
  twitch: {
    clientId: str('TWITCH_CLIENT_ID', ''),
    clientSecret: str('TWITCH_CLIENT_SECRET', ''),
  },

  worker: {
    host: str('WORKER_HOST', '127.0.0.1'),
    port: int('WORKER_PORT', 8787),
  },

  ollama: {
    url: str('OLLAMA_URL', 'http://127.0.0.1:11434').replace(/\/$/, ''),
    model: str('OLLAMA_MODEL', 'llama3.1:8b'),
  },

  /**
   * Which LLM backend to use for segment ranking / hook writing / the halal
   * judgement. Default is the local Ollama above (free, no key, but slow on CPU).
   * Set `LLM_PROVIDER=openai` to use any OpenAI-compatible endpoint instead —
   * Google Gemini's free tier, Groq, Cerebras, etc. See CLOUD.md.
   */
  llm: (() => {
    const baseUrl = str('LLM_BASE_URL', '').replace(/\/$/, '');
    // Gemini uses ordinary Google API keys, so the YouTube key works for it too —
    // fall back to YT_API_KEY when talking to a *.googleapis.com endpoint.
    const isGoogle = /(^|\.)googleapis\.com/.test(baseUrl);
    return {
      provider: str('LLM_PROVIDER', 'ollama').toLowerCase() as 'ollama' | 'openai',
      baseUrl,
      apiKey: str('LLM_API_KEY', '') || (isGoogle ? str('YT_API_KEY', '') : ''),
      model: str('LLM_MODEL', ''),
    };
  })(),

  whisper: {
    model: str('WHISPER_MODEL', 'large-v3'),
    compute: str('WHISPER_COMPUTE', 'int8'),
  },

  dataDir: resolve(REPO_ROOT, str('DATA_DIR', 'data')),
  assetsDir: resolve(REPO_ROOT, str('ASSETS_DIR', 'assets')),
  webPort: int('WEB_PORT', 3000),

  /**
   * yt-dlp auth for videos behind YouTube's "confirm you're not a bot" wall.
   * Set one in `.env`:
   *   YTDLP_COOKIES_FROM_BROWSER=chrome   (or safari, firefox, brave, edge…)
   *   YTDLP_COOKIES_FILE=/path/to/cookies.txt
   */
  ytdlpCookiesFromBrowser: str('YTDLP_COOKIES_FROM_BROWSER', ''),
  ytdlpCookiesFile: str('YTDLP_COOKIES_FILE', ''),

  ffmpeg: resolveFfmpeg('ffmpeg'),
  ffprobe: resolveFfmpeg('ffprobe'),
} as const;

export type Env = typeof env;
