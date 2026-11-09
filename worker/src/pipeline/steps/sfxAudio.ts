import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { run } from '../../lib/exec.ts';
import { runPython } from '../../lib/python.ts';
import { paths } from '../../paths.ts';
import { FFMPEG, runFfmpeg } from '../ffmpeg.ts';
import type { StepContext } from '../context.ts';
import type { DownloadResult } from './download.ts';
import type { Transcript } from '../../types.ts';

export interface AudioResult {
  audioPath: string;
  loudnessBefore: number | null;
  loudnessAfter: number;
  /** true only if the Demucs vocal-stem rebuild actually succeeded. */
  musicStripped: boolean;
}

const SFX_EXT = /\.(wav|mp3|m4a|aac|ogg|flac)$/i;

function pickSfxFile(pack: string, prefer: string[]): string | null {
  const dir = resolve(paths.sfx, pack);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => SFX_EXT.test(f));
  if (!files.length) return null;
  for (const name of prefer) {
    const hit = files.find((f) => f.toLowerCase().startsWith(name));
    if (hit) return resolve(dir, hit);
  }
  return resolve(dir, files[0]!);
}

/**
 * Step 8 — trim segment audio, mix SFX at the configured triggers, denoise, then
 * two-pass EBU R128 loudness normalisation to a consistent −14 LUFS.
 */
