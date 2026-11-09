/**
 * Per-step / end-to-end test harness for the pipeline. No web UI involved.
 *
 *   npm run step -- search "stoicism" "marcus aurelius"
 *   npm run step -- run "day trading tips"            # full pipeline via a real job
 *   npm run smoke -- "https://youtube.com/watch?v=..." # full pipeline, pinned URL
 *   npm run step -- transcribe <video.mp4>
 *   npm run step -- select <transcript.json> <video.mp4>
 *   npm run step -- reframe <video.mp4> <start> <end>
 *   npm run step -- captions <transcript.json> <start> <end> [clean|bold|karaoke-pop]
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createJob, getJob, getJobSteps, saveSettings } from './db.ts';
import { env } from './env.ts';
import { paths } from './paths.ts';
import { runDoctor } from './doctor.ts';
import { searchVideos } from './youtube.ts';
import { STEP_LABEL, type JobEvent } from './types.ts';
import { createContext } from './pipeline/context.ts';
import { runPipeline } from './pipeline/run.ts';
import { score } from './pipeline/steps/score.ts';
import { transcribe } from './pipeline/steps/transcribe.ts';
import { selectSegment } from './pipeline/steps/select.ts';
import { reframe } from './pipeline/steps/reframe.ts';
import { buildCaptions } from './pipeline/steps/captions.ts';
import type { SelectedSegment, Transcript } from './types.ts';
import type { DownloadResult } from './pipeline/steps/download.ts';

const c = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function consoleBroadcast(_jobId: string, _id: number, e: JobEvent): void {
  if (e.type === 'step:status') {
    const glyph = e.status === 'done' ? c.green('✓') : e.status === 'failed' ? c.red('✗') : e.status === 'running' ? c.cyan('▸') : '·';
    process.stdout.write(`  ${glyph} ${STEP_LABEL[e.step].padEnd(16)} ${c.dim(e.detail ?? e.status)}\n`);
    if (e.error) process.stdout.write(`      ${c.red(e.error)}\n`);
  } else if (e.type === 'step:progress' && e.detail) {
    process.stdout.write(`      ${c.dim(`${Math.round(e.pct * 100)}% ${e.detail}`)}\r`);
  } else if (e.type === 'job:candidates') {
    process.stdout.write(`\n  ${c.bold(`${e.candidates.length} candidate clip(s)`)} (transcript via ${e.transcriptVia})\n`);
    e.candidates.forEach((cand, i) =>
      process.stdout.write(
        `    ${i + 1}. ${c.bold(cand.hookTitle)} ${c.dim(`(${cand.durationSec.toFixed(0)}s, score ${cand.score.toFixed(2)})`)}\n       ${c.dim(cand.reason)}\n`,
      ),
    );
  } else if (e.type === 'log' && process.env.DEBUG) {
    process.stdout.write(`      ${c.dim(`[${e.step}] ${e.line}`)}\n`);
  }
}

function scratchCtx(name: string) {
  const dir = resolve(paths.data, 'cli', `${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const job = createJob({ settings: saveSettings({}) });
  const ctx = createContext({ jobId: job.id, settings: job.settings, signal: new AbortController().signal, broadcast: consoleBroadcast });
  return { ctx, dir, job };
}

const fakeDl = (videoPath: string): DownloadResult => ({
  source: {} as never,
  videoPath: resolve(videoPath),
  infoJsonPath: null,
  thumbnailPath: null,
  youtubeSubsPath: null,
  deferred: false,
  windowOffsetSec: 0,
});
const fakeSeg = (start: string, end: string, hookTitle = ''): SelectedSegment => ({
  start: Number(start),
  end: Number(end),
  hookTitle,
  reason: '',
  score: 0.5,
  method: 'llm',
});

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case 'doctor': {
      const r = await runDoctor();
      for (const chk of r.checks) console.log(`  ${chk.status === 'ok' ? '✓' : chk.status === 'warn' ? '!' : '✗'} ${chk.name}: ${chk.detail}`);
      process.exit(r.ok ? 0 : 1);
      break;
    }

    case 'search': {
      if (!args.length) throw new Error('usage: search "<keyword>" ["<keyword>" ...]');
      saveSettings({ keywords: args });
      const publishedAfter = new Date(Date.now() - 365 * 86_400_000);
      const seen = new Map<string, Awaited<ReturnType<typeof searchVideos>>[number]>();
      for (const q of args) {
        const res = await searchVideos({ query: q, publishedAfter });
        for (const v of res) if (!seen.has(v.videoId)) seen.set(v.videoId, v);
      }
      const { ctx } = scratchCtx('search');
      const result = score(ctx, [...seen.values()]);
      console.log(`\n${c.bold('Ranked candidates')} (${result.ranked.length} passed, ${result.rejected.length} rejected)\n`);
      result.ranked.slice(0, 10).forEach((v, i) => {
        console.log(
          `${String(i + 1).padStart(2)}. ${c.bold(v.title.slice(0, 70))}\n` +
            `    ${c.dim(`${v.channel} · ${v.viewCount.toLocaleString()} views · ${Math.round(v.ageDays)}d · ${Math.round(v.viralityScore).toLocaleString()} views/day · ${(v.durationSec / 60).toFixed(0)}min`)}\n` +
            `    ${c.cyan(v.url)}`,
        );
      });
      break;
    }

    case 'run':
    case 'smoke': {
      if (!args[0]) throw new Error(`usage: ${cmd} ${cmd === 'smoke' ? '"<youtube-url>"' : '"<keyword>"'}`);
      const pinnedUrl = cmd === 'smoke' ? args[0] : undefined;
      const settings = saveSettings(cmd === 'run' ? { keywords: args } : {});
      // smoke: deterministic id per video so re-runs reuse the cached download + transcript
      const vid = pinnedUrl ? /(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/.exec(pinnedUrl)?.[1] : null;
      const job =
        cmd === 'smoke' && vid && getJob(`smoke-${vid}`)
          ? getJob(`smoke-${vid}`)!
          : createJob({ settings, ...(cmd === 'smoke' && vid ? { id: `smoke-${vid}` } : {}) });
      console.log(`${c.dim(`job ${job.id}`)}\n`);
      const t0 = Date.now();
      try {
        const out = await runPipeline({ jobId: job.id, signal: new AbortController().signal, broadcast: consoleBroadcast, pinnedUrl });
        console.log(`\n${c.green('done')} in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${out.candidates.length} clip(s) in data/work/${job.id}/`);
      } catch (err) {
        console.error(`\n${c.red('pipeline failed')}: ${(err as Error).message}`);
        for (const s of getJobSteps(job.id)) if (s.status === 'failed') console.error(`  at ${s.step}: ${s.error}`);
        process.exit(1);
      }
      break;
    }

    case 'transcribe': {
      if (!args[0]) throw new Error('usage: transcribe <video.mp4>');
      const { ctx } = scratchCtx('transcribe');
      const r = await transcribe(ctx, fakeDl(args[0]));
      console.log(`\nvia ${r.via} · ${r.segments.length} segments · ${r.segments.reduce((n, s) => n + s.words.length, 0)} words · ${r.language}`);
      console.log(c.dim(r.segments.slice(0, 3).map((s) => `[${s.start.toFixed(1)}] ${s.text}`).join('\n')));
      break;
    }

    case 'select': {
      if (!args[1]) throw new Error('usage: select <transcript.json> <video.mp4>');
      const transcript = { ...(JSON.parse(readFileSync(resolve(args[0]!), 'utf8')) as Transcript), via: 'whisper' as const, audioPath: null };
      const { ctx } = scratchCtx('select');
      const { picks } = await selectSegment(ctx, { transcript, dl: fakeDl(args[1]!) });
      picks.forEach((p, i) =>
        console.log(`\n${i + 1}. ${c.bold(p.hookTitle)}  ${p.start.toFixed(1)}–${p.end.toFixed(1)}s (${(p.end - p.start).toFixed(0)}s, ${p.method})\n   ${c.dim(p.reason)}`),
      );
      break;
    }

    case 'reframe': {
      if (!args[2]) throw new Error('usage: reframe <video.mp4> <start> <end>');
      const { ctx } = scratchCtx('reframe');
      const plan = await reframe(ctx, { dl: fakeDl(args[0]!), segment: fakeSeg(args[1]!, args[2]!), slot: 0 });
      console.log(`\n${plan.method} · crop ${plan.cropWidth}×${plan.cropHeight} of ${plan.sourceWidth}×${plan.sourceHeight} · ${plan.keyframes.length} keyframes`);
      break;
    }

    case 'captions': {
      if (!args[2]) throw new Error('usage: captions <transcript.json> <start> <end> [style]');
      const transcript = JSON.parse(readFileSync(resolve(args[0]!), 'utf8')) as Transcript;
      const { ctx } = scratchCtx('captions');
      ctx.settings.captionStyle = (args[3] as never) ?? 'karaoke-pop';
      const r = buildCaptions(ctx, { transcript, segment: fakeSeg(args[1]!, args[2]!), slot: 0 });
      console.log(`\n${r.assPath} · ${r.wordCount} words`);
      break;
    }

    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]!.replace('/**', ''));
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(c.red(`\n${(err as Error).message}`));
  process.exit(1);
});
