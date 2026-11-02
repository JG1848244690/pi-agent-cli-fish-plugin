/**
 * Progress, library and config persisted outside of Pi's session files, so the
 * novel path never shows up in session history or transcripts.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface BookState {
  para: number;
  /**
   * Characters of the paragraph already read. Line indices are wrap-width
   * dependent, character offsets are not — they survive a restart at a
   * different terminal size, which is why resume uses them when present.
   */
  chars?: number;
  /** Unified (character based) progress at save time, for the bookshelf. */
  percent?: number;
  /** Chapter number at save time, so the shelf can show it without loading. */
  chapter?: number;
  updatedAt: number;
}

export interface FishConfig {
  /** Body lines shown by the focused reader. */
  readerLines: number;
  placement: "aboveEditor" | "belowEditor";
  /** Restore the last book into the widget when Pi starts. */
  resumeOnStart: boolean;
  /** The bundled manual has been offered in the library once. */
  manualSeeded?: boolean;
}

export interface FishState {
  last?: string;
  library: string[];
  books: Record<string, BookState>;
  config: FishConfig;
}

export const DEFAULT_CONFIG: FishConfig = {
  readerLines: 15,
  placement: "aboveEditor",
  resumeOnStart: true,
};

export function defaultState(): FishState {
  return { library: [], books: {}, config: { ...DEFAULT_CONFIG } };
}

/**
 * The plugin used to be called `moyu`; move that folder once so the shelf and
 * the reading position survive the rename instead of silently starting over.
 */
export function migrateLegacyDir(agentDir: string): void {
  const target = join(agentDir, "fish");
  const legacy = join(agentDir, "moyu");
  if (existsSync(target) || !existsSync(legacy)) return;
  try {
    renameSync(legacy, target);
    return;
  } catch {
    // rename fails across devices or when the folder is locked; copy instead.
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    cpSync(legacy, target, { recursive: true });
  } catch {
    // nothing to recover: start with an empty shelf
  }
}

export function statePath(agentDir: string): string {
  return join(agentDir, "fish", "state.json");
}

export function loadState(agentDir: string): FishState {
  migrateLegacyDir(agentDir);
  const file = statePath(agentDir);
  try {
    if (!existsSync(file)) return defaultState();
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<FishState> & {
      config?: Partial<FishConfig> & { pageLines?: number };
    };
    const rawBooks = raw.books && typeof raw.books === "object" ? raw.books : {};
    const books: Record<string, BookState> = {};
    for (const [path, entry] of Object.entries(rawBooks)) {
      const book = entry as Partial<BookState> | undefined;
      if (!book || typeof book !== "object") continue;
      const para = Number(book.para);
      if (!Number.isFinite(para) || para < 0) continue;
      const chars = Number(book.chars);
      const percent = Number(book.percent);
      const chapter = Number(book.chapter);
      books[path] = {
        para: Math.floor(para),
        ...(Number.isFinite(chars) && chars >= 0 ? { chars: Math.floor(chars) } : {}),
        ...(Number.isFinite(percent) && percent >= 0 ? { percent: Math.min(100, Math.round(percent)) } : {}),
        ...(Number.isFinite(chapter) && chapter > 0 ? { chapter: Math.floor(chapter) } : {}),
        updatedAt: Number.isFinite(Number(book.updatedAt)) ? Number(book.updatedAt) : 0,
      };
    }

    const library = Array.isArray(raw.library)
      ? raw.library.filter((entry): entry is string => typeof entry === "string")
      : Object.keys(books);

    // Rebuild config from known keys only, dropping legacy fields such as the
    // old multi-line widget height.
    const rawConfig = (raw.config ?? {}) as Partial<FishConfig> & { pageLines?: number };
    const readerLines =
      typeof rawConfig.readerLines === "number"
        ? Math.min(40, Math.max(4, Math.floor(rawConfig.readerLines)))
        : DEFAULT_CONFIG.readerLines;

    return {
      last: typeof raw.last === "string" ? raw.last : undefined,
      library,
      books,
      config: {
        readerLines,
        placement: rawConfig.placement === "belowEditor" ? "belowEditor" : "aboveEditor",
        resumeOnStart: rawConfig.resumeOnStart !== false,
        manualSeeded: rawConfig.manualSeeded === true,
      },
    };
  } catch {
    return defaultState();
  }
}

export function saveState(agentDir: string, state: FishState): void {
  const file = statePath(agentDir);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, file);
  } catch {
    // Reading novels is not worth crashing an agent session over.
  }
}
