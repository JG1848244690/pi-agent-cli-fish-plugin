/**
 * pi-fish — read a local novel in Pi.
 *
 * Two surfaces:
 *   - widget: always exactly one dim line above the editor, hideable
 *   - reader: many lines, only opened by /fish (or /fish-read)
 *
 * Commands (all `fish-*`, so they sort together and are easy to type):
 *   /fish-find [text]         floating search box: type, pick one of 5 hits, jump
 *   alt+n                     jump to the next hit of the active search
 *   /fish-find off            drop the highlight
 *   /fish-list                shelf overlay: pick a book, then search inside it
 *   /fish-add [file|folder]   add books to the library (prompts when omitted)
 *   /fish                     resume the last book and open the reader
 *   /fish-read                open the many-line reader
 *   /fish-save                save the current position now
 *   /fish list                same shelf, as a sub-command
 *   /fish next|prev [n]       page forward/back
 *   /fish chapter|back-chapter
 *   /fish auto [seconds]      auto-scroll while the agent works
 *   /fish hide|show           boss key
 *   /fish reader-lines <n>    reader height (default 15)
 *   /fish resume on|off       restore last book on startup (default on)
 *   /fish close
 *
 * Shortcuts: alt+m show/hide, alt+j next line, alt+k previous line.
 * (alt+letter, not ctrl+shift+letter: terminals without the Kitty keyboard
 * protocol deliver ctrl+shift+j as ctrl+j, i.e. a newline in the editor.)
 *
 * Nothing about the book is written to the Pi session: progress and library
 * live in <agent dir>/fish/state.json, and no LLM tool is registered.
 */

import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { collectBooks, expandHome, sortShelf, type ShelfEntry } from "./library.ts";
import { ensureManual } from "./manual.ts";
import { advanceFrom, anchorFor, backFrom, charsAt, posFromChars, reanchor, type WidthAnchor } from "./paging.ts";
import {
  chapterAt,
  loadBook,
  nextChapterPos,
  percentAtChars,
  prevChapterPos,
  resumePos,
  type Book,
  type Pos,
} from "./reader.ts";
import { MATCH_LIMIT, findMatches, indexFrom, normalizeQuery, type Match } from "./search.ts";
import { FishReaderView, type ReaderActions, type ReaderResult, type ReaderViewState } from "./reader-view.ts";
import { FishPaletteView, type PaletteMode, type PaletteResult, type PaletteState } from "./search-view.ts";
import { defaultState, loadState, readDiskState, saveState, watchState, type FishState } from "./state.ts";
import { FishWidget, widgetBodyWidth, type WidgetPaging, type WidgetTheme } from "./widget.ts";

const WIDGET_ID = "fish";
const FAKE_NAMES = ["session.ts", "auth.ts", "notes.md", "api.ts", "README.md", "client.ts", "config.ts"];

interface SearchState {
  query: string;
  matches: Match[];
  /** Index of the hit we last jumped to; paging does not change it. */
  index: number;
}

interface ReaderSession extends ReaderViewState {
  hidden: boolean;
  widget: FishWidget | null;
  autoTimer: ReturnType<typeof setInterval> | null;
  anchor: WidthAnchor | null;
  search: SearchState | null;
}

function emptySession(): ReaderSession {
  return {
    book: null,
    pos: { para: 0, line: 0 },
    fakeName: FAKE_NAMES[0],
    readerLines: 15,
    autoSeconds: 0,
    hidden: false,
    widget: null,
    autoTimer: null,
    anchor: null,
    search: null,
    percent: () => currentPercent(),
  };
}

let session = emptySession();
let store: FishState = defaultState();
let reader: FishReaderView | null = null;
/** Stop function for the shared state watcher, one per TUI session. */
let stopWatching: (() => void) | null = null;
/** Timestamp of the last entry this process wrote, to ignore our own watcher event. */
let lastSavedAt = 0;

