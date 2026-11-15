// Reads a rendered video (never the sim) to find:
//   - the letterbox: pixels that stay pure black for the whole game. Only
//     those get the rotated background, so the playfield is never touched.
//   - the stage: the playfield rectangle, so a border can be drawn around it
//   - calm bands: horizontal strips with the least motion during the opening
//     seconds, where the hook can sit without covering the action
import { writeFileSync } from 'node:fs';
import { FFMPEG, run } from './util.mjs';

export const AW = 108, AH = 192; // analysis grid: 1/10 of a 1080x1920 frame

async function frames(video, { start, dur, fps, gray }) {
  const { stdout } = await run(FFMPEG, [
    '-v', 'error', '-ss', String(start), '-t', String(dur), '-i', video,
    '-vf', `fps=${fps},scale=${AW}:${AH}:flags=area,format=${gray ? 'gray' : 'rgb24'}`,
    '-f', 'rawvideo', '-',
  ], { encoding: 'buffer' });
  const size = AW * AH * (gray ? 1 : 3);
  const out = [];
  for (let o = 0; o + size <= stdout.length; o += size) out.push(stdout.subarray(o, o + size));
  return out;
}

export async function analyzeVideo(video, { contentEnd, hookSec = 3 }) {
  // ---- letterbox mask: black (<= 10) in every one of ~30 samples
  const span = Math.max(1, contentEnd - 0.4);
  const samples = await frames(video, { start: 0, dur: span, fps: Math.min(6, 30 / span), gray: false });
  const maxv = new Uint8Array(AW * AH);
  const minv = new Uint8Array(AW * AH).fill(255);
  for (const f of samples) for (let i = 0; i < AW * AH; i++) {
    const m = Math.max(f[i * 3], f[i * 3 + 1], f[i * 3 + 2]);
    if (m > maxv[i]) maxv[i] = m;
    if (m < minv[i]) minv[i] = m;
  }
  let mask = new Uint8Array(AW * AH);
  for (let i = 0; i < mask.length; i++) mask[i] = maxv[i] <= 10 ? 1 : 0;
  // erode one cell (~10px at 1080 wide) so the background never bleeds onto
  // the playfield's own edge
  const er = new Uint8Array(mask.length);
  for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
    let ok = mask[y * AW + x];
    for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1 && ok; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < AH && xx >= 0 && xx < AW && !mask[yy * AW + xx]) ok = 0;
    }
    er[y * AW + x] = ok;
  }
  mask = er;

  // ---- stage: rows/cols that are lit in EVERY sample (the playfield's own
  //      background), so balls flying over black don't count as a stage
  const content = (x, y) => (minv[y * AW + x] > 6 ? 1 : 0);
  const rowDense = [];
  for (let y = 0; y < AH; y++) { let s = 0; for (let x = 0; x < AW; x++) s += content(x, y); rowDense.push(s / AW); }
  const rows = rowDense.map((d, y) => (d >= 0.5 ? y : -1)).filter((y) => y >= 0);
  let stage = null;
  if (rows.length) {
    const y0 = rows[0], y1 = rows.at(-1);
    const colDense = [];
    for (let x = 0; x < AW; x++) { let s = 0; for (let y = y0; y <= y1; y++) s += content(x, y); colDense.push(s / (y1 - y0 + 1)); }
    const cols = colDense.map((d, x) => (d >= 0.5 ? x : -1)).filter((x) => x >= 0);
    if (cols.length) {
      const r = { x: cols[0] / AW, y: y0 / AH, w: (cols.at(-1) + 1 - cols[0]) / AW, h: (y1 + 1 - y0) / AH };
      // a playfield that fills the frame (Ring of Doom / Hot Potato draw on
      // full-frame black) has no separate stage to frame
      // ...and a persistent strip like a banner box isn't a playfield either
      if (r.w < 0.92 && r.h < 0.95 && r.w >= 0.4 && r.h >= 0.25) stage = r;
    }
  }
  // no stage = the game draws on full-frame black (Ring of Doom, Hot Potato):
  // the background then goes behind everything, blended so it only shows
  // where the frame is darker than it (see compose.mjs)
  if (!stage) mask = new Uint8Array(AW * AH).fill(1);
  const letterboxShare = mask.reduce((a, b) => a + b, 0) / mask.length;

  // ---- motion in the opening seconds, per analysis cell
  // a little past the hook's own seconds, so a playfield that's about to
  // start moving (a shuffle starting at 3s) still counts as the action
  const open = await frames(video, { start: 0, dur: hookSec + 1.5, fps: 15, gray: true });
  const motion = new Float32Array(AW * AH);
  const moved = new Float32Array(AW * AH);   // biggest single-step change per cell
  for (let k = 1; k < open.length; k++) for (let i = 0; i < motion.length; i++) {
    const d = Math.abs(open[k][i] - open[k - 1][i]);
    motion[i] += d;
    if (d > moved[i]) moved[i] = d;
  }
  for (let i = 0; i < motion.length; i++) motion[i] /= Math.max(1, open.length - 1);
  // static detail (text, edges) in the same seconds: mean gradient magnitude
  const detail = new Float32Array(AW * AH);
  for (const f of open) for (let y = 1; y < AH - 1; y++) for (let x = 1; x < AW - 1; x++) {
    const i = y * AW + x;
    detail[i] += Math.abs(f[i + 1] - f[i - 1]) + Math.abs(f[i + AW] - f[i - AW]);
  }
  for (let i = 0; i < detail.length; i++) detail[i] /= Math.max(1, open.length);

  return { stage, mask, letterboxShare, motion, moved, detail, samples: samples.length };
}

