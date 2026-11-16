/**
 * The daily autonomous poster. Renders ALL 5 rotation games, in a random
 * order picked fresh each run — ONE AT A TIME, fully publishing and posting
 * each one before starting the next, rather than rendering all 5 first and
 * posting at the end. For each game, in order:
 *
 *   0. picks the order so today's first post is never the same format as
 *      the last one posted (read from post-log/daily.json)
 *   1. renders it. Three of the five (colorwar/followball/eyetest) go
 *      through the SAME dashboard pipeline (runPipeline) so their caption/
 *      hashtags/render settings never drift out of sync with the app.
 *      ringofdoom/hotpotato are different: they're the Python colorwars
 *      engine (a separate project living at colorwars/, not the JS game
 *      renderer), invoked via its own CLI (mine -> render --best ->
 *      commit) — see renderColorwarsEvent() below for why and how.
 *   1b. packages it (scripts/packaging): a fresh opening hook, background,
 *      border and zoom (the game's own sound, no added music), plus a caption, hashtags, cover and pinned
 *      comment written from what actually happened in that video and
 *      checked against the last 10 posts. The kit is logged to
 *      post-log/daily.json, which the workflow commits back.
 *   2. commits its mp4 into a small PUBLIC hand-off repo and serves it via
 *      GitHub Pages (Buffer needs a public, direct, no-auth video URL with a
 *      real video/* content-type — see developers.buffer.com/guides/
 *      hosting-media.html — see the OutputRepo doc comment below for why
 *      that ruled out both GitHub Release assets AND jsDelivr)
 *   3. adds it to Buffer's queue (`addToQueue`) immediately — Buffer's OWN
 *      configured posting schedule (set in its dashboard, not here) is what
 *      actually spreads posts across the day at specific times. This script
 *      doesn't pick post times, just the queue order, once a day.
 *
 * Interleaving like this (rather than render-all-then-post-all) means
 * whatever's already posted by the time a later game fails, or the run gets
 * cut off, is safely sitting in Buffer's queue already — not lost waiting on
 * a final batch step that never ran. One game failing at any step doesn't
 * block the rest; the run only fails outright if every single one does.
 *
 * Meant to run once a day — GitHub's own `schedule:` trigger turned out to
 * be unreliable for this repo (see git history / .github/workflows/
 * daily-post.yml), so this is actually fired by an external cron service
 * calling the workflow_dispatch REST endpoint on a timer. Run it by hand
 * with:
 *   npx tsx scripts/post/daily.ts
 *
 * Required env vars (see .env.example):
 *   BUFFER_API_KEY, BUFFER_CHANNEL_ID, OUTPUT_REPO, OUTPUT_REPO_TOKEN
 */
import { randomInt } from 'node:crypto';
import { mkdtemp, rm, readdir, unlink, mkdir, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Broadcaster } from '../../worker/src/pipeline/context.ts';
import { packageVideo } from '../packaging/package.mjs';
import { CI_LOG, lastPostedFormat, markPosted, readLog } from '../packaging/postlog.mjs';
import { COLORWARS_EVENT, ROTATION, commitColorwarsEpisode, isRotation, renderColorwarsEvent, renderJsGame, type Rotation } from './rotation.ts';

const pexec = promisify(execFile);

// the HTTP API streams these to the dashboard's progress bar; here they're the
// only visibility a CI log has into a multi-minute render, so just print them —
// a silent multi-minute step is indistinguishable from a hung one otherwise.
let lastLoggedPct = -1;
const logProgress: Broadcaster = (_jobId, _eventId, event) => {
  if (event.type === 'step:status') {
    console.log(`[${event.step}] ${event.status}${event.detail ? ` — ${event.detail}` : ''}${event.error ? ` — ${event.error}` : ''}`);
    lastLoggedPct = -1;
  } else if (event.type === 'step:progress') {
    const pct = Math.round(event.pct * 100);
    // 2%, not 10% — at 10% a 1560-frame render needed ~156 frames before the
    // FIRST line appeared, making "no output yet" indistinguishable between
    // "0 frames captured" and "150 frames captured, just under the threshold".
    if (pct >= lastLoggedPct + 2) {
      console.log(`[${event.step}] ${pct}%${event.detail ? ` — ${event.detail}` : ''}`);
      lastLoggedPct = pct;
    }
  } else if (event.type === 'job:error') {
    console.error(`[${event.step}] ERROR — ${event.message}`);
  } else if (event.type === 'log') {
    console.log(`[${event.step}] ${event.line}`);
  }
};

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

