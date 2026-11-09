import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from './env.ts';
import { runPython } from './lib/python.ts';
import type { StepContext } from './pipeline/context.ts';

export const KOKORO_MODEL = resolve(REPO_ROOT, 'assets', 'kokoro', 'kokoro-v1.0.onnx');
export const KOKORO_VOICES = resolve(REPO_ROOT, 'assets', 'kokoro', 'voices-v1.0.bin');

export function kokoroReady(): boolean {
  return existsSync(KOKORO_MODEL) && existsSync(KOKORO_VOICES);
}

export interface NarrationResult {
  /** 24 kHz mono WAV. */
  path: string;
  durationSec: number;
  voice: string;
}

/**
 * Narrate `text` with Kokoro-82M (local, Apache-2.0). Writes `outPath` and returns
 * its measured duration. `voice` is a Kokoro id like "am_michael"; UK ids (b*) use
 * the British phoneme set automatically.
 */
export async function narrate(
  ctx: StepContext,
  input: {
    text: string;
    voice: string;
    outPath: string;
    /** 1.0 = default; lower is slower / more deliberate (storytime). */
    speed?: number;
    onProgress?: (pct: number, msg: string) => void;
  },
): Promise<NarrationResult> {
  if (!kokoroReady()) {
    throw new Error(
      `Kokoro model files are missing (${KOKORO_MODEL}). Run scripts/setup.sh, or download them from ` +
        'github.com/thewh1teagle/kokoro-onnx/releases (model-files-v1.0).',
    );
  }

  const textFile = ctx.file('narration.txt');
  writeFileSync(textFile, input.text, 'utf8');

  const lang = input.voice.startsWith('b') ? 'en-gb' : 'en-us';
  const speed = Math.max(0.6, Math.min(1.3, input.speed ?? 1.0));
  const stdout = await runPython('tts.py', {
    args: ['--text-file', textFile, '--voice', input.voice, '--lang', lang, '--speed', String(speed), '--out', input.outPath],
    signal: ctx.signal,
    onProgress: (p, m) => input.onProgress?.(p, m),
    onLog: (l) => ctx.log('download', l),
  });

  const parsed = JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1) ?? '{}') as Partial<NarrationResult>;
  if (!parsed.path || !existsSync(parsed.path)) throw new Error('Kokoro produced no audio file.');
  return { path: parsed.path, durationSec: parsed.durationSec ?? 0, voice: parsed.voice ?? input.voice };
}
