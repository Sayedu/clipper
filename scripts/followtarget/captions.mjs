// Captions for Follow the Target videos. Same rules as the post packaging for the
// other games: the keyword comes first, it ends on a real question, 3 to 5 hashtags,
// no dashes, no engagement bait, and nothing that gives the answer away. Everything it
// states is true of that video (item count, number of moves, the 25 second shuffle).
import { firstLine, similarity, stripDashes } from '../packaging/util.mjs';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The phrase the caption opens with (this is what TikTok search sees first). */
export function keywordFor(d) {
  const k = d.kind;
  switch (d.key) {
    case 'cups': return 'Cup game';
    case 'parking': return { police: 'Police car challenge', ambulance: 'Ambulance challenge', fire: 'Fire truck challenge', sedan: 'Parking lot challenge' }[k] || 'Parking lot challenge';
    case 'sky': return k === 'airliner' ? 'Follow the plane' : 'Follow the jet';
    case 'carton': return k === 'egg' ? 'Golden egg challenge' : 'Mystery box challenge';
    case 'coins': return /bitcoin/i.test(d.target) ? 'Bitcoin coin challenge' : 'Diamond coin challenge';
    default: return `Follow the ${k}`;
  }
}

const EMOJI = ['👀', '🎯', '🔎', '🧠', '⏱️', '✨', '🚀', '💬', '🤝', '🔄'];
// first line: one of these, filled with true facts about the video
// food dares (ordinary food only): "buys ___"
const STAKES = ['lunch', 'dinner', 'breakfast', 'the coffee', 'ice cream', 'dessert', 'fries', 'snacks', 'the juice', 'a milkshake', 'donuts', 'cookies', 'the tea', 'popcorn', 'pancakes', 'waffles'];
const OPENERS = [
  (d, K) => `${K}. One of the ${d.items} items glows for two seconds, then the shuffle starts.`,
  (d, K, st) => `${K} dare: send this to a friend. Whoever gets it wrong buys ${st}.`,
  (d, K) => `${K}. No pausing and no rewinding, just your eyes.`,
  (d, K) => `${K} with ${d.moves} moves in 25 seconds.`,
  (d, K, st) => `${K}: wrong answer buys ${st}. Keep your eyes on ${d.find}.`,
  (d, K) => `${K}. ${cap(d.find)} glows at the start and then blends in with the rest.`,
  (d, K, st) => `${K} on a 3 by ${d.rows} grid. Loser buys ${st}.`,
  (d, K) => `Quick focus test: ${K.toLowerCase()}. Watch it all the way to the end.`,
  (d, K, st) => `${K}. Tag a friend and bet them ${st}.`,
  (d, K) => `${K}: pick your number before you scroll.`,
  (d, K, st) => `${K} for the whole family. Loser buys ${st}.`,
  (d, K) => `${K}. I reply to every comment and tell you if you got it right.`,
];
// last line: a real question about the video
const ASKS = ['Which number is it?', 'What number does it end on?', 'Which one did you pick?', 'Can you find it?', 'Which number are you going with?', 'Did you track it all the way?', "What's your number?", 'Which one is it?'];

const THEME_TAGS = {
  cups: ['cupgame', 'shellgame'], parking: ['parkinglot', 'satisfying'], sky: ['planes', 'satisfying'],
  carton: ['eggs', 'satisfying'], coins: ['coins', 'satisfying'], infinite: ['brainteaser', 'oddlysatisfying'],
};
const POOL = ['eyetest', 'focustest', 'brainteaser', 'puzzle', 'trackingtest', 'canyoufindit', 'challenge', 'attentiontest', 'visualtest'];

/**
 * Builds caption i of a batch. `history` is the list of captions already written (oldest
 * first); the new one never repeats the opening line and stays well apart in wording from
 * the last 10, and its hashtag set differs from the last 5.
 */
export function buildCaption(d, i, history = []) {
  const K = keywordFor(d), recent = history.slice(-10);
  let best = null;
  for (let t = 0; t < OPENERS.length * ASKS.length; t++) {
    const opener = OPENERS[(i + t) % OPENERS.length], ask = ASKS[(i * 3 + t) % ASKS.length], emoji = EMOJI[(i + t) % EMOJI.length];
    const stake = STAKES[(i * 5 + t) % STAKES.length];
    const text = stripDashes(`${opener(d, K, stake)} ${emoji}\n${ask}`);
    const ok = recent.every((h) => firstLine(h.caption) !== firstLine(text) && similarity(h.caption, text) < 0.5);
    if (!best) best = text;
    if (ok) { best = text; break; }
  }
  const core = ['followthetarget', ...(THEME_TAGS[d.key] || THEME_TAGS.infinite)];
  const lastSets = history.slice(-5).map((h) => [...h.hashtags].sort().join(' '));
  let tags = core;
  for (let shift = 0; shift < POOL.length; shift++) {
    const extra = [POOL[(i + shift) % POOL.length], POOL[(i + shift + 3) % POOL.length]];
    const set = [...new Set([...core.slice(0, 3), ...extra])].slice(0, 5);
    if (!lastSets.includes([...set].sort().join(' '))) { tags = set; break; }
  }
  return { caption: best, hashtags: tags };
}
