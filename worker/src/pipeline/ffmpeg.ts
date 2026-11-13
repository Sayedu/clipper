import { env } from '../env.ts';
import { run, stream, type StreamOptions } from '../lib/exec.ts';

export const FFMPEG = env.ffmpeg;
export const FFPROBE = env.ffprobe;

export interface ProbeResult {
  width: number;
  height: number;
  durationSec: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string | null;
}

interface FfprobeStream {
  codec_type: 'video' | 'audio' | string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
}
interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

function parseFrac(v: string | undefined): number {
  if (!v) return 0;
  const [a, b] = v.split('/').map(Number);
  if (!b) return a ?? 0;
  return (a ?? 0) / b;
}

export async function ffprobe(input: string): Promise<ProbeResult> {
  const out = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', input]);
  if (out.code !== 0) throw new Error(`ffprobe failed for ${input}: ${out.stderr.trim()}`);
  const data = JSON.parse(out.stdout) as FfprobeOutput;
  const v = data.streams?.find((s) => s.codec_type === 'video');
  const a = data.streams?.find((s) => s.codec_type === 'audio');
  const durationSec = Number(v?.duration ?? data.format?.duration ?? a?.duration ?? 0);
  return {
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    durationSec,
    fps: parseFrac(v?.avg_frame_rate) || parseFrac(v?.r_frame_rate) || 30,
    hasAudio: Boolean(a),
    videoCodec: v?.codec_name ?? null,
  };
}

/** True if this ffmpeg build has the libass `ass` filter (needed for captions). */
export async function hasAssFilter(): Promise<boolean> {
  const out = await run(FFMPEG, ['-hide_banner', '-filters']);
  return /\bass\b\s+V->V/.test(out.stdout) || out.stdout.includes(' ass ');
}

/** Extract PCM wav (16 kHz mono for Whisper, 48 kHz stereo for the audio chain). */
export async function extractAudio(
  input: string,
  output: string,
  opts: { sampleRate?: number; channels?: number; start?: number; end?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const args = ['-hide_banner', '-y'];
  if (opts.start != null) args.push('-ss', String(opts.start));
  if (opts.end != null) args.push('-to', String(opts.end));
  args.push(
    '-i', input,
    '-vn',
    '-ac', String(opts.channels ?? 1),
    '-ar', String(opts.sampleRate ?? 16_000),
    '-c:a', 'pcm_s16le',
    output,
  );
  const res = await run(FFMPEG, args, { signal: opts.signal });
  if (res.code !== 0) throw new Error(`audio extract failed: ${res.stderr.trim().split('\n').slice(-3).join('\n')}`);
}

export interface FfmpegRunOptions extends Omit<StreamOptions, 'onStdout'> {
  totalDurationSec?: number;
  onProgress?: (pct: number, outTimeSec: number) => void;
}

/** Run ffmpeg with `-progress pipe:1` and translate it into a progress callback. */
export async function runFfmpeg(args: string[], opts: FfmpegRunOptions = {}): Promise<void> {
  const full = ['-hide_banner', '-nostats', '-progress', 'pipe:1', ...args];
  let outTime = 0;
  await stream(FFMPEG, full, {
    ...opts,
    onStdout: (line) => {
      const eq = line.indexOf('=');
      if (eq < 0) return;
      const key = line.slice(0, eq);
      const val = line.slice(eq + 1);
      if (key === 'out_time_us' || key === 'out_time_ms') {
        outTime = Number(val) / (key === 'out_time_us' ? 1e6 : 1e3);
        if (opts.totalDurationSec && opts.onProgress) {
          opts.onProgress(Math.min(outTime / opts.totalDurationSec, 0.999), outTime);
        }
      }
    },
    onStderr: opts.onStderr,
  });
  opts.onProgress?.(1, outTime);
}

/** Run a short ffmpeg command to completion, throwing on failure. Returns stderr (where ffmpeg logs). */
export async function ffmpegOnce(args: string[], signal?: AbortSignal): Promise<string> {
  const res = await run(FFMPEG, ['-hide_banner', ...args], { signal });
  if (res.code !== 0) {
    throw new Error(`ffmpeg failed: ${res.stderr.trim().split('\n').slice(-4).join('\n')}`);
  }
  return res.stderr;
}

/** Escape a filesystem path for use inside an ffmpeg filter argument. */
export function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/**
 * Concatenates the branded end-card clip (paths.endCard) onto the end of
 * videoPath, in place -- held for its own full length, on every finished
 * video, by request. Uses the `concat` FILTER (decoded frames), not the
 * concat demuxer (raw stream copy): the end card is a fixed clip (30 fps,
 * see scripts/render-endcard.mjs) while the main video can be a different
 * fps/codec depending on content type, so the two rarely share identical
 * stream parameters -- the filter re-encodes and re-times frames to
 * handle that, the demuxer would just refuse to join them.
 */
export async function appendEndCard(videoPath: string, endCardPath: string, signal?: AbortSignal): Promise<void> {
  // the end card is a fixed 1080x1920 asset, but content types render at
  // different resolutions (followball/eyetest go out at 2160x3840) -- the
  // concat filter requires every input frame to be the SAME size, so scale
  // the end card up/down to match whatever the main video actually is
  // (found directly: without this, libx264 rejected the mismatched frame
  // size with "Invalid argument" and produced an empty output).
  const main = await ffprobe(videoPath);
  const tmpPath = videoPath.replace(/(\.[^./]+)$/, '_endcard$1');
  await ffmpegOnce(
    [
      '-y',
      '-i', videoPath,
      '-i', endCardPath,
      '-filter_complex',
      `[0:v]setsar=1[v0];[1:v]scale=${main.width}:${main.height}:flags=lanczos,setsar=1[v1];` +
        '[v0][0:a][v1][1:a]concat=n=2:v=1:a=1[v][a]',
      '-map', '[v]',
      '-map', '[a]',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '19',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      tmpPath,
    ],
    signal,
  );
  const { rename } = await import('node:fs/promises');
  await rename(tmpPath, videoPath);
}
