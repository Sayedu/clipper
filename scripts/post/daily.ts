/**
 * The daily autonomous poster. Picks one of the rotation games at random,
 * renders it through the SAME pipeline the dashboard uses (so the caption,
 * hashtags and render settings never drift out of sync with the app), then:
 *
 *   1. publishes the finished mp4 as a Release asset on a small PUBLIC
 *      hand-off repo (Buffer needs a public, direct, no-auth video URL —
 *      see developers.buffer.com/guides/hosting-media.html)
 *   2. asks Buffer's API to post it to TikTok on the connected channel
 *
 * Meant to run once a day from a GitHub Actions schedule — see
 * .github/workflows/daily-post.yml. Run it by hand with:
 *   npx tsx scripts/post/daily.ts
 *
 * Required env vars (see .env.example):
 *   BUFFER_API_KEY, BUFFER_CHANNEL_ID, OUTPUT_REPO, OUTPUT_REPO_TOKEN
 */
import { randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createJob, getJob } from '../../worker/src/db.ts';
import { runPipeline } from '../../worker/src/pipeline/run.ts';
import type { Broadcaster } from '../../worker/src/pipeline/context.ts';
import { jobCandidateFile } from '../../worker/src/library.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../worker/src/types.ts';

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

// the daily rotation — add to this list to add a 4th game later (e.g. 'quotes')
const ROTATION = ['colorwar', 'lasernationsDuel', 'followball'] as const;
type Rotation = (typeof ROTATION)[number];

function settingsFor(kind: Rotation): Settings {
  const base: Settings = { ...DEFAULT_SETTINGS, clipsPerRun: 1 };
  if (kind === 'colorwar') return { ...base, contentType: 'colorwar', colorWarMode: 'classic' };
  if (kind === 'followball') return { ...base, contentType: 'followball', followBallMode: 'sprint' };
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

async function main() {
  // FORCE_PICK lets a manual workflow_dispatch test one specific game instead of
  // whatever the random pick lands on — useful for isolating a slow/broken game.
  const forced = process.env.FORCE_PICK;
  let pick: Rotation;
  if (forced) {
    if (!isRotation(forced)) throw new Error(`FORCE_PICK must be one of ${ROTATION.join(', ')}, got "${forced}"`);
    pick = forced;
  } else {
    pick = ROTATION[randomInt(0, ROTATION.length)]!;
  }
  console.log(`today's pick: ${pick}`);

  const job = createJob({ settings: settingsFor(pick) });
  await runPipeline({ jobId: job.id, signal: new AbortController().signal, broadcast: logProgress });

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

  const videoUrl = await publishToOutputRepo(videoPath, `Daily post — ${pick}`, caption ?? '');
  console.log(`video public at: ${videoUrl}`);

  const postId = await postToBuffer({
    channelId: BUFFER_CHANNEL_ID,
    text: [caption, tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join('\n\n'),
    videoUrl,
  });
  console.log(`queued on Buffer — post id ${postId}`);
}

/** Uploads the mp4 as a GitHub Release asset on the public hand-off repo, after
 *  deleting any prior release there so the repo never accumulates old videos. */
async function publishToOutputRepo(videoPath: string, title: string, body: string): Promise<string> {
  const [owner, repo] = OUTPUT_REPO.split('/');
  const gh = (path: string, init?: RequestInit) =>
    fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${OUTPUT_REPO_TOKEN}`,
        Accept: 'application/vnd.github+json',
        ...init?.headers,
      },
    });

  const prior = (await gh('/releases').then((r) => r.json())) as Array<{ id: number; tag_name: string }>;
  for (const rel of prior) {
    await gh(`/releases/${rel.id}`, { method: 'DELETE' }).catch(() => {});
    await gh(`/git/refs/tags/${rel.tag_name}`, { method: 'DELETE' }).catch(() => {});
  }

  const tag = `post-${Date.now()}`;
  const release = (await gh('/releases', {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, name: title, body, prerelease: false }),
  }).then((r) => r.json())) as { upload_url?: string; message?: string };
  if (!release.upload_url) throw new Error(`release create failed: ${JSON.stringify(release)}`);

  const uploadUrl = release.upload_url.replace('{?name,label}', `?name=${encodeURIComponent(basename(videoPath))}`);
  const bytes = await readFile(videoPath);
  const asset = (await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OUTPUT_REPO_TOKEN}`,
      'Content-Type': 'video/mp4',
      'Content-Length': String(bytes.length),
    },
    body: bytes,
  }).then((r) => r.json())) as { browser_download_url?: string; message?: string };
  if (!asset.browser_download_url) throw new Error(`asset upload failed: ${JSON.stringify(asset)}`);

  return asset.browser_download_url;
}

/** Hands the public video URL to Buffer, which does the actual TikTok publish —
 *  see developers.buffer.com/examples/create-video-post.html. */
async function postToBuffer(opts: { channelId: string; text: string; videoUrl: string }): Promise<string> {
  const query = `
    mutation CreatePost($channelId: String!, $text: String!, $videoUrl: String!) {
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
