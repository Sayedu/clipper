'use client';

import { useCallback, useEffect, useState } from 'react';
import { colorwarsApi } from '@/lib/colorwarsApi';
import type { ParamSpec, PresetListing } from '@/lib/colorwarsTypes';
import { Button, Field, Select, TextInput, Textarea, Toggle } from '@/components/ui';
import type { StudioState } from './useStudioState';

function groupOrder(groups: string[]): string[] {
  // curated groups (whatever an event prepends) read first, in the order
  // the event itself emitted them; the generic "Advanced" catch-all (every
  // leftover YAML leaf walk_config_params() picked up) always sorts last.
  return [...groups].sort((a, b) => (a === 'Advanced' ? 1 : b === 'Advanced' ? -1 : 0));
}

function ParamRow({
  spec, value, locked, onChange, onToggleLock,
}: {
  spec: ParamSpec;
  value: unknown;
  locked: boolean;
  onChange: (v: unknown) => void;
  onToggleLock: () => void;
}) {
  const current = value ?? spec.default;
  return (
    <div className="flex items-start gap-3 py-2.5">
      <div className="flex-1">
        <Field label={spec.label} hint={spec.help || undefined}>
          {spec.type === 'bool' && (
            <Toggle checked={Boolean(current)} onChange={onChange} label={current ? 'On' : 'Off'} />
          )}
          {spec.type === 'select' && (
            <Select value={String(current)} onChange={(e) => onChange(e.target.value)}>
              {spec.options?.map((o) => (
                <option key={String(o.value)} value={String(o.value)}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
          {(spec.type === 'int' || spec.type === 'float') && (
            <TextInput
              type="number"
              value={String(current)}
              min={spec.min ?? undefined}
              max={spec.max ?? undefined}
              step={spec.step ?? (spec.type === 'int' ? 1 : 'any')}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isNaN(n)) onChange(spec.type === 'int' ? Math.round(n) : n);
              }}
            />
          )}
          {spec.type === 'text' && (
            <TextInput type="text" value={String(current ?? '')} onChange={(e) => onChange(e.target.value)} />
          )}
        </Field>
      </div>
      {spec.randomizable && (
        <Button
          variant={locked ? 'primary' : 'ghost'}
          size="md"
          className="mt-6 shrink-0"
          onClick={onToggleLock}
          title={locked ? 'Locked — Randomize will leave this alone' : 'Unlocked — Randomize may change this'}
        >
          {locked ? 'Locked' : 'Lock'}
        </Button>
      )}
    </div>
  );
}

export function SetupPanel({ studio }: { studio: StudioState }) {
  const {
    events, eventId, setEventId, schema, schemaLoading, seed, setSeed, overrides, setOverride,
    locks, toggleLock, episodeOverrides, setEpisodeOverrides, finale, setFinale,
    volumeMult, setVolumeMult, volumeLocked, toggleVolumeLock,
    randomizeAll, rerollSeedOnly, resetToDefaults, applyPreset,
  } = studio;

  const [presets, setPresets] = useState<PresetListing[]>([]);
  const [presetName, setPresetName] = useState('');
  const [presetBusy, setPresetBusy] = useState(false);
  const [presetError, setPresetError] = useState<string | null>(null);

  const refreshPresets = useCallback(() => {
    colorwarsApi.listPresets(eventId).then((d) => setPresets(d.presets)).catch(() => setPresets([]));
  }, [eventId]);
  useEffect(refreshPresets, [refreshPresets]);

  const savePreset = useCallback(async () => {
    if (!presetName.trim()) return;
    setPresetBusy(true);
    setPresetError(null);
    try {
      await colorwarsApi.savePreset(eventId, {
        name: presetName.trim(), overrides, episode_overrides: episodeOverrides as Record<string, unknown>, seed,
      });
      setPresetName('');
      refreshPresets();
    } catch (e) {
      setPresetError((e as Error).message);
    } finally {
      setPresetBusy(false);
    }
  }, [presetName, eventId, overrides, episodeOverrides, seed, refreshPresets]);

  const loadPreset = useCallback(
    async (name: string) => {
      const { preset } = await colorwarsApi.loadPreset(eventId, name);
      applyPreset(preset);
    },
    [eventId, applyPreset],
  );

  const deletePreset = useCallback(
    async (name: string) => {
      await colorwarsApi.deletePreset(eventId, name);
      refreshPresets();
    },
    [eventId, refreshPresets],
  );

  if (schemaLoading || !schema) {
    return <p className="py-10 text-center text-[13px] text-[color:var(--color-muted)]">Loading event…</p>;
  }

  const groups = groupOrder([...new Set(schema.params.map((p) => p.group))]);

  return (
    <div className="space-y-6">
      <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <Field label="Event">
            <Select value={eventId} onChange={(e) => setEventId(e.target.value)}>
              {events.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.display_name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Seed">
            <div className="flex gap-2">
              <TextInput
                type="number"
                value={seed}
                onChange={(e) => setSeed(Math.max(1, Math.round(Number(e.target.value)) || 1))}
                className="w-28"
              />
              <Button variant="secondary" onClick={rerollSeedOnly}>
                Reroll seed
              </Button>
            </div>
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button variant="primary" onClick={randomizeAll}>
            Randomize
          </Button>
          <Button variant="secondary" onClick={resetToDefaults}>
            Reset to defaults
          </Button>
          <Toggle checked={finale} onChange={setFinale} label="Finale episode" />
        </div>
      </div>

      <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
        <h2 className="text-[15px] font-semibold">Episode</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Hook line">
            <Select
              value={episodeOverrides.hook_line_mode ?? 'auto'}
              onChange={(e) => setEpisodeOverrides({ hook_line_mode: e.target.value as 'auto' | 'custom' })}
            >
              <option value="auto">Auto storyline</option>
              <option value="custom">Custom text</option>
            </Select>
          </Field>
          <Field label="Crown team">
            <Select
              value={episodeOverrides.crown_team_mode ?? 'auto'}
              onChange={(e) => setEpisodeOverrides({ crown_team_mode: e.target.value as 'auto' | 'override' })}
            >
              <option value="auto">From standings</option>
              <option value="override">Override</option>
            </Select>
          </Field>
          {episodeOverrides.hook_line_mode === 'custom' && (
            <Field label="Custom hook line">
              <TextInput
                value={episodeOverrides.hook_line_text ?? ''}
                onChange={(e) => setEpisodeOverrides({ hook_line_text: e.target.value })}
              />
            </Field>
          )}
          {episodeOverrides.crown_team_mode === 'override' && (
            <Field label="Crown team override">
              <Select
                value={episodeOverrides.crown_team_override ?? schema.teams[0]?.id ?? ''}
                onChange={(e) => setEpisodeOverrides({ crown_team_override: e.target.value })}
              >
                {schema.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Target length window (sec)">
            <div className="flex items-center gap-2">
              <TextInput
                type="number"
                className="w-20"
                value={episodeOverrides.duration_min_sec ?? schema.duration_min_sec}
                onChange={(e) => setEpisodeOverrides({ duration_min_sec: Number(e.target.value) })}
              />
              <span className="text-[13px] text-[color:var(--color-muted)]">to</span>
              <TextInput
                type="number"
                className="w-20"
                value={episodeOverrides.duration_max_sec ?? schema.duration_max_sec}
                onChange={(e) => setEpisodeOverrides({ duration_max_sec: Number(e.target.value) })}
              />
            </div>
          </Field>
          <Field label="Names">
            <Select
              value={episodeOverrides.names_mode ?? 'queue'}
              onChange={(e) => setEpisodeOverrides({ names_mode: e.target.value as 'queue' | 'custom' })}
            >
              <option value="queue">From the names queue</option>
              <option value="custom">Typed in below</option>
            </Select>
          </Field>
          <div>
            <Field label={`Audio volume (${Math.round(volumeMult * 100)}%)`}>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={volumeMult}
                  onChange={(e) => setVolumeMult(Number(e.target.value))}
                  className="flex-1"
                />
                <Button
                  variant={volumeLocked ? 'primary' : 'ghost'}
                  onClick={toggleVolumeLock}
                  title={volumeLocked ? 'Locked -- Randomize will leave this alone' : 'Unlocked -- Randomize may change this'}
                >
                  {volumeLocked ? 'Locked' : 'Lock'}
                </Button>
              </div>
            </Field>
          </div>
        </div>
        {episodeOverrides.names_mode === 'custom' && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {schema.teams.map((t) => (
              <Field key={t.id} label={`${t.name} names (one per line)`}>
                <Textarea
                  rows={3}
                  value={(episodeOverrides.custom_names?.[t.name] ?? []).join('\n')}
                  onChange={(e) =>
                    setEpisodeOverrides({
                      custom_names: {
                        ...(episodeOverrides.custom_names ?? {}),
                        [t.name]: e.target.value.split('\n'),
                      },
                    })
                  }
                />
              </Field>
            ))}
          </div>
        )}
      </div>

      {groups.map((group) => (
        <details key={group} open={group !== 'Advanced'} className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
          <summary className="cursor-pointer text-[15px] font-semibold">{group}</summary>
          <div className="mt-2 divide-y divide-[color:var(--color-hairline)]">
            {schema.params
              .filter((p) => p.group === group)
              .map((spec) => (
                <ParamRow
                  key={spec.name}
                  spec={spec}
                  value={overrides[spec.name]}
                  locked={Boolean(locks[spec.name])}
                  onChange={(v) => setOverride(spec.name, v)}
                  onToggleLock={() => toggleLock(spec.name)}
                />
              ))}
          </div>
        </details>
      ))}

      <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-5">
        <h2 className="text-[15px] font-semibold">Presets</h2>
        {presetError && <p className="mt-2 text-[13px] text-[color:var(--color-danger)]">{presetError}</p>}
        <div className="mt-3 flex gap-3">
          <TextInput
            placeholder="Preset name"
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            className="flex-1"
          />
          <Button variant="primary" onClick={savePreset} loading={presetBusy} disabled={!presetName.trim()}>
            Save preset
          </Button>
        </div>
        {presets.length > 0 && (
          <div className="mt-4 divide-y divide-[color:var(--color-hairline)]">
            {presets.map((p) => (
              <div key={p.name} className="flex items-center justify-between py-2 text-[13px]">
                <span>{p.name}</span>
                <span className="flex gap-2">
                  <Button variant="secondary" onClick={() => loadPreset(p.name)}>
                    Load
                  </Button>
                  <Button variant="danger" onClick={() => deletePreset(p.name)}>
                    Delete
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
