import { z } from 'zod';
import { getCachedChannel, putCachedChannel } from '../../db.ts';
import { generateJSON } from '../../ollama.ts';
import { fetchTrending, hydrateVideos, recentUploads, resolveChannel, searchVideos } from '../../youtube.ts';
import { getClips, isTalkingCategory, resolveBroadcaster, topGameIds } from '../../twitch.ts';
import { TRENDING_PICK_SYSTEM } from '../../guidelines.ts';
import type { SourceVideo } from '../../types.ts';
import type { StepContext } from '../context.ts';

/** publishedWithinDays → the earliest upload date we'll consider (null = no floor). */
function publishedAfter(days: number | null): Date | null {
  return days == null ? null : new Date(Date.now() - days * 86_400_000);
}

/**
 * Step 1 — gather candidate clips from the enabled platform(s). YouTube supports
 * every source mode; Twitch's clip API can't do free-text, so it only ever runs
 * in creators or trending (top-games) mode — keyword runs fall back to trending
 * for the Twitch half.
 */
export async function search(ctx: StepContext): Promise<SourceVideo[]> {
  const platform = ctx.settings.sourcePlatform ?? 'youtube';
  const wantYouTube = platform === 'youtube' || platform === 'both';
  const wantTwitch = platform === 'twitch' || platform === 'both';

  const jobs: Array<Promise<SourceVideo[]>> = [];
  if (wantYouTube) jobs.push(searchYouTube(ctx));
  if (wantTwitch) {
    jobs.push(
      searchTwitch(ctx).catch((err) => {
        ctx.log('search', `Twitch search failed: ${(err as Error).message}`);
        if (!wantYouTube) throw err; // Twitch-only run — surface it
        return [] as SourceVideo[];
      }),
    );
  }

  const merged = (await Promise.all(jobs)).flat();
  const seen = new Set<string>();
  const unique = merged.filter((v) => {
    const key = `${v.provider ?? 'youtube'}:${v.videoId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!unique.length) throw new Error('No candidate clips from the selected source(s).');

  if (wantYouTube && wantTwitch) {
    const tw = unique.filter((v) => v.provider === 'twitch').length;
    ctx.log('search', `${unique.length} candidates — ${unique.length - tw} YouTube, ${tw} Twitch`);
  }
  return unique;
}

/** The YouTube half — a creator list, a keyword search, or what's trending. */
async function searchYouTube(ctx: StepContext): Promise<SourceVideo[]> {
  const s = ctx.settings;
  const hasCreators = s.creators.some((c) => c.trim());
  const hasKeywords = s.keywords.some((k) => k.trim());

  const videos =
    s.sourceMode === 'trending' || (!hasCreators && !hasKeywords)
      ? await searchTrending(ctx)
      : s.sourceMode === 'search' || (!hasCreators && hasKeywords)
        ? await searchKeywords(ctx)
        : await searchCreators(ctx);

  // "Just talking" → drop videos filed under Gaming (weak signal, so only a soft cut).
  if (s.clipContentStyle === 'talking') {
    const kept = videos.filter((v) => v.category !== 'Gaming');
    if (kept.length >= 3 && kept.length < videos.length) {
      ctx.log('search', `content style "talking": dropped ${videos.length - kept.length} gaming video(s)`);
      return kept;
    }
  }
  return videos;
}

// --- Twitch --------------------------------------------------------

/** The Twitch half. Creators mode → per-broadcaster clips; anything else → top-games clips. */
async function searchTwitch(ctx: StepContext): Promise<SourceVideo[]> {
  const s = ctx.settings;
  const hasCreators = s.creators.some((c) => c.trim());
  const raw =
    s.sourceMode === 'creators' && hasCreators
      ? await searchTwitchCreators(ctx)
      : s.sourceMode === 'creators'
        ? (() => {
            throw new Error('Twitch creators mode is on but no creators are listed.');
          })()
        : await searchTwitchTrending(ctx);

  return filterByContentStyle(ctx, raw);
}

/** Keep only talking-head (IRL / Just Chatting) or only gameplay clips, per the setting. */
function filterByContentStyle(ctx: StepContext, clips: SourceVideo[]): SourceVideo[] {
  const style = ctx.settings.clipContentStyle ?? 'any';
  if (style === 'any') return clips;

  const want = (v: SourceVideo) =>
    style === 'talking' ? isTalkingCategory(v.category) : !!v.category && !isTalkingCategory(v.category);
  const kept = clips.filter(want);
  // don't strand the run if the filter is too aggressive for this creator's clips
  if (kept.length >= 3) {
    ctx.log('search', `content style "${style}": kept ${kept.length}/${clips.length} clips`);
    return kept;
  }
  ctx.log('search', `content style "${style}": only ${kept.length}/${clips.length} matched — using all (loosen or widen the date range)`);
  return clips;
}

async function searchTwitchCreators(ctx: StepContext): Promise<SourceVideo[]> {
  const names = ctx.settings.creators.map((c) => c.trim()).filter(Boolean);
  // Twitch clips are dated by creation; a wide window still surfaces the best-ever.
  const days = Math.min(ctx.settings.publishedWithinDays ?? 365, 365 * 3);
  const startedAt = new Date(Date.now() - days * 86_400_000);
  const endedAt = new Date();

  const out: SourceVideo[] = [];
  const missed: string[] = [];
  for (const [i, name] of names.entries()) {
    ctx.throwIfCanceled();
    ctx.progress('search', (i / names.length) * 0.9, name);
    try {
      const b = await resolveBroadcaster(name);
      if (!b) {
        missed.push(name);
        ctx.log('search', `⚠ no Twitch channel for "${name}"`);
        continue;
      }
      const clips = await getClips({ broadcasterId: b.id, startedAt, endedAt, max: 80 });
      out.push(...clips);
      ctx.log('search', `${b.displayName}: ${clips.length} clips`);
    } catch (err) {
      missed.push(name);
      ctx.log('search', `Twitch "${name}": ${(err as Error).message}`);
    }
  }

  if (!out.length) {
    throw new Error(
      missed.length === names.length
        ? `Couldn't find any of these on Twitch: ${missed.join(', ')}. Use the streamer's Twitch username (twitch.tv/<name>), not their YouTube name.`
        : 'No Twitch clips found for the listed creators in this date range — try widening "Uploaded within".',
    );
  }
  ctx.setStep('search', 'running', {
    detail: `${out.length} Twitch clips from ${names.length - missed.length} creator(s)${missed.length ? ` · ${missed.length} missed` : ''}`,
  });
  ctx.progress('search', 1);
  return out;
}

const TWITCH_TRENDING_WINDOW_DAYS = 10;

async function searchTwitchTrending(ctx: StepContext): Promise<SourceVideo[]> {
  ctx.progress('search', 0.15, 'reading Twitch top games');
  const games = await topGameIds(10);
  if (!games.length) throw new Error('Twitch returned no top games.');

  const startedAt = new Date(Date.now() - TWITCH_TRENDING_WINDOW_DAYS * 86_400_000);
  const endedAt = new Date();
  const out: SourceVideo[] = [];
  for (const [i, g] of games.entries()) {
    ctx.throwIfCanceled();
    ctx.progress('search', 0.15 + (i / games.length) * 0.8, g.name);
    try {
      out.push(...(await getClips({ gameId: g.id, startedAt, endedAt, max: 40 })));
    } catch (err) {
      ctx.log('search', `Twitch game "${g.name}": ${(err as Error).message}`);
    }
  }
  if (!out.length) throw new Error('Twitch returned no trending clips — try again shortly.');
  ctx.setStep('search', 'running', { detail: `${out.length} clips across ${games.length} top games` });
  ctx.progress('search', 1);
  return out;
}

// --- creators mode -------------------------------------------------

async function searchCreators(ctx: StepContext): Promise<SourceVideo[]> {
  const creators = ctx.settings.creators.map((c) => c.trim()).filter(Boolean);
  if (!creators.length) throw new Error('Creators mode is on but no creators are listed.');

  const after = publishedAfter(ctx.settings.publishedWithinDays);
  // deep list per creator — a channel that mostly posts long streams needs a wide net,
  // and the candidate loop only walks as far down the ranking as it has to.
  const perCreator = creators.length === 1 ? 60 : creators.length <= 3 ? 35 : 20;
  const videoIds: string[] = [];
  const resolvedNames: string[] = [];
  const failed: string[] = [];

  for (const [i, name] of creators.entries()) {
    ctx.throwIfCanceled();
    ctx.progress('search', (i / creators.length) * 0.7, name);

    let channel = getCachedChannel(name);
    if (!channel) {
      try {
        const r = await resolveChannel(name);
        if (r) {
          putCachedChannel(r);
          channel = { ...r, resolvedAt: new Date().toISOString() };
        }
      } catch (err) {
        ctx.log('search', `resolve "${name}" failed: ${(err as Error).message}`);
      }
    }
    if (!channel) {
      failed.push(name);
      ctx.log('search', `⚠ could not find a channel for "${name}" — skipping`);
      continue;
    }

    const ids = await recentUploads(channel.uploadsPlaylistId, perCreator);
    videoIds.push(...ids);
    resolvedNames.push(channel.title);
    ctx.log('search', `${channel.title}: ${ids.length} uploads`);
  }

  if (!videoIds.length) {
    throw new Error(
      failed.length === creators.length
        ? `None of the creators resolved (${failed.join(', ')}). Check the handles in Settings.`
        : 'No uploads found for the listed creators.',
    );
  }

  ctx.progress('search', 0.8, 'fetching video stats');
  let videos = await hydrateVideos([...new Set(videoIds)]);
  if (after) videos = videos.filter((v) => new Date(v.publishedAt).getTime() >= after.getTime());

  // optional: narrow to a topic if keywords are also set
  const kw = ctx.settings.keywords.map((k) => k.toLowerCase().trim()).filter(Boolean);
  if (kw.length) {
    const matched = videos.filter((v) => kw.some((k) => v.title.toLowerCase().includes(k)));
    if (matched.length) {
      ctx.log('search', `topic filter kept ${matched.length}/${videos.length}`);
      videos = matched;
    } else {
      ctx.log('search', `no titles matched ${kw.join(', ')} — using all uploads`);
    }
  }

  if (!videos.length) throw new Error('Creators had uploads, but none in the chosen date range.');

  const detail = `${videos.length} videos from ${resolvedNames.length} creator(s)${failed.length ? ` · ${failed.length} unresolved` : ''}`;
  ctx.setStep('search', 'running', { detail });
  ctx.progress('search', 1, detail);
  return videos;
}

// --- keyword mode -------------------------------------------------

async function searchKeywords(ctx: StepContext, override?: string[], sinceDays?: number): Promise<SourceVideo[]> {
  const keywords = (override ?? ctx.settings.keywords).map((k) => k.trim()).filter(Boolean);
  if (!keywords.length) throw new Error('No search keywords set.');

  const after = (sinceDays != null ? new Date(Date.now() - sinceDays * 86_400_000) : publishedAfter(ctx.settings.publishedWithinDays)) ?? undefined;
  const byId = new Map<string, SourceVideo>();

  for (const [i, keyword] of keywords.entries()) {
    ctx.throwIfCanceled();
    ctx.progress('search', i / keywords.length, `"${keyword}"`);
    ctx.log('search', `searching "${keyword}"${after ? ` (after ${after.toISOString().slice(0, 10)})` : ' (any time)'}`);
    const results = await searchVideos({ query: keyword, publishedAfter: after, maxResults: 120 });
    for (const v of results) if (!byId.has(v.videoId)) byId.set(v.videoId, v);
    ctx.log('search', `  ${results.length} results, ${byId.size} unique so far`);
  }

  const all = [...byId.values()];
  if (!all.length) throw new Error('No videos found. Try broader keywords or a wider date range.');
  ctx.progress('search', 1, `${all.length} candidates`);
  ctx.setStep('search', 'running', { detail: `${all.length} candidates from ${keywords.length} keyword(s)` });
  return all;
}

// --- trending mode ----------------------------------------------

const TRENDING_WINDOW_DAYS = 21; // "this week's" trend, with slack for the run-up

async function searchTrending(ctx: StepContext): Promise<SourceVideo[]> {
  ctx.progress('search', 0.2, 'reading YouTube trending');
  // pull the US chart + a couple of category charts (10=Music dropped, 20=Gaming, 24=Entertainment, 17=Sports)
  const [main, gaming, sports] = await Promise.all([
    fetchTrending('US', 50),
    fetchTrending('US', 30, '20').catch(() => []),
    fetchTrending('US', 20, '17').catch(() => []),
  ]);
  const byId = new Map<string, SourceVideo>();
  for (const v of [...main, ...gaming, ...sports]) if (!byId.has(v.videoId)) byId.set(v.videoId, v);
  const trending = [...byId.values()].filter((v) => v.lang == null || v.lang.startsWith('en'));
  if (!trending.length) throw new Error('YouTube trending returned nothing usable — try again shortly.');

  // LLM picks a halal, kid-appropriate topic — vary it so it isn't Minecraft every time
  let query: string | null = null;
  try {
    ctx.progress('search', 0.45, 'picking a topic');
    const raw = await generateJSON<{ query: string; why: string }>({
      system: TRENDING_PICK_SYSTEM,
      prompt:
        'TRENDING THIS WEEK (English):\n' +
        trending.slice(0, 45).map((v, i) => `${i + 1}. ${v.title} — ${v.channel}`).join('\n') +
        `\n\nPick a topic. Avoid Minecraft unless nothing else fits.`,
      temperature: 0.7,
      signal: ctx.signal,
      timeoutMs: 45_000,
    });
    const parsed = z.object({ query: z.string().min(2).max(60), why: z.string() }).safeParse(raw);
    if (parsed.success) {
      query = parsed.data.query;
      ctx.log('search', `trending topic: "${query}" — ${parsed.data.why}`);
    }
  } catch (err) {
    ctx.log('search', `topic pick skipped (${(err as Error).message})`);
  }

  // Prefer clips actually about the picked topic; fall back to the raw chart if thin.
  let topicResults: SourceVideo[] = [];
  if (query) {
    for (const days of [TRENDING_WINDOW_DAYS, 90]) {
      try {
        topicResults = (await searchKeywords(ctx, [query], days)).filter((v) => v.lang == null || v.lang.startsWith('en'));
      } catch (err) {
        ctx.log('search', `topic search failed (${(err as Error).message})`);
      }
      if (topicResults.length >= 4) break;
    }
  }

  const merged = new Map<string, SourceVideo>();
  for (const v of topicResults) merged.set(v.videoId, v);
  // top up with the chart so score() always has enough to work with
  if (merged.size < 8) for (const v of trending) if (!merged.has(v.videoId)) merged.set(v.videoId, v);

  const all = [...merged.values()];
  ctx.log('search', `${topicResults.length} on-topic${all.length > topicResults.length ? ` + ${all.length - topicResults.length} from the chart` : ''}`);
  ctx.setStep('search', 'running', { detail: query ? `"${query}" + trending` : `${all.length} trending` });
  ctx.progress('search', 1);
  return all;
}