function fakeNameFor(path: string): string {
  let hash = 0;
  for (const ch of path) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return FAKE_NAMES[hash % FAKE_NAMES.length];
}

function persist(): void {
  store.config = { ...store.config, readerLines: session.readerLines };
  let updatedAt = 0;
  if (session.book) {
    const book = session.book;
    store.last = book.path;
    const chapter = chapterAt(book, session.pos);
    updatedAt = Date.now();
    store.books[book.path] = {
      para: session.pos.para,
      chars: charsAt(book, session.pos, session.anchor, activeBodyWidth()),
      percent: currentPercent(),
      ...(chapter ? { chapter: chapter.number } : {}),
      updatedAt,
    };
    if (!store.library.includes(book.path)) store.library.push(book.path);
  }
  saveState(getAgentDir(), store);
  if (updatedAt) lastSavedAt = updatedAt;
}

/**
 * Another Pi/OpenCode process saved the shared state. Refresh the shelf data
 * and, if it advanced the book we are reading, move this view to the same line.
 *
 * Adopting does not write back: that would make the two processes echo each
 * other. The next local page turn persists from the adopted position.
 */
function adoptExternalState(disk: FishState): void {
  for (const [path, entry] of Object.entries(disk.books)) {
    const current = store.books[path];
    if (!current || entry.updatedAt >= current.updatedAt) store.books[path] = entry;
  }
  for (const path of disk.library) {
    if (!store.library.includes(path)) store.library.push(path);
  }

  const book = session.book;
  if (!book) return;
  const entry = disk.books[book.path];
  if (!entry) return;

  const width = activeBodyWidth();
  const localChars = charsAt(book, session.pos, session.anchor, width);
  if (entry.para === session.pos.para && (entry.chars ?? 0) === localChars) {
    lastSavedAt = Math.max(lastSavedAt, entry.updatedAt);
    return;
  }
  if (entry.updatedAt < lastSavedAt) return;

  const pos = posFromChars(book, Math.min(entry.para, book.paragraphs.length - 1), entry.chars ?? 0, width);
  session.pos = pos;
  session.anchor = anchorFor(book, pos, width);
  lastSavedAt = entry.updatedAt;
  if (!session.hidden) {
    reader?.refresh();
    session.widget?.refresh();
  }
}

/** Pull book progress and library from disk without touching session config. */
function refreshStore(): void {
  const disk = readDiskState(getAgentDir());
  for (const [path, entry] of Object.entries(disk.books)) {
    const current = store.books[path];
    if (!current || entry.updatedAt >= current.updatedAt) store.books[path] = entry;
  }
  for (const path of disk.library) {
    if (!store.library.includes(path)) store.library.push(path);
  }
  if (!store.last && disk.last) store.last = disk.last;
  if (disk.config.manualSeeded) store.config = { ...store.config, manualSeeded: true };
}

function currentWidth(): number {
  return reader?.width ?? session.widget?.width ?? 80;
}

/** Wrap width matching the currently visible surface. */
function activeBodyWidth(): number {
  const width = currentWidth();
  return reader ? Math.max(12, width - 6) : widgetBodyWidth(width);
}

/** Wrapped lines per screen on the currently visible surface. */
function activeLines(): number {
  // The widget is always a single line; only the focused reader pages by screen.
  return reader ? Math.max(4, session.readerLines) : 1;
}

/** Character offset of the current page, the metric behind every percentage. */
/** Offset inside the current paragraph — what resume stores (width free). */
function currentChars(): number {
  const book = session.book;
  if (!book) return 0;
  return charsAt(book, session.pos, session.anchor, activeBodyWidth());
}

/** Offset from the very start of the book — what progress is measured in. */
function currentBookChars(): number {
  const book = session.book;
  if (!book) return 0;
  const para = Math.min(session.pos.para, Math.max(0, book.paragraphs.length - 1));
  return (book.prefixChars[para] ?? 0) + currentChars();
}

