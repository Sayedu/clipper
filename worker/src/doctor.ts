import { existsSync, readdirSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { env } from './env.ts';
import { paths } from './paths.ts';
import { run } from './lib/exec.ts';

const LINUX = platform() === 'linux';
const fixFor = (mac: string, linux: string) => (LINUX ? linux : mac);

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Shell command that fixes it, shown verbatim in the UI. */
  fix?: string;
  /** `true` if the pipeline cannot run at all without this. */
  critical: boolean;
}

export interface DoctorReport {
  ok: boolean; // no failing critical checks
  checks: DoctorCheck[];
  generatedAt: string;
}

async function checkFfmpeg(): Promise<DoctorCheck[]> {
  const ffmpegFix = fixFor('brew install ffmpeg-full', 'sudo apt install -y ffmpeg');
  const v = await run(env.ffmpeg, ['-version']);
  if (v.code !== 0) {
    return [{ name: 'ffmpeg', status: 'fail', critical: true, detail: `${env.ffmpeg} not runnable`, fix: ffmpegFix }];
  }
  const ver = v.stdout.split('\n')[0]?.replace('ffmpeg version ', '').split(' ')[0] ?? '?';
  const filters = await run(env.ffmpeg, ['-hide_banner', '-filters']);
  const hasAss = filters.stdout.includes(' ass ') || / ass\s+V->V/.test(filters.stdout);
  const where = env.ffmpeg.includes('ffmpeg-full') ? ' (ffmpeg-full)' : env.ffmpeg.startsWith('/usr') ? ' (apt)' : '';
  return [
    { name: 'ffmpeg', status: 'ok', critical: true, detail: `${ver}${where}` },
    hasAss
      ? { name: 'ffmpeg libass', status: 'ok', critical: true, detail: 'ass filter present' }
      : {
          name: 'ffmpeg libass',
          status: 'fail',
          critical: true,
          detail: 'no "ass" filter — captions cannot be burned',
          fix: ffmpegFix,
        },
  ];
}

async function checkYtDlp(): Promise<DoctorCheck> {
  const v = await run('yt-dlp', ['--version']);
  if (v.code !== 0) {
    const fix = fixFor(
      'brew install yt-dlp',
      'sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64 -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp',
    );
    return { name: 'yt-dlp', status: 'fail', critical: true, detail: 'not on PATH', fix };
  }
  return { name: 'yt-dlp', status: 'ok', critical: true, detail: v.stdout.trim() || 'installed' };
}

