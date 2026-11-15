// Draws the packaging graphics in headless Chrome (real fonts, CSS plates,
// deterministic Web Animations): the opening hook as a transparent frame
// sequence, the cover text, the background and the stage border. None of it
// ever touches the game — these are layers composited on top afterwards.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { FONTS } from './styles.mjs';
import { REPO } from './postlog.mjs';

// TikTok's UI covers the top 10%, bottom 20% and right 15% of a 1080x1920 frame
export const SAFE = { left: 40, top: 192, right: 918, bottom: 1536 };

const fontCache = new Map();
function fontFace(font) {
  if (!fontCache.has(font.id)) {
    const b64 = readFileSync(resolve(REPO, 'assets', 'fonts', font.file)).toString('base64');
    fontCache.set(font.id, `@font-face{font-family:'${font.family}';src:url(data:font/ttf;base64,${b64}) format('truetype');font-weight:100 900;}`);
  }
  return fontCache.get(font.id);
}

export async function openRenderer() {
  const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true });
  const pages = new Map();
  const page = async (scale) => {
    if (!pages.has(scale)) pages.set(scale, await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: scale }));
    return pages.get(scale);
  };
  return { page, close: () => browser.close() };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/**
 * Text and plate colours for each line. A "bare" line (no plate) sits on
 * whatever is behind it with a black outline, so its colour must be light.
 * Exported so verify.mjs can check every palette/plate pair stays readable.
 */
export function lineColours(p, plate) {
  const plated = !!p.plate && plate !== 'none' && plate !== 'underline';
  const bareColour = p.plate && lum(p.plate) > 0.45 ? p.plate : p.plate ? '#FFFFFF' : p.text;
  const bareAccent = p.accent && lum(p.accent) > 0.45 ? p.accent : '#FFFFFF';
  return {
    plated,
    l1: { fg: plated ? p.text : bareColour, bg: plated ? p.plate : null },
    l2: plate === 'split' ? { fg: p.accentText, bg: p.accent } : { fg: plated ? p.text : bareAccent, bg: plated ? p.plate : null },
  };
}
export { lum };

