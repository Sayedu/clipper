import { paths } from '../../paths.ts';
import type { CropPlan, SelectedSegment } from '../../types.ts';
import { buildCropFilter } from '../cropExpr.ts';
import { escapeFilterPath, ffmpegOnce, ffprobe, runFfmpeg } from '../ffmpeg.ts';
import type { StepContext } from '../context.ts';
import type { CaptionResult } from './captions.ts';
import type { DownloadResult } from './download.ts';
import type { AudioResult } from './sfxAudio.ts';

export interface RenderResult {
  videoPath: string;
  thumbPath: string;
  durationSec: number;
  width: number;
  height: number;
}

/** Step 9 (per candidate) — one ffmpeg pass: trim, tracked crop, scale, burn captions, mux audio. */
export async function render(
  ctx: StepContext,
  input: {
    dl: DownloadResult;
    segment: SelectedSegment;
    crop: CropPlan;
    captions: CaptionResult;
    audio: AudioResult;
    slot: number;
    /** file basename prefix — 'final' (default) or 'part' for Top-5 pieces */
    namePrefix?: string;
    onSub?: (pct: number) => void;
  },
): Promise<RenderResult> {
  const { dl, segment, crop, captions, audio, slot } = input;
  const prefix = input.namePrefix ?? 'final';
  const dur = segment.end - segment.start;
  const outPath = ctx.file(`${prefix}.${slot}.mp4`);
  const thumbPath = ctx.file(`thumb.${prefix === 'final' ? slot : `part${slot}`}.jpg`);

  const tail: string[] = [];
  if (captions.assPath) {
    tail.push(`ass='${escapeFilterPath(captions.assPath)}':fontsdir='${escapeFilterPath(paths.fonts)}'`);
  }
  tail.push('format=yuv420p');

  let filterGraph: string;
  if (crop.method === 'letterbox') {
    // Keep the WHOLE frame (nothing cropped), but fill the gaps with a blurred,
    // zoomed copy of the same video instead of black bars — reads as full-screen.
    // `force_original_aspect_ratio=decrease` guarantees the sharp copy never exceeds
    // the target (a near-square/portrait source would otherwise overflow).
    filterGraph = [
      '[0:v]split=2[lbbg][lbfg]',
      '[lbbg]scale=1080:1920:force_original_aspect_ratio=increase:flags=bilinear,crop=1080:1920,' +
        'gblur=sigma=20,eq=brightness=-0.16:saturation=1.05,setsar=1[lbbgb]',
      '[lbfg]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[lbfgs]',
      `[lbbgb][lbfgs]overlay=(W-w)/2:(H-h)/2,setsar=1,${tail.join(',')}[v]`,
    ].join(';');
    ctx.log('render', `clip ${slot + 1}: letterbox (blurred fill)`);
  } else {
    filterGraph = `[0:v]${buildCropFilter(crop).filter},scale=1080:1920:flags=lanczos,setsar=1,${tail.join(',')}[v]`;
  }

  const args = [
    '-y',
    '-ss', String(segment.start),
    '-t', String(dur),
    '-i', dl.videoPath,
    '-i', audio.audioPath,
    '-filter_complex', filterGraph,
    '-map', '[v]',
    '-map', '1:a',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '19',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-shortest',
    outPath,
  ];

  ctx.log('render', `clip ${slot + 1}: encoding 1080×1920 (${crop.method})`);
  await runFfmpeg(args, {
    signal: ctx.signal,
    totalDurationSec: dur,
    onProgress: (pct) => input.onSub?.(pct * 0.95),
    onStderr: (l) => {
      if (/error|invalid|failed/i.test(l)) ctx.log('render', `clip ${slot + 1}: ${l.trim()}`);
    },
  });

  await ffmpegOnce(['-y', '-ss', String(Math.max(dur / 2, 0.1)), '-i', outPath, '-frames:v', '1', '-q:v', '3', thumbPath]);

  const probe = await ffprobe(outPath);
  input.onSub?.(1);
  ctx.log('render', `clip ${slot + 1}: ${outPath.split('/').pop()} (${probe.durationSec.toFixed(1)}s, ${probe.width}×${probe.height})`);

  return {
    videoPath: outPath,
    thumbPath,
    durationSec: probe.durationSec,
    width: probe.width,
    height: probe.height,
  };
}

/**
 * Stitch a Top-5 countdown: concatenate the per-moment renders (#5 → #1) into one
 * clip with a hard cut and a short whoosh-friendly gap. All parts are already
 * 1080×1920 / 30 fps / AAC, so this is a fast filtergraph concat.
 */
export async function concatClips(
  ctx: StepContext,
  parts: RenderResult[],
  outSlot = 0,
): Promise<RenderResult> {
  const outPath = ctx.file(`final.${outSlot}.mp4`);
  const thumbPath = ctx.file(`thumb.${outSlot}.jpg`);

  const inputs = parts.flatMap((p) => ['-i', p.videoPath]);
  const streams = parts.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('');
  const filter = `${streams}concat=n=${parts.length}:v=1:a=1[v][a]`;

  await runFfmpeg(
    [
      '-y',
      ...inputs,
      '-filter_complex', filter,
      '-map', '[v]',
      '-map', '[a]',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '19',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      outPath,
    ],
    { signal: ctx.signal, onProgress: (p) => ctx.progress('render', 0.85 + p * 0.13, 'stitching the countdown') },
  );

  await ffmpegOnce(['-y', '-ss', '1.5', '-i', outPath, '-frames:v', '1', '-q:v', '3', thumbPath]);
  const probe = await ffprobe(outPath);
  ctx.log('render', `countdown: ${parts.length} clips → ${probe.durationSec.toFixed(1)}s`);
  return { videoPath: outPath, thumbPath, durationSec: probe.durationSec, width: probe.width, height: probe.height };
}
