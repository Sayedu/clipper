import type Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Tiny forward-only migration runner. Reads `NNN_*.sql` files from `dir` in
 * lexical order and applies any not yet recorded in `_migrations`. Each file
 * runs in its own transaction together with its bookkeeping row, so a partial
 * failure rolls the whole file back and leaves it pending.
 */
export function runMigrations(db: Database.Database, dir: string): MigrateResult {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL
  )`);

  const result: MigrateResult = { applied: [], skipped: [] };
  if (!existsSync(dir)) return result;

  const done = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map((r) => r.name),
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (done.has(file)) {
      result.skipped.push(file);
      continue;
    }
    const sql = readFileSync(resolve(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
    })();
    result.applied.push(file);
  }
  return result;
}
