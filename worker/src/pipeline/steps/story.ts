import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { generateJSON } from '../../ollama.ts';
import { OPENING_LINE_SYSTEM, STORYTELLER_SYSTEM } from '../../guidelines.ts';
import type { Transcript } from '../../types.ts';
import type { StepContext } from '../context.ts';
import { contentFilterTranscript } from './filter.ts';

const WORDS_PER_SEC = 2.35; // Kokoro at the slower "storytime" speed (0.9)

export interface Story {
  title: string;
  openingLine: string;
  openingCandidates: string[];
  /** Full narration text (opening line is its first sentence). */
  script: string;
  /** Short verbatim phrases from the script where a sound effect should land. */
  sfxCues: string[];
}

const openingSchema = z.object({ candidates: z.array(z.string().min(4).max(240)).min(1) });
const storySchema = z.object({
  title: z.string().min(3).max(90),
  openingLine: z.string().min(4).max(240),
  script: z.string().min(130).max(6000),
  sfxCues: z.array(z.string().min(2).max(120)).max(3).optional().default([]),
});

/** As-you-speak-it text: the transcript screen wants a plain blob. */
function asTranscript(text: string): Transcript {
  return { language: 'en', durationSec: 0, segments: [{ start: 0, end: 0, text, words: [] }] };
}

async function generateStory(ctx: StepContext, genre: string, lengthSec: number, note?: string): Promise<Story> {
  const targetWords = Math.round(lengthSec * WORDS_PER_SEC);

  // 1. opening lines — their own problem to get right
  ctx.setStep('select', 'running', { detail: 'writing opening lines' });
  let candidates: string[] = [];
  try {
    const raw = await generateJSON<unknown>({
      system: OPENING_LINE_SYSTEM,
      prompt: `Genre / theme: ${genre}.${note ? `\nNote from the user: ${note}` : ''}\n\nGive 5 opening lines.`,
      temperature: 1.0,
      signal: ctx.signal,
      timeoutMs: 40_000,
    });
    const parsed = openingSchema.safeParse(raw);
    if (parsed.success) candidates = parsed.data.candidates.map((c) => c.trim()).filter(Boolean).slice(0, 5);
  } catch (err) {
    ctx.log('select', `opening-line pass skipped (${(err as Error).message})`);
  }

  // 2. the full story, told from the strongest opening
  ctx.setStep('select', 'running', { detail: `writing the story (~${targetWords} words)` });
  const system = STORYTELLER_SYSTEM.replace('{WORDS}', String(targetWords)).replace('{SECONDS}', String(lengthSec));
  const prompt = [
    `Genre / theme: ${genre}.`,
    note ? `The user asked for a change: ${note}` : '',
    candidates.length
      ? `Here are candidate opening lines — pick the strongest (or write a better one in the same spirit) and open with it:\n- ${candidates.join('\n- ')}`
      : 'Open on your single strongest line.',
    `\nWrite the COMPLETE story now — full arc, real plot twist that is quietly foreshadowed, and a ` +
      `chilling ending that lands (no question to the listener, no "I never found out"). About ${targetWords} ` +
      `words. Make it genuinely scary and beautifully told. Return JSON.`,
  ]
    .filter(Boolean)
    .join('\n');

  let story: z.infer<typeof storySchema> | null = null;
  for (let attempt = 0; attempt < 3 && !story; attempt++) {
    try {
      const raw = await generateJSON<unknown>({
        system,
        prompt,
        temperature: attempt === 0 ? 0.92 : 0.8,
        signal: ctx.signal,
        timeoutMs: 100_000,
      });
      const parsed = storySchema.safeParse(raw);
      if (parsed.success) story = parsed.data;
      else ctx.log('select', `story JSON rejected (${parsed.error.issues[0]?.message}) — retrying`);
    } catch (err) {
      ctx.log('select', `story draft failed (${(err as Error).message})`);
    }
  }
  if (!story) throw new Error('Could not draft a story. Check the LLM connection (npm run doctor).');

  // make sure the script actually opens with the opening line
  const opening = story.openingLine.trim();
  let script = story.script.replace(/\s+/g, ' ').trim();
  if (opening && !script.toLowerCase().startsWith(opening.slice(0, 24).toLowerCase())) {
    script = `${opening} ${script}`;
  }
  const merged = [opening, ...candidates.filter((c) => c.trim() !== opening)].filter(Boolean).slice(0, 6);

  return { title: story.title.trim(), openingLine: opening, openingCandidates: merged, script, sfxCues: story.sfxCues ?? [] };
}

/**
 * Step "select" for Storyteller — write the story, screen the text against the
 * same content guideline the sourced pipeline uses, then pause for the user to
 * approve / edit / regenerate before anything expensive (TTS, footage, render).
 */
export async function writeAndApproveStory(
  ctx: StepContext,
  opts: { genre: string; lengthSec: number },
): Promise<Story> {
  // "New take" copies an already-approved story.json forward — reuse it, skip the pause.
  const existing = ctx.file('story.json');
  if (existsSync(existing)) {
    try {
      const prev = JSON.parse(readFileSync(existing, 'utf8')) as Story & { approved?: boolean };
      if (prev.approved && prev.script) {
        ctx.log('select', `reusing the approved story — "${prev.title}"`);
        ctx.setStep('select', 'running', { detail: `reusing "${prev.title}"` });
        return prev;
      }
    } catch {
      /* fall through to a fresh write */
    }
  }

  let note: string | undefined;

  for (let round = 0; round < 6; round++) {
    ctx.throwIfCanceled();
    let story = await generateStory(ctx, opts.genre, opts.lengthSec, note);

    // same guideline screen as sourced content — keyword list + semantic LLM pass
    ctx.setStep('select', 'running', { detail: 'checking the script against the guideline' });
    try {
      await contentFilterTranscript(ctx, asTranscript(`${story.title}. ${story.script}`));
    } catch (err) {
      ctx.log('select', `script flagged (${(err as Error).message}) — rewriting`);
      note = `Your last script was rejected by the content filter for: ${(err as Error).message}. Rewrite it fully clean.`;
      continue;
    }

    ctx.writeArtifact('story.json', story);
    const estWords = story.script.split(/\s+/).filter(Boolean).length;
    const res = await ctx.requestInput({
      type: 'approve-script',
      title: story.title,
      openingLine: story.openingLine,
      openingCandidates: story.openingCandidates,
      script: story.script,
      genre: opts.genre,
      estWords,
    });

    if (res.decision === 'approve') {
      ctx.writeArtifact('story.json', { ...story, approved: true });
      ctx.log('select', `story approved — "${story.title}" (${estWords} words)`);
      return story;
    }
    if (res.decision === 'edit-script') {
      story = { ...story, openingLine: res.openingLine.trim() || story.openingLine, script: res.script.replace(/\s+/g, ' ').trim() };
      // still screen the user's edit
      try {
        await contentFilterTranscript(ctx, asTranscript(`${story.title}. ${story.script}`));
      } catch (err) {
        note = `The edited script was flagged for: ${(err as Error).message}. Produce a clean version close to it.`;
        continue;
      }
      ctx.writeArtifact('story.json', { ...story, approved: true });
      ctx.log('select', `story edited + approved — "${story.title}"`);
      return story;
    }
    // regenerate
    note = undefined;
  }
  throw new Error('Story approval loop gave up after 6 rounds.');
}
