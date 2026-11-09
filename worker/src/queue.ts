import { getJob, listJobs, updateJob } from './db.ts';
import { log } from './lib/log.ts';
import { broadcast } from './bus.ts';
import { failOrphanedInputs } from './pipeline/inputGate.ts';
import { runPipeline } from './pipeline/run.ts';

interface QueuedJob {
  jobId: string;
  pinnedUrl?: string;
}

/**
 * Single-flight job queue. One pipeline runs at a time (Whisper + OpenCV + ffmpeg
 * are each hungry; parallel runs would thrash a 16 GB machine).
 */
class JobQueue {
  private pending: QueuedJob[] = [];
  private running: { jobId: string; controller: AbortController } | null = null;

  enqueue(jobId: string, opts: { pinnedUrl?: string } = {}): void {
    this.pending.push({ jobId, pinnedUrl: opts.pinnedUrl });
    log.info(`queued job ${jobId} (${this.pending.length} pending)`);
    void this.tick();
  }

  cancel(jobId: string): boolean {
    if (this.running?.jobId === jobId) {
      this.running.controller.abort();
      log.warn(`aborting running job ${jobId}`);
      return true;
    }
    const before = this.pending.length;
    this.pending = this.pending.filter((j) => j.jobId !== jobId);
    if (this.pending.length < before) {
      updateJob(jobId, { status: 'canceled', finishedAt: new Date().toISOString() });
      return true;
    }
    return false;
  }

  status(): { running: string | null; pending: string[] } {
    return { running: this.running?.jobId ?? null, pending: this.pending.map((j) => j.jobId) };
  }

  private async tick(): Promise<void> {
    if (this.running || !this.pending.length) return;
    const next = this.pending.shift()!;
    const job = getJob(next.jobId);
    if (!job || job.status === 'canceled') return void this.tick();

    const controller = new AbortController();
    this.running = { jobId: next.jobId, controller };

    try {
      await runPipeline({ jobId: next.jobId, signal: controller.signal, broadcast, pinnedUrl: next.pinnedUrl });
    } catch (err) {
      log.error(`job ${next.jobId} ended with error:`, (err as Error).message);
    } finally {
      this.running = null;
      void this.tick();
    }
  }
}

export const queue = new JobQueue();

/** On startup, fail any job left mid-flight (running / queued / mid-review) by a crash. */
export function reconcileOrphans(): void {
  failOrphanedInputs();
  for (const job of listJobs(300)) {
    if (job.status === 'running' || job.status === 'queued' || job.status === 'awaiting_input') {
      updateJob(job.id, {
        status: 'failed',
        errorMessage:
          job.status === 'awaiting_input'
            ? 'worker restarted while this job was waiting for your review'
            : 'worker restarted while this job was in progress',
        finishedAt: new Date().toISOString(),
        pendingInput: null,
      });
    }
  }
}
