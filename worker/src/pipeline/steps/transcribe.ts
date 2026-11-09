import { existsSync, readFileSync } from 'node:fs';
import { env } from '../../env.ts';
import { runPython } from '../../lib/python.ts';
import { CandidateRejected, type Transcript } from '../../types.ts';
import { extractAudio } from '../ffmpeg.ts';
import { parseJson3 } from '../ytTranscript.ts';
import type { StepContext } from '../context.ts';
import type { DownloadResult } from './download.ts';

export interface TranscribeResult extends Transcript {
  /** 16 kHz wav — only produced on the Whisper path; null when we used YouTube captions. */
  audioPath: string | null;
  via: 'youtube' | 'whisper';
}

/**
 * Step 4 — get a word-level transcript. Uses YouTube's captions when available
 * (fast: no transcription), else faster-whisper. `whisper` mode forces the latter.
 */
export async function transcribe(ctx: StepContext, dl: DownloadResult): Promise<TranscribeResult> {
  const transcriptPath = ctx.file('transcript.json');
  if (existsSync(transcriptPath)) {
    const cached = JSON.parse(readFileSync(transcriptPath, 'utf8')) as Transcript & { via?: 'youtube' | 'whisper' };
    ctx.log('transcribe', 'reusing cached transcript');
    ctx.progress('transcribe', 1, 'cached');
    return { ...cached, via: cached.via ?? 'whisper', audioPath: existsSync(ctx.file('audio16k.wav')) ? ctx.file('audio16k.wav') : null };
  }

  const mode = ctx.settings.transcriptSource;

  // --- YouTube captions path -------------------------------------
  if (mode !== 'whisper' && dl.youtubeSubsPath) {
    // Parse the whole caption track — for a deferred (long) source we need every
    // moment in play; times get rebased once the clip is downloaded.
    const parsed = parseJson3(dl.youtubeSubsPath);
    if (parsed && parsed.transcript.segments.length) {
      const words = parsed.transcript.segments.reduce((n, s) => n + s.words.length, 0);
      ctx.log(
        'transcribe',
        `using YouTube captions — ${words} words${parsed.wordTimed ? ', word-timed' : ', line-timed (Whisper will refine the clip)'}`,
      );
      ctx.writeArtifact('transcript.json', { ...parsed.transcript, via: 'youtube' });
      ctx.setStep('transcribe', 'running', { detail: `YouTube captions · ${words} words` });
      ctx.progress('transcribe', 1);
      return { ...parsed.transcript, via: 'youtube', audioPath: null };
    }
    ctx.log('transcribe', 'caption file present but unparseable — falling back to Whisper');
  }

  // Twitch clips never have caption tracks — Whisper is the only path, regardless
  // of the transcript-source setting.
  if (mode === 'youtube' && dl.source.provider !== 'twitch') {
    throw new CandidateRejected('no usable YouTube captions on this video');
  }
  const LOCAL_TRANSCRIBE_CAP_MIN = 90;
  if (mode === 'auto' && dl.source.durationSec > LOCAL_TRANSCRIBE_CAP_MIN * 60) {
    throw new CandidateRejected(
      `no captions and ${(dl.source.durationSec / 60).toFixed(0)} min is beyond the local transcription limit`,
    );
  }

  // --- Whisper path --------------------------------------------
  const audioPath = ctx.file('audio16k.wav');
  ctx.log('transcribe', 'extracting 16 kHz mono audio');
  await extractAudio(dl.videoPath, audioPath, { sampleRate: 16_000, channels: 1, signal: ctx.signal });
  ctx.progress('transcribe', 0.05, 'audio ready');

  // For a long source with no captions this is a from-scratch local pass, so use the
  // turbo model — it's ~6× faster than large-v3 and the burned-in captions are
  // re-transcribed precisely on the final ~60 s clip anyway.
  const configured = ctx.settings.whisperModel || env.whisper.model;
  const longSource = dl.source.durationSec > 15 * 60;
  const model = longSource && !configured.includes('turbo') ? 'large-v3-turbo' : configured;
  ctx.setStep('transcribe', 'running', {
    detail: longSource ? `whisper ${model} · ${(dl.source.durationSec / 60).toFixed(0)} min, this takes a few minutes` : `whisper ${model}`,
  });

  let stdout = '';
  try {
    stdout = await runPython('transcribe.py', {
      args: ['--audio', audioPath, '--out', transcriptPath, '--model', model, '--compute', env.whisper.compute],
      signal: ctx.signal,
      onProgress: (pct, msg) => ctx.progress('transcribe', 0.05 + pct * 0.95, msg),
      onLog: (line) => ctx.log('transcribe', line),
    });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    // faster-whisper / CTranslate2 sometimes crashes at interpreter shutdown on
    // macOS ("recursive_mutex lock failed") *after* writing a complete result.
    // Tolerate a non-zero exit as long as a parseable transcript landed on disk.
    if (!existsSync(transcriptPath)) throw err;
    ctx.log('transcribe', `transcribe.py exited non-zero but a transcript was written — using it (${(err as Error).message.split('\n')[0]})`);
  }

  const transcript = JSON.parse(stdout || readFileSync(transcriptPath, 'utf8')) as Transcript;
  ctx.writeArtifact('transcript.json', { ...transcript, via: 'whisper' });
  const words = transcript.segments.reduce((n, s) => n + s.words.length, 0);
  if (words === 0) throw new Error('Transcription produced no words (silent or music-only audio?).');

  ctx.setStep('transcribe', 'running', { detail: `${words} words · ${transcript.language}` });
  return { ...transcript, via: 'whisper', audioPath };
}
