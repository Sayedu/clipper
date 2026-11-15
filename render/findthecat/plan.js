/* Find The Cat — the seeded PLAN for one render.

   Everything visible that varies from video to video (palette, backdrop
   pattern, cups and swap count per round, which cup the cat starts under,
   which twist each round gets) is derived here from (seed, options) alone.

   Loaded two ways from this one file: as a plain <script> in the browser
   (sets window.FTC_PLAN, used by game.js), and evaluated in a vm sandbox by
   the Node scripts (render.mjs's variety check + render log, verify.mjs) —
   so the game, the log and the variety check can never disagree about what
   a seed looks like. No DOM, no imports, no module syntax on purpose. */
(function (root) {
  'use strict';

  // mulberry32 — the same generator game.js uses
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const THEME_KEYS = ['candy', 'neon', 'sunset', 'colorblind'];
  // colorblind is an explicit accessibility choice, never picked at random
  const RANDOM_THEMES = ['candy', 'neon', 'sunset'];

  // the rotating ray backdrop — wedge count + spin direction both read
  // instantly in the first second, so they're part of a video's "look"
  const BACKDROPS = [
    { id: 'rays40', wedges: 40, spin: 1 },
    { id: 'rays24', wedges: 24, spin: -1 },
    { id: 'rays56', wedges: 56, spin: 1 },
    { id: 'rays32', wedges: 32, spin: -1 },
  ];

  // round 1 easy, round 2 medium, round 3 onward hard (by request)
  const TIERS = [
    { difficulty: 'easy', cups: [3, 4], swaps: [12, 14] },
    { difficulty: 'medium', cups: [4, 5], swaps: [17, 20] },
    { difficulty: 'hard', cups: [5, 6], swaps: [24, 28] },
  ];

  // visual twists only — none of them change where the cat really is
  //   fakeout:    during the countdown a WRONG cup lifts a little and drops
  //               back (nothing under it — a tease, never a lie)
  //   colorshift: at the FASTER!! moment every cup changes color together
  const TWISTS = ['none', 'fakeout', 'colorshift'];

  const pickInt = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

  function buildPlan(seed, opts) {
    const o = opts || {};
    const s = (seed >>> 0) || 1;
    const rounds = Math.max(1, Math.min(6, Math.round(o.rounds || 3)));
    const themeChoice = THEME_KEYS.indexOf(o.theme) >= 0 ? o.theme : 'random';
    const twists = o.twists !== false;
    // a separate stream from buildSchedule's own per-round RNG, and every
    // draw always happens in the same order whether it's used or not — so
    // flipping one option (theme, twists) never reshuffles the others
    const r = rng((s ^ 0x5eed1234) >>> 0);
    const themeDraw = r();
    const backdropDraw = r();
    const theme = themeChoice === 'random'
      ? RANDOM_THEMES[Math.floor(themeDraw * RANDOM_THEMES.length)]
      : themeChoice;
    const backdrop = BACKDROPS[Math.floor(backdropDraw * BACKDROPS.length)];

    const plan = [];
    for (let i = 0; i < rounds; i++) {
      const tier = TIERS[Math.min(i, TIERS.length - 1)];
      let cups = pickInt(r, tier.cups[0], tier.cups[1]);
      let swaps = pickInt(r, tier.swaps[0], tier.swaps[1]);
      const ballDraw = r();
      const twistDraw = r();
      const fakeDraw = r();
      // the final round is announced as the last chance — keep it at least
      // as hard as anything before it, so that on-screen claim stays true
      if (i === rounds - 1 && i > 0) {
        cups = Math.max(cups, plan[i - 1].cups);
        swaps = Math.max(swaps, plan[i - 1].swaps);
      }
      plan.push({
        cups,
        difficulty: tier.difficulty,
        swaps,
        ballCup: Math.floor(ballDraw * cups),
        // round 1 stays clean so the hook is easy to follow
        twist: !twists || i === 0 ? 'none' : TWISTS[Math.floor(twistDraw * TWISTS.length)],
        fakeDraw,
      });
    }
    return { seed: s, rounds, themeChoice, theme, backdrop: backdrop.id, twists, plan };
  }

  // what a viewer sees in the first second: palette + backdrop + cup count
  function signature(p) {
    return p.theme + '|' + p.backdrop + '|' + p.plan[0].cups;
  }

  root.FTC_PLAN = { rng, buildPlan, signature, THEME_KEYS, RANDOM_THEMES, BACKDROPS, TIERS, TWISTS };
})(typeof window !== 'undefined' ? window : globalThis);