// DRY_RUN=1: render + package exactly like a real run, but publish nothing,
// post nothing and log to a throwaway file (the kits land in post-kits/,
// which the workflow uploads as an artifact so they can be inspected)
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const POST_LOG_PATH = DRY_RUN ? join(tmpdir(), 'dry-run-post-log.json') : CI_LOG;
const BUFFER_API_KEY = need('BUFFER_API_KEY');
const BUFFER_CHANNEL_ID = need('BUFFER_CHANNEL_ID');
const OUTPUT_REPO = need('OUTPUT_REPO'); // e.g. "Sayedu/clipper-output"
const OUTPUT_REPO_TOKEN = need('OUTPUT_REPO_TOKEN'); // a PAT with repo scope on THAT repo

function shuffled<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface RenderedPost {
  kind: Rotation;
  /** The job / episode folder the post packaging reads. */
  sourceDir: string;
  videoPath: string;
  /** Run only after a successful Buffer post. Ring of Doom uses this to
   *  commit the episode to league/season.json — see renderRingOfDoom(). */
  onPosted?: () => Promise<void>;
}

async function renderOne(kind: Rotation): Promise<RenderedPost> {
  if (kind === 'ringofdoom' || kind === 'hotpotato') {
    const eventId = COLORWARS_EVENT[kind];
    console.log(`\n=== rendering ${kind} (mining seeds for a great one) ===`);
    const meta = await renderColorwarsEvent(eventId);
    console.log(`[${kind}] seed ${meta.seed} — winner ${meta.winner}, MVP ${meta.mvp}, ${meta.duration_sec.toFixed(1)}s (episode ${meta.episode_id})`);
    return {
      kind,
      sourceDir: meta.out_dir,
      videoPath: join(meta.out_dir, 'final.mp4'),
      // Commit AFTER a successful Buffer post, not before or unconditionally —
      // a render that never actually goes out (e.g. the Buffer step below
      // fails) shouldn't advance the season. Matches the engine's own "never
      // commit automatically" rule (see colorwars/CLAUDE.md): this IS the
      // human-equivalent approval step, the same way posting is for the other
      // games, which have no review step either.
      onPosted: async () => {
        await commitColorwarsEpisode(eventId, meta.episode_id);
        console.log(`[${kind}] committed ${meta.episode_id} to league/season.json`);
      },
    };
  }
  console.log(`\n=== rendering ${kind} ===`);
  const r = await renderJsGame(kind, logProgress);
  return { kind, sourceDir: r.jobDir, videoPath: r.videoPath };
}

/** Post packaging (scripts/packaging): a fresh hook, background, border,
 *  zoom (game sound only, no added music), caption, hashtags, cover and
 *  pinned comment, checked
 *  against the last 10 posts. Tried twice; if it still fails the game is
 *  skipped for today rather than posted unpackaged. */
async function packageOne(r: RenderedPost): Promise<{ videoPath: string; text: string; kitId: string }> {
  // every post goes out packaged (fresh hook, look, sound, caption) — a
  // packaging failure skips the game rather than posting a plain repeat
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) try {
    const kit = await packageVideo(r.sourceDir, { writeLog: POST_LOG_PATH, readLogs: [CI_LOG, POST_LOG_PATH], preset: 'veryfast', salt: attempt > 1 ? `retry${attempt}` : undefined });
    const text = (await readFile(join(kit.kitDir, 'caption.txt'), 'utf-8')).trim();
    console.log(`[${r.kind}] packaged: ${kit.hook.lines.join(' ')} · ${kit.look.bg}/${kit.look.border} · sound ${kit.sound.track}`);
    console.log(`[${r.kind}] caption: ${kit.caption.replace(/\n/g, ' / ')}`);
    console.log(`[${r.kind}] hashtags: ${kit.hashtags.join(', ')}`);
    console.log(`[${r.kind}] PIN THIS COMMENT: ${kit.pinned}`);
    return { videoPath: join(kit.kitDir, 'video.mp4'), text, kitId: kit.id };
  } catch (err) {
    lastErr = err as Error;
    console.error(`[${r.kind}] post packaging attempt ${attempt} failed: ${lastErr.message}`);
  }
  throw new Error(`post packaging failed, not posting an unpackaged video: ${lastErr?.message}`);
}