async function checkLlm(): Promise<DoctorCheck[]> {
  if (env.llm.provider === 'openai') {
    const missing = [
      !env.llm.baseUrl && 'LLM_BASE_URL',
      !env.llm.apiKey && 'LLM_API_KEY',
      !env.llm.model && 'LLM_MODEL',
    ].filter(Boolean);
    if (missing.length) {
      return [
        {
          name: 'LLM (openai-compat)',
          status: 'fail',
          critical: true,
          detail: `missing ${missing.join(', ')}`,
          fix: 'set them in .env — see CLOUD.md (Gemini free tier)',
        },
      ];
    }
    const detail = `${env.llm.model} @ ${new URL(env.llm.baseUrl).host}`;
    try {
      // a real 1-token completion — surfaces the actual error (disabled API, bad key, …)
      const res = await fetch(`${env.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.llm.apiKey}` },
        body: JSON.stringify({ model: env.llm.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return [{ name: 'LLM (openai-compat)', status: 'ok', critical: true, detail }];
      let body = (await res.json().catch(() => ({}))) as { error?: { message?: string } } | Array<{ error?: { message?: string } }>;
      let msg = (Array.isArray(body) ? body[0]?.error?.message : body.error?.message) ?? `HTTP ${res.status}`;
      // Google's OpenAI shim hides the real reason behind a generic 500 — ask the native API.
      if (/googleapis\.com/.test(env.llm.baseUrl) && (res.status >= 500 || /internal error/i.test(msg))) {
        const native = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${env.llm.apiKey}`,
          { signal: AbortSignal.timeout(10_000) },
        ).catch(() => null);
        const nb = (await native?.json().catch(() => ({}))) as { error?: { message?: string } };
        if (nb?.error?.message) msg = nb.error.message;
      }
      let fix = 'check LLM_API_KEY / LLM_BASE_URL';
      if (/has not been used|is disabled/i.test(msg)) {
        msg = 'the Gemini API is not enabled for this key’s Google Cloud project';
        fix = 'enable it: https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com';
      } else if (res.status === 401 || /API key not valid|invalid/i.test(msg)) {
        fix = 'the key is invalid or restricted — allow "Generative Language API" on it, or set a dedicated LLM_API_KEY';
      }
      return [{ name: 'LLM (openai-compat)', status: 'fail', critical: true, detail: `${detail} — ${msg.slice(0, 160)}`, fix }];
    } catch (err) {
      return [
        {
          name: 'LLM (openai-compat)',
          status: 'fail',
          critical: true,
          detail: `unreachable: ${(err as Error).message}`,
          fix: 'check LLM_BASE_URL and your network',
        },
      ];
    }
  }
  const base = env.ollama.url;
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { models?: Array<{ name: string; model?: string }> };
    const names = (body.models ?? []).map((m) => m.model ?? m.name);
    const hasModel = names.some((n) => n === env.ollama.model || n.startsWith(env.ollama.model.split(':')[0] + ':'));
    return [
      { name: 'ollama', status: 'ok', critical: true, detail: `serving at ${base}` },
      hasModel
        ? { name: `ollama model`, status: 'ok', critical: true, detail: env.ollama.model }
        : {
            name: 'ollama model',
            status: 'fail',
            critical: true,
            detail: `${env.ollama.model} not pulled`,
            fix: `ollama pull ${env.ollama.model}`,
          },
    ];
  } catch (err) {
    return [
      {
        name: 'ollama',
        status: 'fail',
        critical: true,
        detail: `unreachable at ${base} (${(err as Error).message})`,
        fix: fixFor('brew services start ollama', 'sudo systemctl start ollama'),
      },
    ];
  }
}

async function checkPython(): Promise<DoctorCheck[]> {
  if (!existsSync(paths.venvPython)) {
    return [
      {
        name: 'python venv',
        status: 'fail',
        critical: true,
        detail: 'python/.venv missing',
        fix: fixFor('bash scripts/setup.sh', 'bash scripts/cloud-setup.sh'),
      },
    ];
  }
  const probe = await run(paths.venvPython, [
    '-c',
    'import faster_whisper,scenedetect,cv2,numpy;' +
      'm="-"\ntry:\n import mediapipe as _mp; m=_mp.__version__\nexcept Exception: pass\n' +
      'print(faster_whisper.__version__,scenedetect.__version__,cv2.__version__,numpy.__version__,m)',
  ]);
  const checks: DoctorCheck[] = [];
  if (probe.code !== 0) {
    checks.push({
      name: 'python ML packages',
      status: 'fail',
      critical: true,
      detail: probe.stderr.trim().split('\n').slice(-1)[0] ?? 'import failed',
      fix: fixFor('bash scripts/setup.sh', 'bash scripts/cloud-setup.sh'),
    });
  } else {
    const [fw, sd, cv, , mp] = probe.stdout.trim().split(' ');
    checks.push({
      name: 'python ML packages',
      status: 'ok',
      critical: true,
      detail: `faster-whisper ${fw} · scenedetect ${sd} · opencv ${cv}${mp && mp !== '-' ? ` · mediapipe ${mp}` : ' · (mediapipe n/a — YuNet reframe)'}`,
    });
  }

  // Phase 2 — content filter stack
  const p2 = await run(paths.venvPython, [
    '-c',
    'import torch,demucs,insightface,open_clip;print(torch.__version__, torch.backends.mps.is_available())',
  ]);
  if (p2.code !== 0) {
    checks.push({
      name: 'content-filter ML',
      status: 'fail',
      critical: true,
      detail: 'torch / demucs / insightface / open_clip not importable',
      fix: fixFor('bash scripts/setup.sh', 'bash scripts/cloud-setup.sh'),
    });
  } else {
    const [ver, mps] = p2.stdout.trim().split(' ');
    checks.push({
      name: 'content-filter ML',
      status: 'ok',
      critical: true,
      detail: `torch ${ver}${mps === 'True' ? ' (mps)' : ' (cpu)'} · demucs · insightface · open_clip`,
    });
  }
  return checks;
}

function checkWhisperCache(): DoctorCheck {
  // faster-whisper caches CTranslate2 weights under the HF hub cache.
  const hubs = [
    resolve(process.env.HOME ?? '', '.cache', 'huggingface', 'hub'),
    resolve(process.env.HF_HOME ?? '', 'hub'),
  ].filter(Boolean);
  for (const hub of hubs) {
    if (!existsSync(hub)) continue;
    const hit = readdirSync(hub).some(
      (d) => d.includes('faster-whisper') || d.includes(`whisper-${env.whisper.model}`),
    );
    if (hit) return { name: 'whisper model', status: 'ok', critical: false, detail: `${env.whisper.model} cached` };
  }
  return {
    name: 'whisper model',
    status: 'warn',
    critical: false,
    detail: `${env.whisper.model} not cached — downloads (~3 GB) on first transcription`,
    fix: fixFor('bash scripts/setup.sh', 'bash scripts/cloud-setup.sh'),
  };
}

function checkFonts(): DoctorCheck {
  if (!existsSync(paths.fonts)) {
    return { name: 'caption fonts', status: 'fail', critical: true, detail: 'assets/fonts missing', fix: fixFor('bash scripts/setup.sh', 'bash scripts/cloud-setup.sh') };
  }
  const ttf = readdirSync(paths.fonts).filter((f) => /\.(ttf|otf)$/i.test(f));
  return ttf.length
    ? { name: 'caption fonts', status: 'ok', critical: true, detail: ttf.join(', ') }
    : {
        name: 'caption fonts',
        status: 'fail',
        critical: true,
        detail: 'no .ttf/.otf in assets/fonts',
        fix: 'drop a font file into assets/fonts/ (e.g. Anton-Regular.ttf)',
      };
}

function checkSfx(): DoctorCheck {
  if (!existsSync(paths.sfx)) {
    return { name: 'sfx packs', status: 'warn', critical: false, detail: 'assets/sfx missing', fix: 'bash scripts/make-sfx.sh' };
  }
  const packs = readdirSync(paths.sfx).filter((d) => {
    const p = resolve(paths.sfx, d);
    return statSync(p).isDirectory() && readdirSync(p).some((f) => /\.(wav|mp3|m4a|aac|ogg)$/i.test(f));
  });
  return packs.length
    ? { name: 'sfx packs', status: 'ok', critical: false, detail: packs.join(', ') }
    : { name: 'sfx packs', status: 'warn', critical: false, detail: 'no packs with audio', fix: 'bash scripts/make-sfx.sh' };
}

async function checkKokoro(): Promise<DoctorCheck> {
  const model = resolve(paths.repoRoot, 'assets', 'kokoro', 'kokoro-v1.0.onnx');
  const voices = resolve(paths.repoRoot, 'assets', 'kokoro', 'voices-v1.0.bin');
  const haveFiles = existsSync(model) && existsSync(voices);
  const imp = await run(paths.venvPython, ['-c', 'import kokoro_onnx, soundfile; print("ok")']);
  const haveLib = imp.code === 0;
  if (haveFiles && haveLib) {
    return { name: 'Kokoro TTS', status: 'ok', critical: false, detail: 'kokoro-onnx + v1.0 model ready' };
  }
  const missing = [!haveLib && 'kokoro-onnx (pip)', !haveFiles && 'assets/kokoro/*.onnx + voices'].filter(Boolean);
  return {
    name: 'Kokoro TTS',
    status: 'warn',
    critical: false,
    detail: `missing ${missing.join(' + ')} — Storyteller mode needs it`,
    fix: 'bash scripts/setup.sh',
  };
}

async function checkBrowserRenderer(): Promise<DoctorCheck> {
  try {
    const { chromium } = (await import('playwright-core')) as typeof import('playwright-core');
    const exe = chromium.executablePath();
    if (exe && existsSync(exe)) {
      return { name: 'Browser renderer', status: 'ok', critical: false, detail: 'playwright-core + Chromium ready — Color race, Escape race, Laser nations, Color war, Follow the ball, Eye test' };
    }
    return {
      name: 'Browser renderer',
      status: 'warn',
      critical: false,
      detail: 'Chromium not installed — "Color race" / "Escape race" / "Laser nations" / "Color war" / "Follow the ball" / "Eye test" content types will not render',
      fix: 'npx playwright install chromium',
    };
  } catch {
    return {
      name: 'Browser renderer',
      status: 'warn',
      critical: false,
      detail: 'playwright-core missing',
      fix: 'bash scripts/setup.sh',
    };
  }
}

async function checkFootageLibrary(): Promise<DoctorCheck> {
  const { footageStatus } = await import('./footage.ts');
  const s = footageStatus();
  return {
    name: 'Storyteller footage',
    status: 'ok',
    critical: false,
    detail: s.count
      ? `${s.count} clip(s) · ${s.totalMinutes} min in the library`
      : 'empty — auto-populates on the first Storyteller run',
  };
}

async function checkTwitch(): Promise<DoctorCheck> {
  const { clientId, clientSecret } = env.twitch;
  if (!clientId && !clientSecret) {
    return {
      name: 'Twitch Clips',
      status: 'ok',
      critical: false,
      detail: 'not configured (only needed for the Twitch / Both source)',
    };
  }
  if (!clientId || !clientSecret) {
    return {
      name: 'Twitch Clips',
      status: 'warn',
      critical: false,
      detail: `missing ${!clientId ? 'TWITCH_CLIENT_ID' : 'TWITCH_CLIENT_SECRET'}`,
      fix: 'set both in .env from dev.twitch.tv/console/apps',
    };
  }
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) return { name: 'Twitch Clips', status: 'ok', critical: false, detail: 'app token OK' };
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    return {
      name: 'Twitch Clips',
      status: 'warn',
      critical: false,
      detail: body.message ?? `HTTP ${res.status}`,
      fix: 'check TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET',
    };
  } catch (err) {
    return { name: 'Twitch Clips', status: 'warn', critical: false, detail: `could not verify (${(err as Error).message})` };
  }
}

async function checkYouTubeKey(): Promise<DoctorCheck> {
  if (!env.ytApiKey) {
    return {
      name: 'YouTube API key',
      status: 'fail',
      critical: true,
      detail: 'YT_API_KEY not set in .env',
      fix: 'add YT_API_KEY=... to .env',
    };
  }
  try {
    const u = new URL('https://www.googleapis.com/youtube/v3/videos');
    u.searchParams.set('part', 'id');
    u.searchParams.set('id', 'dQw4w9WgXcQ');
    u.searchParams.set('key', env.ytApiKey);
    const res = await fetch(u, { signal: AbortSignal.timeout(4000) });
    if (res.ok) return { name: 'YouTube API key', status: 'ok', critical: true, detail: 'valid' };
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return {
      name: 'YouTube API key',
      status: 'fail',
      critical: true,
      detail: body.error?.message ?? `HTTP ${res.status}`,
      fix: 'check YT_API_KEY and that YouTube Data API v3 is enabled',
    };
  } catch (err) {
    return { name: 'YouTube API key', status: 'warn', critical: false, detail: `could not verify (${(err as Error).message})` };
  }
}

export async function runDoctor(): Promise<DoctorReport> {
  const groups = await Promise.all([
    checkFfmpeg(),
    checkYtDlp().then((c) => [c]),
    checkLlm(),
    checkPython(),
    Promise.resolve([checkWhisperCache()]),
    Promise.resolve([checkFonts()]),
    Promise.resolve([checkSfx()]),
    checkYouTubeKey().then((c) => [c]),
    checkTwitch().then((c) => [c]),
    checkKokoro().then((c) => [c]),
    checkBrowserRenderer().then((c) => [c]),
    checkFootageLibrary().then((c) => [c]),
  ]);
  const checks = groups.flat();
  const ok = !checks.some((c) => c.critical && c.status === 'fail');
  return { ok, checks, generatedAt: new Date().toISOString() };
}

// --- CLI ---------------------------------------------------------------

async function main(): Promise<void> {
  const report = await runDoctor();
  const glyph: Record<CheckStatus, string> = { ok: '\x1b[32m✓\x1b[0m', warn: '\x1b[33m!\x1b[0m', fail: '\x1b[31m✗\x1b[0m' };
  const pad = Math.max(...report.checks.map((c) => c.name.length));
  for (const c of report.checks) {
    process.stdout.write(`  ${glyph[c.status]} ${c.name.padEnd(pad)}  ${c.detail}\n`);
    if (c.status !== 'ok' && c.fix) process.stdout.write(`      \x1b[90m→ ${c.fix}\x1b[0m\n`);
  }
  process.stdout.write(
    report.ok
      ? '\n\x1b[32mAll critical checks passed.\x1b[0m\n'
      : '\n\x1b[31mSome critical checks failed — see fixes above.\x1b[0m\n',
  );
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