/**
 * Progress of the open book, 0-100. Character based, so the widget, the reader
 * meta line, the palette hits and the bookshelf all print the same number at
 * the same position, whatever the terminal width is.
 */
function currentPercent(): number {
  const book = session.book;
  if (!book) return 0;
  return percentAtChars(book, currentBookChars());
}

// ---------------------------------------------------------------- widget ----

function mountWidget(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui" || !session.book || session.hidden || reader) return;
  const paging: WidgetPaging = {
    advance: (lines) => {
      advance(ctx, lines);
    },
    back: (lines) => {
      back(ctx, lines);
    },
    screenLines: () => session.readerLines,
    sync: (width) => {
      const book = session.book;
      if (!book) return;
      const body = widgetBodyWidth(width);
      if (session.anchor?.width === body) return;
      session.pos = reanchor(book, session.pos, session.anchor, body);
      session.anchor = anchorFor(book, session.pos, body);
    },
  };
  ctx.ui.setWidget(
    WIDGET_ID,
    (tui, theme) => {
      const widget = new FishWidget(session, theme as WidgetTheme, tui, paging);
      session.widget = widget;
      return widget;
    },
    { placement: store.config.placement },
  );
}

function refreshWidget(ctx: ExtensionContext): void {
  if (session.hidden) return;
  if (!session.widget) {
    mountWidget(ctx);
    return;
  }
  session.widget.refresh();
}

function clearWidget(ctx: ExtensionContext): void {
  session.widget?.dispose();
  session.widget = null;
  if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_ID, undefined);
}

function showWidget(ctx: ExtensionContext): void {
  if (!session.book) return;
  session.hidden = false;
  mountWidget(ctx);
  persist();
}

function boss(ctx: ExtensionContext): void {
  stopAuto();
  session.hidden = true;
  persist();
  reader?.close("boss");
  clearWidget(ctx);
}

/** Persist, then repaint whichever surface is active. */
function touch(ctx: ExtensionContext): void {
  persist();
  if (reader) reader.refresh();
  else refreshWidget(ctx);
}

// ------------------------------------------------------------ navigation ----

function advance(ctx: ExtensionContext, pages = 1): boolean {
  const book = session.book;
  if (!book) return false;
  const step = advanceFrom(book, session.pos, session.anchor, activeBodyWidth(), activeLines(), pages);
  session.pos = step.pos;
  session.anchor = step.anchor;
  if (!step.moved) return false;
  touch(ctx);
  return true;
}

function back(ctx: ExtensionContext, pages = 1): void {
  const book = session.book;
  if (!book) return;
  const step = backFrom(book, session.pos, session.anchor, activeBodyWidth(), activeLines(), pages);
  session.pos = step.pos;
  session.anchor = step.anchor;
  touch(ctx);
}

// ---------------------------------------------------------------- search ----

