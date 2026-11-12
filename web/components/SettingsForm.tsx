'use client';

import {
  COLOR_RACE_MAPS,
  COLOR_WAR_MODES,
  type ColorRaceMap,
  type ColorWarMode,
  type Settings,
} from '@/lib/types';
import { ContentTypePicker } from './ContentTypePicker';
import { Field, Select, SegmentedControl, Toggle } from './ui';

export function SettingsForm({
  settings,
  onChange,
  disabled,
}: {
  settings: Settings;
  sfxPacks: string[];
  twitchConfigured?: boolean;
  onChange: (patch: Partial<Settings>) => void;
  disabled?: boolean;
}) {
  const contentTypeControl = (
    <ContentTypePicker value={settings.contentType} onChange={(v) => onChange({ contentType: v })} />
  );

  if (settings.contentType === 'colorrace') {
    const activeMap = COLOR_RACE_MAPS.find((m) => m.id === settings.colorRaceMap) ?? COLOR_RACE_MAPS[0]!;
    return (
      <fieldset disabled={disabled} className="space-y-9 disabled:opacity-60">
        {contentTypeControl}

        <div>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[14px] font-medium">Course</span>
            <span className="text-[12px] text-[color:var(--color-faint)]">{activeMap.tag}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {COLOR_RACE_MAPS.map((m) => {
              const on = settings.colorRaceMap === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onChange({ colorRaceMap: m.id as ColorRaceMap })}
                  className={`rounded-[var(--radius)] border px-3 py-2.5 text-left transition-colors ${
                    on
                      ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent-hover)]'
                      : 'border-[color:var(--color-hairline-strong)] text-[color:var(--color-muted)] hover:border-[color:var(--color-muted)]'
                  }`}
                >
                  <span className="block text-[13px] font-semibold">{m.name}</span>
                  <span className="mt-0.5 block text-[11px] leading-tight opacity-70">{m.tag}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-5 gap-y-9">
          <Field label="How many marbles" hint="3–6 marbles race.">
            <Select
              value={settings.colorRaceBalls}
              onChange={(e) => onChange({ colorRaceBalls: Number(e.target.value) })}
            >
              {[3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n} marbles
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Race length" hint={`~${settings.colorRaceTargetSec}s target (12–60s; a fresh map every run)`}>
            <input
              type="range"
              min={12}
              max={60}
              step={2}
              value={settings.colorRaceTargetSec}
              onChange={(e) => onChange({ colorRaceTargetSec: Number(e.target.value) })}
              className="mt-3 w-full accent-[color:var(--color-accent)]"
            />
          </Field>
          <Field label="Marble shape">
            <SegmentedControl<'circle' | 'square'>
              value={settings.colorRaceShape}
              onChange={(v) => onChange({ colorRaceShape: v })}
              options={[
                { value: 'circle', label: 'Circle' },
                { value: 'square', label: 'Square' },
              ]}
            />
          </Field>
        </div>
      </fieldset>
    );
  }

  if (settings.contentType === 'escaperace') {
    return (
      <fieldset disabled={disabled} className="space-y-9 disabled:opacity-60">
        {contentTypeControl}

        <div className="grid grid-cols-2 gap-x-5 gap-y-9">
          <Field label="How many balls" hint="3–6 colored balls race.">
            <Select
              value={settings.escapeRaceBalls}
              onChange={(e) => onChange({ escapeRaceBalls: Number(e.target.value) })}
            >
              {[3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n} balls
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Rings to escape" hint="3–14 rings. More rings = more layers to watch.">
            <Select
              value={settings.escapeRaceRings}
              onChange={(e) => onChange({ escapeRaceRings: Number(e.target.value) })}
            >
              {[3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((n) => (
                <option key={n} value={n}>
                  {n} rings
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Video length" hint={`~${settings.escapeRaceTargetSec}s target (12–45s; a fresh race every run)`}>
            <input
              type="range"
              min={12}
              max={45}
              step={1}
              value={settings.escapeRaceTargetSec}
              onChange={(e) => onChange({ escapeRaceTargetSec: Number(e.target.value) })}
              className="mt-3 w-full accent-[color:var(--color-accent)]"
            />
          </Field>
        </div>
      </fieldset>
    );
  }

  if (settings.contentType === 'lasernations') {
    return (
      <fieldset disabled={disabled} className="space-y-9 disabled:opacity-60">
        {contentTypeControl}

        <Field label="Mode">
          <SegmentedControl<'territory' | 'duel'>
            value={settings.laserNationsMode}
            onChange={(v) => onChange({ laserNationsMode: v })}
            options={[
              { value: 'territory', label: 'Territory — 4 nations' },
              { value: 'duel', label: 'Duel — 1v1 fight' },
            ]}
          />
        </Field>

        <div className="grid grid-cols-2 gap-x-5 gap-y-9">
          <Field label="Match length" hint={`~${settings.laserNationsMatchSec}s + a winner card`}>
            <input
              type="range"
              min={35}
              max={65}
              step={1}
              value={settings.laserNationsMatchSec}
              onChange={(e) => onChange({ laserNationsMatchSec: Number(e.target.value) })}
              className="mt-3 w-full accent-[color:var(--color-accent)]"
            />
          </Field>
        </div>

        <Toggle
          checked={settings.laserNationsBlackHole}
          onChange={(v) => onChange({ laserNationsBlackHole: v })}
          label="Black hole sudden-death finish"
        />
      </fieldset>
    );
  }

  if (settings.contentType === 'colorwar') {
    const activeMode = COLOR_WAR_MODES.find((m) => m.id === settings.colorWarMode) ?? COLOR_WAR_MODES[0]!;
    return (
      <fieldset disabled={disabled} className="space-y-9 disabled:opacity-60">
        {contentTypeControl}

        <div>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[14px] font-medium">Board</span>
            <span className="text-[12px] text-[color:var(--color-faint)]">{activeMode.tag}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {COLOR_WAR_MODES.map((m) => {
              const on = settings.colorWarMode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onChange({ colorWarMode: m.id as ColorWarMode })}
                  className={`rounded-[var(--radius)] border px-3 py-2.5 text-left transition-colors ${
                    on
                      ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent-hover)]'
                      : 'border-[color:var(--color-hairline-strong)] text-[color:var(--color-muted)] hover:border-[color:var(--color-muted)]'
                  }`}
                >
                  <span className="block text-[13px] font-semibold">{m.name}</span>
                  <span className="mt-0.5 block text-[11px] leading-tight opacity-70">{m.tag}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-5 gap-y-9">
          <Field label="Ball shape">
            <SegmentedControl<'circle' | 'square'>
              value={settings.colorWarShape}
              onChange={(v) => onChange({ colorWarShape: v })}
              options={[
                { value: 'circle', label: 'Circle' },
                { value: 'square', label: 'Square' },
              ]}
            />
          </Field>
          <Field label="Flip sound">
            <SegmentedControl<'pluck' | 'bubble'>
              value={settings.colorWarFlipSound}
              onChange={(v) => onChange({ colorWarFlipSound: v })}
              options={[
                { value: 'pluck', label: 'Pluck' },
                { value: 'bubble', label: 'Bubble' },
              ]}
            />
          </Field>
        </div>
        <p className="text-[13px] text-[color:var(--color-muted)]">
          No source video, no AI writing — a physics sim rendered from scratch. Four colors bounce a
          grid; every strike on an enemy tile flips it and deflects the ball, and white paint-bomb
          pickups blow a hole in the map. A color with no tiles left is wiped out — last one alive
          wins. <strong>Classic</strong> (default) runs ~42s: a long 4-way, then a ~15s one-on-one
          where each color gets crushed to ~15-20% and storms all the way back, over and over,
          before one pulls clear and wins. <strong>Sprint</strong> is a ~16s cold-open cut.
        </p>
      </fieldset>
    );
  }

  // settings.contentType can only be one of the four above — this is here only as a
  // safe fallback for a stale/legacy persisted settings blob (e.g. an old 'clip' value
  // from before 2026-09-04), so the user always sees a way to pick a valid type.
  return (
    <fieldset disabled={disabled} className="space-y-9 disabled:opacity-60">
      {contentTypeControl}
    </fieldset>
  );
}
