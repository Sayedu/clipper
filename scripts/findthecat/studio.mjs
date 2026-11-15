// Find The Cat preview studio.
//
//   node scripts/findthecat/studio.mjs
//
// Opens a browser to the live preview. Reroll seeds / cups / difficulty /
// theme until you like a shuffle, then "RENDER THIS" (POST /render -> shells
// out to render.mjs --mux). Mirrors scripts/followball/studio.mjs exactly.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startServer } from '../followball/serve.mjs';

const REPO = resolve(new URL('../..', import.meta.url).pathname);
const RENDER = join(REPO, 'scripts/findthecat/render.mjs');
const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
const THEMES = new Set(['candy', 'neon', 'sunset']);

const jobs = new Map();   // id -> { seed, cups, difficulty, round, theme, state, file }
let nextId = 1;

const readJson = (req) => new Promise((res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch { res({}); } });
});
const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const parseSeed = (v) => (parseInt(String(v ?? '').match(/\d+/)?.[0] ?? '', 10) >>> 0) || 0;
const parseCups = (v) => Math.max(3, Math.min(5, parseInt(v, 10) || 5));
const parseDifficulty = (v) => (DIFFICULTIES.has(String(v).toLowerCase()) ? String(v).toLowerCase() : 'easy');
const parseRound = (v) => Math.max(1, Math.min(5, parseInt(v, 10) || 1));
const parseTheme = (v) => (THEMES.has(String(v).toLowerCase()) ? String(v).toLowerCase() : 'candy');

async function onRequest(req, res, url) {
  if (url.pathname === '/render-status') {
    const job = jobs.get(Number(url.searchParams.get('id')));
    if (!job) { sendJson(res, 404, { error: 'unknown job' }); return true; }
    sendJson(res, 200, { state: job.state, file: job.file, progress: job.progress || null });
    return true;
  }

  if (req.method !== 'POST') return false;

  if (url.pathname === '/render') {
    const b = await readJson(req);
    const seed = parseSeed(b.seed), cups = parseCups(b.cups), difficulty = parseDifficulty(b.difficulty);
    const round = parseRound(b.round), theme = parseTheme(b.theme);
    if (!seed) { sendJson(res, 400, { error: 'no seed' }); return true; }
    const id = nextId++;
    const file = `findthecat-${difficulty}-${seed}.mp4`;
    const job = { id, seed, cups, difficulty, round, theme, state: 'running', file, log: [] };
    jobs.set(id, job);
    console.log(`\n▶ RENDER  ${difficulty} ${cups}cups seed${seed}  → render/findthecat/out/${file}`);
    const child = spawn(process.execPath, [
      RENDER, '--seed', String(seed), '--cups', String(cups), '--difficulty', difficulty,
      '--round', String(round), '--theme', theme, '--mux',
    ], { cwd: REPO });
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

const { port } = await startServer(Number(process.argv[2]) || 5191, onRequest);
await mkdir(join(REPO, 'render/findthecat/out'), { recursive: true });
const previewUrl = `http://127.0.0.1:${port}/render/findthecat/index.html`;
console.log(`\n  Find The Cat preview studio\n  ${previewUrl}\n  render a starred combo later:  node scripts/findthecat/render.mjs --seed <n> --cups <3-5> --difficulty <easy|medium|hard> --theme <candy|neon|sunset> --mux\n`);

const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
spawn(opener, [previewUrl], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).on('error', () => {});
