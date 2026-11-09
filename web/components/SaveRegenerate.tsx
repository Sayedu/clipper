'use client';

import { Button } from './ui';

export function SaveRegenerate({
  onSave,
  onDifferentVideo,
  onDiscard,
  busy,
}: {
  onSave: () => void;
  onDifferentVideo: () => void;
  onDiscard: () => void;
  busy: boolean;
}) {
  return (
    <div className="mt-9 flex flex-col items-center gap-4">
      <Button variant="primary" size="lg" onClick={onSave} loading={busy} className="min-w-[200px]">
        Save to library
      </Button>

      <Button variant="secondary" onClick={onDifferentVideo} disabled={busy}>
        Generate a new race
      </Button>
      <p className="max-w-[400px] text-center text-[12px] text-[color:var(--color-faint)]">
        Every race is a brand-new course and a new winner.
      </p>

      <button
        onClick={onDiscard}
        disabled={busy}
        className="mt-1 text-[13px] text-[color:var(--color-muted)] hover:text-[color:var(--color-danger)]"
      >
        Discard
      </button>
    </div>
  );
}
