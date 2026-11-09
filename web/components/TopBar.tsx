'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark' | 'system';

function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  try {
    if (t === 'system') localStorage.removeItem('clip-theme');
    else localStorage.setItem('clip-theme', t);
  } catch {
    /* ignore */
  }
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    try {
      const s = localStorage.getItem('clip-theme');
      if (s === 'dark' || s === 'light') setTheme(s);
    } catch {
      /* ignore */
    }
  }, []);

  const cycle = () => {
    const next: Theme = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system';
    setTheme(next);
    applyTheme(next);
  };

  return (
    <button
      onClick={cycle}
      title={`Theme: ${theme}`}
      className="rounded-[var(--radius-sm)] px-1.5 py-1 text-[13px] text-[color:var(--color-muted)] hover:text-[color:var(--color-text)]"
    >
      {theme === 'dark' ? '◐ Dark' : theme === 'light' ? '○ Light' : '◑ System'}
    </button>
  );
}

export function TopBar({ right }: { right?: React.ReactNode }) {
  return (
    <header className="mx-auto flex h-16 max-w-[680px] items-center justify-between px-6">
      <Link href="/" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-[color:var(--color-accent)]" />
        Clipper
      </Link>
      <nav className="flex items-center gap-5 text-[14px] text-[color:var(--color-muted)]">
        {right}
        <ThemeToggle />
        <Link href="/colorwar" className="hover:text-[color:var(--color-text)]">
          Color War
        </Link>
        <Link href="/colorwar-season" className="hover:text-[color:var(--color-text)]">
          Seasons
        </Link>
        <Link href="/followball" className="hover:text-[color:var(--color-text)]">
          Follow Ball
        </Link>
        <Link href="/eyetest" className="hover:text-[color:var(--color-text)]">
          Eye Test
        </Link>
        <Link href="/quotes" className="hover:text-[color:var(--color-text)]">
          Reminders
        </Link>
        <Link href="/laser-duel" className="hover:text-[color:var(--color-text)]">
          Laser Duel
        </Link>
        <Link href="/schedule" className="hover:text-[color:var(--color-text)]">
          Schedule
        </Link>
        <Link href="/library" className="hover:text-[color:var(--color-text)]">
          Library
        </Link>
      </nav>
    </header>
  );
}
