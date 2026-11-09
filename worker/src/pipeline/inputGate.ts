import { nanoid } from 'nanoid';
import { appendEvent, getJob, updateJob } from '../db.ts';
import { broadcast } from '../bus.ts';
import { log } from '../lib/log.ts';
import type { InputRequest, InputResponse } from '../types.ts';

class InputTimeout extends Error {
  constructor() {
    super('timed out waiting for your review');
    this.name = 'InputTimeout';
  }
}

interface Pending {
  request: InputRequest;
  resolve: (r: InputResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const TIMEOUT_MS = 45 * 60 * 1000;
const pending = new Map<string, Pending>();

export type EmitInput = (request: InputRequest) => void;

/**
 * Suspend the pipeline until the user answers `request` (via `POST /jobs/:id/respond`).
 * Persists the request on the job, flips status to `awaiting_input`, and emits an SSE event.
 */
type RequestInputBody =
  | Omit<Extract<InputRequest, { type: 'review-frames' }>, 'id' | 'jobId'>
  | Omit<Extract<InputRequest, { type: 'approve-text' }>, 'id' | 'jobId'>
  | Omit<Extract<InputRequest, { type: 'approve-script' }>, 'id' | 'jobId'>;

export function requestInput(jobId: string, req: RequestInputBody, emit: EmitInput): Promise<InputResponse> {
  const request = { ...req, id: nanoid(10), jobId } as InputRequest;
  return new Promise<InputResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(jobId);
      updateJob(jobId, { pendingInput: null });
      reject(new InputTimeout());
    }, TIMEOUT_MS);

    pending.set(jobId, { request, resolve, reject, timer });
    updateJob(jobId, { status: 'awaiting_input', pendingInput: request });
    emit(request);
    log.info(`job ${jobId} awaiting input: ${request.type}`);
  });
}

/** Feed a user decision back into the suspended pipeline. Returns false if nothing was waiting. */
export function respondToInput(jobId: string, response: InputResponse): boolean {
  const entry = pending.get(jobId);
  if (!entry || entry.request.id !== response.requestId) return false;
  clearTimeout(entry.timer);
  pending.delete(jobId);
  updateJob(jobId, { status: 'running', pendingInput: null });
  // tell connected clients the pause is over so the UI leaves the review screen
  for (const ev of [{ type: 'job:input-cleared' as const, jobId }, { type: 'job:status' as const, jobId, status: 'running' as const }]) {
    broadcast(jobId, appendEvent(ev), ev);
  }
  entry.resolve(response);
  return true;
}

/** On worker restart, fail any job that was mid-review (its promise is gone). */
export function failOrphanedInputs(): void {
  // pending is process-local; anything the DB says is awaiting_input but not in `pending` is orphaned.
  // The caller (reconcileOrphans) handles the DB side; this just clears our map.
  pending.clear();
}

export function pendingRequest(jobId: string): InputRequest | null {
  return pending.get(jobId)?.request ?? getJob(jobId)?.pendingInput ?? null;
}
