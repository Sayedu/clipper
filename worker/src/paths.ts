import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from './env.ts';

export const paths = {
  repoRoot: env.repoRoot,
  data: env.dataDir,
  db: resolve(env.dataDir, 'clipper.db'),
  work: resolve(env.dataDir, 'work'),
  library: resolve(env.dataDir, 'library'),
  footage: resolve(env.dataDir, 'footage'),

  assets: env.assetsDir,
  fonts: resolve(env.assetsDir, 'fonts'),
  sfx: resolve(env.assetsDir, 'sfx'),
  models: resolve(env.assetsDir, 'models'),
  yunet: resolve(env.assetsDir, 'models', 'face_detection_yunet.onnx'),

  python: resolve(env.repoRoot, 'python'),
  venvPython: resolve(env.repoRoot, 'python', '.venv', 'bin', 'python'),
  script: (name: string) => resolve(env.repoRoot, 'python', name),
} as const;

/** Create the top-level data directories. Call once on startup. */
export function ensureDataDirs(): void {
  for (const dir of [paths.data, paths.work, paths.library, paths.footage]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Scratch directory for one job. Created on demand. */
export function jobWorkDir(jobId: string): string {
  const dir = resolve(paths.work, jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Permanent directory for one saved clip. Created on demand. */
export function clipDir(clipId: string): string {
  const dir = resolve(paths.library, clipId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
