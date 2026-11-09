import { env } from './env.ts';
import { getOAuthToken, putOAuthToken } from './db.ts';
import type { SourceVideo } from './types.ts';

const HELIX = 'https://api.twitch.tv/helix';
const OAUTH = 'https://id.twitch.tv/oauth2/token';

export class TwitchError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'TwitchError';
  }
}

function assertCreds(): { id: string; secret: string } {
  const { clientId, clientSecret } = env.twitch;
  if (!clientId || !clientSecret) {
    throw new TwitchError(
      'Twitch is not configured.',
      'Register an app at dev.twitch.tv/console, then set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env.',
    );
  }
  return { id: clientId, secret: clientSecret };
}

/** App access token via client-credentials. Cached in the DB (~60-day lifetime), refreshed on expiry / 401. */
async function appToken(force = false): Promise<string> {
  const { id, secret } = assertCreds();
  if (!force) {
    const cached = getOAuthToken('twitch');
    if (cached && new Date(cached.expiresAt).getTime() - Date.now() > 24 * 3600_000) {
      return cached.accessToken;
    }
  }
  const res = await fetch(OAUTH, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; message?: string };
  if (!res.ok || !body.access_token) {
    throw new TwitchError(
      `Twitch token request failed: ${body.message ?? `HTTP ${res.status}`}`,
      'Check TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are correct.',
    );
  }
  const expiresAt = new Date(Date.now() + Math.max(0, (body.expires_in ?? 3600) - 60) * 1000).toISOString();
  putOAuthToken('twitch', body.access_token, expiresAt);
  return body.access_token;
}

async function helix<T>(path: string, params: Record<string, string | string[]>, retry = true): Promise<T> {
  const { id } = assertCreds();
  const url = new URL(`${HELIX}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
  }
  const token = await appToken();
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'Client-Id': id, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new TwitchError(`Twitch API request failed: ${(err as Error).message}`);
  }
  if (res.status === 401 && retry) {
    await appToken(true); // force-refresh and try once more
    return helix<T>(path, params, false);
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) {
    throw new TwitchError(`Twitch API error: ${body.message ?? body.error ?? `HTTP ${res.status}`}`);
  }
  return body;
}

// --- users ---------------------------------------------------------

interface HelixUser {
  id: string;
  login: string;
  display_name: string;
}

interface HelixChannelSearch {
  id: string;
  broadcaster_login: string;
  display_name: string;
}

/** "Kai Cenat" → "kaicenat" — a best-guess Twitch login (lowercase, underscores kept). */
const toLogin = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_]/g, '');
/** Aggressive fold for comparing display names. */
const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Resolve a channel name / handle / URL → broadcaster id. Tries an exact login
 * lookup first (Twitch logins are lowercase, no spaces — "Kai Cenat" → "kaicenat"),
 * then falls back to a fuzzy channel search on the display name.
 */
export async function resolveBroadcaster(
  nameOrHandle: string,
): Promise<{ id: string; login: string; displayName: string } | null> {
  const cleaned = nameOrHandle
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.|m\.)?twitch\.tv\//i, '')
    .split(/[/?]/)[0]!
    .trim();
  if (!cleaned) return null;

  // 1. exact login
  const login = toLogin(cleaned);
  if (login) {
    const r = await helix<{ data: HelixUser[] }>('users', { login });
    const u = r.data[0];
    if (u) return { id: u.id, login: u.login, displayName: u.display_name };
  }

  // 2. fuzzy channel search on the display name
  const s = await helix<{ data: HelixChannelSearch[] }>('search/channels', { query: cleaned, first: '20' });
  const target = normName(cleaned);
  const hit =
    s.data.find((c) => c.broadcaster_login === login) ??
    s.data.find((c) => normName(c.display_name) === target) ??
    s.data.find((c) => normName(c.broadcaster_login) === target) ??
    s.data.find((c) => normName(c.display_name).startsWith(target)) ??
    s.data[0];
  return hit ? { id: hit.id, login: hit.broadcaster_login, displayName: hit.display_name } : null;
}

// --- games / categories ------------------------------------------

interface HelixGame {
  id: string;
  name: string;
}

export async function topGameIds(count = 12): Promise<HelixGame[]> {
  const r = await helix<{ data: HelixGame[] }>('games/top', { first: String(Math.min(count, 100)) });
  return r.data;
}

/** Resolve a set of Twitch category ids → names. Batches of 100. */
export async function resolveCategories(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    try {
      const r = await helix<{ data: HelixGame[] }>('games', { id: batch });
      for (const g of r.data) out.set(g.id, g.name);
    } catch {
      /* leave unresolved */
    }
  }
  return out;
}

/**
 * Twitch "categories" that are people talking / IRL rather than gameplay.
 * Matched by lower-cased name (ids drift; names are stable enough).
 */
const TALKING_CATEGORIES = new Set([
  'just chatting',
  'talk shows & podcasts',
  'travel & outdoors',
  'irl',
  'special events',
  'asmr',
  'sports',
  'music',
  'art',
  'food & drink',
  "makers & crafting",
  'fitness & health',
  'politics',
  'science & technology',
  'pools, hot tubs, and beaches',
  'watch parties',
]);

export function isTalkingCategory(name: string | undefined): boolean {
  return !!name && TALKING_CATEGORIES.has(name.toLowerCase());
}

// --- clips -------------------------------------------------------

interface HelixClip {
  id: string;
  url: string;
  title: string;
  broadcaster_id: string;
  broadcaster_name: string;
  creator_name: string;
  game_id: string;
  view_count: number;
  created_at: string;
  thumbnail_url: string;
  duration: number;
  language: string;
}

function clipToSource(c: HelixClip, categories: Map<string, string>): SourceVideo {
  return {
    videoId: c.id,
    title: c.title || `${c.broadcaster_name} clip`,
    channel: c.broadcaster_name,
    url: c.url,
    publishedAt: c.created_at,
    durationSec: c.duration,
    viewCount: c.view_count,
    likeCount: 0,
    thumbnailUrl: c.thumbnail_url || undefined,
    lang: (c.language || '').toLowerCase() || undefined,
    provider: 'twitch',
    creatorHandle: c.broadcaster_name,
    creatorUrl: `https://twitch.tv/${c.broadcaster_name}`,
    category: categories.get(c.game_id) || undefined,
  };
}

