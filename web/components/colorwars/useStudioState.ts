'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { colorwarsApi } from '@/lib/colorwarsApi';
import type { EpisodeOverrides, EventInfo, EventSchema, ParamSpec, Preset, RunConfig } from '@/lib/colorwarsTypes';

function randomSeed(): number {
  return 1 + Math.floor(Math.random() * 999_999);
}

function randomValueFor(spec: ParamSpec): unknown {
  if (spec.type === 'bool') return Math.random() < 0.5;
  if (spec.type === 'select' && spec.options?.length) {
    const options = spec.options;
    return options[Math.floor(Math.random() * options.length)]?.value;
  }
  if (spec.type === 'int' || spec.type === 'float') {
    const lo = spec.min ?? 0;
    const hi = spec.max ?? lo + 10;
    const raw = lo + Math.random() * (hi - lo);
    if (spec.type === 'int') return Math.round(raw);
    const step = spec.step ?? 0.01;
    return Math.round(raw / step) * step;
  }
  return spec.default; // text, or anything unrecognized: leave untouched
}

export interface StudioState {
  events: EventInfo[];
  eventId: string;
  setEventId: (id: string) => void;
  schema: EventSchema | null;
  schemaLoading: boolean;
  seed: number;
  setSeed: (n: number) => void;
  overrides: Record<string, unknown>;
  setOverride: (name: string, value: unknown) => void;
  locks: Record<string, boolean>;
  toggleLock: (name: string) => void;
  episodeOverrides: EpisodeOverrides;
  setEpisodeOverrides: (patch: Partial<EpisodeOverrides>) => void;
  finale: boolean;
  setFinale: (v: boolean) => void;
  volumeMult: number;
  setVolumeMult: (v: number) => void;
  volumeLocked: boolean;
  toggleVolumeLock: () => void;
  randomizeAll: () => void;
  rerollSeedOnly: () => void;
  resetToDefaults: () => void;
  applyPreset: (preset: Preset) => void;
  buildRunConfig: () => RunConfig;
}

/** Shared Setup-form state for the whole colorwars Studio page -- every
 * panel (Preview, Story Director, Render, Library "load into setup") reads
 * or writes this same state instead of each keeping its own copy. */
export function useStudioState(): StudioState {
  const [events, setEvents] = useState<EventInfo[]>([]);
  const [eventId, setEventIdRaw] = useState('ring_of_doom');
  const [schema, setSchema] = useState<EventSchema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(true);
  const [seed, setSeed] = useState(1);
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [locks, setLocks] = useState<Record<string, boolean>>({});
  const [episodeOverrides, setEpisodeOverridesRaw] = useState<EpisodeOverrides>({
    hook_line_mode: 'auto',
    crown_team_mode: 'auto',
    names_mode: 'queue',
  });
  const [finale, setFinale] = useState(false);
  const [volumeMult, setVolumeMult] = useState(1.0);
  const [volumeLocked, setVolumeLocked] = useState(false);

  useEffect(() => {
    colorwarsApi
      .listEvents()
      .then((d) => setEvents(d.events))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setSchemaLoading(true);
    setOverrides({});
    setLocks({});
    colorwarsApi
      .getSchema(eventId)
      .then((d) => setSchema(d))
      .catch(() => setSchema(null))
      .finally(() => setSchemaLoading(false));
  }, [eventId]);

  const setEventId = useCallback((id: string) => setEventIdRaw(id), []);

  const setOverride = useCallback((name: string, value: unknown) => {
    setOverrides((cur) => ({ ...cur, [name]: value }));
  }, []);

  const toggleLock = useCallback((name: string) => {
    setLocks((cur) => ({ ...cur, [name]: !cur[name] }));
  }, []);

  const setEpisodeOverrides = useCallback((patch: Partial<EpisodeOverrides>) => {
    setEpisodeOverridesRaw((cur) => ({ ...cur, ...patch }));
  }, []);

  const toggleVolumeLock = useCallback(() => setVolumeLocked((v) => !v), []);

  const randomizeAll = useCallback(() => {
    if (!schema) return;
    setSeed(randomSeed());
    setOverrides((cur) => {
      const next = { ...cur };
      for (const spec of schema.params) {
        if (!spec.randomizable || locks[spec.name]) continue;
        next[spec.name] = randomValueFor(spec);
      }
      return next;
    });
    if (!volumeLocked) setVolumeMult(Math.round((0.6 + Math.random() * 0.8) * 100) / 100);
  }, [schema, locks, volumeLocked]);

  const rerollSeedOnly = useCallback(() => setSeed(randomSeed()), []);

  const resetToDefaults = useCallback(() => {
    setOverrides({});
    setEpisodeOverridesRaw({ hook_line_mode: 'auto', crown_team_mode: 'auto', names_mode: 'queue' });
    setFinale(false);
    setVolumeMult(1.0);
  }, []);

  const applyPreset = useCallback((preset: Preset) => {
    setOverrides(preset.overrides ?? {});
    setEpisodeOverridesRaw({
      hook_line_mode: 'auto',
      crown_team_mode: 'auto',
      names_mode: 'queue',
      ...(preset.episode_overrides ?? {}),
    });
    if (preset.seed != null) setSeed(preset.seed);
  }, []);

  const buildRunConfig = useCallback(
    (): RunConfig => ({ event_id: eventId, seed, overrides, episode_overrides: episodeOverrides, finale }),
    [eventId, seed, overrides, episodeOverrides, finale],
  );

  return useMemo(
    () => ({
      events, eventId, setEventId, schema, schemaLoading, seed, setSeed, overrides, setOverride,
      locks, toggleLock, episodeOverrides, setEpisodeOverrides, finale, setFinale,
      volumeMult, setVolumeMult, volumeLocked, toggleVolumeLock,
      randomizeAll, rerollSeedOnly, resetToDefaults, applyPreset, buildRunConfig,
    }),
    [events, eventId, setEventId, schema, schemaLoading, seed, overrides, setOverride, locks, toggleLock,
      episodeOverrides, setEpisodeOverrides, finale, volumeMult, volumeLocked, toggleVolumeLock,
      randomizeAll, rerollSeedOnly, resetToDefaults, applyPreset, buildRunConfig],
  );
}