async function main() {
  // FORCE_PICK lets a manual workflow_dispatch test one specific game instead of
  // the full 5-game rotation — useful for isolating a slow/broken game.
  const forced = process.env.FORCE_PICK;
  let order: Rotation[];
  if (forced) {
    if (!isRotation(forced)) throw new Error(`FORCE_PICK must be one of ${ROTATION.join(', ')}, got "${forced}"`);
    order = [forced];
  } else {
    order = shuffled(ROTATION);
    // never the same format twice in a row: today's first post can't be the
    // format yesterday's run posted last (the post log is committed back)
    const last = lastPostedFormat(readLog([CI_LOG]).filter((e) => e.posted));
    if (order.length > 1 && order[0] === last) [order[0], order[1]] = [order[1]!, order[0]!];
  }
  console.log(`today's order: ${order.join(', ')}`);

  if (DRY_RUN) console.log('DRY RUN: rendering and packaging only, nothing gets published or posted');
  const outputRepo = DRY_RUN ? null : await OutputRepo.open();
  try {
    // render → package → push → post, ONE game at a time — not
    // render-all-then-post-all. A game failing at any step doesn't stop the
    // rest, and whatever's already posted by the time a later game fails (or
    // the run times out) is safely queued on Buffer already, not stuck
    // waiting on a final batch step that never runs.
    let posted = 0, rendered = 0;
    for (const kind of order) {
      try {
        const r = await renderOne(kind);
        rendered++;
        const p = await packageOne(r);
        if (!outputRepo) {
          console.log(`[${kind}] DRY RUN kit: ${p.videoPath}`);
          console.log(`[${kind}] DRY RUN post text:\n${p.text}`);
          posted++;
          continue;
        }
        const videoUrl = await outputRepo.publish(r.kind, p.videoPath);
        console.log(`[${kind}] video public at: ${videoUrl}`);
        const postId = await postToBuffer({ channelId: BUFFER_CHANNEL_ID, text: p.text, videoUrl });
        console.log(`[${kind}] queued on Buffer — post id ${postId}`);
        markPosted(p.kitId, { bufferPostId: postId }, CI_LOG);
        posted++;
        // Runs after the post already succeeded, so a failure here (e.g.
        // Ring of Doom's commit step) must NOT land in the catch below —
        // that would misreport an already-posted game as "failed, skipping".
        // It only means the season didn't advance; the post itself is fine.
        if (r.onPosted) {
          try {
            await r.onPosted();
          } catch (err) {
            console.error(`[${kind}] posted fine, but its onPosted step failed: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        console.error(`[${kind}] failed, skipping: ${(err as Error).message}`);
      }
    }
    if (rendered === 0) throw new Error('every game failed to render — nothing to post');
    if (posted === 0) throw new Error('every render succeeded but every publish/post failed');
    console.log(`\n${posted}/${order.length} posted today`);
  } finally {
    await outputRepo?.close();
  }
}

/** Commits each of today's mp4s into the public hand-off repo as its OWN
 *  push (one per game, as soon as that game is ready — not batched to the
 *  end) and serves them via GitHub Pages — NOT GitHub Release assets, and
 *  NOT jsDelivr (tried both first, in that order):
 *   - Release assets force `Content-Disposition: attachment` and
 *     `Content-Type: application/octet-stream` (confirmed with curl — built
 *     for software downloads, not embeddable media), which is exactly why
 *     Buffer rejected it with "Video could not be read from its URL": that
 *     combination tells any fetcher "save this file," not "this is a video."
 *   - jsDelivr serves the right content-type, but its GitHub CDN hard-caps
 *     at 20MB/file (confirmed via jsDelivr's own error response) — too
 *     small for a real 4K Color War or a long Laser Nations Duel without
 *     compressing them enough to visibly hurt quality.
 *  Pages serves the same correct `video/mp4` content-type (confirmed with
 *  curl) with NO 20MB-class limit — the real ceiling is git's own
 *  ~100MB/file. The one real cost: Pages has actual deploy lag after a
 *  push (unlike jsDelivr's instant availability), so `publish()` polls for
 *  OUR commit's deploy to finish rather than guessing a fixed wait — see
 *  `waitForPagesDeploy` (clipper-output deploys via its own Actions
 *  workflow, not GitHub's legacy branch-build pipeline, which was too slow
 *  and inconsistent to poll against reliably).
 *
 *  Each video goes to a NEW path (`v/<timestamp>-<kind>.mp4`) rather than a
 *  reused one, so a stale cached response is never a concern either way.
 *  Stale (48h+) videos are pruned once, on `open()` — see the comment there
 *  for why "wipe everything" broke a real queued Buffer post. */
class OutputRepo {
  private constructor(
    private readonly dir: string,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  static async open(): Promise<OutputRepo> {
    const [owner, repo] = OUTPUT_REPO.split('/');
    const dir = await mkdtemp(join(tmpdir(), 'clipper-output-'));
    await pexec('git', ['clone', '--depth', '1', `https://x-access-token:${OUTPUT_REPO_TOKEN}@github.com/${owner}/${repo}.git`, dir]);

    // Only prune videos older than 48h (parsed from each file's own
    // `<timestamp>-<kind>.mp4` name) -- NOT everything. Wiping everything
    // unconditionally broke a real queued Buffer post in production: Buffer
    // schedules posts for LATER in the day rather than fetching instantly,
    // and a second same-day run (a manual re-test, but a genuine retry after
    // a partial failure would do the same) deleted an earlier run's
    // still-unfetched video out from under a pending Buffer post, which then
    // failed with "media URL not accessible" once its scheduled time came
    // up. 48h gives ~2x margin past the ~24h single-day posting window.
    const videosDir = join(dir, 'v');
    const prior = await readdir(videosDir).catch(() => [] as string[]);
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    for (const f of prior) {
      const ts = Number(f.split('-')[0]);
      if (!Number.isFinite(ts) || ts < cutoff) await unlink(join(videosDir, f)).catch(() => {});
    }
    await mkdir(videosDir, { recursive: true });

    return new OutputRepo(dir, owner!, repo!);
  }

  private git(...args: string[]) {
    return pexec('git', ['-C', this.dir, ...args]);
  }

  async publish(kind: Rotation, videoPath: string): Promise<string> {
    const name = `${Date.now()}-${kind}.mp4`;
    await copyFile(videoPath, join(this.dir, 'v', name));
    await this.git('add', '-A');
    await this.git('-c', 'user.email=bot@clipper.local', '-c', 'user.name=clipper-bot', 'commit', '-m', `post: ${kind}`);
    await this.git('push');
    const sha = (await this.git('rev-parse', 'HEAD')).stdout.trim();
    await this.waitForPagesDeploy(sha);
    return `https://${this.owner.toLowerCase()}.github.io/${this.repo}/v/${name}`;
  }

  /** GitHub Pages (unlike jsDelivr) has real deploy lag after a push — the
   *  file isn't actually live the instant `git push` returns. clipper-output
   *  deploys Pages via its own `.github/workflows/pages.yml` (Actions-based
   *  deploy, `build_type: workflow`) rather than the legacy branch-build
   *  pipeline — the legacy one queued on a shared GitHub build worker with
   *  wildly inconsistent timing (seen anywhere from ~23s to 4+ minutes with
   *  zero progress signal in between), which blew past this function's
   *  original 3-minute budget outright in testing. An Actions deploy is a
   *  normal job, so this polls that workflow's run for OUR commit instead. */
  private async waitForPagesDeploy(sha: string): Promise<void> {
    const start = Date.now();
    let retried = false;
    while (Date.now() - start < 180_000) {
      const runs = (await fetch(
        `https://api.github.com/repos/${this.owner}/${this.repo}/actions/runs?event=push&head_sha=${sha}`,
        { headers: { Authorization: `Bearer ${OUTPUT_REPO_TOKEN}`, Accept: 'application/vnd.github+json' } },
      ).then((r) => r.json())) as { workflow_runs: Array<{ id: number; status: string; conclusion: string | null; html_url: string }> };
      const match = runs.workflow_runs[0];
      if (match?.status === 'completed') {
        if (match.conclusion === 'success') return;
        if (!retried) {
          // Observed once in production: upload-pages-artifact finalizes the
          // artifact, then deploy-pages queries for it under a second later
          // and gets "Found 0 artifact(s)" -- a GitHub-side indexing race,
          // not a config problem (GitHub's own error text for it literally
          // says "re-run the deployment at a later time"). Do that once
          // automatically rather than losing a post to a one-off platform hiccup.
          retried = true;
          await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/actions/runs/${match.id}/rerun`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${OUTPUT_REPO_TOKEN}`, Accept: 'application/vnd.github+json' },
          });
          await new Promise((r) => setTimeout(r, 5_000));
          continue;
        }
        throw new Error(`Pages deploy failed for ${sha} (retried once): ${match.html_url}`);
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    throw new Error(`Pages deploy for ${sha} didn't finish within 3 minutes`);
  }

  async close(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

/** Hands the public video URL to Buffer, which does the actual TikTok publish —
 *  see developers.buffer.com/examples/create-video-post.html. */
async function postToBuffer(opts: { channelId: string; text: string; videoUrl: string }): Promise<string> {
  const query = `
    mutation CreatePost($channelId: ChannelId!, $text: String!, $videoUrl: String!) {
      createPost(input: {
        text: $text
        channelId: $channelId
        schedulingType: automatic
        mode: addToQueue
        assets: [{ video: { url: $videoUrl } }]
      }) {
        ... on PostActionSuccess { post { id } }
        ... on MutationError { message }
      }
    }`;
  const res = (await fetch('https://api.buffer.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BUFFER_API_KEY}` },
    body: JSON.stringify({ query, variables: opts }),
  }).then((r) => r.json())) as { data?: { createPost?: { message?: string; post?: { id: string } } }; errors?: unknown };

  const result = res.data?.createPost;
  if (result?.message) throw new Error(`Buffer rejected the post: ${result.message}`);
  if (!result?.post?.id) throw new Error(`unexpected Buffer response: ${JSON.stringify(res)}`);
  return result.post.id;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
