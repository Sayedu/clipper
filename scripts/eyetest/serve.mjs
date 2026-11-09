// Tiny static file server rooted at the repo root. Serves the Eye Test
// browser bundle (render/eyetest/*) plus the bundled Chakra Petch fonts
// under assets/fonts, so the page renders identically offline in headless Chrome.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
};

// `onRequest(req, res, url)` — optional hook for extra routes (the preview
// studio's POST /render etc.); return true if it handled the request.
export function startServer(port = 0, onRequest = null) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        if (onRequest && (await onRequest(req, res, url))) return;
        let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
        if (!path.startsWith(ROOT)) {
          res.writeHead(403).end('forbidden');
          return;
        }
        let s;
        try {
          s = await stat(path);
        } catch {
          res.writeHead(404).end('not found: ' + url.pathname);
          return;
        }
        if (s.isDirectory()) path = join(path, 'index.html');
        const body = await readFile(path);
        res.writeHead(200, {
          'Content-Type': TYPES[extname(path)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(body);
      } catch (err) {
        res.writeHead(500).end(String(err));
      }
    });
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startServer(Number(process.argv[2]) || 5191);
  console.log(`eyetest static server on http://127.0.0.1:${port}/`);
}
