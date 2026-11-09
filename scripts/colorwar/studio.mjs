// Color War preview studio.
//
//   node scripts/colorwar/studio.mjs
//
// Opens a browser to the live preview. Reroll seeds until you like one, then
// "RENDER THIS" (POST /render -> shells out to render.mjs --mux) or tap S to
// star a seed into render-queue.txt. Everything is preview-only chrome; the
// video never sees it.
import { spawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startServer } from './serve.mjs';

const REPO = resolve(new URL('../..', import.meta.url).pathname);
const QUEUE = join(REPO, 'render-queue.txt');
const RENDER = join(REPO, 'scripts/colorwar/render.mjs');
const MODES = new Set(['sprint', 'classic', 'bigtiles', 'finegrain', 'stripes', 'random']);

const jobs = new Map();           // id -> { seed, mode, state, file, log }
let nextId = 1;

const readJson = (req) => new Promise((res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch { res({}); } });
});
const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const parseSeed = (v) => (parseInt(String(v ?? '').match(/\d+/)?.[0] ?? '', 10) >>> 0) || 0;
const parseMode = (v) => (MODES.has(String(v).toLowerCase()) ? String(v).toLowerCase() : 'sprint');

async function onRequest(req, res, url) {
  if (url.pathname === '/render-status') {
    const job = jobs.get(Number(url.searchParams.get('id')));
    if (!job) { sendJson(res, 404, { error: 'unknown job' }); return true; }
    sendJson(res, 200, { state: job.state, file: job.file, progress: job.progress || null });
    return true;
  }

  if (req.method !== 'POST') return false;

  if (url.pathname === '/star') {
    const b = await readJson(req);
    const seed = parseSeed(b.seed), mode = parseMode(b.mode);
    if (!seed) { sendJson(res, 400, { error: 'no seed' }); return true; }
    await appendFile(QUEUE, `${seed} ${mode}\n`);
    console.log(`★ starred  ${seed} ${mode}  → render-queue.txt`);
    sendJson(res, 200, { ok: true, queued: `${seed} ${mode}` });
    return true;
  }

  if (url.pathname === '/render') {
    const b = await readJson(req);
    const seed = parseSeed(b.seed), mode = parseMode(b.mode);
    if (!seed) { sendJson(res, 400, { error: 'no seed' }); return true; }
    const id = nextId++;
    const file = `colorwar-${mode}-${seed}.mp4`;
    const job = { id, seed, mode, state: 'running', file, log: [] };
    jobs.set(id, job);
    console.log(`\n▶ RENDER  ${mode} ${seed}  → render/colorwar/out/${file}`);
    const child = spawn(process.execPath, [RENDER, '--seed', String(seed), '--mode', mode, '--mux'], { cwd: REPO });
    const onData = (buf) => {
      for (const line of buf.toString().split('\n')) {
        if (!line.trim()) continue;
        job.log.push(line);
        const m = line.match(/@progress (\{.*\})/);
        if (m) { try { job.progress = JSON.parse(m[1]); } catch {} }
        else process.stdout.write('  ' + line + '\n');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      job.state = code === 0 ? 'done' : 'failed';
      console.log(code === 0 ? `✅ ${file}` : `❌ render ${seed} exited ${code}`);
    });
    sendJson(res, 200, { ok: true, id, file });
    return true;
  }

  return false;
}

const { port } = await startServer(Number(process.argv[2]) || 5190, onRequest);
await mkdir(join(REPO, 'render/colorwar/out'), { recursive: true });
const previewUrl = `http://127.0.0.1:${port}/render/colorwar/index.html`;
console.log(`\n  Color War preview studio\n  ${previewUrl}\n  starred seeds → ${QUEUE}\n  render them all later:  node scripts/colorwar/render.mjs --queue render-queue.txt\n`);

// open the browser (best-effort)
const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
spawn(opener, [previewUrl], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).on('error', () => {});
