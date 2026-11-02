/**
 * Full-text search over a loaded book.
 *
 * Pure functions only — no I/O, no rendering, no session state — so the
 * matching rules can be tested directly. Matching is case-insensitive
 * (that is what you want for English text; Chinese has no case, so it
 * behaves as plain substring matching).
 */

import type { Book } from "./reader.ts";

export interface Match {
  /** index into book.paragraphs */
  para: number;
  /** character offset of the match inside that paragraph */
  at: number;
  /** paragraph text around the match, for menus */
  snippet: string;
  /** the matched text exactly as it appears in the book */
  piece: string;
}

/** Stop after this many hits: "的" would otherwise match tens of thousands. */
export const MATCH_LIMIT = 500;

export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

export function snippetAt(text: string, at: number, length: number, radius = 16): string {
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + length + radius);
  const head = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  return `${head}${text.slice(start, end).trim()}${tail}`;
}

/** All non-overlapping hits, in document order. */
export function findMatches(book: Book, rawQuery: string, limit = MATCH_LIMIT): Match[] {
  const query = normalizeQuery(rawQuery);
  if (!query) return [];
  const needle = query.toLowerCase();
  const out: Match[] = [];

  for (let para = 0; para < book.paragraphs.length; para++) {
    const text = book.paragraphs[para];
    const haystack = text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      out.push({ para, at, snippet: snippetAt(text, at, needle.length), piece: text.slice(at, at + needle.length) });
      if (out.length >= limit) return out;
      from = at + needle.length;
    }
  }
  return out;
}

/**
 * Index of the hit to jump to: the first one strictly after (dir 1) or
 * before (dir -1) `para`/`at`, wrapping around at either end. Returns -1
 * only when there is nothing to match.
 */
export function indexFrom(matches: Match[], para: number, at: number, direction: 1 | -1): number {
  if (!matches.length) return -1;
  if (direction > 0) {
    const found = matches.findIndex((m) => m.para > para || (m.para === para && m.at > at));
    return found >= 0 ? found : 0;
  }
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index];
    if (match.para < para || (match.para === para && match.at < at)) return index;
  }
  return matches.length - 1;
}

/** How many hits the palette lists at once. */
export const PICK_COUNT = 5;

/** What the search palette draws: the nearest hits, wrapping at the end. */
export interface HitWindow {
  /** Up to `count` hits, starting at the first hit at or after `from`. */
  hits: Match[];
  /** Hits found before the scan stopped. */
  total: number;
  /** True when the scan stopped at `limit`, so `total` is only a lower bound. */
  capped: boolean;
}

/**
 * Hits for the palette: ordered from the reader's current offset onward and
 * wrapping at the end of the book, so "search" feels like "find the next one"
 * even when you sit in the middle of the text.
 */
export function windowMatches(
  book: Book,
  rawQuery: string,
  from: { para: number; at: number },
  count = PICK_COUNT,
  limit = 60,
): HitWindow {
  const all = findMatches(book, rawQuery, limit);
  if (!all.length) return { hits: [], total: 0, capped: false };

  const start = indexFrom(all, from.para, from.at, 1);
  const rotated = [...all.slice(start), ...all.slice(0, start)];
  return {
    hits: rotated.slice(0, Math.max(0, Math.trunc(count))),
    total: all.length,
    capped: all.length >= limit,
  };
}
