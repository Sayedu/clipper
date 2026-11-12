import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  getCachedChannel,
  getEventsSince,
  getJob,
  getJobSteps,
  getSettings,
  listClips,
  listJobs,
  putCachedChannel,
  saveSettings,
} from './db.ts';
import { paths, clipDir, jobWorkDir } from './paths.ts';
import { env } from './env.ts';
import { runDoctor } from './doctor.ts';
import { resolveChannel } from './youtube.ts';
import { bus } from './bus.ts';
import { queue } from './queue.ts';
import { differentVideo, discardJob, deleteLibraryClip, jobCandidateFile, newTake, saveJobToLibrary } from './library.ts';
import { getSchedule, moveSlot, reflowSchedule, setPosted } from './schedule.ts';
import {
  cancelSeason,
  confirmSeason,
  createSeason,
  getSeasonWithLiveStatus,
  listSeasons,
  rerollSeasonPlan,
  MAX_SEASON_EPISODES,
  MIN_SEASON_EPISODES,
} from './colorwarSeason.ts';
import { searchSeasonSeeds } from '../../scripts/colorwar/search.mjs';
import { Router, readJson, sendJson, serveFile, type Ctx } from './http.ts';
import { DEFAULT_SETTINGS, type Settings } from './types.ts';

const settingsSchema = z
  .object({
    contentType: z.enum(['colorrace', 'escaperace', 'lasernations', 'colorwar', 'followball', 'eyetest', 'pausegame', 'quotes']),
    sourceMode: z.enum(['creators', 'search', 'trending']),
    sourcePlatform: z.enum(['youtube', 'twitch', 'both']),
    creators: z.array(z.string().min(1)).max(40),
    keywords: z.array(z.string().min(1)).max(12),
    clipFormat: z.enum(['single', 'top5', 'auto', 'question', 'story']),
    clipContentStyle: z.enum(['any', 'talking', 'gaming']),
    clipLengthSec: z.number().int().min(10).max(180),
    clipsPerRun: z.number().int().min(1).max(5),
    candidatesPerVideo: z.number().int().min(1).max(5),
    maxSourceMinutes: z.number().int().min(5).max(240),
    minViewCount: z.number().int().min(0),
    publishedWithinDays: z.number().int().min(1).max(3650 * 2).nullable(),
    transcriptSource: z.enum(['auto', 'youtube', 'whisper']),
    preciseCaptions: z.boolean(),
    reframeMode: z.enum(['auto', 'always-crop', 'always-letterbox']),
    tone: z.string().max(120),
    blockedKeywords: z.array(z.string()).max(60),
    captionStyle: z.enum(['clean', 'bold', 'karaoke-pop']),
    captionsEnabled: z.boolean(),
    sfxEnabled: z.boolean(),
    sfxPack: z.string().min(1),
    sfxAtStart: z.boolean(),
    whisperModel: z.string().min(1),
    creditCreator: z.boolean(),
    dailyPostCap: z.number().int().min(1).max(8),
    minPostSpacingHours: z.number().int().min(1).max(24),
    storyGenre: z.string().max(120),
    storyLengthSec: z.number().int().min(45).max(240),
    ttsVoice: z.string().min(1).max(40),
    backgroundFootageQueries: z.array(z.string().min(1)).max(20),
    storyMusic: z.boolean(),
    colorRaceBalls: z.number().int().min(3).max(6),
    colorRaceTargetSec: z.number().int().min(12).max(60),
    colorRaceMap: z.enum(['random', 'zigzag', 'pegstorm', 'spinner', 'fork', 'bumper']),
    colorRaceShape: z.enum(['circle', 'square']),
    marbleRaceMarbles: z.number().int().min(3).max(6),
    marbleRaceTargetSec: z.number().int().min(12).max(60),
    escapeRaceBalls: z.number().int().min(3).max(6),
    escapeRaceRings: z.number().int().min(3).max(14),
    escapeRaceTargetSec: z.number().int().min(12).max(45),
    laserNationsMatchSec: z.number().int().min(35).max(65),
    laserNationsBlackHole: z.boolean(),
    laserNationsMode: z.enum(['territory', 'duel']),
    laserNationsDuelA: z.string().max(40),
    laserNationsDuelB: z.string().max(40),
    laserNationsDuelWinner: z.enum(['A', 'B', 'random']),
    laserNationsSeed: z.number().int().positive().optional(),
    colorWarMode: z.enum(['sprint', 'random', 'classic', 'bigtiles', 'finegrain', 'stripes']),
    colorWarShape: z.enum(['circle', 'square']),
    colorWarFlipSound: z.enum(['pluck', 'bubble']),
    colorWarSeed: z.number().int().positive().optional(),
    colorWarSeasonNumber: z.number().int().positive().optional(),
    colorWarEpisodeIndex: z.number().int().positive().optional(),
    colorWarTotalEpisodes: z.number().int().positive().optional(),
    colorWarScoresBefore: z.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().min(0), z.number().int().min(0)]).optional(),
    followBallMode: z.enum(['sprint', 'classic', 'insane', 'random']),
    followBallSeed: z.number().int().positive().optional(),
    eyeTestBallsPerRound: z.array(z.number().int().min(4).max(10)).min(1).max(6),
    eyeTestShuffleSec: z.number().min(3).max(15),
    eyeTestSeed: z.number().int().positive().optional(),
    pauseGameTargetDeg: z.number().int().min(5).max(30),
    pauseGameRotationMs: z.number().int().min(600).max(2500),
    pauseGameLaps: z.number().int().min(4).max(20),
    pauseGameSeed: z.number().int().positive().optional(),
    quotesSeed: z.number().int().positive().optional(),
  })
  .partial();

