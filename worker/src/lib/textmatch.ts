/** Escape a user-supplied string for literal use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * First disallowed term that appears in `text` as a whole word/phrase
 * (case-insensitive), or `null` if none do. Multi-word terms match across a
 * single run of whitespace. `\b` guards mean "cat" does not match "category".
 */
export function firstDisallowedTerm(text: string, terms: string[]): string | null {
  for (const raw of terms) {
    const term = raw.trim();
    if (!term) continue;
    const pattern = escapeRegExp(term).replace(/\s+/g, '\\s+');
    // Only anchor with \b where the edge character is a word character,
    // so terms like "24/7" or "$$$" still match.
    const left = /^\w/.test(term) ? '\\b' : '';
    const right = /\w$/.test(term) ? '\\b' : '';
    if (new RegExp(`${left}${pattern}${right}`, 'i').test(text)) return term;
  }
  return null;
}
