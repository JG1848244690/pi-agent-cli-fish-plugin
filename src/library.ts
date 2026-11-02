/** Turning a user-supplied path into a list of readable books (.txt / .epub). */

import { readdirSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

export interface CollectResult {
  files: string[];
  error?: string;
}

const BOOK_EXTENSIONS = [".txt", ".epub", ".md"];

function isBookFile(file: string): boolean {
  return BOOK_EXTENSIONS.includes(extname(file).toLowerCase());
}

export function collectBooks(input: string): CollectResult {
  const target = resolve(expandHome(input));

  let stat;
  try {
    stat = statSync(target);
  } catch {
    return { files: [], error: `not found: ${input}` };
  }

  if (stat.isFile()) {
    if (!isBookFile(target)) {
      return { files: [], error: "only .txt, .epub and .md files are supported" };
    }
    return { files: [target] };
  }

  if (!stat.isDirectory()) {
    return { files: [], error: "not a file or directory" };
  }

  const files = readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isBookFile(entry.name))
    .map((entry) => resolve(target, entry.name))
    .sort((a, b) => a.localeCompare(b, "zh"));

  if (!files.length) return { files: [], error: "no .txt, .epub or .md files in that folder" };
  return { files };
}

/** One row of the bookshelf overlay. */
export interface ShelfEntry {
  path: string;
  /** File name shown in the list. */
  title: string;
  /** Unified character-based progress, 0-100, as of the last save. */
  percent: number;
  /** Chapter number at the last save, 0 when the book has no chapters. */
  chapter: number;
  /** The book currently loaded into the session. */
  reading: boolean;
  /** Last read timestamp (0 = never opened). */
  updatedAt: number;
}

export function sortShelf(entries: ShelfEntry[]): ShelfEntry[] {
  // Most recently read first; never-opened books keep their library order.
  return [...entries].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Case-insensitive file-name filter for the shelf (typing narrows the list). */
export function filterShelf(entries: ShelfEntry[], rawQuery: string): ShelfEntry[] {
  const needle = rawQuery.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter(
    (entry) => entry.title.toLowerCase().includes(needle) || entry.path.toLowerCase().includes(needle),
  );
}

export function expandHome(input: string): string {
  const trimmed = input.trim().replace(/^["']|["']$/g, "");
  if (trimmed === "~") return process.env.USERPROFILE ?? process.env.HOME ?? trimmed;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
    return home + trimmed.slice(1);
  }
  return trimmed;
}
