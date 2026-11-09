/**
 * The daily autonomous poster. Renders ALL 4 rotation games, in a random
 * order picked fresh each run, through the SAME pipeline the dashboard uses
 * (so the caption, hashtags and render settings never drift out of sync with
 * the app), then:
 *
 *   1. commits all 4 finished mp4s into a small PUBLIC hand-off repo in one
 *      push and serves them via jsDelivr's CDN (Buffer needs a public,
 *      direct, no-auth video URL with a real video/* content-type — see
 *      developers.buffer.com/guides/hosting-media.html — which is NOT what
 *      GitHub Release assets serve: those force Content-Disposition:
 *      attachment, built for software downloads, not embeddable media)
 *   2. adds each one to Buffer's queue (`addToQueue`), in that same random
 *      order — Buffer's OWN configured posting schedule (set in its
 *      dashboard, not here) is what actually spreads them across the day at
 *      specific times. This script doesn't pick post times, just the queue
 *      order, once a day.
 *
 * One game failing doesn't block the other 3 — each is tried independently
 * and the run only fails outright if every single one does.
 *
 * Meant to run once a day from a GitHub Actions schedule — see
 * .github/workflows/daily-post.yml. Run it by hand with:
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
  if (kind === 'colorwar') return { ...base, contentType: 'colorwar', colorWarMode: 'bigtiles' };
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

  // render every game first (each independent — one failing doesn't stop the rest)
  const rendered: Array<{ kind: Rotation; videoPath: string; text: string }> = [];
  for (const kind of order) {
    try {
      rendered.push(await renderOne(kind));
    } catch (err) {
      console.error(`[${kind}] render failed, skipping: ${(err as Error).message}`);
    }
  }
  if (rendered.length === 0) throw new Error('every game failed to render — nothing to post');

  // one clone, one push with all of today's videos, in the same random order
  const videoUrls = await publishToOutputRepo(rendered);

  // queue each on Buffer in that order — Buffer's own configured posting
  // schedule is what actually spreads them across the day
  let posted = 0;
  for (const r of rendered) {
    const videoUrl = videoUrls.get(r.kind)!;
    try {
      const postId = await postToBuffer({ channelId: BUFFER_CHANNEL_ID, text: r.text, videoUrl });
      console.log(`[${r.kind}] queued on Buffer — post id ${postId}`);
      posted++;
    } catch (err) {
      console.error(`[${r.kind}] Buffer post failed: ${(err as Error).message}`);
    }
  }
  if (posted === 0) throw new Error('every render succeeded but every Buffer post failed');
  console.log(`\n${posted}/${rendered.length} posted today`);
}

/** Commits all of today's mp4s into the public hand-off repo in ONE push and
 *  serves them via jsDelivr's CDN — NOT GitHub Release assets. GitHub serves
 *  every release asset with `Content-Disposition: attachment` and
 *  `Content-Type: application/octet-stream` (confirmed with curl — it's
 *  built for software downloads, not embeddable media), which is exactly
 *  why Buffer rejected it with "Video could not be read from its URL": that
 *  combination tells any fetcher "save this file," not "this is a video."
 *  jsDelivr serves a plain git-committed file with the correct
 *  `Content-Type: video/mp4` and no attachment disposition.
 *
 *  Each video goes to a NEW path (`v/<timestamp>-<kind>.mp4`) rather than a
 *  reused one — jsDelivr caches a given path at its edge for up to 12h
 *  (`s-maxage=43200`), so reusing a path risks Buffer fetching a stale video
 *  instead of today's. A fresh path is never cached, so the first request
 *  always goes straight to the origin. Yesterday's videos are deleted from
 *  the tree (not the repo's history — see `git log`) so it never accumulates. */
async function publishToOutputRepo(
  items: Array<{ kind: Rotation; videoPath: string }>,
): Promise<Map<Rotation, string>> {
  const [owner, repo] = OUTPUT_REPO.split('/');
  const dir = await mkdtemp(join(tmpdir(), 'clipper-output-'));
  try {
    const git = (...args: string[]) => pexec('git', ['-C', dir, ...args]);
    await pexec('git', ['clone', '--depth', '1', `https://x-access-token:${OUTPUT_REPO_TOKEN}@github.com/${owner}/${repo}.git`, dir]);

    const videosDir = join(dir, 'v');
    const prior = await readdir(videosDir).catch(() => [] as string[]);
    for (const f of prior) await unlink(join(videosDir, f)).catch(() => {});
    await mkdir(videosDir, { recursive: true });

    const urls = new Map<Rotation, string>();
    const ts = Date.now();
    for (const { kind, videoPath } of items) {
      const name = `${ts}-${kind}.mp4`;
      await copyFile(videoPath, join(videosDir, name));
      urls.set(kind, `https://cdn.jsdelivr.net/gh/${owner}/${repo}@main/v/${name}`);
    }

    await git('add', '-A');
    await git('-c', 'user.email=bot@clipper.local', '-c', 'user.name=clipper-bot', 'commit', '-m', `post: ${items.map((i) => i.kind).join(', ')}`);
    await git('push');

    return urls;
  } finally {
    await rm(dir, { recursive: true, force: true });
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
