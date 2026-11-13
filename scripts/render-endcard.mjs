/**
 * Regenerates assets/endcard/end_card.mp4 from the design mockup in
 * assets/endcard/source/Main.dc.html -- only needs re-running if that
 * source file changes. Records the page for ~2s via Playwright (its
 * animations loop on their own; this just captures one 2s window of
 * them), then re-encodes to a clean, fixed 1080x1920 30fps mp4 with a
 * silent AAC track (so it concatenates cleanly onto any other clip) and
 * explicit BT.709 color tags (see colorwars/colorwars/render/video.py for
 * why that tagging matters across platforms).
 *
 * Run with: node scripts/render-endcard.mjs
 * Requires: playwright-core (already a project dependency) with its
 * Chromium browser installed, and ffmpeg on PATH (or FFMPEG_PATH set).
 */
import { chromium } from 'playwright-core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SOURCE_HTML = join(REPO_ROOT, 'assets/endcard/source/Main.dc.html');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

async function main() {
  const recDir = await mkdtemp(join(tmpdir(), 'endcard-rec-'));
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1080, height: 1920 },
    recordVideo: { dir: recDir, size: { width: 1080, height: 1920 } },
  });
  const page = await context.newPage();
  await page.goto('file://' + SOURCE_HTML);
  await page.waitForTimeout(2050);
  await context.close();
  await browser.close();

  const { readdir } = await import('node:fs/promises');
  const [webmName] = await readdir(recDir);
  const webmPath = join(recDir, webmName);
  const outPath = join(REPO_ROOT, 'assets/endcard/end_card.mp4');

  await pexec(FFMPEG, [
    '-y', '-ss', '0.05', '-t', '2.0', '-i', webmPath,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-vf', 'fps=30,scale=1080:1920',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-x264opts', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-t', '2.0',
    outPath,
  ]);
  await rm(recDir, { recursive: true, force: true });

  // keep the colorwars Python pipeline's own copy in sync too -- each
  // pipeline stays self-contained rather than reaching across the repo
  // for a shared asset (same reasoning as each side having its own fonts).
  await cp(outPath, join(REPO_ROOT, 'colorwars/assets/endcard/end_card.mp4'));

  console.log(`wrote ${outPath} (and the colorwars/ copy)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