/** CSS + markup for a block of 1-2 text lines in a given style. */
function textBlock(spec) {
  const font = FONTS.find((f) => f.id === spec.font);
  const p = spec.palette;
  const size = Math.round(spec.size * font.size);
  const cols = lineColours(p, spec.plate);
  const plated = cols.plated;
  const bare = !plated;
  const radius = spec.plate === 'pill' ? '999px' : '10px';
  const css = `
    ${fontFace(font)}
    html,body{margin:0;background:transparent;}
    #hook{position:absolute;left:0;top:0;display:flex;flex-direction:column;gap:${Math.round(size * 0.12)}px;
      align-items:${spec.align === 'left' ? 'flex-start' : 'center'};will-change:transform,opacity;}
    #tilt{display:flex;flex-direction:column;gap:inherit;align-items:inherit;transform:rotate(${spec.plate === 'tilt' ? spec.tilt : 0}deg);}
    .line{font-family:'${font.family}';font-weight:${font.weight};font-size:${size}px;line-height:1.02;
      letter-spacing:${font.track}em;white-space:nowrap;padding:${plated ? `${Math.round(size * 0.1)}px ${Math.round(size * (spec.plate === 'pill' ? 0.42 : 0.26))}px` : '0'};
      border-radius:${radius};}
    .l1{color:${cols.l1.fg};background:${cols.l1.bg ?? 'transparent'};}
    .l2{font-size:${Math.round(size * 0.78)}px;color:${cols.l2.fg};background:${cols.l2.bg ?? 'transparent'};}
    ${bare ? `.line{-webkit-text-stroke:${Math.round(size * 0.09)}px ${p.stroke ?? '#000'};paint-order:stroke fill;
      text-shadow:0 ${Math.round(size * 0.06)}px 0 rgba(0,0,0,.85),0 0 ${Math.round(size * 0.25)}px rgba(0,0,0,.6);}` : `.line{box-shadow:0 ${Math.round(size * 0.07)}px 0 rgba(0,0,0,.45);}`}
    ${spec.backing ? `#tilt{min-width:${spec.backing.w}px;min-height:${spec.backing.h}px;box-sizing:border-box;justify-content:center;
      padding:${Math.round(size * 0.18)}px ${Math.round(size * 0.3)}px;border-radius:26px;background:${p.plate && lum(p.plate) < 0.3 ? p.plate : '#0B0B12'};
      box-shadow:0 10px 0 rgba(0,0,0,.4);}` : ''}
    ${spec.plate === 'underline' ? `#tilt::after{content:'';display:block;height:${Math.round(size * 0.12)}px;width:100%;margin-top:${Math.round(size * 0.04)}px;border-radius:99px;background:${p.plate ?? p.accent};box-shadow:0 4px 0 rgba(0,0,0,.6);}` : ''}
  `;
  const [a, b] = spec.lines;
  const html = `<div id="hook"><div id="tilt"><div class="line l1">${esc(a)}</div>${b ? `<div class="line l2">${esc(b)}</div>` : ''}</div></div>`;
  return { css, html };
}

/** Lay the block out inside the safe zone; returns its box in 1080x1920 px. */
async function place(page, spec) {
  return page.evaluate((s) => {
    const el = document.getElementById('hook');
    // a backing card is sized to the text it hides, which already fits the safe zone
    const maxW = s.backing ? s.backing.w + 2 : s.align === 'left' ? s.safe.right - 24 - s.safe.left - 24 : Math.min(s.maxW, (s.cx - s.safe.left - 10) * 2, (s.safe.right - s.cx - 10) * 2);
    // shrink to fit the width, never past 55% of the design size
    let k = 1;
    for (let i = 0; i < 12 && el.getBoundingClientRect().width > maxW && k > 0.55; i++) {
      k *= 0.92;
      for (const l of el.querySelectorAll('.line')) l.style.fontSize = `${parseFloat(getComputedStyle(l).fontSize) * 0.92}px`;
    }
    const r = el.getBoundingClientRect();
    const left = s.align === 'left' ? s.safe.left + 24 : s.cx - r.width / 2;
    const top = Math.max(s.safe.top + 12, Math.min(s.safe.bottom - 12 - r.height, s.cy - r.height / 2));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height, scale: k };
  }, { ...spec, safe: SAFE });
}

/**
 * Entrance keyframes, sized to the free space around the placed block so no
 * frame of the entrance pokes outside TikTok's safe zone: slides travel at
 * most as far as the room on that side, scale-ups stop at the edge.
 */
function entrance(anim, box) {
  const free = { l: box.x - SAFE.left, r: SAFE.right - (box.x + box.w), t: box.y - SAFE.top, b: SAFE.bottom - (box.y + box.h) };
  const room = Math.max(0, Math.min(free.l, free.r) / (box.w / 2), Math.min(free.t, free.b) / (box.h / 2));
  const sMax = 1 + Math.min(Math.min(free.l, free.r) / (box.w / 2), Math.min(free.t, free.b) / (box.h / 2), room);
  const up = (k) => Math.max(1, Math.min(k, sMax - 0.01));
  const cap = (d, f) => Math.max(0, Math.min(d, f - 2));
  switch (anim) {
    case 'pop': return { kf: [{ transform: `scale(${up(1.22)})` }, { transform: 'scale(0.95)', offset: 0.62 }, { transform: 'scale(1)' }], ms: 340, easing: 'ease-out' };
    case 'stamp': return { kf: [{ transform: `scale(${up(1.35)}) rotate(-3deg)` }, { transform: 'scale(0.97) rotate(1deg)', offset: 0.7 }, { transform: 'scale(1) rotate(0)' }], ms: 260, easing: 'ease-in' };
    case 'zoom-in': return { kf: [{ transform: 'scale(0.78)' }, { transform: `scale(${up(1.04)})`, offset: 0.75 }, { transform: 'scale(1)' }], ms: 330, easing: 'ease-out' };
    case 'slide-down': return { kf: [{ transform: `translateY(${-cap(110, free.t)}px)` }, { transform: 'translateY(0)' }], ms: 320, easing: 'cubic-bezier(.2,.9,.25,1)' };
    case 'slide-left': return { kf: [{ transform: `translateX(${cap(150, free.r)}px)` }, { transform: 'translateX(0)' }], ms: 320, easing: 'cubic-bezier(.2,.9,.25,1)' };
    case 'slide-right': return { kf: [{ transform: `translateX(${-cap(150, free.l)}px)` }, { transform: 'translateX(0)' }], ms: 320, easing: 'cubic-bezier(.2,.9,.25,1)' };
    case 'shake': { const a = cap(20, Math.min(free.l, free.r)); return { kf: [0, -a, a * 0.8, -a * 0.6, a * 0.45, -a * 0.25, 0].map((x) => ({ transform: `translateX(${x}px)` })), ms: 480, easing: 'linear' }; }
    case 'bounce': { const a = cap(70, free.t); return { kf: [-a, 0, -a * 0.35, 0, -a * 0.12, 0].map((y) => ({ transform: `translateY(${y}px)` })), ms: 620, easing: 'ease-out' }; }
    case 'stagger': return { stagger: [cap(150, free.l), cap(150, free.r)] };
    default: return { kf: [{ transform: 'none' }, { transform: 'none' }], ms: 1, easing: 'linear' };
  }
}

/**
 * The opening hook, readable from frame 1 (every entrance moves it, none fade
 * it in), held, then faded out by `spec.sec`. Writes RGBA PNG frames of a
 * full-width band and returns where that band goes on a 1080x1920 frame.
 */
export async function renderHook(R, spec, outDir, { fps = 60, scale = 1 } = {}) {
  mkdirSync(outDir, { recursive: true });
  const page = await R.page(scale);
  const { css, html } = textBlock(spec);
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const box = await place(page, spec);
  const total = Math.round(spec.sec * fps);
  const exitMs = 260;
  await page.evaluate(({ e, secMs, exitMs }) => {
    const el = document.getElementById('hook');
    window.__anims = [];
    if (e.stagger) {
      const [a, b] = el.querySelectorAll('.line');
      window.__anims.push(a.animate([{ transform: `translateX(${-e.stagger[0]}px)` }, { transform: 'translateX(0)' }], { duration: 280, easing: 'cubic-bezier(.2,.9,.25,1)', fill: 'both' }));
      if (b) window.__anims.push(b.animate([{ transform: `translateX(${e.stagger[1]}px)` }, { transform: 'translateX(0)' }], { duration: 300, delay: 120, easing: 'cubic-bezier(.2,.9,.25,1)', fill: 'both' }));
    } else {
      window.__anims.push(el.animate(e.kf, { duration: e.ms, easing: e.easing, fill: 'both' }));
    }
    window.__anims.push(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: exitMs, delay: secMs - exitMs, fill: 'both' }));
    for (const a of window.__anims) a.pause();
  }, { e: entrance(spec.anim, box), secMs: spec.sec * 1000, exitMs });
  const band = { x: 0, y: Math.max(0, Math.floor(box.y - 190)), w: 1080 };
  band.h = Math.min(1920 - band.y, Math.ceil(box.h + 380));
  const holdFrom = Math.ceil(0.75 * fps), holdTo = total - Math.ceil((exitMs / 1000) * fps) - 1;
  let hold = null, first = null;
  let extent = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
  for (let i = 0; i < total; i++) {
    const file = join(outDir, `h_${String(i).padStart(4, '0')}.png`);
    if (hold && i > holdFrom && i < holdTo) { writeFileSync(file, hold); continue; }
    const r = await page.evaluate((ms) => {
      for (const a of window.__anims) a.currentTime = ms;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const l of document.querySelectorAll('.line')) {
        const b = l.getBoundingClientRect();
        x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top); x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom);
      }
      return { x0, y0, x1, y1, o: +getComputedStyle(document.getElementById('hook')).opacity };
    }, (i / fps) * 1000);
    if (r.o > 0.02) extent = { x0: Math.min(extent.x0, r.x0), y0: Math.min(extent.y0, r.y0), x1: Math.max(extent.x1, r.x1), y1: Math.max(extent.y1, r.y1) };
    if (i === 0) first = r;
    const buf = await page.screenshot({ clip: { x: band.x, y: band.y, width: band.w, height: band.h }, omitBackground: true });
    writeFileSync(file, buf);
    if (i === holdFrom) hold = buf;
  }
  // extent = everywhere the text went across all frames; first = frame 1
  return { pattern: join(outDir, 'h_%04d.png'), band, box, frames: total, extent, first };
}

/** Static text block (the cover's hook text) on a transparent 1080x1920 PNG. */
export async function renderTextLayer(R, spec, out) {
  const page = await R.page(1);
  const { css, html } = textBlock(spec);
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const box = await place(page, spec);
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
  return box;
}

/** Background (opaque) at the video's own resolution. */
export async function renderBackground(R, bg, out, scale) {
  const page = await R.page(scale);
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;width:1080px;height:1920px;background:${bg.css};}</style></head><body></body></html>`);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
}

