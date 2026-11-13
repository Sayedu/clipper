'use client';

import { useCallback, useEffect, useState } from 'react';
import { colorwarsApi } from '@/lib/colorwarsApi';
import type { LibraryCard, NamesParseResult, NamesResponse, StandingsResponse } from '@/lib/colorwarsTypes';
import { Button, Select, Textarea } from '@/components/ui';
import type { StudioState } from './useStudioState';

interface SeasonShape {
  season_number: number;
  standings: Record<string, { points: number; wins: number; podiums: number; streak_type: string | null; streak_count: number }>;
  head_to_head: Record<string, Record<string, number>>;
  episodes: unknown[];
}

export function LeaguePanel({ studio }: { studio: StudioState }) {
  const { schema } = studio;
  const [standings, setStandings] = useState<StandingsResponse | null>(null);
  const [names, setNames] = useState<NamesResponse | null>(null);
  const [rawComments, setRawComments] = useState('');
  const [parsed, setParsed] = useState<NamesParseResult | null>(null);
  const [parsing, setParsing] = useState(false);

  const [cards, setCards] = useState<LibraryCard[]>([]);
  const [commitTarget, setCommitTarget] = useState('');
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    colorwarsApi.getStandings().then(setStandings).catch(() => {});
    colorwarsApi.getNames().then(setNames).catch(() => {});
    colorwarsApi.listLibrary().then((d) => setCards(d.cards)).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  const parse = useCallback(async () => {
    if (!rawComments.trim()) return;
    setParsing(true);
    try {
      setParsed(await colorwarsApi.parseNames(rawComments));
    } finally {
      setParsing(false);
    }
  }, [rawComments]);

  const saveAccepted = useCallback(async () => {
    if (!parsed?.accepted.length) return;
    await colorwarsApi.saveNames(parsed.accepted.map((a) => ({ team: a.team, name: a.name })));
    setParsed(null);
    setRawComments('');
    refresh();
  }, [parsed, refresh]);

  const commit = useCallback(async () => {
    if (!commitTarget) return;
    const card = cards.find((c) => c.episode_dir === commitTarget);
    if (!card) return;
    if (!confirm(`Commit "${commitTarget}" to the season standings? This changes the standings and cannot be undone.`)) return;
    setCommitting(true);
    setCommitError(null);
    try {
      await colorwarsApi.commitEpisode(card.meta.event, commitTarget);
      refresh();
    } catch (e) {
      setCommitError((e as Error).message);
    } finally {
      setCommitting(false);
    }
  }, [commitTarget, cards, refresh]);

  const season = standings?.season as unknown as SeasonShape | undefined;
  const teamName = (id: string) => schema?.teams.find((t) => t.id === id)?.name ?? id;

  return (
    <div className="space-y-6">
      <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
        <h2 className="text-[15px] font-semibold">Standings — season {season?.season_number ?? '—'}</h2>
        {season && (
          <table className="mt-3 w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-[color:var(--color-muted)]">
                <th className="py-1.5 pr-3">Team</th>
                <th className="py-1.5 pr-3">Points</th>
                <th className="py-1.5 pr-3">Wins</th>
                <th className="py-1.5 pr-3">Podiums</th>
                <th className="py-1.5">Streak</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-hairline)]">
              {Object.entries(season.standings)
                .sort((a, b) => b[1].points - a[1].points)
                .map(([tid, row]) => (
                  <tr key={tid}>
                    <td className="py-2 pr-3 font-medium">
                      {teamName(tid)}
                      {standings?.crown_team === tid && ' — crown'}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{row.points}</td>
                    <td className="py-2 pr-3 tabular-nums">{row.wins}</td>
                    <td className="py-2 pr-3 tabular-nums">{row.podiums}</td>
                    <td className="py-2 tabular-nums">{row.streak_type ? `${row.streak_count} ${row.streak_type}` : '—'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>

      {standings && standings.storyline_candidates.length > 0 && (
        <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
          <h2 className="text-[15px] font-semibold">Storyline candidates</h2>
          <div className="mt-2 divide-y divide-[color:var(--color-hairline)]">
            {standings.storyline_candidates.slice(0, 8).map((c, i) => (
              <div key={i} className="flex items-center justify-between py-2 text-[13px]">
                <span>{c.text}</span>
                <span className="tabular-nums text-[color:var(--color-faint)]">{c.score.toFixed(1)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {season && (
        <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
          <h2 className="text-[15px] font-semibold">Head to head</h2>
          <div className="mt-2 divide-y divide-[color:var(--color-hairline)] text-[13px]">
            {Object.entries(season.head_to_head).map(([key, row]) => {
              const parts = key.split('|');
              const a = parts[0] ?? '';
              const b = parts[1] ?? '';
              return (
                <div key={key} className="flex items-center justify-between py-1.5">
                  <span>
                    {teamName(a)} vs {teamName(b)}
                  </span>
                  <span className="tabular-nums text-[color:var(--color-muted)]">
                    {row[a] ?? 0} – {row[b] ?? 0}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
        <h2 className="text-[15px] font-semibold">Names queue</h2>
        <Textarea
          className="mt-3"
          rows={4}
          placeholder="Paste raw TikTok comments, one per line…"
          value={rawComments}
          onChange={(e) => setRawComments(e.target.value)}
        />
        <Button variant="secondary" className="mt-2" onClick={parse} loading={parsing} disabled={!rawComments.trim()}>
          Parse
        </Button>

        {parsed && (
          <div className="mt-4 space-y-3">
            <div>
              <h3 className="text-[13px] font-medium">Accepted ({parsed.accepted.length})</h3>
              <div className="mt-1 max-h-40 overflow-y-auto text-[12px] text-[color:var(--color-muted)]">
                {parsed.accepted.map((a, i) => (
                  <div key={i}>
                    {a.team}: {a.name}
                  </div>
                ))}
              </div>
            </div>
            {parsed.rejected.length > 0 && (
              <div>
                <h3 className="text-[13px] font-medium">Rejected ({parsed.rejected.length})</h3>
                <div className="mt-1 max-h-40 overflow-y-auto text-[12px] text-[color:var(--color-danger)]">
                  {parsed.rejected.map((r, i) => (
                    <div key={i}>
                      &ldquo;{r.raw}&rdquo; — {r.reason}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <Button variant="primary" onClick={saveAccepted} disabled={!parsed.accepted.length}>
              Save {parsed.accepted.length} to queue
            </Button>
          </div>
        )}

        {names && (
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
                Waiting ({names.queue.length})
              </h3>
              <div className="mt-1 max-h-40 overflow-y-auto text-[12px] text-[color:var(--color-muted)]">
                {names.queue.map((n, i) => (
                  <div key={i}>
                    {n.team}: {n.name}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
                Used ({names.used.length})
              </h3>
              <div className="mt-1 max-h-40 overflow-y-auto text-[12px] text-[color:var(--color-faint)]">
                {names.used.map((n, i) => (
                  <div key={i}>
                    {n.team}: {n.name}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
        <h2 className="text-[15px] font-semibold">Commit an episode</h2>
        <p className="mt-1 text-[13px] text-[color:var(--color-muted)]">
          Updates the season standings for real. Only do this after the episode has actually been posted.
        </p>
        {commitError && <p className="mt-2 text-[13px] text-[color:var(--color-danger)]">{commitError}</p>}
        <div className="mt-3 flex gap-3">
          <Select value={commitTarget} onChange={(e) => setCommitTarget(e.target.value)} className="flex-1">
            <option value="">Choose an episode from the Library…</option>
            {cards.map((c) => (
              <option key={c.episode_dir} value={c.episode_dir}>
                {c.episode_dir} — {c.meta.event}, winner {c.meta.winner}
              </option>
            ))}
          </Select>
          <Button variant="danger" onClick={commit} loading={committing} disabled={!commitTarget}>
            Commit
          </Button>
        </div>
      </div>
    </div>
  );
}
