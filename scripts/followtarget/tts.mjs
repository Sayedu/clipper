// One line of voiceover for Follow the Target, cached on disk so a given
// line + engine + voice + rate is only ever synthesised once.
//
//   engine "kokoro"  (default) offline Kokoro-82M via python/tts.py, no internet
//   engine "edge"    Microsoft Edge neural voices via python/edge_tts_line.py (needs internet,
//                    unofficial service that now and then returns nothing, so it retries)
//
// Rate is written the edge-tts way ("+10%") for both engines; for Kokoro it is
// turned into a speed multiplier (+10% = 1.10).
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const REPO = resolve(new URL('../..', import.meta.url).pathname);
const PY = join(REPO, 'python', '.venv', 'bin', 'python');
export const CACHE_DIR = join(REPO, 'data', 'tts-cache');

export const ENGINES = {
  kokoro: { voice: 'am_adam', ext: 'wav', voiceRe: /^[a-z]{2}_[a-z]+$/ },
  edge: { voice: 'en-US-AndrewNeural', ext: 'mp3', voiceRe: /^[A-Za-z]{2,3}-[A-Za-z]{2,4}(-[A-Za-z0-9]+)?-[A-Za-z0-9]+Neural$/ },
};
export const DEFAULT_ENGINE = 'kokoro';
export const DEFAULT_RATE = '+10%';
const RATE_RE = /^[+-]\d{1,3}%$/;

/** Validates and fills in defaults; throws a readable Error on bad input. */
export function checkTtsOptions({ text, engine = DEFAULT_ENGINE, voice, rate = DEFAULT_RATE }) {
  const e = ENGINES[engine];
  if (!e) throw new Error(`engine must be one of ${Object.keys(ENGINES).join(', ')}, got "${engine}"`);
  text = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('no text to speak');
  if (text.length > 600) throw new Error(`line is ${text.length} characters; keep it under 600`);
  voice = voice || e.voice;
  if (!e.voiceRe.test(voice)) throw new Error(`"${voice}" is not a ${engine} voice name (for example ${e.voice})`);
  if (!RATE_RE.test(rate)) throw new Error(`rate must look like +10% or -5%, got "${rate}"`);
  return { text, engine, voice, rate };
}
const speedOf = (rate) => Math.min(1.6, Math.max(0.5, 1 + parseInt(rate, 10) / 100));

/** -> { path, cached, text, engine, voice, rate } : an audio file for the line. */
export async function ttsLine(opts) {
  const { text, engine, voice, rate } = checkTtsOptions(opts);
  mkdirSync(CACHE_DIR, { recursive: true });
  const key = createHash('sha1').update(`${engine}|${voice}|${rate}|${text}`).digest('hex').slice(0, 20);
  const path = join(CACHE_DIR, `${key}.${ENGINES[engine].ext}`);
  if (existsSync(path)) return { path, cached: true, text, engine, voice, rate };
  const tmp = `${path}.part.${ENGINES[engine].ext}`;
  try {
    if (engine === 'kokoro') {
      const txt = `${path}.txt`;
      writeFileSync(txt, text);
      try {
        await pexec(PY, [join(REPO, 'python', 'tts.py'), '--text-file', txt, '--voice', voice, '--speed', String(speedOf(rate)), '--out', tmp], { timeout: 120_000 });
      } finally { rmSync(txt, { force: true }); }
    } else {
      await pexec(PY, [join(REPO, 'python', 'edge_tts_line.py'), '--text', text, '--voice', voice, '--rate', rate, '--out', tmp], { timeout: 90_000 });
    }
  } catch (err) {
    throw new Error(`voice generation failed (${engine}): ${(err.stderr || err.message || '').toString().trim().split('\n').pop()}`);
  }
  renameSync(tmp, path);
  return { path, cached: false, text, engine, voice, rate };
}
