import type { ContentType } from '@/lib/types';

/** One small line-icon per content type, used in the picker grid and studio
 *  headers. Plain stroke icons (currentColor) so they follow text color in
 *  both themes — no extra palette to maintain. */
export function ContentTypeIcon({ type, className = 'h-5 w-5' }: { type: ContentType; className?: string }) {
  const common = { className, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, viewBox: '0 0 24 24' };
  switch (type) {
    case 'colorwar':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="8" height="8" rx="1.5" />
          <rect x="13" y="3" width="8" height="8" rx="1.5" />
          <rect x="3" y="13" width="8" height="8" rx="1.5" />
          <rect x="13" y="13" width="8" height="8" rx="1.5" />
        </svg>
      );
    case 'followball':
      return (
        <svg {...common}>
          <path d="M4 10c0-1.5 1-3 3-3s3 1.5 3 3v8H4z" />
          <path d="M9 10c0-1.5 1-3 3-3s3 1.5 3 3v8H9" />
          <path d="M14 10c0-1.5 1-3 3-3s3 1.5 3 3v8h-6" />
          <circle cx="7" cy="7" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'eyetest':
      return (
        <svg {...common}>
          <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
          <circle cx="12" cy="12" r="2.6" />
        </svg>
      );
    case 'pausegame':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 12 16 7" />
          <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'quotes':
      return (
        <svg {...common}>
          <path d="M7 8c-2 .5-3 2-3 4s1.2 3 3 3" />
          <path d="M7 15c1.5 0 2.5-1 2.5-2.5S8.5 10 7 10" />
          <path d="M16 8c-2 .5-3 2-3 4s1.2 3 3 3" />
          <path d="M16 15c1.5 0 2.5-1 2.5-2.5S17.5 10 16 10" />
        </svg>
      );
    case 'colorrace':
      return (
        <svg {...common}>
          <path d="M5 3v18" />
          <path d="M5 4h6l-1.5 3L11 10H5" />
          <circle cx="17" cy="16" r="3" />
        </svg>
      );
    case 'escaperace':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" />
          <path d="M12 3v4M21 12h-4" />
        </svg>
      );
    case 'lasernations':
      return (
        <svg {...common}>
          <path d="M5 4v16M5 4l7 2-3 3 3 3-7 2" />
          <path d="M19 20 10 11" />
        </svg>
      );
    default:
      return null;
  }
}
