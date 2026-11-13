'use client';

import { useCallback, useEffect, useState } from 'react';
import { colorwarsApi, colorwarsMediaUrl } from '@/lib/colorwarsApi';
import type { LibraryCard } from '@/lib/colorwarsTypes';
import { Button } from '@/components/ui';
import type { StudioState } from './useStudioState';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard permission denied -- nothing more we can do here */
        }
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

export function LibraryPanel({ studio }: { studio: StudioState }) {
  const { setEventId, setSeed, applyPreset, setFinale } = studio;
  const [cards, setCards] = useState<LibraryCard[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    colorwarsApi
      .listLibrary()
      .then((d) => setCards(d.cards))
      .finally(() => setLoading(false));
  }, []);
  useEffect(refresh, [refresh]);

  const renderAgain = useCallback(
    async (card: LibraryCard) => {
      try {
        await colorwarsApi.createRenderJob({
          event_id: card.meta.event,
          seed: card.meta.seed,
          overrides: card.meta.studio_overrides ?? {},
          episode_overrides: card.meta.studio_episode_overrides ?? {},
          finale: card.meta.is_finale,
          mode: 'final',
        });
        alert('Queued — check the Render tab.');
      } catch (e) {
        alert('could not queue: ' + (e as Error).message);
      }
    },
    [],
  );

  const loadIntoSetup = useCallback(
    (card: LibraryCard) => {
      setEventId(card.meta.event);
      setFinale(card.meta.is_finale);
      applyPreset({
        name: card.episode_dir,
        saved_at: 0,
        overrides: card.meta.studio_overrides ?? {},
        episode_overrides: card.meta.studio_episode_overrides ?? {},
        seed: card.meta.seed,
      });
    },
    [setEventId, setFinale, applyPreset],
  );

  const deleteCard = useCallback(
    async (card: LibraryCard) => {
      if (!confirm(`Delete "${card.episode_dir}"? This can't be undone.`)) return;
      await colorwarsApi.deleteLibraryItem(card.episode_dir);
      refresh();
    },
    [refresh],
  );

  if (loading) return <p className="py-10 text-center text-[13px] text-[color:var(--color-muted)]">Loading…</p>;
  if (cards.length === 0) return <p className="py-10 text-center text-[13px] text-[color:var(--color-muted)]">No renders yet.</p>;

  return (
    <div className="grid gap-5 sm:grid-cols-2">
      {cards.map((card) => (
        <div key={card.episode_dir} className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-4">
          {card.video_url ? (
            <video src={colorwarsMediaUrl(card.video_url)} controls poster={card.cover_url ? colorwarsMediaUrl(card.cover_url) : undefined}
              className="w-full rounded-[10px] bg-black" />
          ) : card.cover_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={colorwarsMediaUrl(card.cover_url)} alt="" className="w-full rounded-[10px]" />
          ) : null}

          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-[color:var(--color-muted)]">
            <span>Seed {card.meta.seed}</span>
            <span>{card.meta.event}</span>
            <span>{card.meta.duration_sec.toFixed(1)}s</span>
            <span>MVP {card.meta.mvp}</span>
            <span className="col-span-2">Placements: {card.meta.placements.join(' → ')}</span>
            <span className="col-span-2">Drama score: {String((card.meta.drama as { score?: number })?.score ?? '—')}</span>
          </div>

          <details className="mt-3">
            <summary className="cursor-pointer text-[12px] font-medium">Caption</summary>
            <p className="mt-1 whitespace-pre-wrap text-[12px] text-[color:var(--color-muted)]">{card.caption}</p>
            <CopyButton text={card.caption} />
          </details>
          <details className="mt-2">
            <summary className="cursor-pointer text-[12px] font-medium">Pinned comment</summary>
            <p className="mt-1 whitespace-pre-wrap text-[12px] text-[color:var(--color-muted)]">{card.pinned_comment}</p>
            <CopyButton text={card.pinned_comment} />
          </details>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => renderAgain(card)}>
              Render again
            </Button>
            <Button variant="secondary" onClick={() => loadIntoSetup(card)}>
              Load into setup
            </Button>
            {card.video_url && (
              <a href={colorwarsMediaUrl(card.video_url)} download>
                <Button variant="secondary">Download</Button>
              </a>
            )}
            <Button variant="danger" onClick={() => deleteCard(card)}>
              Delete
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