function listSfxPacks(): string[] {
  if (!existsSync(paths.sfx)) return [];
  return readdirSync(paths.sfx).filter((d) => {
    const p = resolve(paths.sfx, d);
    try {
      return statSync(p).isDirectory() && readdirSync(p).some((f) => /\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(f));
    } catch {
      return false;
    }
  });
}

export function buildRouter(): Router {
  const r = new Router();

  r.get('/health', ({ res }) => sendJson(res, 200, { ok: true, queue: queue.status() }));

  r.get('/doctor', async ({ res }) => sendJson(res, 200, await runDoctor()));

  r.get('/settings', ({ res }) =>
    sendJson(res, 200, {
      settings: getSettings(),
      sfxPacks: listSfxPacks(),
      defaults: DEFAULT_SETTINGS,
      twitchConfigured: Boolean(env.twitch.clientId && env.twitch.clientSecret),
    }),
  );

  r.put('/settings', async ({ req, res }) => {
    const patch = settingsSchema.parse(await readJson(req));
    sendJson(res, 200, { settings: saveSettings(patch as Partial<Settings>) });
  });

  r.get('/sfx-packs', ({ res }) => sendJson(res, 200, { packs: listSfxPacks() }));

  r.get('/tts-voices', async ({ res }) => {
    const { TTS_VOICES } = await import('./types.ts');
    const { kokoroReady } = await import('./tts.ts');
    sendJson(res, 200, { voices: TTS_VOICES, ready: kokoroReady() });
  });

  // Resolve creator handles → channel titles (cached). Used by Settings to show what sticks.
  r.get('/creators/check', async ({ res, url }) => {
    const names = (url.searchParams.get('names') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 40);
    const results = await Promise.all(
      names.map(async (name) => {
        const cached = getCachedChannel(name);
        if (cached) return { input: name, ok: true as const, title: cached.title };
        try {
          const r = await resolveChannel(name);
          if (r) {
            putCachedChannel(r);
            return { input: name, ok: true as const, title: r.title };
          }
        } catch {
          /* ignore */
        }
        return { input: name, ok: false as const };
      }),
    );
    sendJson(res, 200, { results });
  });

  // --- jobs --------------------------------------------------------
  r.get('/jobs', ({ res, url }) =>
    sendJson(res, 200, { jobs: listJobs(Number(url.searchParams.get('limit') ?? 40)) }),
  );

  r.post('/jobs', async ({ req, res }) => {
    const body = z
      .object({ keywords: z.array(z.string()).optional(), pinnedUrl: z.string().url().optional() })
      .parse(await readJson(req));

    const settings = body.keywords?.length ? saveSettings({ keywords: body.keywords }) : getSettings();

    if (body.pinnedUrl) {
      const { createJob } = await import('./db.ts');
      const job = createJob({ settings });
      queue.enqueue(job.id, { pinnedUrl: body.pinnedUrl });
      return sendJson(res, 201, { jobs: [job] });
    }

    // no creators AND no keywords → the run falls back to trending in search.ts, so we allow it.

    const { createJob } = await import('./db.ts');
    const count = Math.max(1, Math.min(settings.clipsPerRun, 5));
    const jobs = Array.from({ length: count }, (_, i) => {
      const job = createJob({ settings, candidateRank: i });
      queue.enqueue(job.id);
      return job;
    });
    sendJson(res, 201, { jobs });
  });

  // Color War preview studio — render one clip for an exact seed + board. Goes
  // through the full pipeline (Who-Will-Win text, safe-area layout, caption,
  // hashtags, 4K mux) exactly like a normal job, then the studio downloads it.
  r.post('/colorwar/render', async ({ req, res }) => {
    const body = z
      .object({
        seed: z.number().int().positive(),
        mode: z.enum(['sprint', 'random', 'classic', 'bigtiles', 'finegrain', 'stripes']).default('classic'),
      })
      .parse(await readJson(req));
    const { createJob } = await import('./db.ts');
    const settings: Settings = {
      ...getSettings(),
      contentType: 'colorwar',
      colorWarMode: body.mode,
      colorWarSeed: body.seed,
      clipsPerRun: 1,
    };
    const job = createJob({ settings });
    queue.enqueue(job.id);
    sendJson(res, 201, { jobId: job.id, seed: body.seed, mode: body.mode });
  });

  // Color War Season Mode's "Test 1 Episode" — same shape as /colorwar/render,
  // but the seed is chosen by the same close-game/comeback search a real
  // season episode uses (any winner — no season is planned or attached).
  r.post('/colorwar/episode-test', async ({ res }) => {
    const [found] = searchSeasonSeeds({
      targets: [{ episodeIndex: 1, requiredKind: 'any' }],
      mode: 'classic',
      planningSeed: Math.floor(Math.random() * 0x7fffffff) || 1,
      maxAttempts: 80,
    });
    const { createJob } = await import('./db.ts');
    const settings: Settings = {
      ...getSettings(),
      contentType: 'colorwar',
      colorWarMode: 'classic',
      colorWarSeed: found!.seed,
      colorWarSeasonNumber: 1,
      colorWarEpisodeIndex: 1,
      colorWarTotalEpisodes: 1,
      colorWarScoresBefore: [0, 0, 0, 0],
      clipsPerRun: 1,
    };
    const job = createJob({ settings });
    queue.enqueue(job.id);
    sendJson(res, 201, { jobId: job.id, seed: found!.seed, winner: found!.winner });
  });

  // Color War Season Mode — plan a whole season up front (win distribution +
  // story beats), let the user review/reroll it, then confirm to seed-search
  // and render every episode. See worker/src/colorwarSeason.ts.
  r.post('/colorwar/seasons', async ({ req, res }) => {
    const body = z
      .object({
        seasonNumber: z.number().int().positive(),
        totalEpisodes: z.number().int().min(MIN_SEASON_EPISODES).max(MAX_SEASON_EPISODES),
      })
      .parse(await readJson(req));
    sendJson(res, 201, { season: createSeason(body) });
  });

  r.get('/colorwar/seasons', ({ res }) => sendJson(res, 200, { seasons: listSeasons() }));

  r.get('/colorwar/seasons/:id', ({ res, params }) => {
    const season = getSeasonWithLiveStatus(params.id!);
    if (!season) return sendJson(res, 404, { error: 'season not found' });
    sendJson(res, 200, { season });
  });

  r.post('/colorwar/seasons/:id/reroll-plan', ({ res, params }) => sendJson(res, 200, { season: rerollSeasonPlan(params.id!) }));
  r.post('/colorwar/seasons/:id/confirm', ({ res, params }) => sendJson(res, 200, { season: confirmSeason(params.id!) }));
  r.post('/colorwar/seasons/:id/cancel', ({ res, params }) => sendJson(res, 200, { season: cancelSeason(params.id!) }));

  // Follow The Ball preview studio — same shape as /colorwar/render.
  r.post('/followball/render', async ({ req, res }) => {
    const body = z
      .object({
        seed: z.number().int().positive(),
        mode: z.enum(['sprint', 'classic', 'insane', 'random']).default('sprint'),
      })
      .parse(await readJson(req));
    const { createJob } = await import('./db.ts');
    const settings: Settings = {
      ...getSettings(),
      contentType: 'followball',
      followBallMode: body.mode,
      followBallSeed: body.seed,
      clipsPerRun: 1,
    };
    const job = createJob({ settings });
    queue.enqueue(job.id);
    sendJson(res, 201, { jobId: job.id, seed: body.seed, mode: body.mode });
  });

  // Eye Test preview studio — same shape as /colorwar/render / /followball/render,
  // plus the user-authored round plan (no more preset modes).
  r.post('/eyetest/render', async ({ req, res }) => {
    const body = z
      .object({
        seed: z.number().int().positive(),
        ballsPerRound: z.array(z.number().int().min(4).max(10)).min(1).max(6).default([8, 8, 8]),
        shuffleSec: z.number().min(3).max(15).default(6),
      })
      .parse(await readJson(req));
    const { createJob } = await import('./db.ts');
    const settings: Settings = {
      ...getSettings(),
      contentType: 'eyetest',
      eyeTestBallsPerRound: body.ballsPerRound,
      eyeTestShuffleSec: body.shuffleSec,
      eyeTestSeed: body.seed,
      clipsPerRun: 1,
    };
    const job = createJob({ settings });
    queue.enqueue(job.id);
    sendJson(res, 201, { jobId: job.id, seed: body.seed, ballsPerRound: body.ballsPerRound, shuffleSec: body.shuffleSec });
  });

  // Pause Game preview studio — same shape as /colorwar/render / /followball/render.
  r.post('/pausegame/render', async ({ req, res }) => {
    const body = z
      .object({
        seed: z.number().int().positive(),
        targetDeg: z.number().int().min(5).max(30).default(9),
        rotationMs: z.number().int().min(600).max(2500).default(1100),
        laps: z.number().int().min(4).max(20).default(10),
      })
      .parse(await readJson(req));
    const { createJob } = await import('./db.ts');
    const settings: Settings = {
      ...getSettings(),
      contentType: 'pausegame',
      pauseGameTargetDeg: body.targetDeg,
      pauseGameRotationMs: body.rotationMs,
      pauseGameLaps: body.laps,
      pauseGameSeed: body.seed,
      clipsPerRun: 1,
    };
    const job = createJob({ settings });
    queue.enqueue(job.id);
    sendJson(res, 201, { jobId: job.id, seed: body.seed, targetDeg: body.targetDeg, rotationMs: body.rotationMs, laps: body.laps });
  });

  // Reminders preview studio — same shape as /colorwar/render / /followball/render.
  // No mode to pick: the seed alone picks both the quote and the background drift.
  r.post('/quotes/render', async ({ req, res }) => {
    const body = z.object({ seed: z.number().int().positive() }).parse(await readJson(req));
    const { createJob } = await import('./db.ts');
    const settings: Settings = {
      ...getSettings(),
      contentType: 'quotes',
      quotesSeed: body.seed,
      clipsPerRun: 1,
    };
    const job = createJob({ settings });
    queue.enqueue(job.id);
    sendJson(res, 201, { jobId: job.id, seed: body.seed });
  });

  // Laser Nations DUEL preview studio. Unlike the other /render/ POSTs, this
  // one usually can't just replay the exact seed the <iframe> happened to
  // show: a forced winner always needs its own server-side search
  // (laserDuelSearch.ts) before a seed even exists to pin. The studio only
  // sends `seed` when winner === 'random', in which case the preview's own
  // unforced run IS what gets rendered. No length control — the fight has
  // no fixed duration, it always runs until a fighter hits 0 hp.
  r.post('/lasernations/duel/render', async ({ req, res }) => {
    const body = z
      .object({
        seed: z.number().int().positive().optional(),
        nationA: z.string().max(40).default(''),
        nationB: z.string().max(40).default(''),
        winner: z.enum(['A', 'B', 'random']).default('random'),
      })
      .parse(await readJson(req));
    const { createJob } = await import('./db.ts');
    const settings: Settings = {
      ...getSettings(),
      contentType: 'lasernations',
      laserNationsMode: 'duel',
      laserNationsDuelA: body.nationA,
      laserNationsDuelB: body.nationB,
      laserNationsDuelWinner: body.winner,
      laserNationsSeed: body.winner === 'random' ? body.seed : undefined,
      clipsPerRun: 1,
    };
    const job = createJob({ settings });
    queue.enqueue(job.id);
    sendJson(res, 201, { jobId: job.id });
  });

  // Serve the deterministic preview bundles for the studio <iframe>s. The game
  // files + fonts are the SAME ones the render pipeline uses (index.html loads
  // them by relative path, so it works both here and under the render server).
  const staticFile = (relPath: string, ctx: Ctx) => {
    const clean = relPath.replace(/\.\.+/g, '').replace(/^\/+/, '');
    const abs = resolve(paths.repoRoot, clean);
    if (!abs.startsWith(paths.repoRoot) ||
        !/^(render\/(colorwar|followball|eyetest|lasernations|pausegame|quotes)\/|assets\/fonts\/)/.test(clean)) {
      return sendJson(ctx.res, 403, { error: 'forbidden' });
    }
    if (!existsSync(abs)) return sendJson(ctx.res, 404, { error: 'not found' });
    const ext = abs.slice(abs.lastIndexOf('.'));
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.ttf': 'font/ttf', '.woff2': 'font/woff2' }[ext] ?? 'application/octet-stream';
    ctx.res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    createReadStream(abs).pipe(ctx.res);
  };
  r.get('/render/colorwar/:file', (ctx) => staticFile(`render/colorwar/${ctx.params.file}`, ctx));
  r.get('/render/followball/:file', (ctx) => staticFile(`render/followball/${ctx.params.file}`, ctx));
  r.get('/render/eyetest/:file', (ctx) => staticFile(`render/eyetest/${ctx.params.file}`, ctx));
  r.get('/render/pausegame/:file', (ctx) => staticFile(`render/pausegame/${ctx.params.file}`, ctx));
  r.get('/render/lasernations/:file', (ctx) => staticFile(`render/lasernations/${ctx.params.file}`, ctx));
  r.get('/render/quotes/:file', (ctx) => staticFile(`render/quotes/${ctx.params.file}`, ctx));
  r.get('/assets/fonts/:file', (ctx) => staticFile(`assets/fonts/${ctx.params.file}`, ctx));

  r.get('/jobs/:id', ({ res, params }) => {
    const job = getJob(params.id!);
    if (!job) return sendJson(res, 404, { error: 'job not found' });
    sendJson(res, 200, { job, steps: getJobSteps(job.id) });
  });

  r.get('/jobs/:id/events', (ctx) => streamJobEvents(ctx));

  r.post('/jobs/:id/cancel', ({ res, params }) => {
    const ok = queue.cancel(params.id!);
    sendJson(res, 200, { canceled: ok });
  });

  // Feed a human decision back into a paused job (Storyteller script approval, etc.)
  r.post('/jobs/:id/respond', async ({ req, res, params }) => {
    const { respondToInput } = await import('./pipeline/inputGate.ts');
    const body = z
      .object({
        requestId: z.string().min(1),
        decision: z.enum(['approve', 'edit', 'edit-script', 'regenerate', 'keep', 'skip']),
        hook: z.string().optional(),
        overlays: z.array(z.string()).optional(),
        openingLine: z.string().optional(),
        script: z.string().optional(),
      })
      .parse(await readJson(req));
    const ok = respondToInput(params.id!, body as Parameters<typeof respondToInput>[1]);
    sendJson(res, ok ? 200 : 409, { ok });
  });

  r.post('/jobs/:id/save', async ({ req, res, params }) => {
    const body = z.object({ candidateIndex: z.number().int().min(0).max(4).optional() }).parse(await readJson(req));
    const clip = await saveJobToLibrary(params.id!, body.candidateIndex);
    sendJson(res, 200, { clip });
  });

  r.post('/jobs/:id/choose', async ({ req, res, params }) => {
    const body = z.object({ candidateIndex: z.number().int().min(0).max(4) }).parse(await readJson(req));
    const { updateJob } = await import('./db.ts');
    updateJob(params.id!, { chosenIndex: body.candidateIndex });
    sendJson(res, 200, { ok: true });
  });

  r.post('/jobs/:id/discard', ({ res, params }) => {
    discardJob(params.id!);
    sendJson(res, 200, { ok: true });
  });

  r.post('/jobs/:id/new-take', async ({ req, res, params }) => {
    const patch = settingsSchema.parse(await readJson(req));
    const { job } = newTake(params.id!, patch as Partial<Settings>);
    if (!job) return sendJson(res, 500, { error: 'could not create job' });
    queue.enqueue(job.id);
    sendJson(res, 201, { job });
  });

  r.post('/jobs/:id/different-video', async ({ req, res, params }) => {
    const patch = settingsSchema.parse(await readJson(req));
    const { job } = differentVideo(params.id!, patch as Partial<Settings>);
    if (!job) return sendJson(res, 500, { error: 'could not create job' });
    queue.enqueue(job.id);
    sendJson(res, 201, { job });
  });

  r.get('/jobs/:id/preview/:index', (ctx) =>
    serveFile(ctx, jobCandidateFile(ctx.params.id!, Number(ctx.params.index ?? 0), 'video')),
  );
  r.get('/jobs/:id/thumb/:index', (ctx) =>
    serveFile(ctx, jobCandidateFile(ctx.params.id!, Number(ctx.params.index ?? 0), 'thumb')),
  );
  // download the finished clip to the user's computer (with a meaningful filename)
  r.get('/jobs/:id/download/:index', (ctx) => {
    const job = getJob(ctx.params.id!);
    const s = job?.settings;
    const name = job && s?.contentType === 'colorwar' && s.colorWarSeasonNumber && s.colorWarEpisodeIndex
      ? `ColorWars_S${s.colorWarSeasonNumber}_Ep${String(s.colorWarEpisodeIndex).padStart(2, '0')}.mp4`
      : job && s?.contentType === 'colorwar'
      ? `colorwar-${s.colorWarMode}${s.colorWarSeed ? '-' + s.colorWarSeed : ''}-${job.id}.mp4`
      : job && s?.contentType === 'followball'
      ? `followball-${s.followBallMode}${s.followBallSeed ? '-' + s.followBallSeed : ''}-${job.id}.mp4`
      : job && s?.contentType === 'eyetest'
      ? `eyetest-${(s.eyeTestBallsPerRound ?? [8, 8, 8]).length}r${s.eyeTestSeed ? '-' + s.eyeTestSeed : ''}-${job.id}.mp4`
      : job && s?.contentType === 'pausegame'
      ? `pausegame${s.pauseGameSeed ? '-' + s.pauseGameSeed : ''}-${job.id}.mp4`
      : job && s?.contentType === 'quotes'
      ? `reminders${s.quotesSeed ? '-' + s.quotesSeed : ''}-${job.id}.mp4`
      : job && s?.contentType === 'lasernations' && s.laserNationsMode === 'duel'
      ? `lasernations-duel-${(s.laserNationsDuelA || 'a').toLowerCase().replace(/\s+/g, '')}-vs-${(s.laserNationsDuelB || 'b').toLowerCase().replace(/\s+/g, '')}-${job.id}.mp4`
      : job && s?.contentType === 'lasernations'
      ? `lasernations-${s.laserNationsMatchSec}s-${job.id}.mp4`
      : `clip-${ctx.params.id}.mp4`;
    serveFile(ctx, jobCandidateFile(ctx.params.id!, Number(ctx.params.index ?? 0), 'video'), { download: name });
  });
  // flagged frames for the review pause
  r.get('/jobs/:id/screen/:name', (ctx) =>
    serveFile(ctx, resolve(jobWorkDir(ctx.params.id!), 'flagged-frames', ctx.params.name!.replace(/[^\w.-]/g, ''))),
  );

  // --- library ----------------------------------------------------
  r.get('/library', ({ res }) => sendJson(res, 200, { clips: listClips() }));

  r.get('/library/:id/video', ({ req, res, params, url }) => {
    const p = resolve(clipDir(params.id!), 'clip.mp4');
    serveFile({ req, res, params, url }, p);
  });

  r.get('/library/:id/thumb', ({ req, res, params, url }) => {
    serveFile({ req, res, params, url }, resolve(clipDir(params.id!), 'thumb.jpg'));
  });

  r.delete('/library/:id', ({ res, params }) => {
    deleteLibraryClip(params.id!);
    sendJson(res, 200, { ok: true });
  });

  // --- post schedule --------------------------------------------
  r.get('/schedule', ({ res }) => {
    const s = getSettings();
    sendJson(res, 200, {
      schedule: getSchedule(),
      dailyPostCap: s.dailyPostCap,
      minPostSpacingHours: s.minPostSpacingHours,
    });
  });

  r.post('/schedule/reflow', ({ res }) => sendJson(res, 200, { schedule: reflowSchedule() }));

  r.post('/library/:id/posted', async ({ req, res, params }) => {
    const body = z.object({ posted: z.boolean().default(true) }).parse(await readJson(req));
    setPosted(params.id!, body.posted);
    sendJson(res, 200, { ok: true });
  });

  r.put('/library/:id/schedule', async ({ req, res, params }) => {
    const body = z.object({ scheduledAt: z.string().min(1) }).parse(await readJson(req));
    moveSlot(params.id!, body.scheduledAt);
    sendJson(res, 200, { ok: true });
  });

  // --- Storyteller background-footage library (fills itself automatically) ---
  r.get('/footage', async ({ res }) => {
    const { footageStatus } = await import('./footage.ts');
    sendJson(res, 200, footageStatus());
  });

  return r;
}

// --- SSE ----------------------------------------------------------
function streamJobEvents({ req, res, params, url }: Ctx): void {
  const jobId = params.id!;
  if (!getJob(jobId)) {
    sendJson(res, 404, { error: 'job not found' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const lastId = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
  const send = (id: number, data: unknown) => {
    res.write(`id: ${id}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // replay anything the client missed
  let cursor = lastId;
  for (const { id, event } of getEventsSince(jobId, lastId)) {
    send(id, event);
    cursor = id;
  }

  // then stream live, skipping any the replay already covered
  const unsub = bus.subscribe(jobId, ({ id, event }) => {
    if (id <= cursor) return;
    cursor = id;
    send(id, event);
  });

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsub();
  });
}
