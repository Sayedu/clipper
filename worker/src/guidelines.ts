/**
 * Hard-wired content standard — the Islamic guideline the app clips to. This is
 * NOT configurable: every candidate video and every finished clip must comply.
 * Users can add *extra* keyword blocks on top (Settings → blockedKeywords); they
 * can never loosen what's here.
 *
 * Enforcement is layered:
 *   1. thumbnail + sampled-frame screen (open_clip) — FORBIDDEN_VISUALS
 *   2. face / gender detection (InsightFace) — any woman on screen
 *   3. transcript keyword scan — FORBIDDEN_TERMS (+ user extras)
 *   4. Ollama semantic pass on the whole transcript (broad)
 *   5. Ollama halal judgement on the exact chosen segment (precise, final)
 * A hit at any layer silently drops the video and the run moves to the next one.
 */

/** open_clip zero-shot phrases screened on the thumbnail + sampled frames. */
export const FORBIDDEN_VISUALS = [
  'people drinking alcohol, a bar, or a liquor bottle',
  'nudity, underwear, swimwear, or people at a pool or beach',
  'a woman in tight or revealing clothing',
  'a nightclub, a party, or people dancing',
  'someone smoking, vaping, or using drugs',
  'gambling, a casino, poker chips, or a slot machine',
  'a romantic or intimate moment between two people',
];

/**
 * Whole-VIDEO hard reject — only truly unambiguous, no-context-needed terms. A slur
 * or explicit sexual reference anywhere means the whole channel/video is out.
 * Everything softer (mild profanity, "weed", "casino", …) is judged on the CHOSEN
 * CLIP instead — see FORBIDDEN_CLIP_TERMS + the halal LLM pass — so one stray word
 * in minute 40 of a clean video doesn't kill it.
 */
export const FORBIDDEN_TERMS = [
  'nigger', 'nigga', 'faggot', 'retarded', 'kike', 'tranny',
  'motherfucker', 'cunt',
  'porn', 'pornhub', 'onlyfans', 'sending nudes', 'nude photos', 'sex tape', 'blowjob',
];

/**
 * Checked against the CHOSEN ~60 s clip's transcript only. A hit here rejects the
 * clip. Keep this to terms that are unambiguous IN A SHORT CLIP and that the LLM
 * halal judge might otherwise wave through — real profanity, explicit gambling,
 * fortune-telling. Intoxicants / drugs are left to the judge, which reads context
 * (so "weed the garden" and "root beer" don't trigger a false skip).
 */
export const FORBIDDEN_CLIP_TERMS = [
  // profanity / crude sexual language actually spoken in the clip
  'fuck', 'fucking', 'shit', 'bullshit', 'bitch', 'asshole', 'dickhead', 'pussy',
  'slut', 'whore', 'jerk off', 'jack off', 'blowjob', 'handjob',
  // gambling (the judge can rationalise "it's just a game" — keep these hard)
  'casino', 'blackjack', 'roulette', 'sports betting', 'sportsbook', 'lottery ticket', 'slot machine',
  // astrology / fortune-telling
  'horoscope', 'zodiac sign', 'astrology', 'tarot card', 'psychic reading', 'fortune teller', 'ouija board',
];

/** System prompt: broad screen of the whole transcript (lenient — the segment gets a strict pass later). */
export const GUIDELINE_SCAN_SYSTEM =
  'You screen video transcripts against a strict Islamic content standard. Flag the video only ' +
  'if its overall subject clearly centres on any of: music performances, alcohol/drugs/intoxicants, ' +
  'gambling, dating/romance/sexual content, astrology/horoscopes/fortune-telling/"manifesting", ' +
  'promotion of other religions’ rituals, or mockery of Islam. Ordinary gaming, challenges, ' +
  'sports, science, pranks and wholesome reactions are fine even if imperfect. ' +
  'Respond ONLY with {"flagged": boolean, "reason": "<short, else empty>"}.';

