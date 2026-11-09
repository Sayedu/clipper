'use client';

import { useMemo, useState } from 'react';
import type { InputRequest } from '@/lib/types';
import { Button } from './ui';

type ScriptRequest = Extract<InputRequest, { type: 'approve-script' }>;

export function ScriptReview({
  request,
  busy,
  onApprove,
  onRegenerate,
  onEdit,
  onCancel,
}: {
  request: ScriptRequest;
  busy: boolean;
  onApprove: () => void;
  onRegenerate: () => void;
  onEdit: (openingLine: string, script: string) => void;
  onCancel: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [opening, setOpening] = useState(request.openingLine);
  const [script, setScript] = useState(request.script);

  // keep the script's first sentence in sync with the chosen opening when not hand-editing
  const swapOpening = (line: string) => {
    setOpening(line);
    if (!editing) {
      const rest = request.script.startsWith(request.openingLine)
        ? request.script.slice(request.openingLine.length).trim()
        : request.script;
      setScript(`${line} ${rest}`.replace(/\s+/g, ' ').trim());
    }
  };

  const words = useMemo(() => script.split(/\s+/).filter(Boolean).length, [script]);
  const dirty = editing && (opening.trim() !== request.openingLine || script.trim() !== request.script);

  return (
    <div className="mx-auto max-w-[560px]">
      <header className="mb-6">
        <p className="text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-faint)]">
          Storyteller · {request.genre} · review before narration
        </p>
        <h1 className="mt-1.5 text-[24px] font-semibold tracking-tight">{request.title}</h1>
      </header>

      {/* opening line — the 2-second hook, on its own */}
      <section className="mb-6 rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] p-4">
        <p className="mb-2 text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-faint)]">
          Opening line — the whole hook
        </p>
        {editing ? (
          <textarea
            value={opening}
            onChange={(e) => setOpening(e.target.value)}
            rows={2}
            className="w-full rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-3 text-[16px] font-medium leading-snug focus:border-[color:var(--color-accent)] focus:outline-none"
          />
        ) : (
          <p className="text-[17px] font-medium leading-snug">{opening}</p>
        )}
        {request.openingCandidates.length > 1 && (
          <div className="mt-3 space-y-1.5">
            {request.openingCandidates
              .filter((c) => c.trim() && c.trim() !== opening.trim())
              .slice(0, 4)
              .map((c) => (
                <button
                  key={c}
                  onClick={() => swapOpening(c)}
                  className="block w-full rounded-[8px] border border-[color:var(--color-hairline)] px-3 py-2 text-left text-[13px] text-[color:var(--color-muted)] transition hover:border-[color:var(--color-faint)] hover:text-[color:var(--color-text)]"
                >
                  {c}
                </button>
              ))}
          </div>
        )}
      </section>

      {/* full script */}
      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-faint)]">
            Full script · {words} words · ~{Math.round(words / 2.35)}s
          </p>
          <button
            onClick={() => setEditing((v) => !v)}
            className="text-[12px] font-medium text-[color:var(--color-accent)] hover:text-[color:var(--color-accent-hover)]"
          >
            {editing ? 'Done editing' : 'Edit'}
          </button>
        </div>
        {editing ? (
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={10}
            className="w-full rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-3.5 text-[15px] leading-relaxed focus:border-[color:var(--color-accent)] focus:outline-none"
          />
        ) : (
          <p className="whitespace-pre-wrap rounded-[var(--radius)] bg-[color:var(--color-surface)] p-4 text-[15px] leading-relaxed">
            {script}
          </p>
        )}
      </section>

      <div className="flex flex-col items-center gap-4">
        {dirty ? (
          <Button variant="primary" size="lg" onClick={() => onEdit(opening.trim(), script.trim())} loading={busy} className="min-w-[220px]">
            Save edits &amp; narrate
          </Button>
        ) : (
          <Button variant="primary" size="lg" onClick={onApprove} loading={busy} className="min-w-[220px]">
            Approve &amp; narrate
          </Button>
        )}
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={onRegenerate} disabled={busy}>
            Regenerate
          </Button>
          <button
            onClick={onCancel}
            disabled={busy}
            className="text-[13px] text-[color:var(--color-muted)] hover:text-[color:var(--color-danger)]"
          >
            Cancel run
          </button>
        </div>
        <p className="text-[12px] text-[color:var(--color-faint)]">
          Nothing expensive runs until you approve — narration, footage, and render come after.
        </p>
      </div>
    </div>
  );
}
