// The post log: one JSON entry per post kit (caption, hashtags, hook, cover
// style + hash, sound, presentation, format). The repeat checker reads the
// most recent entries from it; the posting queue reads the last posted format.
//
// Two files, read together and sorted by time:
//   post-log/daily.json        written by the daily CI poster and committed
//                              back to the repo by its workflow
//   post-kits/post-log.json    written by local runs (CLI + dashboard), not
//                              committed, so it never conflicts with CI's file
// POST_LOG overrides which file this process WRITES to.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const REPO = resolve(new URL('../..', import.meta.url).pathname);
export const CI_LOG = resolve(REPO, 'post-log', 'daily.json');
export const LOCAL_LOG = resolve(REPO, 'post-kits', 'post-log.json');

export function writeLogPath() {
  return process.env.POST_LOG ? resolve(process.env.POST_LOG) : LOCAL_LOG;
}

function readOne(path) {
  if (!existsSync(path)) return [];
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(j.entries) ? j.entries : [];
  } catch {
    return [];
  }
}

/** Every entry from every log this process can see, oldest first. Pass
 *  `paths` to read only specific logs (tests use a throwaway one). */
export function readLog(paths = null) {
  const list = paths ?? [...new Set([CI_LOG, LOCAL_LOG, writeLogPath()])];
  const all = list.flatMap(readOne);
  const seen = new Set();
  return all
    .filter((e) => (seen.has(e.id) ? false : seen.add(e.id)))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function appendEntry(entry, path = writeLogPath()) {
  const entries = readOne(path);
  const i = entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) entries[i] = entry; else entries.push(entry);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 1));
  renameSync(tmp, path);
}

export function markPosted(id, info = {}, path = writeLogPath()) {
  const entries = readOne(path);
  const e = entries.find((x) => x.id === id);
  if (!e) return false;
  Object.assign(e, { posted: true, postedAt: new Date().toISOString(), ...info });
  appendEntry(e, path);
  return true;
}

export const recent = (entries, n, format = null) =>
  (format ? entries.filter((e) => e.format === format) : entries).slice(-n);

/** The format of the last thing actually posted (or queued to post). */
export function lastPostedFormat(entries) {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].posted) return entries[i].format;
  return entries.at(-1)?.format ?? null;
}

/**
 * Posting order with no format twice in a row: always take the format with
 * the most kits left that isn't the one just placed (ties broken by the
 * input order). If one format outnumbers all the others combined, a repeat
 * is unavoidable — those spots are marked so the caller can warn.
 */
export function buildQueue(items, lastFormat = null) {
  const byFormat = new Map();
  for (const it of items) {
    if (!byFormat.has(it.format)) byFormat.set(it.format, []);
    byFormat.get(it.format).push(it);
  }
  const order = [];
  let prev = lastFormat;
  while (order.length < items.length) {
    const ranked = [...byFormat.entries()].filter(([, v]) => v.length).sort((a, b) => b[1].length - a[1].length);
    const pick = ranked.find(([f]) => f !== prev) ?? ranked[0];
    const it = pick[1].shift();
    order.push({ ...it, backToBack: pick[0] === prev });
    prev = pick[0];
  }
  return order;
}
