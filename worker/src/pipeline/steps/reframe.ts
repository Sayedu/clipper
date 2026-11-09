import { existsSync, readFileSync } from 'node:fs';
import { runPython } from '../../lib/python.ts';
import { paths } from '../../paths.ts';
import type { CropPlan, SelectedSegment } from '../../types.ts';
import type { StepContext } from '../context.ts';
import type { DownloadResult } from './download.ts';

/** Step 6 (per candidate) — subject-tracked 9:16 crop path (OpenCV YuNet + One-Euro smoothing). */
export async function reframe(
  ctx: StepContext,
  input: { dl: DownloadResult; segment: SelectedSegment; slot: number; onSub?: (pct: number, msg: string) => void },
): Promise<CropPlan> {
  const { dl, segment, slot } = input;
  const cropPath = ctx.file(`crop.${slot}.json`);

  if (existsSync(cropPath)) {
    ctx.log('reframe', `clip ${slot + 1}: reusing cached crop plan`);
    return JSON.parse(readFileSync(cropPath, 'utf8')) as CropPlan;
  }

  const model = existsSync(paths.yunet) ? paths.yunet : '';

  // Twitch clips are composited streams (gameplay + a corner facecam) — cropping to
  // the face throws the game away and cropping to centre loses the minimap / killfeed.
  // Always keep the whole frame unless the user explicitly forced a crop.
  const mode =
    dl.source.provider === 'twitch' && ctx.settings.reframeMode !== 'always-crop'
      ? 'always-letterbox'
      : ctx.settings.reframeMode;
  if (mode !== ctx.settings.reframeMode) {
    ctx.log('reframe', `clip ${slot + 1}: Twitch clip — keeping the whole frame (letterbox)`);
  }

  const stdout = await runPython('reframe.py', {
    args: [
      '--video', dl.videoPath,
      '--start', String(segment.start),
      '--end', String(segment.end),
      '--out', cropPath,
      '--target-w', '1080',
      '--target-h', '1920',
      '--sample-fps', '6',
      '--model', model,
      '--mode', mode,
    ],
    signal: ctx.signal,
    onProgress: (pct, msg) => input.onSub?.(pct, msg),
    onLog: (line) => ctx.log('reframe', `clip ${slot + 1}: ${line}`),
  });

  const plan = JSON.parse(stdout || readFileSync(cropPath, 'utf8')) as CropPlan;
  ctx.log('reframe', `clip ${slot + 1}: ${plan.method}${plan.reason ? ` (${plan.reason})` : ''}`);
  return plan;
}
