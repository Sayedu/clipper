import type { CropKeyframe, CropPlan } from '../types.ts';

/** Reduce keyframes to at most `max`, keeping the ones that bend the path most. */
export function thinKeyframes(keyframes: CropKeyframe[], max = 48): CropKeyframe[] {
  if (keyframes.length <= max) return keyframes;
  // score interior points by deviation from the line between neighbours; keep the top ones.
  const scored = keyframes.map((k, i) => {
    if (i === 0 || i === keyframes.length - 1) return { k, i, score: Infinity };
    const a = keyframes[i - 1]!;
    const b = keyframes[i + 1]!;
    const span = b.t - a.t || 1;
    const fx = a.x + ((b.x - a.x) * (k.t - a.t)) / span;
    const fy = a.y + ((b.y - a.y) * (k.t - a.t)) / span;
    return { k, i, score: Math.hypot(k.x - fx, k.y - fy) };
  });
  const keep = new Set(
    [...scored].sort((p, q) => q.score - p.score).slice(0, max).map((s) => s.i),
  );
  return keyframes.filter((_, i) => keep.has(i));
}

// The whole expression is wrapped in single quotes in the filtergraph, so commas
// do NOT need escaping (and escaping them inside quotes actually breaks the parser).
function axisExpr(keyframes: CropKeyframe[], axis: 'x' | 'y'): string {
  if (keyframes.length === 1) return String(round(keyframes[0]![axis]));
  const terms: string[] = [];
  const first = keyframes[0]!;
  const last = keyframes[keyframes.length - 1]!;

  terms.push(`lt(t,${round(first.t)})*${round(first[axis])}`);

  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i]!;
    const b = keyframes[i + 1]!;
    const t0 = round(a.t);
    const t1 = round(b.t);
    const v0 = round(a[axis]);
    const slope = round((b[axis] - a[axis]) / (b.t - a.t || 0.001));
    // active only within [t0, t1)
    terms.push(`(gte(t,${t0})*lt(t,${t1}))*(${v0}+(${slope})*(t-${t0}))`);
  }

  terms.push(`gte(t,${round(last.t)})*${round(last[axis])}`);
  return terms.join('+');
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface CropFilterResult {
  /** A `crop=...` filter string with quoted, animated x/y expressions. */
  filter: string;
  keyframesUsed: number;
}

/**
 * Build a single `crop` filter whose window follows the planned path with
 * piecewise-linear interpolation (smooth pan in one ffmpeg pass).
 */
export function buildCropFilter(plan: CropPlan): CropFilterResult {
  const cw = Math.round(plan.cropWidth);
  const ch = Math.round(plan.cropHeight);

  if (plan.method === 'center-fallback' || plan.keyframes.length === 0) {
    const x = Math.round((plan.sourceWidth - cw) / 2);
    const y = Math.round((plan.sourceHeight - ch) / 2);
    return { filter: `crop=${cw}:${ch}:${x}:${y}`, keyframesUsed: 0 };
  }

  const kf = thinKeyframes([...plan.keyframes].sort((a, b) => a.t - b.t));
  const maxX = Math.max(plan.sourceWidth - cw, 0);
  const maxY = Math.max(plan.sourceHeight - ch, 0);
  const xe = axisExpr(kf, 'x');
  const ye = axisExpr(kf, 'y');

  return {
    filter:
      `crop=${cw}:${ch}:` +
      `x='clip(${xe},0,${maxX})':` +
      `y='clip(${ye},0,${maxY})'`,
    keyframesUsed: kf.length,
  };
}
