// Post kit for one Find The Cat render: file naming, a ready-to-paste
// caption (topic keyword first, then a real question, then 3-5 relevant
// hashtags, written naturally with no dashes), a suggested pinned comment,
// and a cover PNG taken from the final reveal with the hook text burned in.
//
// Shared by the CLI (scripts/findthecat/render.mjs) and the dashboard
// pipeline (worker/src/pipeline/steps/findthecat.ts + run.ts), so both
// produce the exact same wording.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const REPO = resolve(new URL('../..', import.meta.url).pathname);
export const COVER_FONT = join(REPO, 'assets/fonts/ChakraPetch-Bold.ttf');

/** Length presets. "long" is the smallest round count that clears TikTok
 *  Creator Rewards' "over one minute" bar with room to spare: 4 rounds of
 *  18.8s = 75.2s (3 rounds would be 56.4s — under the line). */
export const LENGTH_ROUNDS = { short: 1, long: 4 };

/** The honest label for a round count: short (15-30s), long (over 60s),
 *  or custom for anything in between. */
export function lengthModeFor(rounds) {
  return rounds <= 1 ? 'short' : rounds >= LENGTH_ROUNDS.long ? 'long' : 'custom';
}

/** findthecat-<mode>-<seconds>s-seed<seed> — shared by every file of a render. */
export function baseName(r) {
  return `findthecat-${lengthModeFor(r.roundCount)}-${Math.round(r.durationSec)}s-seed${r.seed}`;
}

export function buildPostKit(r) {
  const n = r.roundCount;
  const caption = n > 1
    ? `Find the cat cup game 🐱 Can you track the cat through all ${n} rounds? Every round adds cups and speeds up the shuffle, so keep count of how many you get right.`
    : 'Find the cat cup game 🐱 Can you track which cup the cat ends up under? Lock in your answer before the reveal.';
  const hashtags = ['findthecat', 'cupgame', 'shellgame', 'eyetest', 'catsoftiktok'];
  const pinnedComment = n > 1
    ? `How many did you get right out of ${n}? Drop your score below 🐱`
    : 'Which cup did you pick? Be honest 🐱';
  return {
    caption,
    hashtags,
    pinnedComment,
    hook: r.hook || 'FIND THE CAT',
    coverSub: n > 1 ? `CUP GAME · ${n} ROUNDS` : 'CUP GAME',
  };
}

/** The .txt saved next to every video. */
export function postKitText(kit, r, files = {}) {
  const lines = [
    'CAPTION',
    kit.caption,
    '',
    kit.hashtags.map((t) => `#${t}`).join(' '),
    '',
    'PINNED COMMENT',
    kit.pinnedComment,
    '',
    'ANSWERS (for you, not for the caption)',
    ...r.answers.map((a, i) => `Round ${i + 1}: cup ${a} (${r.difficulty[i]}, ${r.cups[i]} cups${r.twists && r.twists[i] !== 'none' ? `, ${r.twists[i]} twist` : ''})`),
    '',
    'RENDER',
    `seed ${r.seed} · ${r.roundCount} round(s) · ${lengthModeFor(r.roundCount)} · ${r.durationSec}s · theme ${r.theme} · backdrop ${r.backdrop}`,
  ];
  const f = Object.entries(files).filter(([, v]) => v);
  if (f.length) lines.push('', 'FILES', ...f.map(([k, v]) => `${k}: ${v}`));
  return lines.join('\n') + '\n';
}

/** When the cover should be grabbed: the final round's reveal, just after
 *  the winning cup lifts — cat + confetti + zoom, the most eye-catching
 *  moment of the video. */
export function coverTimeSec(r) {
  return (r.roundCount - 1) * r.roundTotalSec + r.revealOffsetSec + 0.55;
}

/** Grab a frame and burn the hook + sub line onto it (inside a dark box
 *  near the upper middle — it survives TikTok's 3:4 profile-grid crop and
 *  stays clear of the top bar). Always written at 1080x1920. */
export async function writeCover({ ffmpeg, video, atSec, out, hook, sub, top = 0.215 }) {
  const dir = await mkdtemp(join(tmpdir(), 'ftc-cover-'));
  try {
    // textfile= sidesteps drawtext's quoting rules for arbitrary hook text
    const hookFile = join(dir, 'hook.txt');
    const subFile = join(dir, 'sub.txt');
    await writeFile(hookFile, hook);
    await writeFile(subFile, sub);
    const vf = [
      'scale=1080:1920:flags=lanczos',
      `drawtext=fontfile=${COVER_FONT}:textfile=${hookFile}:fontsize=112:fontcolor=white:borderw=6:bordercolor=black@0.9:box=1:boxcolor=black@1:boxborderw=28:x=(w-text_w)/2:y=h*${top}`,
      `drawtext=fontfile=${COVER_FONT}:textfile=${subFile}:fontsize=46:fontcolor=0xFFD23F:box=1:boxcolor=black@1:boxborderw=16:x=(w-text_w)/2:y=h*${top}+172`,
    ].join(',');
    await pexec(ffmpeg, ['-y', '-v', 'error', '-ss', String(atSec), '-i', video, '-frames:v', '1', '-vf', vf, out], { maxBuffer: 1 << 24 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return out;
}
