/**
 * The floating palette: a bookshelf and a full-text search box in one overlay.
 *
 * Opened by `/fish` (shelf), `/fish-find` (search) and by `/` in the reader (it
 * stacks on top of the reader, so the page stays visible behind it). It is a
 * plain overlay component rather than one of pi's stock dialogs so it can be
 * large, re-query on every keystroke, and list the hits closest to the reader.
 *
 * Shelf mode: type to narrow the file list, ↑/↓ (wheel) to choose, Enter or a
 * click to open that book and switch straight into searching its text.
 * Search mode: type to search, ↑/↓ to choose, Enter or a click to jump there.
 * `tab` flips between the two, Esc cancels.
 */

import { Input, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

import { basename } from "node:path";

import { filterShelf, type ShelfEntry } from "./library.ts";
import { chapterAt, percentAtChars, textWidth, type Book } from "./reader.ts";
import { PICK_COUNT, windowMatches, type Match } from "./search.ts";
import { WheelBurst } from "./wheel.ts";

/** What the palette hands back. */
export type PaletteResult =
  | { kind: "match"; query: string; match: Match }
  | { kind: "open"; path: string }
  | { kind: "shelf" }
  | { kind: "search" }
  | null;

export type PaletteMode = "search" | "shelf";

export interface PaletteState {
  mode: PaletteMode;
  /** The open book; null when nothing is loaded yet (shelf only). */
  book: Book | null;
  /** Query the box opens with (empty starts blank). */
  query: string;
  /** Where the reader is now: hits are listed from here on, wrapping. */
  from: { para: number; at: number };
  /** Library rows, already sorted. */
  shelf: ShelfEntry[];
}

/** The slice of pi's Theme we use. */
export interface PaletteTheme {
  fg(token: string, text: string): string;
  bold?(text: string): string;
}

/** Just enough of the TUI to ask for a repaint. */
export interface PaletteHost {
  requestRender(): void;
}

/** Rows above the first result: border, title, input, gap. */
const RESULTS_TOP = 4;

export class FishPaletteView implements Component {
  private readonly state: PaletteState;
  private readonly theme: PaletteTheme;
  private readonly host: PaletteHost;
  private readonly done: (result: PaletteResult) => void;
  private readonly input: Input;

  /** Visible rows: hits in search mode, books in shelf mode. */
  private hits: Match[] = [];
  private books: ShelfEntry[] = [];
  private total = 0;
  private capped = false;
  private selected = 0;
  private queried: string | null = null;
  /** Collapses the extra wheel reports Orca-style terminals send per notch. */
  private readonly wheelBurst = new WheelBurst();

  constructor(state: PaletteState, theme: PaletteTheme, host: PaletteHost, done: (result: PaletteResult) => void) {
    this.state = state;
    this.theme = theme;
    this.host = host;
    this.done = done;

    this.input = new Input({
      prompt: theme.fg("accent", "> "),
      placeholder:
        state.mode === "shelf" ? "输入书名过滤，⏎ 打开并搜索内容" : "输入关键词，下面实时列出 5 处命中",
      placeholderStyle: (text) => theme.fg("dim", text),
    });
    this.input.focused = true;
    this.input.setValue(state.query);
    this.input.onSubmit = () => this.choose();
    this.input.onEscape = () => this.cancel();

    this.recompute();
  }

  invalidate(): void {
    // nothing is cached — the palette re-renders from state every frame
  }

  render(width: number): string[] {
    const inner = Math.max(12, width - 2);
    const rows: string[] = [this.rule(width), this.row(this.title(), inner), ` ${this.input.render(inner)[0]}`, ""];
    const count = this.state.mode === "shelf" ? this.books.length : this.hits.length;

    for (let slot = 0; slot < PICK_COUNT; slot++) {
      let text = "";
      if (slot < count) text = this.state.mode === "shelf" ? this.bookRow(slot, inner) : this.hitRow(slot);
      else if (slot === 0) text = this.empty();
      rows.push(this.row(text, inner));
    }

    rows.push("");
    rows.push(this.row(this.theme.fg("dim", this.hint()), inner));
    rows.push(this.rule(width));
    return rows;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      this.move(1);
      return;
    }
    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      this.choose();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.cancel();
      return;
    }
    if (matchesKey(data, "tab")) {
      this.done(this.state.mode === "shelf" ? { kind: "search" } : { kind: "shelf" });
      return;
    }

    this.input.handleInput(data);
    this.recompute();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "press") {
      // Claim the press: without this no click is ever synthesized.
      return event.button === "left" || event.button === "right" ? { handled: true } : undefined;
    }

    if (event.type === "wheel") {
      const delta = event.wheelDelta ?? 0;
      if (!delta) return undefined;
      const direction = delta > 0 ? 1 : -1;
      if (this.wheelBurst.duplicate(direction)) return { handled: true, render: false };
      this.move(direction);
      return { handled: true };
    }

    if (event.type !== "click") return undefined;
    const slot = event.y - RESULTS_TOP;
    const count = this.state.mode === "shelf" ? this.books.length : this.hits.length;
    if (slot >= 0 && slot < count) {
      this.selected = slot;
      this.choose();
    }
    return { handled: true };
  }

  // ------------------------------------------------------------ internals ----

  private recompute(): void {
    const query = this.input.getValue();
    if (query === this.queried) return;
    this.queried = query;

    if (this.state.mode === "shelf") {
      this.books = filterShelf(this.state.shelf, query);
      this.total = this.books.length;
      // Opening on the book you are reading is the useful default.
      const reading = this.books.findIndex((entry) => entry.reading);
      this.selected = reading >= 0 && !query ? Math.min(reading, PICK_COUNT - 1) : 0;
    } else if (this.state.book) {
      const window = windowMatches(this.state.book, query, this.state.from, PICK_COUNT);
      this.hits = window.hits;
      this.total = window.total;
      this.capped = window.capped;
      this.selected = 0;
    }

    this.host.requestRender();
  }

  private visibleCount(): number {
    return Math.min(PICK_COUNT, this.state.mode === "shelf" ? this.books.length : this.hits.length);
  }

  private move(direction: 1 | -1): void {
    const count = this.visibleCount();
    if (!count) return;
    this.selected = ((this.selected + direction) % count + count) % count;
    this.host.requestRender();
  }

  private choose(): void {
    if (this.state.mode === "shelf") {
      const entry = this.books[this.selected];
      if (!entry) {
        this.cancel();
        return;
      }
      this.done({ kind: "open", path: entry.path });
      return;
    }

    const match = this.hits[this.selected];
    if (!match) {
      this.cancel();
      return;
    }
    this.done({ kind: "match", query: this.queried ?? "", match });
  }

  private cancel(): void {
    this.done(null);
  }

  private rule(width: number): string {
    return this.theme.fg("border", "─".repeat(Math.max(4, width)));
  }

  private row(text: string, inner: number): string {
    return ` ${truncateToWidth(text, inner, "…", true)}`;
  }

  private title(): string {
    const word = this.state.mode === "shelf" ? "书架" : "搜索";
    const label = this.theme.bold ? this.theme.bold(word) : word;
    const head = this.theme.fg("accent", label);
    if (this.state.mode === "shelf") {
      const total = this.state.shelf.length;
      const shown = this.queried ? `${this.total}/${total}` : `${total}`;
      return `${head}${this.theme.fg("dim", ` · ${shown} 本`)}`;
    }
    // Naming the open book makes it obvious which text you are searching.
    const name = this.state.book ? basename(this.state.book.path) : "";
    if (!this.queried) return `${head}${name ? this.theme.fg("dim", ` · ${name}`) : ""}`;
    const count = `${this.total}${this.capped ? "+" : ""} 处命中`;
    return `${head}${this.theme.fg("dim", name ? ` · ${name} · ${count}` : ` · ${count}`)}`;
  }

  private hint(): string {
    return this.state.mode === "shelf"
      ? "↑↓ 选择 · ⏎ 打开并搜索 · tab 搜索当前这本 · esc 取消"
      : "↑↓ 选择 · ⏎ 跳转 · tab 书架 · esc 取消";
  }

  private empty(): string {
    if (this.state.mode === "shelf") {
      return this.theme.fg("dim", this.state.shelf.length ? "没有匹配的书名" : "书库是空的：用 /fish-add 加一本");
    }
    if (!this.queried) return this.theme.fg("dim", "输入关键词开始搜索");
    return this.theme.fg("dim", `没有找到“${this.queried}”`);
  }

  /** `→` cursor, `*` for the book being read, then name, progress, chapter. */
  private bookRow(slot: number, inner: number): string {
    const entry = this.books[slot];
    const selected = slot === this.selected;
    const mark = selected ? "→" : entry.reading ? "*" : " ";
    const percent = `${entry.percent}%`.padStart(4, " ");
    const chapter = entry.chapter ? `  ch.${entry.chapter}` : "";
    const columns = Math.max(10, inner - 2 - 1 - 4 - 6);
    const name = truncateToWidth(entry.title, columns, "…");
    const padded = name + " ".repeat(Math.max(0, columns - textWidth(name)));
    const head = `${mark} ${padded} ${percent}${chapter}`;
    return this.theme.fg(selected ? "accent" : entry.reading ? "text" : "dim", head);
  }

  private hitRow(slot: number): string {
    const match = this.hits[slot];
    const selected = slot === this.selected;
    const percent = `${percentAtChars(this.state.book, this.bookChars(match))}%`;
    // Books without chapter headings would waste six columns on blank padding,
    // so the column only exists when something can fill it.
    const chapter = this.hasChapters() ? this.chapter(match).padEnd(6, " ") : "";
    const head = `${selected ? "→" : " "} ${slot + 1}  ${percent.padStart(4, " ")}  ${chapter}`;
    const base = selected ? "text" : "dim";
    return `${this.theme.fg(selected ? "accent" : "dim", head)}${this.paint(match.snippet, base)}`;
  }

  /** Character offset of a hit, so its percentage matches the unified metric. */
  private bookChars(match: Match): number {
    const book = this.state.book;
    if (!book) return 0;
    return (book.prefixChars[match.para] ?? 0) + match.at;
  }

  private chapter(match: Match): string {
    const book = this.state.book;
    if (!book) return "";
    const chapter = chapterAt(book, { para: match.para, line: 0 });
    return chapter ? `ch.${chapter.number}` : "";
  }

  private hasChapters(): boolean {
    return this.hits.some((match) => this.chapter(match) !== "");
  }

  /** Color the query inside a snippet, the rest in `base`. */
  private paint(snippet: string, base: string): string {
    const query = this.queried ?? "";
    const at = query ? snippet.toLowerCase().indexOf(query.toLowerCase()) : -1;
    if (at < 0) return this.theme.fg(base, snippet);

    const before = snippet.slice(0, at);
    const found = snippet.slice(at, at + query.length);
    const after = snippet.slice(at + query.length);
    return `${this.theme.fg(base, before)}${this.theme.fg("accent", found)}${this.theme.fg(base, after)}`;
  }
}
