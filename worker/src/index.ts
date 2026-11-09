import { createServer } from 'node:http';
import { env } from './env.ts';
import { ensureDataDirs } from './paths.ts';
import { log } from './lib/log.ts';
import { buildRouter } from './api.ts';
import { reconcileOrphans } from './queue.ts';
import { sweepWorkDirs } from './library.ts';
import { reconcileFootage } from './footage.ts';
import './db.ts'; // opens the database + applies schema

ensureDataDirs();
reconcileOrphans();
sweepWorkDirs();
reconcileFootage();

const router = buildRouter();
const server = createServer((req, res) => {
  void router.handle(req, res);
});

server.headersTimeout = 0;
server.requestTimeout = 0;

server.listen(env.worker.port, env.worker.host, () => {
  log.ok(`worker listening on http://${env.worker.host}:${env.worker.port}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`${sig} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
