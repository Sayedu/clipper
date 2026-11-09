import { copyFileSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createClip,
  createJob,
  db,
  deleteClip,
  getClip,
  getJob,
  listJobs,
  setVideoOutcome,
  updateJob,
} from './db.ts';
import { clipDir, jobWorkDir, paths } from './paths.ts';
import { ffprobe } from './pipeline/ffmpeg.ts';
import { assignSlot } from './schedule.ts';
import { log } from './lib/log.ts';
import type { Clip, Settings } from './types.ts';

export function jobCandidateFile(jobId: string, index: number, kind: 'video' | 'thumb'): string {
  const dir = jobWorkDir(jobId);
  return resolve(dir, kind === 'video' ? `final.${index}.mp4` : `thumb.${index}.jpg`);
}

/** Move one of a reviewed job's candidate clips into the permanent library. */
export async function saveJobToLibrary(jobId: string, candidateIndex?: number): Promise<Clip> {
  const job = getJob(jobId);
  if (!job) throw new Error('job not found');

  const idx = candidateIndex ?? job.chosenIndex ?? 0;
  const cand = job.candidates.find((c) => c.index === idx) ?? job.candidates[0];
  if (!cand) throw new Error('this job has no rendered clip to save');

  const videoPath = jobCandidateFile(jobId, cand.index, 'video');
  const thumbSrc = jobCandidateFile(jobId, cand.index, 'thumb');
  if (!existsSync(videoPath)) throw new Error('rendered clip file is missing');

  const probe = await ffprobe(videoPath);

  const transcriptPath = resolve(jobWorkDir(jobId), 'transcript.json');
  let excerpt = '';
  if (existsSync(transcriptPath)) {
    try {
      const t = JSON.parse(readFileSync(transcriptPath, 'utf8')) as {
        segments: Array<{ start: number; end: number; text: string }>;
      };
      excerpt = t.segments
        .filter((s) => s.end > cand.segment[0] && s.start < cand.segment[1])
        .map((s) => s.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .slice(0, 600);
    } catch {
      /* optional */
    }
  }

  const clip = createClip({
    jobId: job.id,
    title: cand.hookTitle || job.source?.title || 'Untitled clip',
    source: job.source ?? {
      videoId: '',
      title: 'unknown',
      channel: '',
      url: '',
      publishedAt: '',
      durationSec: 0,
      viewCount: 0,
      likeCount: 0,
    },
    durationSec: probe.durationSec,
    filePath: '',
    thumbPath: '',
    meta: {
      segment: cand.segment,
      captionStyle: job.settings.captionStyle,
      transcriptExcerpt: excerpt,
      viralityScore: job.viralityScore,
      hook: job.draftText?.hook,
      overlays: job.draftText?.overlays,
      caption: job.draftText?.caption,
      hashtags: job.draftText?.hashtags,
      reframeMode: job.chosenReframeMode ?? cand.reframeMode,
      provider: job.source?.provider,
      creatorHandle: job.source?.creatorHandle,
      creatorUrl: job.source?.creatorUrl,
      faceFrac: job.source?.faceFrac,
    },
  });

  const dir = clipDir(clip.id);
  const filePath = resolve(dir, 'clip.mp4');
  const thumbPath = resolve(dir, 'thumb.jpg');
  copyFileSync(videoPath, filePath);
  if (existsSync(thumbSrc)) copyFileSync(thumbSrc, thumbPath);
  db.prepare('UPDATE clips SET file_path = ?, thumb_path = ? WHERE id = ?').run(filePath, thumbPath, clip.id);

  // give it a suggested post slot in the schedule queue
  const when = assignSlot(clip.id);

  writeFileSync(
    resolve(dir, 'metadata.json'),
    JSON.stringify(
      {
        clipId: clip.id,
        jobId: job.id,
        candidateIndex: cand.index,
        source: job.source,
        segment: cand.segment,
        hookTitle: cand.hookTitle,
        reason: cand.reason,
        caption: job.draftText?.caption,
        hashtags: job.draftText?.hashtags,
        scheduledAt: when,
        settings: job.settings,
        savedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  updateJob(jobId, { status: 'saved', chosenIndex: cand.index });
  if (job.source) setVideoOutcome(job.source.videoId, 'saved');

  // The clip now lives in the library — wipe the job's scratch folder (download,
  // intermediate renders, the other candidates). Nothing else reads from it.
  const workDir = jobWorkDir(jobId);
  rmSync(workDir, { recursive: true, force: true });

  log.ok(
    `saved clip ${clip.id} — "${clip.title}" (candidate ${cand.index + 1}/${job.candidates.length}); ` +
      `scheduled ${when.slice(0, 16).replace('T', ' ')}; cleared ${workDir}`,
  );
  return getClip(clip.id)!;
}

const REUSABLE_GLOBS = [
  /^source\.(mp4|mkv|webm|jpg|jpeg|png|webp)$/,
  /^source\.info\.json$/,
  /^source\..*\.json3$/, // youtube captions
  /^audio16k\.wav$/,
  /^transcript\.json$/,
  /^cuts\.json$/,
  /^filter\.json$/, // content-filter verdict (music/visual)
];

/**
 * "New take" — same source video, re-run selection / reframe / text / render.
 * Copies the parent's download + transcript + filter verdict forward so the new
 * run resumes at the `select` step. Marks the parent done-with.
 */
export function newTake(jobId: string, patch: Partial<Settings> = {}): { job: ReturnType<typeof getJob> } {
  const parent = getJob(jobId);
  if (!parent) throw new Error('job not found');

  // colorrace/escaperace/lasernations/colorwar (the only content types left) have
  // no source video at all — they're procedurally generated — so "new take" just
  // makes a fresh post with a new random seed.
  if (!parent.source) {
    updateJob(parent.id, { status: 'discarded' });
    const child = createJob({ settings: { ...parent.settings, ...patch }, parentJobId: parent.id });
    log.info(`new take ${child.id} from ${parent.id} — fresh post`);
    return { job: getJob(child.id) };
  }

  const settings: Settings = { ...parent.settings, ...patch };
  const child = createJob({ settings, parentJobId: parent.id, candidateRank: parent.candidateRank });

  // pin the child to the same video (run.ts skips search/score/thumbcheck when source is preset)
  updateJob(child.id, { source: parent.source });

  const from = jobWorkDir(parent.id);
  const to = jobWorkDir(child.id);
  for (const name of existsSync(from) ? readdirSync(from) : []) {
    if (REUSABLE_GLOBS.some((re) => re.test(name))) cpSync(resolve(from, name), resolve(to, name));
  }
  updateJob(parent.id, { status: 'discarded' });
  log.info(`new take ${child.id} from ${parent.id} — reusing "${parent.source.title}"`);
  return { job: getJob(child.id) };
}

/**
 * "Different video" — exclude this source too and pick a fresh candidate from scratch.
 */
export function differentVideo(jobId: string, patch: Partial<Settings> = {}): { job: ReturnType<typeof getJob> } {
  const parent = getJob(jobId);
  if (!parent) throw new Error('job not found');

  if (parent.source) setVideoOutcome(parent.source.videoId, 'rejected');
  updateJob(parent.id, { status: 'discarded' });

  const settings: Settings = { ...parent.settings, ...patch };
  const child = createJob({ settings, parentJobId: parent.id });
  log.info(`different video: ${child.id} (excluding ${parent.source?.videoId ?? '?'})`);
  return { job: getJob(child.id) };
}

/** Delete a saved clip (files + row). */
export function deleteLibraryClip(clipId: string): void {
  const clip = getClip(clipId);
  if (!clip) return;
  const dir = clipDir(clipId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  deleteClip(clipId);
  log.info(`deleted clip ${clipId}`);
}

/** Discard a reviewed job without saving; wipe its entire scratch folder. */
export function discardJob(jobId: string): void {
  const job = getJob(jobId);
  updateJob(jobId, { status: 'discarded' });
  if (job?.source) setVideoOutcome(job.source.videoId, 'discarded');
  const dir = resolve(paths.work, jobId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/**
 * On startup, tidy `data/work/`:
 *  - `saved` / `discarded` jobs      → wipe now (they're done with)
 *  - `failed` / `canceled` jobs      → wipe after 24h (leave a day to retry with the cache)
 *  - orphaned dirs (no job row)      → wipe now
 *  - anything at all older than 7d   → wipe
 * `awaiting_review` and in-flight jobs are always kept.
 */
export function sweepWorkDirs(): void {
  if (!existsSync(paths.work)) return;
  const jobs = new Map(listJobs(2000).map((j) => [j.id, j]));
  const dayAgo = Date.now() - 86_400_000;
  const weekAgo = Date.now() - 7 * 86_400_000;
  let cleared = 0;

  for (const name of readdirSync(paths.work)) {
    const dir = resolve(paths.work, name);
    if (!existsSync(dir)) continue;
    const job = jobs.get(name);
    const created = job ? new Date(job.createdAt).getTime() : 0;

    const wipe =
      !job ||
      job.status === 'saved' ||
      job.status === 'discarded' ||
      ((job.status === 'failed' || job.status === 'canceled') && created < dayAgo) ||
      created < weekAgo;

    if (wipe) {
      rmSync(dir, { recursive: true, force: true });
      cleared++;
    }
  }
  if (cleared) log.info(`swept ${cleared} stale work dir(s) from data/work/`);
}
