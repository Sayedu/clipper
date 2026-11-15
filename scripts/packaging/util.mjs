// Small shared helpers: seeded randomness, text similarity, perceptual hash.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export const FFMPEG = process.env.FFMPEG_PATH
  || (existsSync('/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg') ? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg' : 'ffmpeg');
export const FFPROBE = process.env.FFPROBE_PATH
  || (existsSync('/opt/homebrew/opt/ffmpeg-full/bin/ffprobe') ? '/opt/homebrew/opt/ffmpeg-full/bin/ffprobe' : 'ffprobe');

export function run(cmd, args, opts = {}) {
  return pexec(cmd, args, { maxBuffer: 1 << 30, ...opts });
}

// ---------------------------------------------------------------- randomness
export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}
export function rng(seed) {
  let a = seed >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.shuffle = (arr) => {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return next;
}

// ---------------------------------------------------------------- text
const STOP = new Set('a an the and or but of to in on at for with by is it its this that be are was were you your i my me we our do did does how who what which when where why can could would will just so if as from up out one all any no not'.split(' '));
// numbers and colour names are the parts that change between two captions
// built from the same sentence, so they're normalised away: "Blue was last at
// 12 seconds" and "Red was last at 20 seconds" count as the same sentence.
const COLOURS = new Set(['red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'gold', 'cyan']);
export function tokens(text) {
  return String(text)
    .toLowerCase()
    .replace(/#[\w]+/g, ' ')
    .replace(/[^\p{L}\p{N}%\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (/^\d+(\.\d+)?%?$/.test(w) ? '<n>' : COLOURS.has(w) ? '<c>' : w));
}
function shingles(toks, n) {
  const out = new Set();
  for (let i = 0; i + n <= toks.length; i++) out.add(toks.slice(i, i + n).join(' '));
  return out;
}
function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
/** 0 = nothing in common, 1 = the same text. The max of a content-word
 *  overlap and a word-pair (phrase) overlap, so both "same words reshuffled"
 *  and "same sentence, new numbers" score high. */
export function similarity(a, b) {
  const ta = tokens(a), tb = tokens(b);
  const ca = new Set(ta.filter((w) => !STOP.has(w))), cb = new Set(tb.filter((w) => !STOP.has(w)));
  return Math.max(jaccard(ca, cb), jaccard(shingles(ta, 2), shingles(tb, 2)));
}
export const firstLine = (s) => String(s).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
export const normText = (s) => tokens(s).join(' ');

export const hasDash = (s) => /[-‐-―−]/.test(s);
export function stripDashes(s) {
  return s.replace(/\s*[–—―]\s*/g, ', ').replace(/[-‐-‒−]/g, ' ').replace(/ {2,}/g, ' ');
}

// ---------------------------------------------------------------- media
export async function probe(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration', '-of', 'json', file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const [n, d] = (v?.r_frame_rate ?? '60/1').split('/').map(Number);
  return { width: v?.width, height: v?.height, fps: n / (d || 1), duration: Number(j.format.duration), vcodec: v?.codec_name, acodec: a?.codec_name, hasAudio: !!a };
}

/** Grayscale frame as raw bytes (w*h). `at` in seconds, or an image file. */
export async function grayFrame(src, w, h, at = null) {
  const args = ['-v', 'error'];
  if (at != null) args.push('-ss', String(at));
  args.push('-i', src, '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', '-');
  const { stdout } = await pexec(FFMPEG, args, { encoding: 'buffer', maxBuffer: 1 << 28 });
  return stdout;
}

// DCT perceptual hash (the classic pHash: 32x32 gray, 2D DCT, top-left 8x8
// minus DC, threshold at the median) as a 16-char hex string.
const N = 32;
const COS = Array.from({ length: 8 }, (_, u) => Array.from({ length: N }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N))));
export async function phash(imageOrVideo, at = null) {
  const px = await grayFrame(imageOrVideo, N, N, at);
  const coef = [];
  for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
    let s = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) s += px[y * N + x] * COS[u][x] * COS[v][y];
    coef.push(s);
  }
  const ac = coef.slice(1);
  const med = [...ac].sort((a, b) => a - b)[Math.floor(ac.length / 2)];
  let hex = '', nib = 0;
  for (let i = 0; i < 64; i++) {
    nib = (nib << 1) | ((i === 0 ? 0 : coef[i] > med) ? 1 : 0);
    if (i % 4 === 3) { hex += nib.toString(16); nib = 0; }
  }
  return hex;
}
export function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

export const title = (s) => String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
