// Tiny static file server rooted at the repo root. Serves the marble-race
// browser bundle plus node_modules/three + node_modules/@dimforge over HTTP so
// ES-module imports and the Rapier WASM load cleanly in headless Chrome.
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
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
};

export function startServer(port = 0) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
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
  const { port } = await startServer(Number(process.argv[2]) || 5188);
  console.log(`marblerace static server on http://127.0.0.1:${port}/`);
}
