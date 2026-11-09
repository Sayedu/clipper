import { env } from './env.ts';
import type { SourceVideo } from './types.ts';

const API = 'https://www.googleapis.com/youtube/v3';

export class YouTubeError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'YouTubeError';
  }
}

interface ApiError {
  error?: { code: number; message: string; errors?: Array<{ reason?: string }> };
}

function assertKey(): string {
  if (!env.ytApiKey) {
    throw new YouTubeError(
      'YT_API_KEY is not set.',
      'Add YT_API_KEY=... to .env — a YouTube Data API v3 key from Google Cloud Console.',
    );
  }
  return env.ytApiKey;
}

async function call<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', assertKey());

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new YouTubeError(`YouTube API request failed: ${(err as Error).message}`);
  }

  const body = (await res.json().catch(() => ({}))) as T & ApiError;

  if (!res.ok || body.error) {
    const reason = body.error?.errors?.[0]?.reason ?? '';
    const message = body.error?.message ?? `HTTP ${res.status}`;
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      throw new YouTubeError('YouTube API daily quota exceeded.', 'Quota resets at midnight Pacific. Try again later.');
    }
    if (reason === 'keyInvalid' || res.status === 400) {
      throw new YouTubeError(
        `YouTube API rejected the key: ${message}`,
        'Check YT_API_KEY and that "YouTube Data API v3" is enabled for the project.',
      );
    }
    throw new YouTubeError(`YouTube API error: ${message}`, reason || undefined);
  }
  return body;
}

/** ISO-8601 duration (PT#H#M#S) → seconds. */
export function parseISODuration(iso: string): number {
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return 0;
  const [, d, h, min, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}

// --- video hydration ---------------------------------------------------

interface VideoListResponse {
  items: Array<{
    id: string;
    snippet: {
      title: string;
      channelId: string;
      channelTitle: string;
      publishedAt: string;
      liveBroadcastContent: string;
      categoryId?: string;
      thumbnails?: Record<string, { url: string; width: number }>;
      defaultAudioLanguage?: string;
      defaultLanguage?: string;
    };
    statistics: { viewCount?: string; likeCount?: string };
    contentDetails: { duration: string };
  }>;
}

/** A few YouTube videoCategory ids worth naming for the content-style filter. */
const YT_CATEGORY: Record<string, string> = {
  '10': 'Music',
  '17': 'Sports',
  '20': 'Gaming',
  '22': 'People & Blogs',
  '23': 'Comedy',
  '24': 'Entertainment',
  '25': 'News & Politics',
  '26': 'Howto & Style',
  '27': 'Education',
  '28': 'Science & Technology',
};

/** Turn a set of video ids into full `SourceVideo`s. Batches of 50 (1 quota unit each). */
export async function hydrateVideos(ids: string[]): Promise<SourceVideo[]> {
  const out: SourceVideo[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    if (!batch.length) continue;
    const res = await call<VideoListResponse>('videos', {
      part: 'snippet,statistics,contentDetails',
      id: batch.join(','),
    });
    for (const v of res.items) {
      if (v.snippet.liveBroadcastContent !== 'none') continue; // skip live / upcoming
      const thumbs = v.snippet.thumbnails ?? {};
      const thumb = thumbs.maxres ?? thumbs.standard ?? thumbs.high ?? thumbs.medium ?? thumbs.default;
      out.push({
        videoId: v.id,
        title: v.snippet.title,
        channel: v.snippet.channelTitle,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        publishedAt: v.snippet.publishedAt,
        durationSec: parseISODuration(v.contentDetails.duration),
        viewCount: Number(v.statistics.viewCount ?? 0),
        likeCount: Number(v.statistics.likeCount ?? 0),
        thumbnailUrl: thumb?.url,
        lang: (v.snippet.defaultAudioLanguage ?? v.snippet.defaultLanguage ?? '').toLowerCase() || undefined,
        provider: 'youtube',
        creatorHandle: v.snippet.channelTitle,
        creatorUrl: v.snippet.channelId ? `https://www.youtube.com/channel/${v.snippet.channelId}` : undefined,
        category: v.snippet.categoryId ? YT_CATEGORY[v.snippet.categoryId] : undefined,
      });
    }
  }
  return out;
}

interface CommentThreadsResponse {
  items?: Array<{ snippet: { topLevelComment: { snippet: { textOriginal: string } } } }>;
}

/**
 * Top comments across a batch of videos — real, current audience language to ground the
 * text writer. 1 quota unit per video; comments-disabled videos are skipped silently.
 */
export async function fetchTopComments(videoIds: string[], perVideo = 8): Promise<string[]> {
  const all: string[] = [];
  for (const id of videoIds) {
    try {
      const res = await call<CommentThreadsResponse>('commentThreads', {
        part: 'snippet',
        videoId: id,
        order: 'relevance',
        maxResults: String(Math.min(perVideo, 20)),
        textFormat: 'plainText',
      });
      for (const it of res.items ?? []) {
        const text = it.snippet.topLevelComment.snippet.textOriginal.replace(/\s+/g, ' ').trim();
        if (text.length >= 3 && text.length <= 200) all.push(text);
      }
    } catch {
      // comments disabled / not found — fine
    }
  }
  return all;
}

// --- keyword search --------------------------------------------------

export interface SearchOptions {
  query: string;
  publishedAfter?: Date;
  publishedBefore?: Date;
  maxResults?: number;
}

interface SearchListResponse {
  items: Array<{ id: { videoId?: string; channelId?: string } }>;
  nextPageToken?: string;
}

/** Keyword search + hydrate. `search.list` (100 units/page) then `videos.list` (1 unit). */
export async function searchVideos(opts: SearchOptions): Promise<SourceVideo[]> {
  const want = Math.min(opts.maxResults ?? 50, 200);
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const params: Record<string, string> = {
      part: 'snippet',
      q: opts.query,
      type: 'video',
      order: 'viewCount',
      maxResults: '50',
      videoEmbeddable: 'true',
      safeSearch: 'none',
      relevanceLanguage: 'en',
      regionCode: 'US', // bias results to English-speaking uploads
      ...(pageToken ? { pageToken } : {}),
    };
    if (opts.publishedAfter) params.publishedAfter = opts.publishedAfter.toISOString();
    if (opts.publishedBefore) params.publishedBefore = opts.publishedBefore.toISOString();

    const res = await call<SearchListResponse>('search', params);
    for (const it of res.items) if (it.id.videoId) ids.push(it.id.videoId);
    pageToken = res.nextPageToken;
  } while (pageToken && ids.length < want);

  return ids.length ? hydrateVideos(ids.slice(0, want)) : [];
}

