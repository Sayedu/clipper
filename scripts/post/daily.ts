/**
 * The daily autonomous poster. Renders ALL 4 rotation games, in a random
 * order picked fresh each run, through the SAME pipeline the dashboard uses
 * (so the caption, hashtags and render settings never drift out of sync with
 * the app) — ONE AT A TIME, fully publishing and posting each one before
 * starting the next, rather than rendering all 4 first and posting at the
 * end. For each game, in order:
 *
 *   1. renders it
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
import { mkdtemp, rm, readdir, unlink, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createJob, getJob } from '../../worker/src/db.ts';
import { runPipeline } from '../../worker/src/pipeline/run.ts';
import type { Broadcaster } from '../../worker/src/pipeline/context.ts';
import { jobCandidateFile } from '../../worker/src/library.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../worker/src/types.ts';

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

const BUFFER_API_KEY = need('BUFFER_API_KEY');
const BUFFER_CHANNEL_ID = need('BUFFER_CHANNEL_ID');
const OUTPUT_REPO = need('OUTPUT_REPO'); // e.g. "Sayedu/clipper-output"
const OUTPUT_REPO_TOKEN = need('OUTPUT_REPO_TOKEN'); // a PAT with repo scope on THAT repo

// the daily rotation — add to this list to add a 5th game later (e.g. 'quotes')
const ROTATION = ['colorwar', 'lasernationsDuel', 'followball', 'eyetest'] as const;
type Rotation = (typeof ROTATION)[number];

function settingsFor(kind: Rotation): Settings {
  const base: Settings = { ...DEFAULT_SETTINGS, clipsPerRun: 1 };
  if (kind === 'colorwar') {
    // 'random' picks one of the four ~41-44s wild-duel boards (never SPRINT's
    // short cold-open) — see render/colorwar/game.js's pickMode(). Shape is a
    // cosmetic design tweak, randomized here too so the same board layout
    // doesn't look identical to a prior day's render. Flip-sound stays
    // pinned to 'bubble' — the user's chosen sound, not randomized.
    return {
      ...base,
      contentType: 'colorwar',
      colorWarMode: 'random',
      colorWarShape: randomInt(0, 2) === 0 ? 'circle' : 'square',
      colorWarFlipSound: 'bubble',
    };
  }
  if (kind === 'followball') return { ...base, contentType: 'followball', followBallMode: 'random' };
  if (kind === 'eyetest') {
    return { ...base, contentType: 'eyetest', eyeTestBallsPerRound: [5, 6, 8], eyeTestShuffleSec: 6 };
  }
  // random nations, random winner — same as the un-forced duel preview, no scripted outcome
  return {
    ...base,
    contentType: 'lasernations',
    laserNationsMode: 'duel',
    laserNationsDuelA: '',
    laserNationsDuelB: '',
    laserNationsDuelWinner: 'random',
  };
}

function isRotation(v: string): v is Rotation {
  return (ROTATION as readonly string[]).includes(v);
}

function shuffled<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function renderOne(kind: Rotation) {
  console.log(`\n=== rendering ${kind} ===`);
  const job = createJob({ settings: settingsFor(kind) });
  return runPipeline({ jobId: job.id, signal: new AbortController().signal, broadcast: logProgress }).then(() => {
    const finished = getJob(job.id);
    if (!finished || finished.status !== 'awaiting_review' || !finished.draftText) {
      throw new Error(`render did not finish cleanly — status: ${finished?.status}, error: ${finished?.errorMessage ?? 'none'}`);
    }
    const videoPath = jobCandidateFile(job.id, 0, 'video');
    const { caption, hashtags = [] } = finished.draftText;
    // TikTok allows at most 5 hashtags — the source caption templates already stay
    // under that, but this is the actual enforcement point before anything posts.
    const tags = hashtags.slice(0, 5);
    console.log(`rendered ${videoPath}`);
    console.log(`caption: ${caption}`);
    console.log(`hashtags: ${tags.join(', ')}`);
    return { kind, videoPath, text: [caption, tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join('\n\n') };
  });
}

async function main() {
  // FORCE_PICK lets a manual workflow_dispatch test one specific game instead of
  // the full 4-game rotation — useful for isolating a slow/broken game.
  const forced = process.env.FORCE_PICK;
  let order: Rotation[];
  if (forced) {
    if (!isRotation(forced)) throw new Error(`FORCE_PICK must be one of ${ROTATION.join(', ')}, got "${forced}"`);
    order = [forced];
  } else {
    order = shuffled(ROTATION);
  }
  console.log(`today's order: ${order.join(', ')}`);

  const outputRepo = await OutputRepo.open();
  try {
    // render → push → post, ONE game at a time — not render-all-then-post-all.
    // A game failing at any step doesn't stop the rest, and whatever's
    // already posted by the time a later game fails (or the run times out)
    // is safely queued on Buffer already, not stuck waiting on a final batch
    // step that never runs.
    let posted = 0, rendered = 0;
    for (const kind of order) {
      try {
        const r = await renderOne(kind);
        rendered++;
        const videoUrl = await outputRepo.publish(r.kind, r.videoPath);
        console.log(`[${kind}] video public at: ${videoUrl}`);
        const postId = await postToBuffer({ channelId: BUFFER_CHANNEL_ID, text: r.text, videoUrl });
        console.log(`[${kind}] queued on Buffer — post id ${postId}`);
        posted++;
      } catch (err) {
        console.error(`[${kind}] failed, skipping: ${(err as Error).message}`);
      }
    }
    if (rendered === 0) throw new Error('every game failed to render — nothing to post');
    if (posted === 0) throw new Error('every render succeeded but every publish/post failed');
    console.log(`\n${posted}/${order.length} posted today`);
  } finally {
    await outputRepo.close();
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
