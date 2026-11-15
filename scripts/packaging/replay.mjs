// Rebuilds the event log for a render made before event logs were kept, by
// replaying the same seed and settings headlessly (no screenshots, nothing
// written). Read-only: it runs the unchanged game page and listens. The
// replay is only trusted if it reproduces the stored result exactly (same
// answers / winner and the same number of frames); otherwise it's dropped.
import { chromium } from 'playwright-core';
import { startServer } from '../followball/serve.mjs';

function queryFor(format, r, mode) {
  const q = new URLSearchParams({ render: '1', seed: String(r.seed), fps: String(r.fps ?? 60), ss: '1' });
  if (format === 'followball') q.set('mode', r.mode ?? 'sprint');
  if (format === 'eyetest') { q.set('balls', (r.ballsPerRound ?? []).join(',')); q.set('shuffle', String(r.shuffleSec)); }
  if (format === 'colorwar') { q.set('mode', mode.mode); q.set('shape', mode.shape); }
  return q;
}

const API = { followball: 'FTB', eyetest: 'ET', colorwar: 'CW' };

function matches(format, stored, got) {
  if (got.frames !== stored.frames) return false;
  if (format === 'colorwar') return got.winner === stored.winner && got.winAtSec === stored.winAtSec;
  return JSON.stringify(got.answers) === JSON.stringify(stored.answers);
}

/** { events, timeline? } or null when the replay doesn't reproduce the render. */
export async function replayEvents(src) {
  const api = API[src.format];
  if (!api) return null;
  const r = src.result;
  if (src.format === 'colorwar' && (r.season || r.seasonNumber)) return null;
  const { server, port } = await startServer(0);
  const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true, args: ['--mute-audio'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    // Color War's 'random' board pick happens inside the game from the seed,
    // so try the concrete board first, then 'random'
    // (and the shape, which the result json doesn't record)
    const modes = src.format === 'colorwar'
      ? [r.mode, 'random'].flatMap((m) => ['circle', 'square'].map((shape) => ({ mode: m, shape })))
      : [null];
    for (const mode of modes) {
      await page.goto(`http://127.0.0.1:${port}/render/${src.format}/index.html?${queryFor(src.format, r, mode)}`, { waitUntil: 'load' });
      await page.waitForFunction((a) => window[a] && window[a].meta, api, { timeout: 30000 });
      const fps = r.fps ?? 60;
      const out = await page.evaluate(async ({ a, fps, cw, maxFrames }) => {
        const events = [], timeline = [];
        for (let f = 1; f <= maxFrames; f++) {
          const st = window[a].step();
          for (const e of st.events ?? []) events.push(e);
          if (cw && (f % Math.round(fps / 10) === 0 || st.done)) {
            timeline.push({
              t: +(f / fps).toFixed(2),
              shares: [...document.querySelectorAll('#chips .cv')].map((e) => (e.textContent === 'OUT' ? null : parseFloat(e.textContent))),
              flash: document.getElementById('flash')?.style.display === 'block' ? document.getElementById('flash').textContent : '',
            });
          }
          if (st.done) break;
        }
        return { events, timeline, result: window[a].result() };
      }, { a: api, fps, cw: src.format === 'colorwar', maxFrames: (r.frames ?? 6000) + 5 });
      if (matches(src.format, r, out.result)) return { events: out.events, timeline: src.format === 'colorwar' ? out.timeline : undefined };
    }
    return null;
  } finally {
    await browser.close();
    server.close();
  }
}