interface TrendingResponse {
  items?: Array<{ id: string }>;
}

/** YouTube's own "most popular" chart for a region (optionally one videoCategoryId). 1 unit. */
export async function fetchTrending(regionCode = 'US', max = 50, categoryId?: string): Promise<SourceVideo[]> {
  const res = await call<TrendingResponse>('videos', {
    part: 'id',
    chart: 'mostPopular',
    regionCode,
    maxResults: String(Math.min(max, 50)),
    ...(categoryId ? { videoCategoryId: categoryId } : {}),
  });
  const ids = (res.items ?? []).map((i) => i.id).filter(Boolean);
  return ids.length ? hydrateVideos(ids) : [];
}

// --- channels / creators -------------------------------------------

export interface ResolvedChannel {
  handle: string;
  channelId: string;
  title: string;
  uploadsPlaylistId: string;
}

interface ChannelListResponse {
  items?: Array<{
    id: string;
    snippet: { title: string };
    contentDetails: { relatedPlaylists: { uploads: string } };
  }>;
}
interface ChannelSearchResponse {
  items?: Array<{ id: { channelId?: string }; snippet: { title: string } }>;
}

/**
 * Resolve a channel handle / name to its id + uploads playlist.
 * Tries `channels.list?forHandle` (1 unit); falls back to a channel search (100 units).
 * Returns null if nothing matches — callers skip and log.
 */
export async function resolveChannel(handleOrName: string): Promise<ResolvedChannel | null> {
  const raw = handleOrName.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?youtube\.com\/@?/, '');
  if (!raw) return null;

  // 1. exact handle
  try {
    const byHandle = await call<ChannelListResponse>('channels', {
      part: 'snippet,contentDetails',
      forHandle: raw,
    });
    const c = byHandle.items?.[0];
    if (c) {
      return {
        handle: raw,
        channelId: c.id,
        title: c.snippet.title,
        uploadsPlaylistId: c.contentDetails.relatedPlaylists.uploads,
      };
    }
  } catch {
    /* fall through */
  }

  // 2. channel search by name
  const found = await call<ChannelSearchResponse>('search', {
    part: 'snippet',
    q: raw,
    type: 'channel',
    maxResults: '1',
  });
  const hit = found.items?.[0];
  const channelId = hit?.id.channelId;
  if (!channelId) return null;

  const detail = await call<ChannelListResponse>('channels', {
    part: 'snippet,contentDetails',
    id: channelId,
  });
  const c = detail.items?.[0];
  if (!c) return null;
  return {
    handle: raw,
    channelId: c.id,
    title: c.snippet.title,
    uploadsPlaylistId: c.contentDetails.relatedPlaylists.uploads,
  };
}

interface PlaylistItemsResponse {
  items?: Array<{ contentDetails: { videoId: string; videoPublishedAt?: string } }>;
  nextPageToken?: string;
}

/** Most recent uploads for a channel's uploads playlist. 1 unit per 50. */
export async function recentUploads(uploadsPlaylistId: string, max = 25): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  while (ids.length < max) {
    const res: PlaylistItemsResponse = await call<PlaylistItemsResponse>('playlistItems', {
      part: 'contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults: String(Math.min(50, max - ids.length)),
      ...(pageToken ? { pageToken } : {}),
    });
    for (const it of res.items ?? []) ids.push(it.contentDetails.videoId);
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return ids;
}
