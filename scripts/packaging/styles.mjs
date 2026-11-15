// The look catalog the packaging rotates through. Every choice is logged so
// the next post of the same format can pick something else.

export const FONTS = [
  { id: 'anton', family: 'Anton', file: 'Anton-Regular.ttf', weight: 400, size: 1.0, track: 0.01 },
  { id: 'bebas', family: 'Bebas Neue', file: 'packaging/BebasNeue-Regular.ttf', weight: 400, size: 1.12, track: 0.02 },
  { id: 'bangers', family: 'Bangers', file: 'packaging/Bangers-Regular.ttf', weight: 400, size: 1.0, track: 0.04 },
  { id: 'bungee', family: 'Bungee', file: 'packaging/Bungee-Regular.ttf', weight: 400, size: 0.78, track: 0 },
  { id: 'luckiest', family: 'Luckiest Guy', file: 'packaging/LuckiestGuy-Regular.ttf', weight: 400, size: 0.88, track: 0.02 },
  { id: 'marker', family: 'Permanent Marker', file: 'packaging/PermanentMarker-Regular.ttf', weight: 400, size: 0.86, track: 0 },
  { id: 'rubikmono', family: 'Rubik Mono One', file: 'packaging/RubikMonoOne-Regular.ttf', weight: 400, size: 0.7, track: 0 },
  { id: 'montserrat', family: 'Montserrat', file: 'Montserrat-VariableFont.ttf', weight: 900, size: 0.84, track: -0.01 },
  { id: 'chakra', family: 'Chakra Petch', file: 'ChakraPetch-Bold.ttf', weight: 700, size: 0.9, track: 0.03 },
];

// text / plate / second-line accent. plate null = no plate, heavy outline instead.
export const PALETTES = [
  { id: 'yellow-black', text: '#111111', plate: '#FFD400', accent: '#FFFFFF', accentText: '#111111' },
  { id: 'pink-white', text: '#FFFFFF', plate: '#FF2E88', accent: '#111111', accentText: '#FFFFFF' },
  { id: 'white-black', text: '#111111', plate: '#FFFFFF', accent: '#FF3B3B', accentText: '#FFFFFF' },
  { id: 'cyan-night', text: '#00E5FF', plate: '#0B1020', accent: '#00E5FF', accentText: '#0B1020' },
  { id: 'lime-night', text: '#B6FF3B', plate: '#0E140A', accent: '#B6FF3B', accentText: '#0E140A' },
  { id: 'red-white', text: '#FFFFFF', plate: '#E8202A', accent: '#FFD400', accentText: '#111111' },
  { id: 'blue-white', text: '#FFFFFF', plate: '#2563FF', accent: '#FFFFFF', accentText: '#2563FF' },
  { id: 'orange-night', text: '#FF8A00', plate: '#160C03', accent: '#FF8A00', accentText: '#160C03' },
  { id: 'violet-white', text: '#FFFFFF', plate: '#7C3AED', accent: '#22D3EE', accentText: '#0B1020' },
  { id: 'outline-yellow', text: '#FFE600', plate: null, stroke: '#000000', accent: '#FFFFFF', accentText: '#111111' },
  { id: 'outline-white', text: '#FFFFFF', plate: null, stroke: '#000000', accent: '#FF2E88', accentText: '#111111' },
  { id: 'mint-night', text: '#111111', plate: '#5CFFB0', accent: '#111111', accentText: '#5CFFB0' },
];

export const PLATES = ['box', 'pill', 'tilt', 'split', 'underline', 'none'];
export const ANIMS = ['pop', 'slide-down', 'slide-left', 'slide-right', 'stamp', 'shake', 'bounce', 'stagger', 'zoom-in'];

// letterbox / backdrop. Kept dark: the playfield stays the brightest thing
// on screen, and full-frame games blend it in with "lighten".
export const BACKGROUNDS = [
  { id: 'midnight', css: 'linear-gradient(160deg,#0b1030 0%,#1b0f3a 100%)' },
  { id: 'ember', css: 'radial-gradient(120% 80% at 50% 25%,#3a0d16 0%,#0a0507 70%)' },
  { id: 'ocean', css: 'linear-gradient(180deg,#021a2b 0%,#06343f 100%)' },
  { id: 'forest', css: 'linear-gradient(200deg,#04140c 0%,#10301b 100%)' },
  { id: 'grape', css: 'radial-gradient(100% 70% at 30% 70%,#3b0a4f 0%,#12041c 75%)' },
  { id: 'slate', css: 'linear-gradient(170deg,#0d1117 0%,#283040 100%)' },
  { id: 'sunset', css: 'linear-gradient(180deg,#2b0b1e 0%,#3a1a06 100%)' },
  { id: 'teal-plum', css: 'linear-gradient(135deg,#062a2f 0%,#2e0b2a 100%)' },
  { id: 'gold', css: 'radial-gradient(110% 70% at 50% 50%,#2c2206 0%,#0a0802 75%)' },
  { id: 'grid', css: 'repeating-linear-gradient(0deg,rgba(90,120,255,.16) 0 2px,transparent 2px 54px),repeating-linear-gradient(90deg,rgba(90,120,255,.16) 0 2px,transparent 2px 54px),linear-gradient(180deg,#070a1c,#0c0f2a)' },
  { id: 'dots', css: 'radial-gradient(circle,rgba(255,255,255,.13) 3px,transparent 4px) 0 0/44px 44px,linear-gradient(180deg,#14061e,#05101e)' },
  { id: 'stripes', css: 'repeating-linear-gradient(45deg,rgba(255,80,140,.10) 0 26px,transparent 26px 60px),linear-gradient(180deg,#120613,#08070f)' },
  { id: 'aurora', css: 'radial-gradient(60% 40% at 20% 20%,rgba(0,200,160,.32),transparent 70%),radial-gradient(60% 40% at 80% 80%,rgba(140,60,255,.32),transparent 70%),#05070d' },
  { id: 'spot', css: 'radial-gradient(70% 45% at 50% 45%,#1f2a44 0%,#06080e 80%)' },
];

export const BORDERS = ['none', 'thin', 'glow', 'double', 'dashed', 'corners', 'thick'];
export const BORDER_COLOURS = ['#FFD400', '#FF2E88', '#00E5FF', '#B6FF3B', '#FFFFFF', '#FF8A00', '#8B5CF6', '#FF3B3B'];
export const ZOOMS = [
  { id: 'none', from: 1.0, dur: 0 },
  { id: 'nudge', from: 1.05, dur: 0.6 },
  { id: 'punch', from: 1.1, dur: 0.75 },
  { id: 'push', from: 1.14, dur: 1.0 },
];
export const ALIGNS = ['center', 'left'];

/** Pick a value, preferring ones not used by the last few posts of this format. */
export function freshPick(r, options, usedRecently) {
  const ids = options.map((o) => (typeof o === 'string' ? o : o.id));
  const free = ids.filter((id) => !usedRecently.includes(id));
  const id = r.pick(free.length ? free : ids);
  return options[ids.indexOf(id)];
}
