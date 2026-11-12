'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { ContentType, Settings } from '@/lib/types';
import { estimateRemaining, fmtDuration, parseSourceMinutes } from '@/lib/eta';
import { useJobStream } from '@/lib/useJobStream';
import { CandidateReview } from '@/components/CandidateReview';
import { ColorWarStudio } from '@/components/ColorWarStudio';
import { ContentTypePicker } from '@/components/ContentTypePicker';
import { ContentTypeIcon } from '@/components/ContentTypeIcons';
import { FollowBallStudio } from '@/components/FollowBallStudio';
import { EyeTestStudio } from '@/components/EyeTestStudio';
import { PauseGameStudio } from '@/components/PauseGameStudio';
import { QuotesStudio } from '@/components/QuotesStudio';
import { LaserNationsStudio } from '@/components/LaserNationsStudio';
import { DoctorBanner } from '@/components/DoctorBanner';
import { PipelineChecklist } from '@/components/PipelineChecklist';
import { SaveRegenerate } from '@/components/SaveRegenerate';
import { ScriptReview } from '@/components/ScriptReview';
import { SettingsForm } from '@/components/SettingsForm';
import { SkippedCandidates } from '@/components/SkippedCandidates';
import { TopBar } from '@/components/TopBar';
import { Button, Spinner } from '@/components/ui';

type Phase = 'boot' | 'idle' | 'running' | 'input' | 'review' | 'error';

// Content types whose "generate" flow is a self-contained studio (inline
// preview + reroll + render + download) rather than the generic
// search/review pipeline below. Laser Nations is a studio ONLY in duel mode
// (settings.laserNationsMode === 'duel') — plain territory mode still uses
// the generic settings-driven autonomous flow — so it's checked separately
// wherever this list is, rather than living in it.
const STUDIO_CONTENT_TYPES: ContentType[] = ['colorwar', 'followball', 'eyetest', 'pausegame', 'quotes'];
const isLaserDuel = (settings: Settings) => settings.contentType === 'lasernations' && settings.laserNationsMode === 'duel';

