'use client';

import { useEffect, useRef, useState } from 'react';
import { jobEventsUrl } from './api';
import {
  STEP_ORDER,
  type DraftText,
  type InputRequest,
  type JobCandidate,
  type JobEvent,
  type JobStatus,
  type SkippedCandidate,
  type Step,
  type StepStatus,
} from './types';

export interface StepState {
  status: StepStatus;
  detail: string | null;
  progress: number; // 0..1
  startedAt: number | null; // client clock (ms)
  endedAt: number | null;
}

export interface ReviewInfo {
  candidates: JobCandidate[];
  sourceTitle: string;
  sourceChannel: string;
  sourceUrl: string;
  sourceProvider: 'youtube' | 'twitch' | null;
  faceFrac: number | null;
  transcriptVia: 'youtube' | 'whisper' | null;
  draftText: DraftText | null;
}

export interface JobStreamState {
  connected: boolean;
  jobStatus: JobStatus | null;
  steps: Record<Step, StepState>;
  logs: Array<{ step: Step; line: string }>;
  review: ReviewInfo | null;
  inputRequest: InputRequest | null;
  skipped: SkippedCandidate[];
  considering: { title: string; rank: number; total: number } | null;
  error: { step: Step; message: string } | null;
}

const emptySteps = (): Record<Step, StepState> =>
  Object.fromEntries(
    STEP_ORDER.map((s) => [s, { status: 'pending', detail: null, progress: 0, startedAt: null, endedAt: null }]),
  ) as Record<Step, StepState>;

const INITIAL: JobStreamState = {
  connected: false,
  jobStatus: null,
  steps: emptySteps(),
  logs: [],
  review: null,
  inputRequest: null,
  skipped: [],
  considering: null,
  error: null,
};

export function useJobStream(jobId: string | null): JobStreamState {
  const [state, setState] = useState<JobStreamState>(INITIAL);
  const lastId = useRef(0);

  useEffect(() => {
    if (!jobId) {
      setState(INITIAL);
      return;
    }
    lastId.current = 0;
    setState({ ...INITIAL, steps: emptySteps() });

    let es: EventSource | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (stopped) return;
      es = new EventSource(jobEventsUrl(jobId, lastId.current));

      es.onopen = () => setState((s) => ({ ...s, connected: true }));

      es.onmessage = (ev) => {
        lastId.current = Number(ev.lastEventId) || lastId.current;
        let data: JobEvent;
        try {
          data = JSON.parse(ev.data) as JobEvent;
        } catch {
          return;
        }
        setState((s) => reduce(s, data));
      };

      es.onerror = () => {
        setState((s) => ({ ...s, connected: false }));
        es?.close();
        if (!stopped) retry = setTimeout(connect, 1500);
      };
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(retry);
      es?.close();
    };
  }, [jobId]);

  return state;
}

function reduce(s: JobStreamState, e: JobEvent): JobStreamState {
  switch (e.type) {
    case 'job:status':
      return { ...s, jobStatus: e.status };
    case 'step:status': {
      const prev = s.steps[e.step];
      const now = Date.now();
      const terminal = e.status === 'done' || e.status === 'failed' || e.status === 'skipped';
      // 'pending' fires when the fallthrough loop resets loop steps for a fresh
      // candidate — wipe the clock so a stale duration doesn't linger.
      const reset = e.status === 'pending';
      return {
        ...s,
        steps: {
          ...s.steps,
          [e.step]: {
            status: e.status,
            detail: reset ? null : e.detail ?? prev.detail,
            progress: e.status === 'done' ? 1 : reset ? 0 : prev.progress,
            startedAt: e.status === 'running' && !prev.startedAt ? now : reset ? null : prev.startedAt,
            endedAt: reset ? null : terminal ? (prev.endedAt ?? now) : prev.endedAt,
          },
        },
      };
    }
    case 'step:progress': {
      const prev = s.steps[e.step];
      return {
        ...s,
        steps: {
          ...s.steps,
          [e.step]: {
            ...prev,
            progress: e.pct,
            detail: e.detail ?? prev.detail,
            startedAt: prev.startedAt ?? Date.now(),
          },
        },
      };
    }
    case 'log':
      return { ...s, logs: [...s.logs.slice(-400), { step: e.step, line: e.line }] };
    case 'candidate:considering':
      return { ...s, considering: { title: e.title, rank: e.rank, total: e.total } };
    case 'candidate:skipped':
      return { ...s, skipped: [...s.skipped.filter((x) => x.videoId !== e.skipped.videoId), e.skipped] };
    case 'job:input-request':
      return { ...s, inputRequest: e.request };
    case 'job:input-cleared':
      return { ...s, inputRequest: null };
    case 'job:candidates':
      return {
        ...s,
        review: {
          candidates: e.candidates,
          sourceTitle: e.source?.title ?? '',
          sourceChannel: e.source?.channel ?? '',
          sourceUrl: e.source?.url ?? '',
          sourceProvider: e.source?.provider ?? (e.source ? 'youtube' : null),
          faceFrac: e.source?.faceFrac ?? null,
          transcriptVia: e.transcriptVia,
          draftText: e.draftText,
        },
      };
    case 'job:error':
      return { ...s, error: { step: e.step, message: e.message } };
    default:
      return s;
  }
}
