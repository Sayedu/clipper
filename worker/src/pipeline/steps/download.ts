import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { env } from '../../env.ts';
import { CommandError, run, stream } from '../../lib/exec.ts';
import { CandidateRejected, type SourceVideo } from '../../types.ts';
import { findYoutubeSubs } from '../ytTranscript.ts';
import type { StepContext } from '../context.ts';

export interface DownloadResult {
  source: SourceVideo;
  /** Path to the local video, or '' when only captions were fetched (see `deferred`). */
  videoPath: string;
  infoJsonPath: string | null;
  thumbnailPath: string | null;
  youtubeSubsPath: string | null;
  /**
   * True when the source is a long VOD and we fetched only its captions so far —
   * the real clip gets downloaded (just the chosen ~90 s) after the segment is picked.
   */
  deferred: boolean;
  /** Seconds into the original video where `videoPath` begins. 0 while deferred / for full downloads. */
  windowOffsetSec: number;
}

const CLIP_PAD_SEC = 8; // extra media on each side of the picked segment

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

const ytdlpAuth = () => [
  ...(env.ytdlpCookiesFromBrowser ? ['--cookies-from-browser', env.ytdlpCookiesFromBrowser] : []),
  ...(env.ytdlpCookiesFile ? ['--cookies', env.ytdlpCookiesFile] : []),
];
const ffmpegLoc = () => (env.ffmpeg.startsWith('/') ? ['--ffmpeg-location', dirname(env.ffmpeg)] : []);

/**
 * Step 3 — get the source. Short videos download whole. A long VOD (> the
 * "how much to use" cap) only has its captions pulled here; {@link downloadClip}
 * grabs the actual ~90 s once the segment is chosen. Skips work already on disk.
 */
export async function download(
  ctx: StepContext,
  video: SourceVideo,
  opts: { forceFullDownload?: boolean } = {},
): Promise<DownloadResult> {
  const capSec = Math.max(ctx.settings.maxSourceMinutes, 3) * 60;
  const canUseCaptions = ctx.settings.transcriptSource !== 'whisper';
  const LOCAL_TRANSCRIBE_CAP_SEC = 90 * 60;

  // The YouTube API mis-reports duration for live VODs, so confirm it cheaply before
  // committing to a full download.
  let realDuration = video.durationSec;
  try {
    const probe = await run('yt-dlp', ['--no-warnings', '--skip-download', '--print', 'duration', ...ytdlpAuth(), video.url], {
      signal: ctx.signal,
    });
    const d = Number(probe.stdout.trim().split('\n')[0]);
    if (Number.isFinite(d) && d > 0) realDuration = d;
  } catch {
    /* keep API duration */
  }
  video = { ...video, durationSec: realDuration };

  // Defer the heavy download only when we can find the moment from captions instead.
  const deferred = !opts.forceFullDownload && canUseCaptions && realDuration > capSec * 1.08;

  // Whispering hours of audio locally is a trap — but anything within reach is fine.
  if (!deferred && realDuration > LOCAL_TRANSCRIBE_CAP_SEC && (!canUseCaptions || opts.forceFullDownload)) {
    throw new CandidateRejected(`${(realDuration / 60).toFixed(0)} min is beyond the local transcription limit`);
  }

  const existing = findExistingSource(ctx.workDir);
  if (existing && !deferred) {
    ctx.log('download', `reusing cached ${existing.split('/').pop()}`);
    ctx.progress('download', 1, 'cached');
    return finalize(ctx, video, existing, 0, false);
  }

  const outTemplate = ctx.file('source.%(ext)s');
  const subArgs = canUseCaptions
    ? ['--write-auto-subs', '--write-subs', '--sub-langs', 'en,en-orig,en-US,en-GB', '--sub-format', 'json3']
    : [];

  const args = [
    '--no-playlist',
    '--newline',
    '--no-warnings',
    '--no-part',
    ...ffmpegLoc(),
    ...ytdlpAuth(),
    ...(deferred ? ['--skip-download'] : []),
    ...(deferred
      ? []
      : [
          '-f',
          'bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=1080]+ba/b[height<=1080]/b',
          '--merge-output-format',
          'mp4',
        ]),
    '--write-info-json',
    '--write-thumbnail',
    '--convert-thumbnails',
    'jpg',
    ...subArgs,
    '--progress-template',
    'download:__PROG__ %(progress._percent_str)s %(progress._speed_str)s eta %(progress._eta_str)s',
    '-o',
    outTemplate,
    video.url,
  ];

  ctx.log(
    'download',
    deferred
      ? `${video.url} is ${(video.durationSec / 60).toFixed(0)} min — pulling captions only, will clip the best ~${ctx.settings.clipLengthSec}s after selection`
      : `yt-dlp ${video.url}`,
  );
  try {
    await stream('yt-dlp', args, {
      signal: ctx.signal,
      cwd: ctx.workDir,
      onStdout: (line) => {
        const m = /__PROG__\s+([\d.]+)%\s+(\S+)\s+eta\s+(\S+)/.exec(line);
        if (m) ctx.progress('download', Number(m[1]) / 100, `${m[1]}% · ${m[2]} · eta ${m[3]}`);
        else if (line.includes('[Merger]') || line.includes('[download] Destination')) ctx.log('download', line.trim());
      },
      onStderr: (line) => ctx.log('download', line.trim()),
    });
  } catch (err) {
    if (err instanceof CommandError && (deferred ? hasSubs(ctx.workDir) : findExistingSource(ctx.workDir))) {
      ctx.log('download', 'primary asset ok; a secondary file failed to download (non-fatal)');
    } else if (err instanceof CommandError && /confirm you.?re not a bot|Sign in to confirm/i.test(err.message)) {
      throw new Error(
        "YouTube asked yt-dlp to \"confirm you're not a bot\" for this video. Set " +
          'YTDLP_COOKIES_FROM_BROWSER=chrome (or safari/firefox) in .env and restart, ' +
          'or wait a few minutes — this is usually a temporary rate-limit.',
      );
    } else {
      throw err;
    }
  }

  if (deferred) {
    if (!findYoutubeSubs(ctx.workDir)) {
      // No captions on a long VOD — the deferred trick needs them. Fall back to a
      // full download + local transcription when it's within reach.
      if (realDuration <= LOCAL_TRANSCRIBE_CAP_SEC) {
        ctx.log(
          'download',
          `no captions on this ${(realDuration / 60).toFixed(0)} min VOD — downloading it in full to transcribe locally`,
        );
        for (const name of readdirSync(ctx.workDir)) {
          if (name.startsWith('source.')) rmSync(resolve(ctx.workDir, name), { force: true });
        }
        return download(ctx, video, { forceFullDownload: true });
      }
      throw new CandidateRejected(
        `${(realDuration / 60).toFixed(0)} min VOD with no captions — beyond the local transcription limit`,
      );
    }
    ctx.progress('download', 1);
    return finalize(ctx, video, '', 0, true);
  }

  const videoPath = findExistingSource(ctx.workDir);
  if (!videoPath) throw new Error('yt-dlp finished but no source video file was produced.');
  ctx.progress('download', 1);
  return finalize(ctx, video, videoPath, 0, false);
}

