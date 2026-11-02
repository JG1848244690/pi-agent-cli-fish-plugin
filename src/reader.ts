/**
 * Novel loading, encoding detection, chapter detection, CJK-aware wrapping
 * and page math. Deliberately dependency-free so it can be unit tested
 * outside of Pi with plain `node`.
 */

import { readFileSync } from "node:fs";

import { isEpubPath, readEpubContent } from "./epub.ts";

export interface Line {
  text: string;
  paragraph: number;
  chapter: boolean;
}

export interface Pos {
  para: number;
  line: number;
}

export interface Book {
  path: string;
  paragraphs: string[];
  chapterParas: number[];
  chapterTitles: string[];
  chapterSet: Set<number>;
  /** prefixChars[i] = number of characters before paragraph i */
  prefixChars: number[];
  totalChars: number;
  encoding: string;
}

const CHAPTER_RE =
  /^\s*(第[0-9零一二三四五六七八九十百千万两〇]+[章回节卷集部篇]|Chapter\s+\d+|CHAPTER\s+\d+)/;

export function decodeText(buf: Buffer): { text: string; encoding: string } {
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(buf),
      encoding: "utf-8",
    };
  } catch {
    // Most Chinese .txt novels in the wild are GBK/GB18030.
    return { text: new TextDecoder("gb18030").decode(buf), encoding: "gb18030" };
  }
}

function titleOf(text: string): string {
  return text.length > 40 ? text.slice(0, 40) : text;
}

/**
 * Assemble a Book from plain paragraphs. Chapter starts come from the chapter
 * regex plus any explicit ones (an EPUB table of contents); an explicit title
 * wins over the regex because it is what the reader actually printed.
 */
export function buildBook(
  path: string,
  paragraphs: string[],
  encoding: string,
  explicitChapters: { para: number; title: string }[] = [],
): Book {
  const prefixChars: number[] = [];
  const titles = new Map<number, string>();
  let chars = 0;

  paragraphs.forEach((paragraph, index) => {
    prefixChars.push(chars);
    chars += paragraph.length;
    if (CHAPTER_RE.test(paragraph)) titles.set(index, titleOf(paragraph));
  });

  for (const chapter of explicitChapters) {
    const title = chapter.title.trim();
    if (!title || !Number.isFinite(chapter.para)) continue;
    if (chapter.para < 0 || chapter.para >= paragraphs.length) continue;
    titles.set(chapter.para, titleOf(title));
  }

  const chapterParas = [...titles.keys()].sort((a, b) => a - b);

  return {
    path,
    paragraphs,
    chapterParas,
    chapterTitles: chapterParas.map((para) => titles.get(para) ?? ""),
    chapterSet: new Set(chapterParas),
    prefixChars,
    totalChars: chars,
    encoding,
  };
}

export function loadBook(file: string): Book {
  if (isEpubPath(file)) {
    const epub = readEpubContent(file);
    return buildBook(file, epub.paragraphs, "epub", epub.chapters);
  }

  const buf = readFileSync(file);
  const { text, encoding } = decodeText(buf);

  const paragraphs = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return buildBook(file, paragraphs, encoding);
}

/** Display width of one code point in terminal cells. */
export function charWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (c === 0x200b) return 0;
  const wide =
    c >= 0x1100 &&
    (c <= 0x115f ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd));
  return wide ? 2 : 1;
}

export function textWidth(text: string): number {
  let used = 0;
  for (const ch of text) used += charWidth(ch);
  return used;
}

/** ASCII (non-space) — the characters that form a word worth keeping whole. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && ch > " " && ch < "\x7f";
}

export function wrapParagraph(text: string, width: number): string[] {
  const limit = Math.max(2, Math.floor(width));
  const out: string[] = [];
  let line = "";
  let used = 0;
  /** Cut point just after the last space, so a long line can break on a word. */
  let spaceAt = -1;
  let spaceUsed = 0;

  const resetSpace = (from: string, usedAt: number) => {
    const index = from.lastIndexOf(" ");
    if (index < 0) {
      spaceAt = -1;
      spaceUsed = 0;
      return;
    }
    spaceAt = index + 1;
    spaceUsed = usedAt - textWidth(from.slice(index + 1));
  };

  for (const ch of text) {
    const w = charWidth(ch);
    if (line && used + w > limit) {
      // Chinese breaks anywhere, but cutting "fullscreen" into "fullsc|reen" is
      // just noise: when the break lands inside an ASCII word, fall back to the
      // last space. The space stays on the finished line, so no character moves.
      const insideWord = isWordChar(ch) && isWordChar(line[line.length - 1]);
      if (insideWord && spaceAt > 0 && spaceUsed > 0) {
        out.push(line.slice(0, spaceAt));
        line = line.slice(spaceAt);
        used -= spaceUsed;
        resetSpace(line, used);
      } else {
        out.push(line);
        line = "";
        used = 0;
        spaceAt = -1;
        spaceUsed = 0;
      }
    }
    line += ch;
    used += w;
    if (ch === " ") {
      spaceAt = line.length;
      spaceUsed = used;
    }
  }
  if (line) out.push(line);
  return out;
}

