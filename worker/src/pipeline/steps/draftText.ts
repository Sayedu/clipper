import { z } from 'zod';
import { generateJSON } from '../../ollama.ts';
import type { ClipProvider, DraftText, Transcript } from '../../types.ts';
import type { StepContext } from '../context.ts';

const HOOK_MAX_CHARS = 58;
const HOOK_MAX_WORDS = 11;

const draftSchema = z.object({
  hook: z.string().min(2).max(160),
  overlays: z.array(z.string().max(80)).max(4).optional().default([]),
  caption: z.string().max(300).optional().default(''),
  hashtags: z.array(z.string().max(40)).max(12).optional().default([]),
});

/**
 * Modelled on how the big streamer-clip accounts caption: a third-person
 * reaction STATEMENT about the moment ("<name> <REACTION> after <thing> 😳"),
 * one or two words in CAPS, an emoji or two, ~12-16 words. Not a debate question.
 */
const SYSTEM = `You caption viral vertical clips of streamers / YouTubers, in the exact style of the
big clip accounts (AtomLightning, N3on clips, Adin Ross clips, Kai Cenat clips). Study these
real top-performing captions:

- "<name> couldn't believe after <thing> RETIRED 💔"
- "<name> was SHOCKED after <person> tells him <thing> 👀😳"
- "The moment <name> got EMOTIONAL after <thing> 💔"
- "<name> did not EXPECT <person> to <do thing> ❤️🥺"
- "<name> REALIZED <thing> 👀😳"
- "<person> FELT bad after <name> <did thing> 💔🥺"

THE PATTERN, every time:
- Third person. Name the streamer as the subject. Describe the actual moment in the clip.
- One clear REACTION verb, usually in CAPS: SHOCKED, REALIZED, REVEALS, EXPECT, EMOTIONAL,
  couldn't believe, FELT bad, WORRIED, PROUD, SPEECHLESS, LOST IT, went CRAZY, FROZE.
- Put 1–2 key words in ALL CAPS for emphasis. Not the whole line.
- End with 1–2 emoji that match the vibe: 👀 😳 💀 😭 🤯 🔥 💔 ❤️ 🥺 (💔/❤️/🥺 only for
  wholesome/emotional moments, never romance).
- 10–16 words. No question mark. No "POV". No hashtags inside the caption.
- HALAL: no profanity, no romance/dating, nothing crude or about anyone's looks/body,
  no gambling, no other-faith rituals. Keep it clean — wholesome-but-dramatic.

HOOK = the big text burned on screen for the first seconds. Same reaction-statement style,
SHORTER (under 11 words / 58 characters), 1–2 words in CAPS, at most one emoji. It should make
someone stop scrolling to see what happens.

OVERLAYS: 0–1 tiny line (<5 words) for a punch-in beat, e.g. "he FROZE" / "no way". Optional.

HASHTAGS: 5–7, lowercase, no '#'. Lead with the streamer's tag and "<streamer>clips", then
viral trending xyzbca fyp, then 1–2 that fit the moment.

Respond ONLY with JSON: {"hook": "...", "overlays": ["..."], "caption": "...", "hashtags": ["..."]}`;

export interface DraftContext {
  transcript: Transcript;
  segment: [number, number];
  /** Titles + top comments from the same batch of candidate videos — real current slang/context. */
  batchTitles: string[];
  batchComments: string[];
  /** Source provenance — the streamer in the clip + the optional creator credit. */
  sourceTitle?: string;
  sourceChannel?: string;
  provider?: ClipProvider;
  creatorHandle?: string;
  creatorUrl?: string;
}

/** The streamer's display name — the subject of the caption ("<name> was SHOCKED …"). */
function subjectName(ctx: DraftContext): string | null {
  const raw = (ctx.sourceChannel || ctx.creatorHandle || '').trim().replace(/^@/, '');
  return raw || null;
}

/** Handle for a hashtag / @-mention credit. */
function creditTag(ctx: DraftContext): string | null {
  const raw = (ctx.creatorHandle || ctx.sourceChannel || '').trim().replace(/^@/, '');
  return raw || null;
}

/** Step 7 (part of select) — draft the hook, overlays, caption + hashtags, grounded in real context. */
export async function draftText(ctx: StepContext, input: DraftContext, attempt = 0): Promise<DraftText> {
  const [a, b] = input.segment;
  const clipText = input.transcript.segments
    .filter((s) => s.end > a && s.start < b)
    .map((s) => s.text)
    .join(' ')
    .slice(0, 1500);

  const subject = subjectName(input);
  const credit = creditTag(input);
  const wantCredit = ctx.settings.creditCreator;

  const context = [
    input.batchTitles.length ? `Recent titles in this niche:\n- ${input.batchTitles.slice(0, 12).join('\n- ')}` : '',
    input.batchComments.length ? `Real comments people are leaving:\n- ${input.batchComments.slice(0, 20).join('\n- ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const tone = ctx.settings.tone.trim();
  const prompt = [
    subject ? `The streamer in this clip is ${subject}. Use that name as the subject of the caption and hook.` : '',
    tone ? `Extra tone note: ${tone}.` : '',
    credit && wantCredit
      ? `Also credit the original channel — put "${credit}" and "${credit}clips" among the hashtags.`
      : '',
    attempt > 0 ? `Your last hook was too long. Rewrite it SHORTER — under ${HOOK_MAX_CHARS} characters.` : '',
    context ? `\nCURRENT CONTEXT (for slang / who's who only):\n${context}` : '',
    `\nWHAT HAPPENS IN THE CLIP (transcript):\n${clipText}`,
    '\nWrite the caption + hook in the reaction-statement style. Return JSON.',
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await generateJSON<unknown>({
    system: SYSTEM,
    prompt,
    temperature: attempt > 0 ? 0.5 : 0.75,
    signal: ctx.signal,
    timeoutMs: 90_000,
  });
  const parsed = draftSchema.parse(raw);

  // The on-screen hook / overlays are burned with the Anton font (no emoji glyphs) —
  // strip emoji there. The caption keeps them (it's copy-paste text for the post).
  let hook = stripEmoji(parsed.hook).replace(/^["']|["']$/g, '').replace(/\s*[?.]+\s*$/, '').trim();
  const tooLong = hook.length > HOOK_MAX_CHARS || hook.split(/\s+/).length > HOOK_MAX_WORDS;
  if (tooLong && attempt < 2) {
    ctx.log('select', `hook "${hook}" too long — redrafting shorter`);
    return draftText(ctx, input, attempt + 1);
  }
  if (tooLong) hook = hook.split(/\s+/).slice(0, HOOK_MAX_WORDS).join(' ');

  const overlays = parsed.overlays.map((o) => stripEmoji(o).replace(/[.]+$/, '').trim()).filter(Boolean).slice(0, 2);

  let caption = parsed.caption.trim().replace(/\s+/g, ' ');
  const hashtags = dedupeTags(
    parsed.hashtags.map((t) => t.trim().replace(/^#/, '').replace(/\s+/g, '').toLowerCase()),
  );

  // Guarantee the credit lands in the tags when it's wanted.
  if (credit && wantCredit) {
    const c = credit.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (c && !hashtags.some((t) => t === c)) hashtags.unshift(c);
  }

  return {
    hook,
    overlays,
    caption: caption || undefined,
    hashtags: hashtags.length ? hashtags.slice(0, 8) : undefined,
  };
}

/** Drop emoji + pictographs (Anton has no glyphs for them) and tidy the spacing. */
function stripEmoji(s: string): string {
  return s
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    if (t.length < 2 || t.length > 30 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
