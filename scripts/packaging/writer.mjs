// Picks the wording for one post kit: caption (rotating style), hashtags,
// opening hook, cover text and pinned comment. Every pick prefers the
// templates used least recently for this format, then is checked against the
// last 10 posts (checks.mjs) and redone if it's too close to one of them.
import { COPY, STYLES, available } from './copy.mjs';
import { repeatProblems } from './checks.mjs';
import { stripDashes } from './util.mjs';

/** Index of the most recent entry that used `id` (via `get`), -1 if never. */
function lastUse(entries, get, id) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const v = get(entries[i]);
    if (Array.isArray(v) ? v.includes(id) : v === id) return i;
  }
  return -1;
}
/** Candidates ordered least recently used first; ties shuffled. */
function freshest(cands, entries, get, r) {
  return r.shuffle(cands)
    .map((c) => ({ c, used: lastUse(entries, get, c.id) }))
    .sort((a, b) => a.used - b.used)
    .map((x) => x.c);
}

const caps = (lines) => lines.map((l) => stripDashes(String(l)).toUpperCase());

export function writeCopy(facts, history, r) {
  const fmt = facts.format;
  const C = COPY[fmt];
  const same = history.filter((e) => e.format === fmt);
  const recent = history.slice(-10);
  const notes = [];
  const kit = { hashtags: [], hook: null, cover: null, pinned: null, caption: null };

  // ---- caption: least recently used style first, then template, question, emoji
  const styles = STYLES.filter((s) => available(C.caption[s], facts).length);
  const styleOrder = freshest(styles.map((id) => ({ id })), same, (e) => e.captionStyle, r).map((x) => x.id);
  outer: for (const style of styleOrder) {
    const lines = freshest(available(C.caption[style], facts), same, (e) => e.captionIds, r);
    const asks = freshest(available(C.ask, facts), same, (e) => e.captionIds, r);
    for (const line of lines) {
      for (const ask of asks.slice(0, 3)) {
        const emoji = r.pick(C.emoji);
        const caption = stripDashes(`${line.value} ${emoji}\n${ask.value}`);
        const probe = { caption, hook: { lines: [] }, cover: { lines: [] }, pinned: '', hashtags: [] };
        const bad = repeatProblems(probe, recent).filter((p) => p.part === 'caption');
        if (bad.length) { notes.push(`caption ${line.id}: ${bad[0].why}`); continue; }
        kit.caption = caption;
        kit.captionStyle = style;
        kit.captionIds = [line.id, ask.id];
        break outer;
      }
    }
  }
  if (!kit.caption) throw new Error(`no caption for ${fmt} passes the repeat check against the last 10 posts: ${notes.slice(-6).join(" | ")}`);

  // ---- hashtags: the format's core tag(s) + 2 or 3 from its pool, the
  //      least recently used pool tags first, never the same set as the last 5
  const want = Math.min(5, C.tags.core.length + r.int(2, 3)) - C.tags.core.length;
  const lastSets = history.slice(-5).map((e) => [...(e.hashtags ?? [])].sort().join(' '));
  const pool = freshest(C.tags.pool.map((id) => ({ id })), same, (e) => e.hashtags, r).map((x) => x.id);
  for (let shift = 0; shift < pool.length; shift++) {
    const pick = [...pool.slice(shift), ...pool.slice(0, shift)].slice(0, want);
    const set = [...C.tags.core, ...pick];
    if (!lastSets.includes([...set].sort().join(' '))) { kit.hashtags = set; break; }
  }
  if (!kit.hashtags.length) kit.hashtags = [...C.tags.core, ...pool.slice(0, want)];

  // ---- opening hook
  for (const h of freshest(available(C.hook, facts), same, (e) => e.hook?.id, r)) {
    const lines = caps(h.value);
    const bad = repeatProblems({ caption: '\u0000', hook: { id: h.id, lines }, cover: { lines: [] }, pinned: '', hashtags: [] }, recent).filter((p) => p.part === 'hook');
    if (bad.length) { notes.push(`hook ${h.id}: ${bad[0].why}`); continue; }
    kit.hook = { id: h.id, lines };
    break;
  }
  if (!kit.hook) throw new Error(`no opening hook for ${fmt} passes the repeat check`);

  // ---- cover text (never the same words as this video's own hook)
  const hookNorm = kit.hook.lines.join(' ');
  for (const c of freshest(available(C.cover, facts), same, (e) => e.cover?.id, r)) {
    const lines = caps(c.value);
    if (lines.join(' ') === hookNorm) continue;
    const bad = repeatProblems({ caption: '\u0000', hook: { lines: [] }, cover: { lines }, pinned: '', hashtags: [] }, recent).filter((p) => p.part === 'coverText');
    if (bad.length) { notes.push(`cover text ${c.id}: ${bad[0].why}`); continue; }
    kit.cover = { id: c.id, lines };
    break;
  }
  if (!kit.cover) throw new Error(`no cover text for ${fmt} passes the repeat check`);

  // ---- pinned comment
  for (const p of freshest(available(C.pinned, facts), same, (e) => e.pinnedId, r)) {
    const text = stripDashes(p.value);
    const bad = repeatProblems({ caption: '\u0000', hook: { lines: [] }, cover: { lines: [] }, pinned: text, hashtags: [] }, recent).filter((x) => x.part === 'pinned');
    if (bad.length) { notes.push(`pinned ${p.id}: ${bad[0].why}`); continue; }
    kit.pinned = text;
    kit.pinnedId = p.id;
    break;
  }
  if (!kit.pinned) {
    // an old render with few facts can run out of pinned comments that are
    // unlike all of the last 10 — then the least recently used one that
    // isn't among the last 3 for this format still counts as "different"
    const last3 = same.slice(-3).map((e) => e.pinnedId);
    const p = freshest(available(C.pinned, facts), same, (e) => e.pinnedId, r).find((x) => !last3.includes(x.id));
    if (!p) throw new Error(`no pinned comment for ${fmt} differs from the last 3 posts`);
    kit.pinned = stripDashes(p.value);
    kit.pinnedId = p.id;
    notes.push(`pinned comment: relaxed to "not in the last 3" (${p.id})`);
  }

  kit.notes = notes;
  return kit;
}