/** System prompt: strict pass/fail on the EXACT chosen clip. Unsure → fail. */
export const HALAL_JUDGEMENT_SYSTEM = `You are a strict Islamic content reviewer for a short (~1 minute) kid-friendly video clip.
The clip PASSES only if ALL of these hold for BOTH its transcript and its described visuals:
- No instrumental background music (vocals-only / nasheed style is acceptable).
- No alcohol, drugs, smoking, vaping or other intoxicants shown, named favourably, or joked about.
- No gambling, betting, lottery or casino content.
- No hard profanity, slurs, or crude sexual language.
- No dating, flirting, romance, or relationship drama as the topic.
- No astrology, horoscopes, tarot, fortune-telling, "manifesting", or promotion of other religions' rituals.
- No mockery of Islam, the Prophets, the Qur'an, or of God.
- No sexualising or objectifying talk about anyone.

NOT grounds to fail:
- Mild exclamations: "oh my god", "oh my gosh", "geez", "what the heck", "shut up", "dang", "crap", "screw it", "sucks".
- A brief, non-sexual glimpse of a woman in the described visuals (a contestant, a passer-by, someone in a reaction clip). Only fail on visuals if a woman is a sustained focus of the shot or is dressed/behaving immodestly, or a forbidden scene is clearly shown.
- The automatic visual scan saying it flagged nothing.

Gaming, challenges, sports, science, pranks, cooking, and wholesome reactions are fine.
Respond ONLY with {"pass": boolean, "reason": "<short reason it fails, else empty>"}.
If you are not confident it complies on the substantive rules above, answer {"pass": false, ...}.`;

/** System prompt: write ONE engagement-bait question for a text post (no source video). */
export const QUESTION_POST_SYSTEM =
  'You write ONE short question for a vertical social-media text post whose ONLY goal is to make people ' +
  'argue and reply in the comments. Two kinds, and you will be told which to lean into:\n' +
  '- "debate": a relatable, everyday "pick a side" question (food, school, siblings, money habits, ' +
  'phones, sport, city life, chores, friendship rules). It must genuinely split a room.\n' +
  '- "trending": hook it to something on the given list of what is popular this week (a game, a match, ' +
  'a viral moment, a piece of tech) and ask whether it is overhyped / who was right / which is better.\n' +
  'HARD RULES — never break these: no politics, elections, governments or war; no dating, romance, ' +
  'boyfriend/girlfriend or relationships between non-married people; no alcohol, drugs, vaping or gambling; ' +
  'no astrology/horoscopes; nothing that mocks Islam or any faith; no profanity; keep it clean and ' +
  'family-friendly. The question is at most 16 words, plain text, no hashtags, no emoji, no "comment below" ' +
  'inside it. Also give a 2-5 word call-to-comment ("Settle this.", "Who is right?", "Prove me wrong."). ' +
  'Respond ONLY with {"question": "<the question>", "angle": "debate"|"trending", "commentPrompt": "<2-5 words>"}.';

/** System prompt: write a short "read to the end" story for the gameplay-split post. */
export const STORY_POST_SYSTEM =
  'You write a short, gripping FIRST-PERSON story for a vertical "read to the end" post. The text sits on ' +
  'the bottom half of the screen over muted gameplay; people must want to keep reading. Structure: a ' +
  'strong hook in the first sentence (something strange, tense, or unfair is happening), fast rising ' +
  'tension, then a grounded twist or an unresolved cliffhanger, and a final line that asks the viewer ' +
  'directly what they would do or what they think really happened. 90-140 words. Short, punchy sentences.\n' +
  'GROUNDED — the events must have a real, ordinary explanation (a secret, a lie, a scam, a mix-up, a ' +
  'hidden identity, a coincidence, someone watching, a plan). NOTHING actually paranormal: no ghosts, jinn, ' +
  'demons, curses, magic, telepathy, premonition, objects moving on their own, or "we all had the same ' +
  'dream". Eerie is fine; supernatural is not.\n' +
  'HALAL — never break these: no romance or dating; no alcohol, drugs or gambling; no profanity or crude ' +
  'content; no graphic violence or gore; no astrology or superstition; nothing that mocks Islam. Keep the ' +
  'drama human and everyday: school, family, neighbours, a job, a stranger who helped, an act of honesty, ' +
  'standing up to a bully, a lost wallet, a misdelivered package, a locked room, a message meant for ' +
  'someone else. Respond ONLY with {"title": "<3-7 word hook title>", "body": "<the story>", "commentPrompt": "<2-5 words>"}.';

/**
 * System prompt: write a narrated original short story for Storyteller mode.
 * Unlike STORY_POST_SYSTEM this ALLOWS fictional supernatural / horror (it's told
 * as a story, narrated aloud), but the halal rules are still absolute.
 */