/** Opening-seconds motion and static detail inside a box given in
 *  1080x1920 pixels, plus the bounding box of the detail (text) in it. */
export function boxMotion(an, box) {
  const x0 = Math.max(0, Math.floor(box.x / 10)), x1 = Math.min(AW, Math.ceil((box.x + box.w) / 10));
  const y0 = Math.max(0, Math.floor(box.y / 10)), y1 = Math.min(AH, Math.ceil((box.y + box.h) / 10));
  let s = 0, d = 0, n = 0, peak = 0, active = 0;
  let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * AW + x;
    s += an.motion[i]; d += an.detail?.[i] ?? 0; n++;
    if (an.motion[i] > peak) peak = an.motion[i];
    if ((an.moved?.[i] ?? 0) > 14) active++;
    if ((an.detail?.[i] ?? 0) > 12) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
  }
  const detailBox = bx1 >= 0 ? { x: bx0 * 10, y: by0 * 10, w: (bx1 - bx0 + 1) * 10, h: (by1 - by0 + 1) * 10 } : null;
  // active = share of the box where something moved at all: a ball rolling
  // through barely moves the average but lights up these cells
  return { mean: n ? s / n : 0, detail: n ? d / n : 0, peak, active: n ? active / n : 0, detailBox };
}

export function writeMaskPgm(an, path) {
  const head = Buffer.from(`P5\n${AW} ${AH}\n255\n`);
  const body = Buffer.alloc(AW * AH);
  for (let i = 0; i < body.length; i++) body[i] = an.mask[i] ? 255 : 0;
  writeFileSync(path, Buffer.concat([head, body]));
}

/** Static detail per horizontal band of one still image, plainest first. */
export async function bandDetail(png, cys, halfH = 150) {
  const { grayFrame } = await import('./util.mjs');
  const f = await grayFrame(png, AW, AH);
  return cys.map((cy) => {
    let d = 0, n = 0;
    for (let y = Math.max(1, Math.floor((cy - halfH) / 10)); y < Math.min(AH - 1, Math.ceil((cy + halfH) / 10)); y++) {
      for (let x = 8; x < 86; x++) { const i = y * AW + x; d += Math.abs(f[i + 1] - f[i - 1]) + Math.abs(f[i + AW] - f[i - AW]); n++; }
    }
    return { cy, detail: d / Math.max(1, n) };
  }).sort((a, b) => a.detail - b.detail);
}