/** Border around the stage (or an inset frame when the game is full-frame). */
export async function renderBorder(R, { style, colour, stage }, out, scale) {
  const page = await R.page(scale);
  const gap = 16;
  const r = stage
    ? { x: stage.x * 1080 - gap, y: stage.y * 1920 - gap, w: stage.w * 1080 + gap * 2, h: stage.h * 1920 + gap * 2 }
    : { x: 26, y: 26, w: 1080 - 52, h: 1920 - 52 };
  const base = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;box-sizing:border-box;`;
  const c = colour;
  const styles = {
    thin: `<div style="${base}border:3px solid ${c};border-radius:22px;"></div>`,
    glow: `<div style="${base}border:4px solid ${c};border-radius:24px;box-shadow:0 0 22px ${c},0 0 60px ${c}88,inset 0 0 18px ${c}55;"></div>`,
    double: `<div style="${base}border:10px double ${c};border-radius:18px;"></div>`,
    dashed: `<div style="${base}border:5px dashed ${c};border-radius:20px;"></div>`,
    thick: `<div style="${base}border:12px solid ${c};border-radius:34px;box-shadow:0 0 0 3px #000;"></div>`,
    corners: ['left:0;top:0;border-left:8px solid;border-top:8px solid;', 'right:0;top:0;border-right:8px solid;border-top:8px solid;', 'left:0;bottom:0;border-left:8px solid;border-bottom:8px solid;', 'right:0;bottom:0;border-right:8px solid;border-bottom:8px solid;']
      .map((s) => `<div style="position:absolute;${s}width:90px;height:90px;border-color:${c};"></div>`)
      .reduce((a, b) => a + b, `<div style="${base}">`) + '</div>',
  };
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:transparent;}</style></head><body>${styles[style] ?? ''}</body></html>`);
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
  return r;
}