/**
 * Download just the media around a chosen segment of a (long) video — fast, because
 * ffmpeg range-requests only the bytes it needs. Writes `source.mp4`; returns the
 * offset so segment/transcript times can be rebased to it.
 */
export async function downloadClip(
  ctx: StepContext,
  video: SourceVideo,
  span: { startSec: number; endSec: number },
): Promise<{ videoPath: string; offsetSec: number }> {
  const start = Math.max(0, Math.floor(span.startSec - CLIP_PAD_SEC));
  const end = Math.min(video.durationSec, Math.ceil(span.endSec + CLIP_PAD_SEC));
  const outTemplate = ctx.file('source.%(ext)s');

  ctx.log('download', `fetching ${fmtClock(start)}–${fmtClock(end)} (${Math.round(end - start)}s) of the source`);
  await stream(
    'yt-dlp',
    [
      '--no-playlist',
      '--newline',
      '--no-warnings',
      '--no-part',
      ...ffmpegLoc(),
      ...ytdlpAuth(),
      '--download-sections',
      `*${start}-${end}`,
      '--downloader',
      'ffmpeg',
      '-f',
      'bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=1080]+ba/b[height<=1080]/b',
      '--merge-output-format',
      'mp4',
      '--progress-template',
      'download:__PROG__ %(progress._percent_str)s %(progress._speed_str)s eta %(progress._eta_str)s',
      '-o',
      outTemplate,
      video.url,
    ],
    {
      signal: ctx.signal,
      cwd: ctx.workDir,
      onStdout: (line) => {
        const m = /__PROG__\s+([\d.]+)%\s+(\S+)\s+eta\s+(\S+)/.exec(line);
        if (m) ctx.progress('filter', Number(m[1]) / 100 * 0.2, `downloading clip · ${m[1]}%`);
      },
      onStderr: (line) => ctx.log('download', line.trim()),
    },
  );

  const videoPath = findExistingSource(ctx.workDir);
  if (!videoPath) throw new Error('clip download produced no file.');
  return { videoPath, offsetSec: start };
}

function findExistingSource(workDir: string): string | null {
  for (const ext of ['mp4', 'mkv', 'webm', 'mov']) {
    const p = resolve(workDir, `source.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

function hasSubs(workDir: string): boolean {
  return existsSync(workDir) && readdirSync(workDir).some((f) => f.startsWith('source.') && f.endsWith('.json3'));
}

function finalize(
  ctx: StepContext,
  video: SourceVideo,
  videoPath: string,
  windowOffsetSec: number,
  deferred: boolean,
): DownloadResult {
  const infoJsonPath = existsSync(ctx.file('source.info.json')) ? ctx.file('source.info.json') : null;
  const thumbnailPath = readdirSync(ctx.workDir).find((f) => /^source\.(jpg|jpeg|png|webp)$/i.test(f)) ?? null;

  let source = video;
  if (infoJsonPath) {
    try {
      const info = JSON.parse(readFileSync(infoJsonPath, 'utf8')) as {
        duration?: number;
        view_count?: number;
        like_count?: number;
        title?: string;
        uploader?: string;
        channel?: string;
      };
      source = {
        ...video,
        durationSec: info.duration ?? video.durationSec,
        viewCount: info.view_count ?? video.viewCount,
        likeCount: info.like_count ?? video.likeCount,
        title: info.title ?? video.title,
        channel: info.channel ?? info.uploader ?? video.channel,
      };
    } catch {
      /* keep API metadata */
    }
  }

  const youtubeSubsPath = findYoutubeSubs(ctx.workDir);
  const detail = deferred
    ? `${(source.durationSec / 60).toFixed(0)} min VOD · captions only for now`
    : `${(source.durationSec / 60).toFixed(1)} min source${youtubeSubsPath ? ' · captions found' : ''}`;
  ctx.setStep('download', 'running', { detail });
  ctx.log('download', deferred ? `captions ready (${detail})` : `saved ${videoPath.split('/').pop()} (${detail})`);

  return {
    source,
    videoPath,
    infoJsonPath,
    thumbnailPath: thumbnailPath ? resolve(ctx.workDir, thumbnailPath) : null,
    youtubeSubsPath,
    deferred,
    windowOffsetSec,
  };
}
