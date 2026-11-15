// Builds the packaged video with ffmpeg, from the finished render plus the
// packaging layers. Order of layers (bottom to top):
//   game video  ->  background (only where the game is black: "lighten",
//   masked to the letterbox when there is one)  ->  stage border  ->
//   opening camera zoom  ->  hook text
// The game's own pixels inside the playfield come through untouched apart
// from the brief opening zoom; the sim is never re-run.
import { resolve } from 'node:path';
import { FFMPEG, run } from './util.mjs';

const PY = resolve(new URL('../../python/.venv/bin/python', import.meta.url).pathname);
const BED = resolve(new URL('../../python/packaging_bed.py', import.meta.url).pathname);

/** Background PNG multiplied by the letterbox mask (black elsewhere). */
export async function maskedBackground(bgPng, maskPgm, w, h, out) {
  await run(FFMPEG, ['-v', 'error', '-y', '-i', bgPng, '-i', maskPgm, '-filter_complex',
    `[0]scale=${w}:${h},format=gbrp[b];[1]scale=${w}:${h}:flags=bilinear,format=gbrp[m];[b][m]blend=all_mode=multiply`,
    '-frames:v', '1', out]);
}

export async function extractAudio(video, out) {
  await run(FFMPEG, ['-v', 'error', '-y', '-i', video, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', out]);
}

export async function mixBed({ track, seed, orig, contentEnd, out }) {
  const { stdout } = await run(PY, [BED, '--track', track, '--seed', String(seed), '--orig', orig, '--content-end', String(contentEnd), '--out', out]);
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

export async function listTracks() {
  const { stdout } = await run(PY, [BED, '--list']);
  return JSON.parse(stdout);
}

/**
 * One encode: video + layers + mixed audio -> out. `p` holds the probe of
 * the source, the PNG paths and the presentation picks.
 */
export async function composeVideo(p) {
  const { src, probe, bg, border, hook, zoom, contentEnd, audio, out, preset = 'fast' } = p;
  const W = probe.width, H = probe.height, fps = Math.round(probe.fps);
  const k = W / 1080;
  const nz = Math.round(zoom.dur * fps);
  const ce = contentEnd.toFixed(3);
  const parts = [
    `[0:v]format=gbrp[v]`,
    `[1:v]format=gbrp[bg]`,
    `[v][bg]blend=all_mode=lighten:shortest=1:enable='lt(t,${ce})',format=yuv420p[b]`,
    `[b][2:v]overlay=0:0:shortest=1:enable='lt(t,${ce})'[c]`,
  ];
  let last = 'c';
  if (nz > 1 && zoom.from > 1) {
    // ease-out from `from` to 1 over the first nz frames, centred a little
    // above the middle (where every game's playfield sits)
    const z = `if(lte(on,${nz}),${zoom.from}-(${zoom.from}-1)*(1-pow(1-on/${nz},3)),1)`;
    parts.push(
      `[c]split[c1][c2]`,
      `[c1]trim=end_frame=${nz},zoompan=z='${z}':d=1:x='iw/2-(iw/zoom/2)':y='ih*0.46-(ih/zoom*0.46)':s=${W}x${H}:fps=${fps},setpts=PTS-STARTPTS[z1]`,
      `[c2]trim=start_frame=${nz},setpts=PTS-STARTPTS[z2]`,
      `[z1][z2]concat=n=2:v=1:a=0,setpts=N/(${fps}*TB)[d]`,
    );
    last = 'd';
  }
  parts.push(`[${last}][3:v]overlay=0:${Math.round(hook.band.y * k)}:eof_action=pass,format=yuv420p[out]`);
  // some renders' audio ends a beat before the picture: pad with silence so
  // the packaged video keeps every frame (-t below sets the exact length)
  parts.push('[4:a]apad[aout]');
  const args = [
    '-v', 'error', '-y',
    '-i', src,
    '-loop', '1', '-i', bg,
    '-loop', '1', '-i', border,
    '-framerate', String(fps), '-i', hook.pattern,
    '-i', audio,
    '-filter_complex', parts.join(';'),
    '-map', '[out]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', preset, '-crf', '17', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart',
    '-t', probe.duration.toFixed(3),
    out,
  ];
  await run(FFMPEG, args);
}

/** Same picture, different soundtrack (stream copy, no re-encode). */
export async function swapAudio(video, wav, out, durationSec) {
  await run(FFMPEG, ['-v', 'error', '-y', '-i', video, '-i', wav, '-map', '0:v', '-map', '1:a', '-af', 'apad', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-t', durationSec.toFixed(3), out]);
}

export async function frameAt(video, at, out) {
  await run(FFMPEG, ['-v', 'error', '-y', '-ss', at.toFixed(3), '-i', video, '-frames:v', '1', '-vf', 'scale=1080:1920:flags=lanczos', out]);
}

export async function overlayPng(base, layer, out) {
  await run(FFMPEG, ['-v', 'error', '-y', '-i', base, '-i', layer, '-filter_complex', '[0][1]overlay=0:0', '-frames:v', '1', out]);
}

/** Small RGB thumbnail for scoring how eye-catching a frame is. */
export async function thumbRgb(video, at) {
  const { stdout } = await run(FFMPEG, ['-v', 'error', '-ss', at.toFixed(3), '-i', video, '-frames:v', '1', '-vf', 'scale=54:96:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
  return stdout;
}

/** Hasler & Süsstrunk colourfulness plus luminance contrast. */
export function eyeCatch(rgb) {
  const n = rgb.length / 3;
  let srg = 0, syb = 0, srg2 = 0, syb2 = 0, sl = 0, sl2 = 0;
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const rg = r - g, yb = 0.5 * (r + g) - b, l = 0.299 * r + 0.587 * g + 0.114 * b;
    srg += rg; syb += yb; srg2 += rg * rg; syb2 += yb * yb; sl += l; sl2 += l * l;
  }
  const m = (s) => s / n, sd = (s, s2) => Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  const colour = Math.sqrt(sd(srg, srg2) ** 2 + sd(syb, syb2) ** 2) + 0.3 * Math.sqrt(m(srg) ** 2 + m(syb) ** 2);
  return colour + 0.5 * sd(sl, sl2);
}