export async function sfxAudio(
  ctx: StepContext,
  input: {
    dl: DownloadResult;
    segment: { start: number; end: number };
    transcript: Transcript;
    slot: number;
    stripMusic?: boolean;
    onSub?: (pct: number) => void;
  },
): Promise<AudioResult> {
  const { dl, segment, slot } = input;
  const [segStart, segEnd] = [segment.start, segment.end];
  const dur = segEnd - segStart;
  const raw = ctx.file(`seg_audio.${slot}.wav`);
  const out = ctx.file(`final_audio.${slot}.wav`);
  const sub = (p: number) => input.onSub?.(p);

  // 1. trim the segment's audio to a clean 48k stereo wav
  await run(
    FFMPEG,
    ['-hide_banner', '-y', '-ss', String(segStart), '-to', String(segEnd), '-i', dl.videoPath,
     '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', raw],
    { signal: ctx.signal },
  );
  sub(0.1);

  // 1b. strip music — rebuild the voice track from Demucs' vocal stem
  let voiceSource = raw;
  let musicStripped = false;
  if (input.stripMusic) {
    try {
      const stemDir = ctx.file(`stems.${slot}`);
      const model = process.env.DEMUCS_MODEL || 'htdemucs'; // set DEMUCS_MODEL=htdemucs_ft for cleaner isolation
      const res = await runPython('demucs_split.py', {
        args: ['--audio', raw, '--mode', 'full', '--out-dir', stemDir, '--model', model],
        signal: ctx.signal,
        onProgress: (p) => input.onSub?.(0.1 + p * 0.35),
        onLog: (l) => ctx.log('sfx', `clip ${slot + 1}: ${l}`),
      });
      const vocals = (JSON.parse(res) as { vocals?: string }).vocals;
      if (vocals && existsSync(vocals)) {
        voiceSource = ctx.file(`voice.${slot}.wav`);
        // clean up residual bleed the stem model leaves: drop sub-bass (kick/bass never
        // overlaps speech), a soft downward-expander to push quiet music under, de-ess-y top.
        const cleanup =
          'highpass=f=110,' +
          'compand=attacks=0:decays=0.3:points=-90/-90|-45/-90|-30/-20|-15/-12|0/-6,' +
          'afftdn=nf=-32:tn=1,lowpass=f=15000';
        await run(
          FFMPEG,
          ['-hide_banner', '-y', '-i', vocals, '-af', cleanup, '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', voiceSource],
          { signal: ctx.signal },
        );
        musicStripped = true;
        ctx.log('sfx', `clip ${slot + 1}: rebuilt audio from vocal stem — music removed (${model})`);
      }
    } catch (err) {
      ctx.log('sfx', `clip ${slot + 1}: music strip failed (${(err as Error).message}) — keeping original audio`);
    }
  }
  sub(0.2);

  // 2. build the filtergraph: [voice] -> denoise ; optional [sfx] mixes
  const inputs = ['-i', voiceSource];
  const filters: string[] = [];
  const denoise = 'afftdn=nf=-25,highpass=f=60';
  filters.push(`[0:a]${denoise}[voice]`);
  let mixLabel = '[voice]';
  const triggers: number[] = [];

  if (ctx.settings.sfxEnabled) {
    const sfxFile = pickSfxFile(ctx.settings.sfxPack, ['whoosh', 'riser', 'transition', 'swoosh']);
    if (sfxFile) {
      if (ctx.settings.sfxAtStart) triggers.push(0.0);

      const uniqTriggers = [...new Set(triggers)].slice(0, 8);
      if (uniqTriggers.length) {
        inputs.push('-i', sfxFile);
        // one delayed, level-trimmed copy of the sfx per trigger, then mix them
        const sfxParts = uniqTriggers
          .map((t, i) => `[1:a]adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)},volume=0.6[sfx${i}]`)
          .join(';');
        const sfxMixIns = uniqTriggers.map((_, i) => `[sfx${i}]`).join('');
        filters.push(sfxParts);
        filters.push(`${sfxMixIns}amix=inputs=${uniqTriggers.length}:normalize=0[sfxbed]`);
        // duck the voice slightly under the sfx, then combine
        filters.push(`[voice][sfxbed]sidechaincompress=threshold=0.05:ratio=4:attack=5:release=250[ducked]`);
        filters.push(`[ducked][sfxbed]amix=inputs=2:normalize=0[mixed]`);
        mixLabel = '[mixed]';
        ctx.log('sfx', `mixing ${sfxFile.split('/').pop()} at ${uniqTriggers.map((t) => `${t}s`).join(', ')}`);
      }
    } else {
      ctx.log('sfx', `no audio files in sfx pack "${ctx.settings.sfxPack}" — skipping sfx`);
    }
  }

  // 3. measure loudness (pass 1)
  sub(0.4);
  const measureGraph = `${filters.join(';')};${mixLabel}loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json`;
  const m = await run(
    FFMPEG,
    ['-hide_banner', ...inputs, '-filter_complex', measureGraph, '-f', 'null', '-'],
    { signal: ctx.signal },
  );
  const stats = parseLoudnormJson(m.stderr);
  ctx.log('sfx', `input loudness ${stats?.input_i ?? '?'} LUFS → target −14`);

  // 4. apply (pass 2)
  sub(0.6);
  const applyLoudnorm = stats
    ? `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:` +
      `measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true`
    : 'loudnorm=I=-14:TP=-1.5:LRA=11';
  const applyGraph = `${filters.join(';')};${mixLabel}${applyLoudnorm}[a]`;

  await runFfmpeg(
    ['-y', ...inputs, '-filter_complex', applyGraph, '-map', '[a]', '-ar', '48000', '-ac', '2',
     '-c:a', 'pcm_s16le', out],
    {
      signal: ctx.signal,
      totalDurationSec: dur,
      onProgress: (pct) => sub(0.6 + pct * 0.4),
      onStderr: (l) => {
        if (l.includes('Error') || l.includes('Invalid')) ctx.log('sfx', l.trim());
      },
    },
  );

  ctx.log('sfx', `clip ${slot + 1}: −14 LUFS${triggers.length ? ` · ${new Set(triggers).size} sfx hit(s)` : ''}`);
  return {
    audioPath: out,
    loudnessBefore: stats ? Number(stats.input_i) : null,
    loudnessAfter: -14,
    musicStripped,
  };
}

interface LoudnormStats {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

function parseLoudnormJson(stderr: string): LoudnormStats | null {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < 0 || end < start) return null;
  try {
    const j = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string | undefined>;
    if (!j.input_i || !j.input_tp || !j.input_lra || !j.input_thresh || !j.target_offset) return null;
    return {
      input_i: j.input_i,
      input_tp: j.input_tp,
      input_lra: j.input_lra,
      input_thresh: j.input_thresh,
      target_offset: j.target_offset,
    };
  } catch {
    return null;
  }
}
