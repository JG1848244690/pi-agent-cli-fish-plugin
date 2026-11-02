/**
 * Position bookkeeping for turning pages.
 *
 * Two things make naive paging wrong:
 *
 * 1. A `Pos.line` is a *wrapped* line index, so it only means something at one
 *    wrap width. The single-line widget wraps at 72 columns, the focused reader
 *    at `terminal width - 6`; carrying a raw line index between them jumps a
 *    few sentences. `WidthAnchor` remembers the character offset of the current
 *    page and converts only when the width actually changed.
 * 2. The page that reaches the end of the book has nothing behind it. Storing
 *    its `end` position parks the reader past the last paragraph, where
 *    `clampPos` folds it back to the start of that paragraph — so the tail
 *    cycles forever and the last screen is never stable. `advanceFrom` refuses
 *    that step, which keeps the final page on screen.
 */

import { pageAt, pageBack, wrapParagraph, type Book, type Pos } from "./reader.ts";

export interface WidthAnchor {
  width: number;
  chars: number;
}

export interface PageState {
  pos: Pos;
  anchor: WidthAnchor;
}

/** Characters of paragraph consumed by the wrapped lines before `pos.line`. */
export function charsInParagraph(book: Book, pos: Pos, width: number): number {
  const wrapped = wrapParagraph(book.paragraphs[pos.para] ?? "", width);
  let chars = 0;
  for (let i = 0; i < Math.min(pos.line, wrapped.length); i++) chars += wrapped[i].length;
  return chars;
}

/** Inverse of `charsInParagraph`: the line that holds character offset `chars`. */
export function posFromChars(book: Book, para: number, chars: number, width: number): Pos {
  const wrapped = wrapParagraph(book.paragraphs[para] ?? "", width);
  let used = 0;
  for (let i = 0; i < wrapped.length; i++) {
    if (used + wrapped[i].length > chars) return { para, line: i };
    used += wrapped[i].length;
  }
  return { para, line: Math.max(0, wrapped.length - 1) };
}

export function anchorFor(book: Book, pos: Pos, width: number): WidthAnchor {
  return { width, chars: charsInParagraph(book, pos, width) };
}

/**
 * Character offset of `pos` in its paragraph. The anchor wins when there is
 * one: it was measured at the width the position was computed for, while
 * `width` may already describe a different (re-wrapped) surface.
 */
export function charsAt(book: Book, pos: Pos, anchor: WidthAnchor | null, width: number): number {
  return anchor ? anchor.chars : charsInParagraph(book, pos, width);
}

/** Re-express `pos` at `width` when the last page turn happened elsewhere. */
export function reanchor(book: Book, pos: Pos, anchor: WidthAnchor | null, width: number): Pos {
  if (!anchor || anchor.width === width) return pos;
  return posFromChars(book, pos.para, anchor.chars, width);
}

export interface AdvanceResult extends PageState {
  /** False when the book is already showing its final page. */
  moved: boolean;
}

/** Move forward `pages` screens of `maxLines` wrapped lines. */
export function advanceFrom(
  book: Book,
  pos: Pos,
  anchor: WidthAnchor | null,
  width: number,
  maxLines: number,
  pages = 1,
): AdvanceResult {
  const lines = Math.max(1, Math.floor(maxLines));
  let current = reanchor(book, pos, anchor, width);
  let moved = false;

  for (let i = 0; i < Math.max(1, pages); i++) {
    const page = pageAt(book, current, width, lines);
    if (!page.lines.length) break;
    // Past the last paragraph there is nothing left to render; stepping there
    // would just be folded back onto this page.
    if (page.end.para >= book.paragraphs.length) break;
    if (page.end.para === current.para && page.end.line === current.line) break;
    current = page.end;
    moved = true;
  }

  return { pos: current, anchor: anchorFor(book, current, width), moved };
}

/** Move backward `pages` screens of `maxLines` wrapped lines. */
export function backFrom(
  book: Book,
  pos: Pos,
  anchor: WidthAnchor | null,
  width: number,
  maxLines: number,
  pages = 1,
): PageState {
  const lines = Math.max(1, Math.floor(maxLines));
  let current = reanchor(book, pos, anchor, width);
  for (let i = 0; i < Math.max(1, pages); i++) {
    current = pageBack(book, current, width, lines);
  }
  return { pos: current, anchor: anchorFor(book, current, width) };
}

/** True when the current position already shows the tail of the book. */
export function atBookEnd(book: Book, pos: Pos, width: number, maxLines: number): boolean {
  const page = pageAt(book, pos, width, Math.max(1, Math.floor(maxLines)));
  return page.lines.length > 0 && page.end.para >= book.paragraphs.length;
}