export function clampPos(book: Book, pos: Pos, width: number): Pos {
  const last = Math.max(0, book.paragraphs.length - 1);
  const para = Math.min(Math.max(0, Math.floor(pos.para)), last);
  const wrapped = wrapParagraph(book.paragraphs[para] ?? "", width);
  const line = Math.min(Math.max(0, Math.floor(pos.line)), Math.max(0, wrapped.length - 1));
  return { para, line };
}

export interface Page {
  lines: Line[];
  end: Pos;
}

/**
 * Collect `maxLines` wrapped lines starting at `pos`. The returned `end` is
 * where the next page starts, so no text is lost for long paragraphs.
 */
export function pageAt(book: Book, pos: Pos, width: number, maxLines: number): Page {
  const start = clampPos(book, pos, width);
  const lines: Line[] = [];
  let p = start.para;
  let l = start.line;

  while (lines.length < maxLines && p < book.paragraphs.length) {
    const wrapped = wrapParagraph(book.paragraphs[p], width);
    const isChapter = book.chapterSet.has(p);

    while (l < wrapped.length && lines.length < maxLines) {
      lines.push({ text: wrapped[l], paragraph: p, chapter: isChapter && l === 0 });
      l++;
    }

    if (l >= wrapped.length) {
      p++;
      l = 0;
    } else {
      break; // page is full in the middle of a paragraph
    }
  }

  const end: Pos = lines.length >= maxLines && l > 0 ? { para: p, line: l } : { para: p, line: 0 };
  return { lines, end };
}

/** Move one page backwards. */
export function pageBack(book: Book, pos: Pos, width: number, maxLines: number): Pos {
  const start = clampPos(book, pos, width);
  let p = start.para;
  let l = start.line;
  let remaining = maxLines;

  if (l === 0) {
    if (p === 0) return { para: 0, line: 0 };
    p -= 1;
    l = wrapParagraph(book.paragraphs[p], width).length;
  }

  for (;;) {
    if (l >= remaining) return { para: p, line: l - remaining };
    remaining -= l;
    if (p === 0) return { para: 0, line: 0 };
    p -= 1;
    l = wrapParagraph(book.paragraphs[p], width).length;
  }
}

export function nextChapterPos(book: Book, pos: Pos): Pos | null {
  for (const index of book.chapterParas) {
    if (index > pos.para) return { para: index, line: 0 };
  }
  return null;
}

export function prevChapterPos(book: Book, pos: Pos): Pos | null {
  let found: number | null = null;
  for (const index of book.chapterParas) {
    if (index < pos.para) found = index;
    else break;
  }
  return found === null ? null : { para: found, line: 0 };
}

export function chapterAt(book: Book, pos: Pos): { number: number; title: string } | null {
  let result: { number: number; title: string } | null = null;
  for (let i = 0; i < book.chapterParas.length; i++) {
    if (book.chapterParas[i] <= pos.para) result = { number: i + 1, title: book.chapterTitles[i] };
    else break;
  }
  return result;
}

/**
 * Progress at an exact character offset: the one number every surface shows
 * (widget, reader meta, palette hits, bookshelf) so they can never disagree.
 * Unlike percentAt it does not depend on the wrap width.
 */
export function percentAtChars(book: Book, chars: number | undefined): number {
  if (book.totalChars <= 0) return 100;
  const offset = Math.min(Math.max(0, chars ?? 0), book.totalChars);
  return Math.max(0, Math.min(100, Math.round((offset / book.totalChars) * 100)));
}

export function percentAt(book: Book, pos: Pos, width?: number, gutter = 0): number {
  if (book.totalChars <= 0) return 100;
  const para = Math.min(pos.para, Math.max(0, book.paragraphs.length - 1));
  const before = book.prefixChars[para] ?? 0;

  // Refine inside long paragraphs: line offsets are width dependent, but the
  // approximation is good enough for a progress readout.
  let within = 0;
  if (width && book.paragraphs[para]) {
    const wrapped = wrapParagraph(book.paragraphs[para], Math.max(2, width - gutter));
    if (wrapped.length > 1) {
      const fraction = Math.min(1, Math.max(0, pos.line / wrapped.length));
      within = Math.floor(book.paragraphs[para].length * fraction);
    }
  }

  const percent = Math.round(((before + within) / book.totalChars) * 100);
  return Math.max(0, Math.min(100, percent));
}

/** Restore a saved paragraph without trusting a width-dependent line offset. */
export function resumePos(book: Book, para: number | undefined): Pos {
  if (!book.paragraphs.length) return { para: 0, line: 0 };
  const last = book.paragraphs.length - 1;
  const safe = typeof para === "number" && Number.isFinite(para) ? Math.floor(para) : 0;
  return { para: Math.min(Math.max(0, safe), last), line: 0 };
}
