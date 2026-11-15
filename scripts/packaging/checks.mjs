// The two gates every post kit has to pass before it's finished:
//   revealProblems()  nothing states the winner or an answer, no engagement
//                     bait, no dashes, keyword first, ends on a question
//   repeatProblems()  not too close to the last 10 posts (caption, hook,
//                     cover, pinned), sound not in the last 3, hashtag set
//                     not identical to the last 5
import { firstLine, hamming, hasDash, normText, similarity } from './util.mjs';

export const LIMITS = {
  window: 10,
  captionSimilarity: 0.5,   // max overlap with any of the last 10 captions
  pinnedSimilarity: 0.6,
  coverHamming: 10,         // pHash bits; 10 or fewer of 64 = near-duplicate image
  soundWindow: 3,
  hashtagWindow: 5,
};

const WIN_WORDS = /\b(wins?|won|winner|winning|champion|victor|victory|takes (it|the (grid|crown|win))|survives?|survived|survivor|last (one|colour|color|ball) (standing|left)|comes out on top)\b/i;
const BAIT = /\blike\s*(=|for|if)\b|\bcomment\s*(=|if)\b|\b(follow|subscribe) (for|to see)\b|\bshare (this|with)\b|\btag (a|someone|your)\b|\bpart 2\b|=\s*(red|blue|green|yellow)\b|\bdouble tap\b/i;

/** Problems with one kit's text, as a list of strings (empty = clean). */
export function revealProblems(kit, facts) {
  const out = [];
  const texts = {
    caption: kit.caption,
    hook: kit.hook.lines.join(' '),
    cover: kit.cover.lines.join(' '),
    pinned: kit.pinned,
  };
  const hidden = facts.hidden ?? {};
  for (const [what, text] of Object.entries(texts)) {
    // the winner's name may appear (any colour can be quoted in a moment —
    // see facts.mjs on why that's picked at random), but never in the same
    // sentence as a word that says how it ended
    for (const sentence of text.split(/(?<=[.!?\n])\s*/)) {
      for (const w of hidden.words ?? []) {
        if (w && new RegExp(`\\b${w}\\b`, 'i').test(sentence) && WIN_WORDS.test(sentence)) {
          out.push(`${what} ties "${w}" (the winner) to an outcome word: "${sentence.trim()}"`);
        }
      }
    }
    if (hidden.answers?.length) {
      // a cup game's answer is a cup/ball number — no template ever names a
      // specific cup or ball, so any "cup 3" / "ball #2" / "number 4" is a leak
      const m = text.match(/\b(cup|ball|number|no\.?|position|slot)\s*#?\s*(\d+)\b|\bunder\s+#?(\d+)\b|#(\d+)\s+(cup|ball)\b/i);
      if (m) out.push(`${what} names a specific cup/ball: "${m[0]}"`);
    }
    if (/\b(the )?(winner|answer) (is|was)\b/i.test(text)) out.push(`${what} announces the result: "${text}"`);
    if (BAIT.test(text)) out.push(`${what} has engagement bait: "${text.match(BAIT)[0]}"`);
    if (hasDash(text)) out.push(`${what} has a dash`);
  }
  if (!kit.caption.startsWith(facts.keyword)) out.push(`caption doesn't start with the keyword "${facts.keyword}"`);
  if (!kit.caption.trim().endsWith('?')) out.push('caption doesn\'t end with a question');
  if (!kit.pinned.trim().endsWith('?') && !/\bcomment\b/i.test(kit.pinned)) out.push('pinned comment doesn\'t ask anything');
  if (kit.hashtags.length < 3 || kit.hashtags.length > 5) out.push(`${kit.hashtags.length} hashtags (want 3 to 5)`);
  return out;
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');

/**
 * What about this kit is too close to recent posts. `recent` = log entries,
 * oldest first. Each problem names its component so the caller can redo just
 * that part. Pass `phash` once the cover exists to include the image check.
 */
export function repeatProblems(kit, recent) {
  const last = recent.slice(-LIMITS.window);
  const out = [];
  const fl = normText(firstLine(kit.caption));
  for (const e of last) {
    if (normText(firstLine(e.caption)) === fl) out.push({ part: 'caption', why: `first line matches post ${e.id}` });
    const s = similarity(kit.caption, e.caption);
    if (s > LIMITS.captionSimilarity) out.push({ part: 'caption', why: `caption ${Math.round(s * 100)}% similar to post ${e.id}` });
    const hook = normText(kit.hook.lines.join(' '));
    if (hook && hook === normText((e.hook?.lines ?? []).join(' '))) out.push({ part: 'hook', why: `hook repeats post ${e.id}` });
    if (kit.hook.id && kit.hook.id === e.hook?.id) out.push({ part: 'hook', why: `hook template ${kit.hook.id} used by post ${e.id}` });
    const cover = normText(kit.cover.lines.join(' '));
    if (cover && cover === normText((e.cover?.lines ?? []).join(' '))) out.push({ part: 'coverText', why: `cover text repeats post ${e.id}` });
    const p = similarity(kit.pinned, e.pinned ?? '');
    if (p > LIMITS.pinnedSimilarity) out.push({ part: 'pinned', why: `pinned comment ${Math.round(p * 100)}% similar to post ${e.id}` });
    if (kit.cover.phash && e.cover?.phash) {
      const d = hamming(kit.cover.phash, e.cover.phash);
      if (d <= LIMITS.coverHamming) out.push({ part: 'cover', why: `cover looks like post ${e.id} (pHash distance ${d})` });
    }
  }
  for (const e of recent.slice(-LIMITS.soundWindow)) {
    if (kit.sound?.track && kit.sound.track !== 'none' && kit.sound.track === e.sound?.track) out.push({ part: 'sound', why: `sound track "${kit.sound.track}" used by post ${e.id}` });
  }
  for (const e of recent.slice(-LIMITS.hashtagWindow)) {
    if (e.hashtags && sameSet(kit.hashtags, e.hashtags)) out.push({ part: 'hashtags', why: `same hashtag set as post ${e.id}` });
  }
  return out;
}