export interface ClipQuery {
  broadcasterId?: string;
  gameId?: string;
  /** RFC3339. Helix requires both started_at and ended_at together, or neither. */
  startedAt?: Date;
  endedAt?: Date;
  /** Total clips to pull across pages (Helix pages 100 at a time, max ~1000). */
  max?: number;
}

/** Get Clips for one broadcaster or game. Helix has no sort param — caller sorts. */
export async function getClips(q: ClipQuery): Promise<SourceVideo[]> {
  if (!q.broadcasterId && !q.gameId) throw new TwitchError('getClips needs a broadcasterId or gameId.');
  const want = Math.min(q.max ?? 100, 1000);
  const out: HelixClip[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, string> = { first: '100' };
    if (q.broadcasterId) params.broadcaster_id = q.broadcasterId;
    if (q.gameId) params.game_id = q.gameId;
    if (q.startedAt && q.endedAt) {
      params.started_at = q.startedAt.toISOString();
      params.ended_at = q.endedAt.toISOString();
    }
    if (cursor) params.after = cursor;
    const r = await helix<{ data: HelixClip[]; pagination?: { cursor?: string } }>('clips', params);
    out.push(...r.data);
    cursor = r.pagination?.cursor;
    // Helix returns clips roughly view-sorted already, but pull a couple of pages
    // so a client-side sort has the real top to work with.
  } while (cursor && out.length < want * 2 && out.length < 500);

  out.sort((a, b) => b.view_count - a.view_count);
  const top = out.slice(0, want);
  const categories = await resolveCategories(top.map((c) => c.game_id));
  return top.map((c) => clipToSource(c, categories));
}
