import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  url: URL;
}
export type Handler = (ctx: Ctx) => void | Promise<void>;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    const keys: string[] = [];
    const regex = new RegExp(
      '^' +
        pattern.replace(/:[^/]+/g, (m) => {
          keys.push(m.slice(1));
          return '([^/]+)';
        }) +
        '/?$',
    );
    this.routes.push({ method, regex, keys, handler });
  }

  get(p: string, h: Handler) { this.add('GET', p, h); }
  post(p: string, h: Handler) { this.add('POST', p, h); }
  put(p: string, h: Handler) { this.add('PUT', p, h); }
  delete(p: string, h: Handler) { this.add('DELETE', p, h); }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Last-Event-ID');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const m = route.regex.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      try {
        await route.handler({ req, res, params, url });
      } catch (err) {
        if (!res.headersSent) {
          const status = (err as { status?: number }).status ?? 500;
          sendJson(res, status, { error: (err as Error).message, hint: (err as { hint?: string }).hint });
        } else {
          res.end();
        }
      }
      return;
    }
    sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    const e = new Error('invalid JSON body') as Error & { status: number };
    e.status = 400;
    throw e;
  }
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

/** Serve a file with HTTP Range support (needed for <video> scrubbing).
 *  `opts.download` sets Content-Disposition: attachment with that filename. */
export function serveFile(ctx: Ctx, filePath: string, opts: { download?: string } = {}): void {
  const { req, res } = ctx;
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    sendJson(res, 404, { error: 'file not found' });
    return;
  }
  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  if (opts.download) {
    res.setHeader('Content-Disposition', `attachment; filename="${opts.download.replace(/[^\w.\- ]/g, '_')}"`);
  }
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : stat.size - 1;
    if (start >= stat.size || end >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Cache-Control': 'no-cache',
    });
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  }
}