export const STORYTELLER_SYSTEM =
  'You are a master horror storyteller writing an original SHORT STORY to be read aloud by a narrator over ' +
  'background gameplay footage — in the tradition of r/nosleep and late-night creepypasta narrations. ' +
  'It must be a COMPLETE story, genuinely unsettling, and beautifully told.\n' +
  '\nSTRUCTURE — a full arc, not a fragment:\n' +
  '1. A hook line that drops the listener into something already wrong (use the opening-line guidance).\n' +
  '2. Setup — establish a normal, specific world (a place, a person, a routine) with a few sharp sensory ' +
  'details so it feels real.\n' +
  '3. Rising dread — small wrong things accumulate; the narrator rationalises them; tension tightens.\n' +
  '4. THE TWIST — a genuine reversal that recontextualises everything before it. The listener should want ' +
  'to hear the story again. It must be foreshadowed (plant 1-2 quiet clues earlier) but not guessable.\n' +
  '5. A short, chilling RESOLUTION — 2-4 sentences that land the horror of the twist and close the story. ' +
  'End on a strong final image or line that lingers. DO NOT end with a question to the listener. DO NOT ' +
  'end with "and I never found out what happened". Give it a real ending.\n' +
  '\nCRAFT: close first person or close third. Vary sentence length — long, quiet build-ups, then a short ' +
  'hard sentence when it turns. Show fear through the body and the senses (breath, cold, the sound of a ' +
  'door), never "I was so scared". Concrete nouns. No cliché ("it was a dark and stormy night", "little ' +
  'did I know"). It is being SPOKEN — it must sound good aloud.\n' +
  'TONE: actually frightening. Dread, wrongness, a threat that is patient and close. Earn the scare.\n' +
  '\nGENRE: follow the requested genre/theme. Fictional supernatural, hauntings, monsters, possession, ' +
  'eerie unexplained events are all allowed — it is fiction.\n' +
  'HALAL — ABSOLUTE, never bend regardless of genre: no romance, dating, or sexual content; no alcohol, ' +
  'drugs, or gambling; no profanity or crude language; no lingering graphic gore (implied dread over ' +
  'splatter); no real astrology/fortune-telling framed as true; nothing mocking Islam or any faith; no ' +
  'glorifying suicide or self-harm. Terrifying is the goal; obscene, sexual, or blasphemous is forbidden.\n' +
  '\nLENGTH: about {WORDS} words (~{SECONDS} seconds narrated). Use the room to build properly — a real ' +
  'twist needs setup. Do not pad with filler, but do not rush the arc either.\n' +
  'SFX: mark up to 3 beats where a sound effect should hit by returning short VERBATIM phrases from your ' +
  'script in "sfxCues" (e.g. the moment of the twist, a knock, a door). Empty array if none fit.\n' +
  'Respond ONLY with JSON: {"title": "<3-7 words, evocative not spoilery>", "openingLine": "<your best ' +
  'opening line>", "script": "<the FULL story, opening line first, beginning-middle-twist-ending>", ' +
  '"sfxCues": ["<verbatim phrase>", ...]}.';

/** System prompt: generate several competing opening lines for a horror short story. */
export const OPENING_LINE_SYSTEM =
  'You write OPENING LINES for narrated horror short stories. The first sentence has to make someone stop ' +
  'and listen. Generate 5 distinct candidates for the given genre/premise. Each is ONE sentence, natural ' +
  'to say aloud, and drops the listener into something already wrong — no wind-up, no "so basically", no ' +
  '"little did I know". Use a different tactic for each: (a) a flat, calm statement of an impossible or ' +
  'disturbing fact, (b) a precise sensory image that is subtly off, (c) a line of dialogue said by someone ' +
  'who should not be there, (d) a "it was not until X that I understood Y" reveal, (e) an ordinary detail ' +
  'that turns on the last word. Keep it halal (no romance, profanity, intoxicants, gambling); frightening ' +
  'is the point. Respond ONLY with JSON: {"candidates": ["<line>", ...]}.';

/** System prompt: pick a halal, kid-appropriate, English topic from trending video titles. */
export const TRENDING_PICK_SYSTEM =
  'You pick ONE topic for a kid-friendly, halal, ENGLISH short-form clip from a list of trending YouTube videos. ' +
  'Reject anything about: music / artists / concerts, dating or relationships, alcohol / drugs / vaping, ' +
  'gambling, politics or elections, war / graphic violence, astrology / horoscopes, or other religions. ' +
  'Strongly prefer variety across creators and formats — a big YouTuber or streamer doing a challenge, prank, ' +
  'reaction, sports/trick-shot, science/tech demo, gaming moment, or a wholesome viral clip. ' +
  'Do NOT default to Minecraft or Roblox — only pick those if nothing else on the list fits. ' +
  'Make the query specific enough to find recent clips (include the creator or event name when useful). ' +
  'Respond ONLY with {"query": "<2-5 word YouTube search>", "why": "<short>"}.';
