import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appendEvent, setStepStatus, updateJob } from '../db.ts';
import { jobWorkDir } from '../paths.ts';
import type { InputRequest, InputResponse, JobEvent, Settings, Step, StepStatus } from '../types.ts';
import { requestInput as gateRequestInput } from './inputGate.ts';

type InputRequestInput =
  | Omit<Extract<InputRequest, { type: 'review-frames' }>, 'id' | 'jobId'>
  | Omit<Extract<InputRequest, { type: 'approve-text' }>, 'id' | 'jobId'>
  | Omit<Extract<InputRequest, { type: 'approve-script' }>, 'id' | 'jobId'>;

/** Called after an event is persisted, with its DB row id (used as SSE `Last-Event-ID`). */
export type Broadcaster = (jobId: string, eventId: number, event: JobEvent) => void;

/** `JobEvent` minus `jobId`, preserving the discriminated union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EmittableEvent = DistributiveOmit<JobEvent, 'jobId'>;

export class CanceledError extends Error {
  constructor() {
    super('canceled');
    this.name = 'CanceledError';
  }
}

export interface StepContext {
  jobId: string;
  workDir: string;
  settings: Settings;
  signal: AbortSignal;

  /** Absolute path to `name` inside this job's work directory. */
  file(name: string): string;
  /** Persist a JSON artifact in the work dir (also handy for the CLI harness). */
  writeArtifact(name: string, data: unknown): string;

  emit(event: EmittableEvent): void;
  setStep(step: Step, status: StepStatus, extra?: { detail?: string; error?: string }): void;
  progress(step: Step, pct: number, detail?: string): void;
  log(step: Step, line: string): void;

  /** Suspend until the user answers (frame review / text approval). */
  requestInput(req: InputRequestInput): Promise<InputResponse>;

  /** Throw {@link CanceledError} if the job was canceled. Call between long operations. */
  throwIfCanceled(): void;
}

export function createContext(opts: {
  jobId: string;
  settings: Settings;
  signal: AbortSignal;
  broadcast?: Broadcaster;
}): StepContext {
  const { jobId, settings, signal, broadcast } = opts;
  const workDir = jobWorkDir(jobId);
  mkdirSync(workDir, { recursive: true });

  const emit: StepContext['emit'] = (partial) => {
    const event = { ...(partial as object), jobId } as JobEvent;
    const id = appendEvent(event);
    broadcast?.(jobId, id, event);
  };

  return {
    jobId,
    workDir,
    settings,
    signal,

    file: (name) => resolve(workDir, name),
    writeArtifact(name, data) {
      const path = resolve(workDir, name);
      writeFileSync(path, JSON.stringify(data, null, 2));
      return path;
    },

    emit,
    setStep(step, status, extra) {
      setStepStatus(jobId, step, status, extra);
      emit({ type: 'step:status', step, status, detail: extra?.detail, error: extra?.error });
      if (status === 'failed' && extra?.error) {
        emit({ type: 'job:error', step, message: extra.error });
        updateJob(jobId, { errorStep: step, errorMessage: extra.error });
      }
    },
    progress(step, pct, detail) {
      emit({ type: 'step:progress', step, pct: Math.max(0, Math.min(1, pct)), detail });
    },
    log(step, line) {
      emit({ type: 'log', step, line });
    },

    requestInput(req) {
      return gateRequestInput(jobId, req, (request) => emit({ type: 'job:input-request', request }));
    },

    throwIfCanceled() {
      if (signal.aborted) throw new CanceledError();
    },
  };
}