/** Character offset of the current page turn, used to search from the cursor. */
function cursorOffset(): { para: number; at: number } {
  const book = session.book;
  if (!book) return { para: 0, at: 0 };
  return { para: session.pos.para, at: charsAt(book, session.pos, session.anchor, activeBodyWidth()) };
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

/** Jump to hit #`index` (wraps), highlight the query, and report where we are. */
function gotoMatch(ctx: ExtensionContext, index: number): void {
  const book = session.book;
  const search = session.search;
  if (!book || !search || !search.matches.length) return;

  const count = search.matches.length;
  const at = ((index % count) + count) % count;
  const match = search.matches[at];
  search.index = at;

  // Land on the line that actually holds the hit, not on the paragraph top.
  const width = activeBodyWidth();
  session.pos = posFromChars(book, match.para, match.at, width);
  session.anchor = anchorFor(book, session.pos, width);
  session.highlight = search.query;
  touch(ctx);

  const meta = [`${at + 1}/${count}${count >= MATCH_LIMIT ? "+" : ""}`];
  const chapter = chapterAt(book, session.pos);
  if (chapter) meta.push(`ch.${chapter.number}`);
  meta.push(`段 ${Math.min(match.para + 1, book.paragraphs.length)}/${book.paragraphs.length}`);
  notify(ctx, `“${search.query}” · ${meta.join(" · ")}`);
}

/** Headless fallback (no TUI): search and jump to the first hit from here. */
function runFind(ctx: ExtensionContext, rawQuery: string): void {
  const book = session.book;
  if (!book) {
    notify(ctx, "先 /fish-add 加一本书", "warning");
    return;
  }

  const query = normalizeQuery(rawQuery);
  if (!query) {
    notify(ctx, "usage: /fish-find <text>", "warning");
    return;
  }

  const matches = findMatches(book, query);
  if (!matches.length) {
    session.search = null;
    session.highlight = undefined;
    touch(ctx);
    notify(ctx, `没有找到“${query}”`, "warning");
    return;
  }

  session.search = { query, matches, index: 0 };
  const here = cursorOffset();
  gotoMatch(ctx, indexFrom(matches, here.para, here.at, 1));
  if (matches.length >= MATCH_LIMIT) {
    notify(ctx, `只搜到前 ${MATCH_LIMIT} 处，用 alt+n 继续，或换个更长的词`, "warning");
  }
}

/** `alt+n` (and `n`/`N` inside the reader); with no search yet this opens the palette. */
async function stepMatch(ctx: ExtensionContext, direction: 1 | -1): Promise<void> {
  const search = session.search;
  if (!search || !search.matches.length) {
    await openPalette(ctx, "search");
    return;
  }
  gotoMatch(ctx, search.index + direction);
}

/** `/fish-find off`: drop the highlight but stay where we are. */
function clearFind(ctx: ExtensionContext): void {
  session.search = null;
  session.highlight = undefined;
  touch(ctx);
  notify(ctx, "fish: 已取消高亮");
}

/**
 * `off` is the documented way to drop the highlight. Only an exact single word
 * counts, so searching for a book that literally contains "off" still works
 * when other words are present (`/fish-find off by one`).
 */
function wantsClearFind(args: string): boolean {
  return args.trim().toLowerCase() === "off";
}

/**
 * The floating palette: bookshelf + full-text search in one overlay.
 *
 * `/fish-find` opens it in search mode, `/fish-list` (and `/fish` with no book
 * open) in shelf mode. Picking a book opens it and reopens the palette in
 * search mode for that book, so "click a book, search its text, jump" is one
 * uninterrupted flow. `tab` flips modes inside the overlay; Esc closes it.
 */
async function openPalette(
  ctx: ExtensionContext,
  start: PaletteMode,
  initial?: string,
  after?: "read",
): Promise<void> {
  const headless = ctx.mode !== "tui" || !ctx.hasUI;
  if (headless) {
    if (start === "search" && session.book) {
      const term = normalizeQuery(initial ?? "") || session.search?.query || "";
      if (term) runFind(ctx, term);
      else notify(ctx, "usage: /fish-find <text>", "warning");
      return;
    }
    const paths = libraryPaths();
    notify(ctx, paths.length ? paths.map((path) => basename(path)).join("\n") : "no books yet — run /fish-add", "info");
    return;
  }

  if (!shelfEntries().length) {
    notify(ctx, "书库是空的：先 /fish-add 加一本书", "warning");
    return;
  }

  let mode: PaletteMode = start === "search" && !session.book ? "shelf" : start;
  let query = normalizeQuery(initial ?? "");
  let wantReader = false;

  for (;;) {
    const state: PaletteState = { mode, book: session.book, query, from: cursorOffset(), shelf: shelfEntries() };
    const result = await ctx.ui.custom<PaletteResult>(
      (tui, theme, _keybindings, done) =>
        new FishPaletteView(state, theme as WidgetTheme, tui, done),
      { overlay: true, overlayOptions: { width: "70%", minWidth: 44, maxHeight: 16, anchor: "center" } },
    );

    if (!result) {
      if (wantReader) await openReader(ctx);
      return;
    }

    switch (result.kind) {
      case "shelf":
        mode = "shelf";
        query = "";
        continue;
      case "search":
        if (!session.book) {
          mode = "shelf";
          query = "";
          continue;
        }
        mode = "search";
        query = session.search?.query ?? "";
        continue;
      case "open":
        if (!openBook(ctx, result.path)) return;
        wantReader = after === "read";
        mode = "search";
        query = "";
        continue;
      case "match":
        applyPick(ctx, result.query, result.match);
        if (wantReader) await openReader(ctx);
        return;
    }
  }
}

/** Jump to the hit the palette handed back and keep the search active. */
function applyPick(ctx: ExtensionContext, query: string, match: Match): void {
  const book = session.book;
  if (!book) return;

  const matches = findMatches(book, query);
  const index = matches.findIndex((hit) => hit.para === match.para && hit.at === match.at);
  session.search = { query, matches, index: Math.max(0, index) };
  gotoMatch(ctx, session.search.index);
}

function jumpTo(ctx: ExtensionContext, pos: Pos | null): void {
  const book = session.book;
  if (!book || !pos) return;
  session.pos = pos;
  session.anchor = anchorFor(book, pos, activeBodyWidth());
  touch(ctx);
}

function stopAuto(): void {
  if (session.autoTimer) clearInterval(session.autoTimer);
  session.autoTimer = null;
  session.autoSeconds = 0;
}

function startAuto(ctx: ExtensionContext, seconds: number): void {
  if (!session.book) return;
  stopAuto();
  session.autoSeconds = Math.max(2, seconds);
  session.autoTimer = setInterval(() => {
    if (!session.book) return;
    if (!advance(ctx, 1)) {
      stopAuto();
      touch(ctx);
    }
  }, session.autoSeconds * 1000);
  touch(ctx);
}

// ----------------------------------------------------------------- books ----

function openBook(ctx: ExtensionContext, input: string): boolean {
  // Another CLI may have advanced this book since this process started.
  refreshStore();
  const raw = expandHome(input);
  const file = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);
  if (!existsSync(file)) {
    if (ctx.hasUI) ctx.ui.notify(`no such file: ${input}`, "error");
    return false;
  }

  let book: Book;
  try {
    book = loadBook(file);
  } catch (error) {
    if (ctx.hasUI) ctx.ui.notify(`failed to read file: ${String(error)}`, "error");
    return false;
  }
  if (!book.paragraphs.length) {
    if (ctx.hasUI) ctx.ui.notify("file has no readable text", "warning");
    return false;
  }

  stopAuto();
  reader?.close("boss");
  session.book = book;
  session.readerLines = store.config.readerLines;
  // Resume from the stored character offset when we have one: it is stable
  // across terminal widths, unlike the wrapped line index.
  const saved = store.books[file];
  const resumeWidth = widgetBodyWidth(currentWidth());
  session.pos = resumePos(book, saved?.para);
  if (saved?.chars) session.pos = posFromChars(book, session.pos.para, saved.chars, resumeWidth);
  session.anchor = { width: resumeWidth, chars: charsAt(book, session.pos, null, resumeWidth) };
  session.fakeName = fakeNameFor(file);
  session.search = null;
  session.highlight = undefined;
  session.hidden = false;
  session.widget = null;

  persist();
  mountWidget(ctx);
  return true;
}

