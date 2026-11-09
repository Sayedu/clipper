export function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

export function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

export function relativeDate(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}

export function durationLabel(days: number): string {
  if (days <= 31) return `past ${days === 7 ? 'week' : days === 30 || days === 31 ? 'month' : `${days} days`}`;
  if (days <= 93) return 'past 3 months';
  if (days <= 186) return 'past 6 months';
  if (days <= 400) return 'past year';
  return `past ${Math.round(days / 365)} years`;
}
