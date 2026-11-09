import { EventEmitter } from 'node:events';
import type { JobEvent } from './types.ts';

export interface BusMessage {
  id: number; // job_events row id — used as SSE Last-Event-ID
  event: JobEvent;
}

/**
 * In-process fan-out of live job events to connected SSE clients.
 * Durability lives in SQLite (`job_events`); this is just the live wire.
 */
class JobBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  publish(jobId: string, id: number, event: JobEvent): void {
    this.emit(jobId, { id, event } satisfies BusMessage);
    this.emit('*', { id, event } satisfies BusMessage);
  }

  subscribe(jobId: string, listener: (msg: BusMessage) => void): () => void {
    this.on(jobId, listener);
    return () => this.off(jobId, listener);
  }
}

export const bus = new JobBus();

/** The broadcaster handed to the pipeline. */
export const broadcast = (jobId: string, id: number, event: JobEvent): void => {
  bus.publish(jobId, id, event);
};