function libraryPaths(): string[] {
  const set = new Set<string>();
  for (const path of [...store.library, ...(store.last ? [store.last] : []), ...Object.keys(store.books)]) {
    if (existsSync(path)) set.add(path);
  }
  return [...set];
}

/**
 * Library rows for the shelf overlay. Progress and chapter come from the last
 * save, so listing a hundred books never opens a file.
 */
function shelfEntries(): ShelfEntry[] {
  return sortShelf(
    libraryPaths().map((path) => {
      const saved = store.books[path];
      return {
        path,
        title: basename(path),
        percent: saved?.percent ?? 0,
        chapter: saved?.chapter ?? 0,
        reading: path === session.book?.path,
        updatedAt: saved?.updatedAt ?? 0,
      };
    }),
  );
}

async function addBooks(ctx: ExtensionContext, target?: string): Promise<void> {
  let input = (target ?? "").trim();
  if (!input) {
    if (!ctx.hasUI) return;
    const start = store.last ? dirname(store.last) : ctx.cwd;
    const value = await ctx.ui.input("Book file or folder", start);
    if (!value || !value.trim()) return;
    input = value;
  }

  const { files, error } = collectBooks(input);
  if (error) {
    if (ctx.hasUI) ctx.ui.notify(error, "error");
    return;
  }

  let added = 0;
  for (const file of files) {
    if (!store.library.includes(file)) {
      store.library.push(file);
      added++;
    }
  }
  persist();

  if (!ctx.hasUI) return;
  const total = libraryPaths().length;
  if (files.length === 1) {
    ctx.ui.notify(`added ${basename(files[0])} · ${total} book(s) · /fish to read`, "info");
  } else {
    ctx.ui.notify(`added ${added} book(s) from folder · ${total} in library`, "info");
  }
}

