import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/lib/migrate.ts';
import { escapeRegExp, firstDisallowedTerm } from '../src/lib/textmatch.ts';
import { usedVideoCutoff } from '../src/db.ts';

// ------------------------------------------------------------------
describe('runMigrations', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clip-mig-'));
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies files once, in lexical order, and is idempotent', () => {
    writeFileSync(join(dir, '002_b.sql'), 'CREATE TABLE b (x);');
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x);');

    const first = runMigrations(db, dir);
    expect(first.applied).toEqual(['001_a.sql', '002_b.sql']);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('a','b')").all()).toHaveLength(2);

    const second = runMigrations(db, dir);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['001_a.sql', '002_b.sql']);
  });

  it('picks up a migration added after the first run', () => {
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x);');
    runMigrations(db, dir);
    writeFileSync(join(dir, '002_c.sql'), 'CREATE TABLE c (x);');
    expect(runMigrations(db, dir).applied).toEqual(['002_c.sql']);
  });

  it('rolls a failing migration back and leaves it pending', () => {
    writeFileSync(join(dir, '001_ok.sql'), 'CREATE TABLE ok (x);');
    writeFileSync(join(dir, '002_bad.sql'), 'CREATE TABLE d (x); THIS IS NOT SQL;');

    expect(() => runMigrations(db, dir)).toThrow();
    // 001 committed, 002 fully rolled back (table d gone, not recorded)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='ok'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='d'").get()).toBeFalsy();
    expect(db.prepare('SELECT name FROM _migrations').all()).toEqual([{ name: '001_ok.sql' }]);

    // fix it and re-run
    writeFileSync(join(dir, '002_bad.sql'), 'CREATE TABLE d (x);');
    expect(runMigrations(db, dir).applied).toEqual(['002_bad.sql']);
  });

  it('no-ops when the directory does not exist', () => {
    expect(runMigrations(db, join(dir, 'nope')).applied).toEqual([]);
  });
});

// ------------------------------------------------------------------
describe('usedVideoCutoff', () => {
  const now = Date.parse('2026-08-27T00:00:00.000Z');

  it('null cooldown → no cutoff (exclude a used video forever)', () => {
    expect(usedVideoCutoff(null, now)).toBeNull();
  });

  it('N days → an ISO timestamp N days before now', () => {
    expect(usedVideoCutoff(30, now)).toBe('2026-07-28T00:00:00.000Z');
    expect(usedVideoCutoff(1, now)).toBe('2026-08-26T00:00:00.000Z');
  });

  it('a video last used exactly at the cutoff is no longer excluded (strict >)', () => {
    // excludedVideoIds filters `last_used_at > cutoff`
    const cutoff = usedVideoCutoff(7, now)!;
    const lastUsed = new Date(now - 7 * 86_400_000).toISOString();
    expect(lastUsed > cutoff).toBe(false);
    const usedYesterday = new Date(now - 6 * 86_400_000).toISOString();
    expect(usedYesterday > cutoff).toBe(true);
  });

  it('treats junk / negative input as "forever"-ish, never throws', () => {
    expect(usedVideoCutoff(Number.NaN, now)).toBeNull();
    expect(usedVideoCutoff(-5, now)).toBe('2026-08-27T00:00:00.000Z'); // clamped to 0 days
  });
});

// ------------------------------------------------------------------
describe('firstDisallowedTerm', () => {
  it('matches whole words case-insensitively', () => {
    expect(firstDisallowedTerm('We went to the CASINO last night', ['casino'])).toBe('casino');
    expect(firstDisallowedTerm('Nothing to see here', ['casino'])).toBeNull();
  });

  it('respects word boundaries', () => {
    expect(firstDisallowedTerm('a whole category of things', ['cat'])).toBeNull();
    expect(firstDisallowedTerm('my cat is here', ['cat'])).toBe('cat');
  });

  it('matches multi-word phrases across any whitespace', () => {
    expect(firstDisallowedTerm('talking about\nsports  betting today', ['sports betting'])).toBe('sports betting');
  });

  it('returns the first hit in list order and ignores blanks', () => {
    expect(firstDisallowedTerm('this mentions poker', ['  ', 'blackjack', 'poker'])).toBe('poker');
  });

  it('does not choke on regex metacharacters in a term', () => {
    expect(firstDisallowedTerm('open 24/7 baby', ['24/7'])).toBe('24/7');
    expect(firstDisallowedTerm('price is $$$ huge', ['$$$'])).toBe('$$$');
    expect(() => firstDisallowedTerm('safe text', ['(', '[a-z]+', '.*'])).not.toThrow();
  });

  it('escapeRegExp neutralises metacharacters', () => {
    expect(new RegExp(escapeRegExp('a.b(c)')).test('a.b(c)')).toBe(true);
    expect(new RegExp(escapeRegExp('a.b')).test('axb')).toBe(false);
  });
});
