// The hand-picked 20 for a batch (scripts/followtarget/batch.mjs) and the voice lines used.
// a different voice challenge (and food dare) for each video: lines 1, 2, 4, 5 ... of the page's list.
// Line 3, the longest (about 7 s), is left out of batches.
export const LINES = Array.from({ length: 40 }, (_, i) => i + 1).filter((n) => n !== 3);
// The 20 are picked by hand: planes and jets, cars, cups, coins, eggs and some fun random
// objects, shuffled so the same kind never comes twice in a row. `want` asks for a specific look.
export const PLAN = [
  { theme: 'sky', rows: 3, want: 'model=fighter,glowCol=#ffcf3a' },
  { theme: 'parking', rows: 4, want: 'kind=police' },
  { theme: 'infinite', rows: 3, object: '🚀 rocket' },
  { theme: 'cups', rows: 4, want: 'col=red,nT=1' },
  { theme: 'sky', rows: 4, want: 'model=airliner,glowCol=#ff3d3d' },
  { theme: 'parking', rows: 3, want: 'kind=sedan,col=#ee6a12' },
  { theme: 'coins', rows: 4, want: 'metal=gold,mark=btc' },
  { theme: 'infinite', rows: 3, object: '🍩 donut' },
  { theme: 'parking', rows: 4, want: 'kind=fire' },
  { theme: 'sky', rows: 3, want: 'model=fighter,glowCol=#ff3d3d' },
  { theme: 'infinite', rows: 4, object: '🎈 balloon' },
  { theme: 'cups', rows: 4, want: 'col=blue,nT=2' },
  { theme: 'parking', rows: 3, want: 'kind=ambulance' },
  { theme: 'carton', rows: 4, want: 'kind=egg' },
  { theme: 'infinite', rows: 3, object: '⚽ soccer ball' },
  { theme: 'sky', rows: 4, want: 'model=airliner,glowCol=#ffcf3a' },
  { theme: 'coins', rows: 3, want: 'metal=silver,mark=diamond' },
  { theme: 'parking', rows: 4, want: 'kind=sedan,col=#f2a516' },
  { theme: 'infinite', rows: 3, object: '🍦 ice cream' },
  { theme: 'cups', rows: 4, want: 'col=gold,nT=1' },
];