// ----------------------------------------------------------- reader mode ----

async function openReader(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui" || !session.book || reader) return;

  clearWidget(ctx);
  const actions: ReaderActions = {
    next: () => advance(ctx, 1),
    prev: () => back(ctx, 1),
    nextChapter: () => session.book && jumpTo(ctx, nextChapterPos(session.book, session.pos)),
    prevChapter: () => session.book && jumpTo(ctx, prevChapterPos(session.book, session.pos)),
    toggleAuto: () => {
      if (session.autoSeconds > 0) {
        stopAuto();
        touch(ctx);
      } else {
        startAuto(ctx, 8);
      }
    },
    find: () => {
      void openPalette(ctx, "search").catch(() => {});
    },
    nextMatch: () => {
      void stepMatch(ctx, 1).catch(() => {});
    },
    prevMatch: () => {
      void stepMatch(ctx, -1).catch(() => {});
    },
    quit: () => {
      stopAuto();
      persist();
      reader?.close("quit");
    },
    boss: () => boss(ctx),
  };

  try {
    await ctx.ui.custom<ReaderResult>((tui, theme, _keybindings, done) => {
      const view = new FishReaderView(session, theme as WidgetTheme, tui, done, actions);
      reader = view;
      return view;
    });
  } finally {
    reader = null;
    if (session.book && !session.hidden) mountWidget(ctx);
  }
}

// -------------------------------------------------------------- commands ----

function statusText(): string {
  if (!session.book) return "notes: nothing open";
  const percent = currentPercent();
  const chapter = chapterAt(session.book, session.pos);
  const chapterText = chapter ? ` · ch.${chapter.number}` : "";
  return `notes: ${percent}%${chapterText} · ${basename(session.book.path)}`;
}

/** `/fish-save`: write the current position now and say where it went. */
function saveNow(ctx: ExtensionContext): void {
  if (!session.book) {
    notify(ctx, "fish: 没有打开的书，没东西可存", "warning");
    return;
  }
  persist();
  const percent = currentPercent();
  const chapter = chapterAt(session.book, session.pos);
  const chapterText = chapter ? ` · ch.${chapter.number}` : "";
  notify(ctx, `fish: 已保存 ${percent}%${chapterText} · ${basename(session.book.path)}`);
}

