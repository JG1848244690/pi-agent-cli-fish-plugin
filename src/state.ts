/**
 * Progress, library and config persisted outside of Pi's session files, so the
 * novel path never shows up in session history or transcripts.
 */

import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
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
  const state = readState(agentDir);
  configBaseline.set(agentDir, { ...state.config });
  return state;
}

/**
 * Config keys that `saveState` three-way merges. A value this process did not
 * change never overwrites one another running Pi changed.
 */
const CONFIG_KEYS = ["readerLines", "placement", "resumeOnStart", "manualSeeded"] as const;

/** What this process last read (or wrote) for a config, per agent dir. */
const configBaseline = new Map<string, FishConfig>();

function parseState(agentDir: string): FishState | null {
  migrateLegacyDir(agentDir);
  const file = statePath(agentDir);
  try {
    if (!existsSync(file)) return null;
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
    return null;
  }
}

function readState(agentDir: string): FishState {
  return parseState(agentDir) ?? defaultState();
}

/**
 * Read the file for a merge without touching the config-merge baseline. Used
 * by plugins that refresh progress from disk while running; changing the
 * baseline there would make their older in-memory config look like a local edit
 * and overwrite another instance's config change on the next save.
 */
export function readDiskState(agentDir: string): FishState {
  return parseState(agentDir) ?? defaultState();
}

// ------------------------------------------------------------ multi-instance --

/** A writer holds the lock for one read-merge-write; this is only a safety net. */
const LOCK_TIMEOUT_MS = 250;
const LOCK_RETRY_MS = 5;
/** A lock older than this is from a process that crashed mid-save. */
const LOCK_STALE_MS = 10_000;

function sleepSync(ms: number): void {
  // Saves are rare and short; the TUI can afford a few milliseconds of spin.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Exclusive-create lock; returns the release function, or null on timeout. */
function acquireLock(file: string): (() => void) | null {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeFileSync(fd, String(process.pid), "utf8");
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          unlinkSync(lock);
        } catch {
          // another process already cleared it
        }
      };
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        // the lock disappeared between open and stat: try again
      }
      if (Date.now() >= deadline) return null;
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

/**
 * Merge what another Pi instance wrote while this one was running.
 *
 * Progress is per book: the newer `updatedAt` wins, so different instances
 * reading different books never roll each other back. The library is a union.
 * Config is a three-way merge: only fields this process actually changed are
 * allowed to replace what is on disk.
 */
function mergeStates(agentDir: string, disk: FishState, incoming: FishState): FishState {
  const books: Record<string, BookState> = { ...disk.books };
  for (const [path, book] of Object.entries(incoming.books)) {
    const current = books[path];
    if (!current || book.updatedAt >= current.updatedAt) books[path] = book;
  }

  const library = [...disk.library];
  for (const path of incoming.library) {
    if (!library.includes(path)) library.push(path);
  }

  const base = configBaseline.get(agentDir);
  const config: FishConfig = { ...disk.config };
  if (base) {
    for (const key of CONFIG_KEYS) {
      if (incoming.config[key] !== base[key]) Object.assign(config, { [key]: incoming.config[key] });
    }
  } else {
    Object.assign(config, incoming.config);
  }

  return { last: incoming.last ?? disk.last, library, books, config };
}

export function saveState(agentDir: string, state: FishState): void {
  const file = statePath(agentDir);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const release = acquireLock(file);
    try {
      const merged = mergeStates(agentDir, readState(agentDir), state);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
      // rename replaces atomically: a reader never sees a half-written file.
      renameSync(tmp, file);
      configBaseline.set(agentDir, { ...state.config });
    } finally {
      release?.();
    }
  } catch {
    // Reading novels is not worth crashing an agent session over.
  }
}

/**
 * Watch the shared state file and call `onChange` when another process writes
 * it. Both plugins use this so a page turn in Pi shows up in OpenCode (and the
 * other way round) without reopening the book.
 *
 * The watcher follows the directory rather than the file: saves replace
 * `state.json` via rename, which would detach a file watcher on Windows.
 */
export function watchState(agentDir: string, onChange: (state: FishState) => void): () => void {
  const dir = dirname(statePath(agentDir));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  try {
    mkdirSync(dir, { recursive: true });
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (filename && String(filename) !== "state.json") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // Atomic rename means a half-written file should never be visible; if
        // the parse still fails, keep the last good state and try the next event.
        const state = parseState(agentDir);
        if (state) onChange(state);
      }, 50);
      (timer as { unref?: () => void }).unref?.();
    });
  } catch {
    return () => {};
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
