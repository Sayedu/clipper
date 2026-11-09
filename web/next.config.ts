import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// The single .env lives at the repo root, one level up from web/.
const rootEnv = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(rootEnv)) {
  try {
    process.loadEnvFile(rootEnv);
  } catch {
    /* ignore malformed .env */
  }
}

const workerHost = process.env.WORKER_HOST ?? '127.0.0.1';
const workerPort = process.env.WORKER_PORT ?? '8787';
const workerBase = `http://${workerHost}:${workerPort}`;

// When the dashboard runs on a remote box (e.g. an Oracle Cloud VM) you open it
// by IP or Tailscale name, not localhost — `next dev` blocks that as cross-origin
// unless the host is allow-listed. Comma-separated hostnames in DEV_ORIGINS.
const devOrigins = (process.env.DEV_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // This repo, not $HOME, is the workspace root (there's a stray lockfile in ~).
  outputFileTracingRoot: fileURLToPath(new URL('..', import.meta.url)),

  ...(devOrigins.length ? { allowedDevOrigins: devOrigins } : {}),

  // The browser only ever talks to this origin; everything backend is proxied.
  async rewrites() {
    return [{ source: '/worker/:path*', destination: `${workerBase}/:path*` }];
  },
  // Allow <video> preview served from the worker.
  async headers() {
    return [];
  },
  experimental: {
    proxyTimeout: 1000 * 60 * 30, // long-lived SSE connections
  },
};

export default nextConfig;