function parseCount(value: string | undefined, fallback = 1): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  store = loadState(agentDir);

  // First run: the manual is the first book, so `/fish` opens something useful
  // instead of an empty widget. It also refreshes the readable copy when the
  // packaged TUTORIAL.md is newer, so doc fixes reach existing installs.
  // Offer the bundled manual once: an empty library opens it straight away, and
  // anyone else still finds it in the shelf without it taking over `last`.
  const manual = ensureManual(agentDir);
  if (manual && !store.config.manualSeeded) {
    store.config = { ...store.config, manualSeeded: true };
    if (!store.library.includes(manual)) {
      store.library.push(manual);
      if (!store.last) store.last = manual;
    }
    persist();
  }

  pi.on("session_start", (_event, ctx) => {
    stopAuto();
    session = emptySession();
    session.readerLines = store.config.readerLines;

    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(WIDGET_ID, undefined);
    if (store.config.resumeOnStart && store.last && existsSync(store.last)) {
      openBook(ctx, store.last);
    }
    stopWatching?.();
    stopWatching = watchState(agentDir, adoptExternalState);
  });

  pi.on("session_shutdown", () => {
    stopAuto();
    // Pick up a position another CLI saved while this process was busy.
    adoptExternalState(readDiskState(agentDir));
    persist();
    stopWatching?.();
    stopWatching = null;
  });

  const toggleWidget = (ctx: ExtensionContext): void => {
    if (!session.book) return;
    if (session.hidden) showWidget(ctx);
    else boss(ctx);
  };

  pi.registerShortcut("alt+m", {
    description: "Toggle notes widget",
    handler: toggleWidget,
  });

  // alt+h is the "hide" muscle memory some people have; same toggle as alt+m.
  pi.registerShortcut("alt+h", {
    description: "Show/hide notes widget",
    handler: toggleWidget,
  });

  // alt+letter, *not* ctrl+shift+letter: terminals without the Kitty keyboard
  // protocol send ctrl+shift+j as ctrl+j (newline) and ctrl+shift+k as ctrl+k
  // (delete-to-line-end), which corrupts whatever is typed in the editor.
  pi.registerShortcut("alt+j", {
    description: "Notes: next line",
    handler: (ctx) => {
      advance(ctx, 1);
    },
  });

  pi.registerShortcut("alt+k", {
    description: "Notes: previous line",
    handler: (ctx) => {
      back(ctx, 1);
    },
  });

  // One key instead of a `/fish-next` command: after picking a hit you often
  // want the following one, and that should not cost a floating dialog.
  // (`N` for the previous hit exists only inside the reader.)
  pi.registerShortcut("alt+n", {
    description: "Notes: next match",
    handler: async (ctx) => {
      await stepMatch(ctx, 1);
    },
  });

  const addCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    await addBooks(ctx, args);
  };

  const readCommand = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (!session.book) {
      const path = store.last && existsSync(store.last) ? store.last : null;
      if (!path) {
        await openPalette(ctx, "shelf", "", "read");
        return;
      }
      if (!openBook(ctx, path)) return;
    }
    await openReader(ctx);
  };

  const mainCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const trimmed = args.trim();
    const [command, ...rest] = trimmed.split(/\s+/);

    switch (command) {
      case "":
        if (!session.book) {
          const path = store.last && existsSync(store.last) ? store.last : null;
          if (!path) {
            await openPalette(ctx, "shelf", "", "read");
            return;
          }
          if (!openBook(ctx, path)) return;
        }
        await openReader(ctx);
        return;

      case "add":
        await addBooks(ctx, rest.join(" "));
        return;

      case "list":
      case "shelf":
        await openPalette(ctx, "shelf");
        return;

      case "read":
        await openReader(ctx);
        return;

      case "next":
        if (!advance(ctx, parseCount(rest[0]))) {
          stopAuto();
          if (ctx.hasUI) ctx.ui.notify("fish: 已经读到结尾了", "info");
        }
        return;

      case "prev":
        back(ctx, parseCount(rest[0]));
        return;

      case "chapter":
        if (session.book) jumpTo(ctx, nextChapterPos(session.book, session.pos));
        return;

      case "find":
      case "search":
      case "搜索":
      case "查找":
      case "find-list":
      case "hits": {
        // The palette replaced the old find/find-list pair; keep the words
        // working so old muscle memory does not error out.
        const query = rest.join(" ");
        if (wantsClearFind(query)) {
          clearFind(ctx);
          return;
        }
        await openPalette(ctx, "search", query);
        return;
      }

      case "find-next":
      case "next-hit":
      case "n":
        await stepMatch(ctx, 1);
        return;

      case "find-prev":
      case "prev-hit":
        await stepMatch(ctx, -1);
        return;

      case "back-chapter":
        if (session.book) jumpTo(ctx, prevChapterPos(session.book, session.pos));
        return;

      case "auto": {
        if (!session.book) return;
        if (rest[0] === "off" || rest[0] === "0") {
          stopAuto();
          touch(ctx);
          if (ctx.hasUI) ctx.ui.notify("notes: auto-scroll off", "info");
          return;
        }
        const seconds = parseCount(rest[0], 8);
        startAuto(ctx, seconds);
        if (ctx.hasUI) ctx.ui.notify(`notes: auto-scroll every ${seconds}s`, "info");
        return;
      }

      case "hide":
      case "boss":
        boss(ctx);
        return;

      case "show":
        showWidget(ctx);
        return;

      case "lines":
        if (ctx.hasUI) ctx.ui.notify("the widget is always 1 line — use /fish reader-lines <n>", "info");
        return;

      case "reader-lines": {
        const lines = Number.parseInt(rest[0] ?? "", 10);
        if (!Number.isFinite(lines) || lines < 4 || lines > 40) {
          if (ctx.hasUI) ctx.ui.notify("usage: /fish reader-lines <4-40>", "warning");
          return;
        }
        session.readerLines = lines;
        touch(ctx);
        if (ctx.hasUI) ctx.ui.notify(`notes: reader ${lines} lines`, "info");
        return;
      }

      case "resume": {
        const enabled = rest[0] !== "off";
        store.config.resumeOnStart = enabled;
        persist();
        if (ctx.hasUI) ctx.ui.notify(`notes: startup resume ${enabled ? "on" : "off"}`, "info");
        return;
      }

      case "save":
        saveNow(ctx);
        return;

      case "status":
        if (ctx.hasUI) ctx.ui.notify(statusText(), "info");
        return;

      case "close":
        stopAuto();
        reader?.close("boss");
        session.book = null;
        session.search = null;
        session.highlight = undefined;
        clearWidget(ctx);
        persist();
        return;

      default: {
        // The whole argument is the path, so names with spaces work.
        if (openBook(ctx, trimmed)) await openReader(ctx);
      }
    }
  };

  pi.registerCommand("fish", {
    description: "摸鱼：打开阅读模式（/fish <path> 直接打开一本书）",
    handler: mainCommand,
  });

  pi.registerCommand("fish-add", {
    description: "摸鱼：添加 txt/epub 书或整个文件夹",
    handler: addCommand,
  });

  pi.registerCommand("fish-read", {
    description: "摸鱼：打开整页阅读模式",
    handler: readCommand,
  });

  pi.registerCommand("fish-save", {
    description: "摸鱼：立即保存当前阅读进度",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      saveNow(ctx);
    },
  });

  pi.registerCommand("fish-find", {
    description: "摸鱼：搜索全书，悬浮层里选一处直接跳过去（/fish-find off 取消高亮）",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (wantsClearFind(args)) {
        clearFind(ctx);
        return;
      }
      await openPalette(ctx, "search", args);
    },
  });

  pi.registerCommand("fish-list", {
    description: "摸鱼：打开书架悬浮层，选一本（点书名直接搜它的内容）",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await openPalette(ctx, "shelf");
    },
  });
}
