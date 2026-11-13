#!/usr/bin/env node
/**
 * Dev launcher.
 *  - loads the repo-root .env
 *  - brings up Ollama if it isn't already running (and shuts it down on exit,
 *    but only if *we* started it)
 *  - runs the worker + the Next.js dashboard together with prefixed output
 *  Ctrl-C stops everything this script started.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    /* ignore malformed .env */
  }
}

const webPort = process.env.WEB_PORT || '3100';
const workerPort = process.env.WORKER_PORT || '8787';
const colorwarsApiPort = process.env.COLORWARS_API_PORT || '8799';
const ollamaUrl = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const C = { worker: '\x1b[34m', web: '\x1b[35m', cwapi: '\x1b[33m', ollama: '\x1b[36m', reset: '\x1b[0m', dim: '\x1b[90m' };

const tagFor = (name) => `${C[name] ?? ''}${name.padEnd(6)}${C.reset} ${C.dim}│${C.reset} `;
function pipeLines(stream, name) {
  const tag = tagFor(name);
  let buf = '';
  stream.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) process.stdout.write(tag + line + '\n');
  });
}

const children = [];
let ollamaChild = null;
let ollamaStartedByUs = false;

async function ollamaUp() {
  try {
    const res = await fetch(`${ollamaUrl}/api/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureOllama() {
  if ((process.env.LLM_PROVIDER || 'ollama').toLowerCase() !== 'ollama') {
    process.stdout.write(`${tagFor('ollama')}LLM_PROVIDER is not "ollama" — skipping local Ollama\n`);
    return;
  }
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/.test(ollamaUrl);
  if (!isLocal) return; // remote Ollama — not ours to manage

  if (await ollamaUp()) {
    process.stdout.write(`${tagFor('ollama')}already running — leaving it as is\n`);
    return;
  }

  process.stdout.write(`${tagFor('ollama')}starting…\n`);
  ollamaChild = spawn('ollama', ['serve'], {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ollamaChild.on('error', (err) => {
    process.stdout.write(`${tagFor('ollama')}could not start (${err.message}) — is it installed? \`brew install ollama\`\n`);
  });
  pipeLines(ollamaChild.stdout, 'ollama');
  pipeLines(ollamaChild.stderr, 'ollama');
  ollamaChild.on('exit', () => {
    if (!shuttingDown) {
      process.stdout.write(`${tagFor('ollama')}exited unexpectedly\n`);
      shutdown();
    }
  });
  ollamaStartedByUs = true;

  for (let i = 0; i < 40; i++) {
    if (await ollamaUp()) {
      process.stdout.write(`${tagFor('ollama')}ready at ${ollamaUrl}\n`);
      return;
    }
    await sleep(500);
  }
  process.stdout.write(`${tagFor('ollama')}did not respond after 20s — the pipeline's segment step may fail\n`);
}

function startApp() {
  const colorwarsPython = fileURLToPath(new URL('../colorwars/.venv/bin/python', import.meta.url));
  const colorwarsApiReady = existsSync(colorwarsPython);
  if (!colorwarsApiReady) {
    process.stdout.write(
      `${tagFor('cwapi')}no venv at colorwars/.venv — skipping (run \`python3 -m venv .venv\` and ` +
        `\`.venv/bin/pip install -r requirements.txt\` inside colorwars/ to enable the Studio page)\n`,
    );
  }

  const procs = [
    { name: 'worker', cmd: 'npm', args: ['run', 'dev', '--silent', '--workspace', 'worker'] },
    { name: 'web', cmd: 'npm', args: ['run', 'dev', '--silent', '--workspace', 'web'], env: { PORT: webPort, WEB_PORT: webPort } },
    ...(colorwarsApiReady
      ? [
          {
            name: 'cwapi',
            cmd: colorwarsPython,
            args: ['-m', 'uvicorn', 'colorwars.studio_api.main:app', '--host', '127.0.0.1', '--port', colorwarsApiPort],
            cwd: fileURLToPath(new URL('../colorwars', import.meta.url)),
          },
        ]
      : []),
  ];
  for (const { name, cmd, args, env, cwd } of procs) {
    const child = spawn(cmd, args, {
      cwd: cwd ?? root,
      env: { ...process.env, ...env, FORCE_COLOR: '1' },
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    pipeLines(child.stdout, name);
    pipeLines(child.stderr, name);
    child.on('exit', (code) => {
      process.stdout.write(`${tagFor(name)}exited (${code})\n`);
      shutdown();
    });
    children.push(child);
  }
  process.stdout.write(
    `\n${C.dim}dashboard →${C.reset} http://localhost:${webPort}   ${C.dim}worker →${C.reset} http://127.0.0.1:${workerPort}` +
      (colorwarsApiReady ? `   ${C.dim}colorwars api →${C.reset} http://127.0.0.1:${colorwarsApiPort}\n\n` : '\n\n'),
  );
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill('SIGTERM');
  if (ollamaStartedByUs && ollamaChild) {
    process.stdout.write(`${tagFor('ollama')}stopping (started by this run)\n`);
    ollamaChild.kill('SIGTERM');
    setTimeout(() => ollamaChild?.kill('SIGKILL'), 3000).unref();
  }
  setTimeout(() => process.exit(0), 800);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await ensureOllama();
startApp();