export default function DashboardPage() {
  const [phase, setPhase] = useState<Phase>('boot');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sfxPacks, setSfxPacks] = useState<string[]>([]);
  const [twitchConfigured, setTwitchConfigured] = useState(true);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [chosen, setChosen] = useState(0);
  const [queuedJobIds, setQueuedJobIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const stream = useJobStream(
    phase === 'running' || phase === 'input' || phase === 'review' || phase === 'error' ? activeJobId : null,
  );

  // --- boot -------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const s = await api.getSettings();
        setSettings(s.settings);
        setSfxPacks(s.sfxPacks);
        setTwitchConfigured(s.twitchConfigured);
        const { jobs } = await api.listJobs();
        // Color War / Follow the ball / Eye test jobs are owned by their studio
        // (it renders inline + offers a download) — don't hijack the dashboard
        // into the generic review flow for one.
        const resumable = jobs.filter((j) => !STUDIO_CONTENT_TYPES.includes(j.settings.contentType) && !isLaserDuel(j.settings));
        const live = resumable.find(
          (j) => j.status === 'running' || j.status === 'queued',
        );
        const waiting = resumable.find((j) => j.status === 'awaiting_input');
        const review = resumable.find((j) => j.status === 'awaiting_review');
        if (waiting) {
          setActiveJobId(waiting.id);
          setRunStartedAt(new Date(waiting.startedAt ?? waiting.createdAt).getTime());
          setPhase('input');
        } else if (live) {
          setActiveJobId(live.id);
          setRunStartedAt(new Date(live.startedAt ?? live.createdAt).getTime());
          setPhase('running');
        } else if (review) {
          setActiveJobId(review.id);
          setPhase('review');
        } else {
          setPhase('idle');
        }
      } catch {
        setPhase('idle');
      }
    })();
  }, []);

  // --- react to stream ------------------------------------------
  useEffect(() => {
    if (phase !== 'running' && phase !== 'input') return;
    if (stream.review) {
      setChosen(0);
      setPhase('review');
    } else if (stream.error || stream.jobStatus === 'failed') setPhase('error');
    else if (stream.jobStatus === 'canceled') advance('Run canceled.');
    else if (stream.inputRequest && phase === 'running') setPhase('input');
    else if (!stream.inputRequest && phase === 'input' && stream.jobStatus === 'running') setPhase('running');
  }, [phase, stream.review, stream.error, stream.jobStatus, stream.inputRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings((cur) => (cur ? { ...cur, ...patch } : cur));
    try {
      const { settings: saved } = await api.saveSettings(patch);
      setSettings(saved);
    } catch {
      /* keep optimistic value */
    }
  }, []);

  const goHome = useCallback((msg?: string) => {
    setNotice(msg ?? null);
    setActiveJobId(null);
    setQueuedJobIds([]);
    setChosen(0);
    setStartError(null);
    setPhase('idle');
  }, []);

  const startRun = useCallback(async () => {
    setStartError(null);
    setNotice(null);
    setChosen(0);
    setBusy(true);
    // show the working view straight away — "making a new one" starts now
    setActiveJobId(null);
    setQueuedJobIds([]);
    setRunStartedAt(Date.now());
    setPhase('running');
    try {
      const { jobs } = await api.startRun();
      const first = jobs[0];
      if (!first) throw new Error('No job was created');
      setActiveJobId(first.id);
      setQueuedJobIds(jobs.slice(1).map((j) => j.id));
    } catch (e) {
      setStartError((e as Error).message);
      setPhase('idle'); // bounce back to the form with the error shown
    } finally {
      setBusy(false);
    }
  }, []);

  const advance = useCallback(
    (msg?: string) => {
      if (msg) setNotice(msg);
      setQueuedJobIds((q) => {
        const [next, ...rest] = q;
        if (next) {
          setActiveJobId(next);
          setRunStartedAt(Date.now());
          setPhase('running');
        } else {
          setActiveJobId(null);
          setPhase('idle');
        }
        return rest;
      });
    },
    [],
  );

  const onSave = useCallback(async () => {
    if (!activeJobId) return;
    setBusy(true);
    try {
      await api.saveJob(activeJobId, chosen);
      advance('Saved to your library.');
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [activeJobId, chosen, advance]);

  const onChoose = useCallback(
    (index: number) => {
      setChosen(index);
      if (activeJobId) void api.chooseCandidate(activeJobId, index).catch(() => {});
    },
    [activeJobId],
  );

  const onDiscard = useCallback(async () => {
    if (!activeJobId) return;
    setBusy(true);
    try {
      // drop this clip and stop the rest of the run — then go home
      await api.discardJob(activeJobId).catch(() => {});
      await Promise.all(queuedJobIds.map((id) => api.cancelJob(id).catch(() => {})));
    } finally {
      setBusy(false);
      goHome('Discarded.');
    }
  }, [activeJobId, queuedJobIds, goHome]);

  const followUp = useCallback(
    async (kind: 'new-take' | 'different-video') => {
      if (!activeJobId) return;
      setBusy(true);
      try {
        const { job } = await (kind === 'new-take' ? api.newTake(activeJobId) : api.differentVideo(activeJobId));
        setActiveJobId(job.id);
        setRunStartedAt(Date.now());
        setChosen(0);
        setPhase('running');
      } catch (e) {
        setNotice((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [activeJobId],
  );

  const onCancel = useCallback(async () => {
    if (!activeJobId) return;
    await api.cancelJob(activeJobId).catch(() => {});
  }, [activeJobId]);

  const respondScript = useCallback(
    async (body: { requestId: string; decision: 'approve' | 'regenerate' } | { requestId: string; decision: 'edit-script'; openingLine: string; script: string }) => {
      if (!activeJobId) return;
      setBusy(true);
      try {
        await api.respondToInput(activeJobId, body);
        setPhase('running'); // pipeline resumes; the stream takes over from here
      } catch (e) {
        setNotice((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [activeJobId],
  );

  const tryAgain = useCallback(() => {
    setPhase('idle');
    setActiveJobId(null);
    startRun();
  }, [startRun]);

  const runsQueuedNote = useMemo(
    () => (queuedJobIds.length ? `${queuedJobIds.length} more clip${queuedJobIds.length > 1 ? 's' : ''} queued` : null),
    [queuedJobIds.length],
  );

  if (phase === 'boot' || !settings) {
    return (
      <>
        <TopBar />
        <main className="mx-auto flex max-w-[680px] justify-center px-6 py-24 text-[color:var(--color-muted)]">
          <Spinner className="h-5 w-5" />
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar right={runsQueuedNote && <span className="text-[13px]">{runsQueuedNote}</span>} />
      <main className="mx-auto max-w-[680px] px-6 pb-32 pt-8">
        {phase === 'idle' && <DoctorBanner />}

        {notice && (
          <div className="clip-fade-up mb-8 rounded-[var(--radius)] bg-[color:var(--color-accent-soft)] px-4 py-3 text-[14px] text-[color:var(--color-accent-hover)]">
            {notice}
          </div>
        )}

        {/* ---------------- IDLE · studio (Color War / Follow the ball / Eye test / Laser Duel) ---------------- */}
        {phase === 'idle' && (STUDIO_CONTENT_TYPES.includes(settings.contentType) || isLaserDuel(settings)) && (
          <div className="clip-fade-up">
            <header className="mb-6 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <ContentTypeIcon
                  type={isLaserDuel(settings) ? 'lasernations' : settings.contentType}
                  className="h-6 w-6 text-[color:var(--color-accent)]"
                />
                <h1 className="text-[22px] font-semibold tracking-tight">
                  {settings.contentType === 'colorwar'
                    ? 'Color War'
                    : settings.contentType === 'followball'
                    ? 'Follow The Ball'
                    : settings.contentType === 'eyetest'
                    ? 'Eye Test'
                    : settings.contentType === 'pausegame'
                    ? 'Pause Game'
                    : settings.contentType === 'quotes'
                    ? 'Reminders'
                    : 'Laser Duel'}
                </h1>
              </div>
              {isLaserDuel(settings) && (
                <button
                  onClick={() => patchSettings({ laserNationsMode: 'territory' })}
                  className="text-[13px] text-[color:var(--color-muted)] hover:text-[color:var(--color-text)]"
                >
                  Switch to Territory
                </button>
              )}
            </header>

            <ContentTypePicker
              value={settings.contentType}
              onChange={(v) => patchSettings({ contentType: v })}
            />

            <div className="mt-7">
              {settings.contentType === 'colorwar' ? (
                <ColorWarStudio />
              ) : settings.contentType === 'followball' ? (
                <FollowBallStudio />
              ) : settings.contentType === 'eyetest' ? (
                <EyeTestStudio />
              ) : settings.contentType === 'pausegame' ? (
                <PauseGameStudio />
              ) : settings.contentType === 'quotes' ? (
                <QuotesStudio />
              ) : (
                <LaserNationsStudio />
              )}
            </div>
          </div>
        )}

        {/* ---------------- IDLE ---------------- */}
        {phase === 'idle' && !STUDIO_CONTENT_TYPES.includes(settings.contentType) && !isLaserDuel(settings) && (
          <div className="clip-fade-up">
            <header className="mb-6 flex items-center gap-2.5">
              <ContentTypeIcon type={settings.contentType} className="h-6 w-6 text-[color:var(--color-accent)]" />
              <h1 className="text-[22px] font-semibold tracking-tight">
                {settings.contentType === 'colorrace'
                  ? 'Color Race'
                  : settings.contentType === 'escaperace'
                    ? 'Escape Race'
                    : 'Laser Nations'}
              </h1>
            </header>

            <SettingsForm
              settings={settings}
              sfxPacks={sfxPacks}
              twitchConfigured={twitchConfigured}
              onChange={patchSettings}
            />

            <div className="mt-12 flex flex-col items-center">
              <Button variant="primary" size="lg" onClick={startRun} loading={busy} className="min-w-[200px]">
                Generate race
              </Button>
              {startError && <p className="mt-3 text-[13px] text-[color:var(--color-danger)]">{startError}</p>}
            </div>
          </div>
        )}

        {/* ---------------- RUNNING ---------------- */}
        {phase === 'running' && (
          <div className="clip-fade-up">
            <RunningHeader settings={settings} stream={stream} startedAt={runStartedAt} onCancel={onCancel} />
            <SkippedCandidates skipped={stream.skipped} considering={stream.considering} />
            <PipelineChecklist stream={stream} />
          </div>
        )}

        {/* ---------------- SCRIPT APPROVAL ---------------- */}
        {phase === 'input' && stream.inputRequest?.type === 'approve-script' && (
          <div className="clip-fade-up pt-2">
            <ScriptReview
              request={stream.inputRequest}
              busy={busy}
              onApprove={() => respondScript({ requestId: stream.inputRequest!.id, decision: 'approve' })}
              onRegenerate={() => respondScript({ requestId: stream.inputRequest!.id, decision: 'regenerate' })}
              onEdit={(openingLine, script) =>
                respondScript({ requestId: stream.inputRequest!.id, decision: 'edit-script', openingLine, script })
              }
              onCancel={onCancel}
            />
          </div>
        )}
        {phase === 'input' && stream.inputRequest?.type !== 'approve-script' && (
          <div className="clip-fade-up">
            <RunningHeader settings={settings} stream={stream} startedAt={runStartedAt} onCancel={onCancel} />
            <PipelineChecklist stream={stream} />
          </div>
        )}

        {/* ---------------- REVIEW ---------------- */}
        {phase === 'review' && stream.review && (
          <div className="clip-fade-up pt-4">
            <CandidateReview
              jobId={activeJobId!}
              candidates={stream.review.candidates}
              selected={chosen}
              onSelect={onChoose}
              hook={stream.review.draftText?.hook}
              caption={stream.review.draftText?.caption}
              hashtags={stream.review.draftText?.hashtags}
              source={{
                title: stream.review.sourceTitle,
                channel: stream.review.sourceChannel,
                url: stream.review.sourceUrl,
              }}
              provider={stream.review.sourceProvider}
              faceFrac={stream.review.faceFrac}
              transcriptVia={stream.review.transcriptVia}
            />
            <SaveRegenerate
              onSave={onSave}
              onDifferentVideo={() => followUp('different-video')}
              onDiscard={onDiscard}
              busy={busy}
            />
          </div>
        )}

        {/* ---------------- ERROR ---------------- */}
        {phase === 'error' && (
          <div className="clip-fade-up pt-4">
            <ErrorPanel stream={stream} onTryAgain={tryAgain} onAdjust={() => goHome()} />
          </div>
        )}
      </main>
    </>
  );
}

function useTick(active: boolean, ms = 1000) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => force((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [active, ms]);
}

function RunningHeader({
  settings,
  stream,
  startedAt,
  onCancel,
}: {
  settings: Settings;
  stream: ReturnType<typeof useJobStream>;
  startedAt: number | null;
  onCancel: () => void;
}) {
  useTick(true);
  const now = Date.now();
  const elapsed = startedAt ? (now - startedAt) / 1000 : 0;
  const sourceMinutes = parseSourceMinutes(stream.steps.download.detail);
  const eta = estimateRemaining(stream.steps, {
    sourceMinutes,
    whisperModel: settings.whisperModel,
    candidates: settings.candidatesPerVideo,
    transcriptSource: settings.transcriptSource,
    preciseCaptions: settings.preciseCaptions,
    now,
  });

  const label =
    settings.sourceMode === 'creators'
      ? settings.creators.slice(0, 3).join(', ') + (settings.creators.length > 3 ? '…' : '')
      : settings.sourceMode === 'trending'
        ? 'trending on YouTube'
        : settings.keywords.join(', ') || 'pinned video';

  const running = Object.entries(stream.steps).find(([, st]) => st.status === 'running');
  const stepNow = running ? running[1].detail || running[0] : 'starting…';

  return (
    <div className="mb-9">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Working…</h1>
          <p className="mt-1 text-[13px] text-[color:var(--color-muted)]">
            {label} · {settings.clipLengthSec}s · {stepNow}
          </p>
        </div>
        <button
          onClick={onCancel}
          className="mt-1 text-[13px] text-[color:var(--color-muted)] hover:text-[color:var(--color-danger)]"
        >
          Cancel
        </button>
      </div>

      <div className="mt-5 flex items-baseline gap-3">
        <span className="font-mono text-[26px] tabular-nums tracking-tight">{fmtClock(elapsed)}</span>
        <span className="text-[13px] text-[color:var(--color-muted)]">
          {eta.remainingSec > 2
            ? `~${fmtDuration(eta.remainingSec)} left${eta.confident ? '' : ' (rough)'}`
            : 'almost there'}
        </span>
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[color:var(--color-hairline)]">
        <div
          className="h-full rounded-full bg-[color:var(--color-accent)] transition-[width] duration-700 ease-out"
          style={{ width: `${Math.round(overallProgress(stream.steps) * 100)}%` }}
        />
      </div>
    </div>
  );
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

function overallProgress(steps: ReturnType<typeof useJobStream>['steps']): number {
  const order = Object.values(steps);
  const done = order.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const running = order.find((s) => s.status === 'running');
  return Math.min(1, (done + (running ? running.progress : 0)) / order.length);
}

function ErrorPanel({
  stream,
  onTryAgain,
  onAdjust,
}: {
  stream: ReturnType<typeof useJobStream>;
  onTryAgain: () => void;
  onAdjust: () => void;
}) {
  const failed = stream.error;
  return (
    <div className="text-center">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-[color:var(--color-danger-soft)]">
        <svg viewBox="0 0 24 24" className="h-5 w-5 text-[color:var(--color-danger)]" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M12 8v5M12 16h.01" strokeLinecap="round" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      </div>
      <h1 className="mt-5 text-[20px] font-semibold tracking-tight">
        Stopped at {failed ? failed.step : 'a step'}
      </h1>
      <p className="mx-auto mt-2 max-w-[420px] whitespace-pre-wrap text-[14px] text-[color:var(--color-muted)]">
        {failed?.message ?? 'Something went wrong. Check the details below.'}
      </p>
      <div className="mt-7 flex justify-center gap-3">
        <Button variant="primary" onClick={onTryAgain}>
          Try again
        </Button>
        <Button variant="secondary" onClick={onAdjust}>
          Adjust settings
        </Button>
      </div>
      <div className="mt-8 text-left">
        <PipelineChecklist stream={stream} />
      </div>
    </div>
  );
}
