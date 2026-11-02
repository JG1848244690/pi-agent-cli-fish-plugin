/**
 * Focused reading mode. Unlike the always-on widget this component owns the
 * keyboard, so paging is plain keys: space/j/k, [ ], b, q.
 */

import { matchesKey } from "@earendil-works/pi-tui";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

import { chapterAt, pageAt, percentAt, type Book, type Pos } from "./reader.ts";
import { atBookEnd } from "./paging.ts";
import { WheelBurst } from "./wheel.ts";
import type { WidgetHost, WidgetState, WidgetTheme } from "./widget.ts";

const GUTTER = "   ⎿  ";
const CONT = "      ";

export interface ReaderViewState extends WidgetState {
  readerLines: number;
  autoSeconds: number;
  /** Query to highlight in the body; undefined means no highlight. */
  highlight?: string;
}

export interface ReaderActions {
  next(): void;
  prev(): void;
  nextChapter(): void;
  prevChapter(): void;
  toggleAuto(): void;
  /** Ask for a search term and jump to the next hit. */
  find(): void;
  nextMatch(): void;
  prevMatch(): void;
  quit(): void;
  boss(): void;
}

export type ReaderResult = "quit" | "boss";

export class FishReaderView {
  readonly host: WidgetHost;
  private readonly state: ReaderViewState;
  private readonly theme: WidgetTheme;
  private readonly actions: ReaderActions;
  private readonly done: (result: ReaderResult) => void;

  private finished = false;
  private cache: string[] | null = null;
  private cachedWidth = 0;
  private version = 0;
  private cachedVersion = -1;
  /** Collapses the extra wheel reports Orca-style terminals send per notch. */
  private readonly wheelBurst = new WheelBurst();

  /** Last rendered width, used by commands to page without a render. */
  width = 80;

  constructor(
    state: ReaderViewState,
    theme: WidgetTheme,
    host: WidgetHost,
    done: (result: ReaderResult) => void,
    actions: ReaderActions,
  ) {
    this.state = state;
    this.theme = theme;
    this.host = host;
    this.done = done;
    this.actions = actions;
  }

  invalidate(): void {
    this.version++;
    this.cache = null;
  }

  refresh(): void {
    this.invalidate();
    this.host.requestRender();
  }

  close(result: ReaderResult): void {
    if (this.finished) return;
    this.finished = true;
    this.done(result);
  }

  /**
   * Mouse paging, same dialect as the single-line widget: left click next
   * page, right / middle / shift+click previous page, wheel one page per
   * notch, alt+wheel a chapter.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.state.book) return undefined;

    if (event.type === "press") {
      return event.button === "left" || event.button === "right" || event.button === "middle"
        ? { handled: true }
        : undefined;
    }

    if (event.type === "click") {
      if (event.button !== "left" || event.shift) this.actions.prev();
      else this.actions.next();
      return { handled: true };
    }

    if (event.type === "wheel") {
      const delta = event.wheelDelta ?? 0;
      if (!delta) return undefined;
      const direction = delta > 0 ? 1 : -1;
      if (this.wheelBurst.duplicate(direction)) return { handled: true, render: false };
      if (event.alt) {
        if (delta > 0) this.actions.nextChapter();
        else this.actions.prevChapter();
      } else if (delta > 0) {
        this.actions.next();
      } else {
        this.actions.prev();
      }
      return { handled: true };
    }

    return undefined;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.actions.quit();
      return;
    }
    if (data === "b" || data === "B") {
      this.actions.boss();
      return;
    }
    if (
      data === " " ||
      data === "j" ||
      data === "J" ||
      data === "\x1b[C" ||
      data === "\x1b[B" ||
      matchesKey(data, "pageDown")
    ) {
      this.actions.next();
      return;
    }
    if (
      data === "k" ||
      data === "K" ||
      data === "\x1b[D" ||
      data === "\x1b[A" ||
      matchesKey(data, "pageUp")
    ) {
      this.actions.prev();
      return;
    }
    if (data === "]") {
      this.actions.nextChapter();
      return;
    }
    if (data === "[") {
      this.actions.prevChapter();
      return;
    }
    if (data === "/") {
      this.actions.find();
      return;
    }
    if (data === "n") {
      this.actions.nextMatch();
      return;
    }
    if (data === "N") {
      this.actions.prevMatch();
      return;
    }
    if (data === "a" || data === "A") {
      this.actions.toggleAuto();
    }
  }

  render(width: number): string[] {
    this.width = width;
    if (this.cache && this.cachedWidth === width && this.cachedVersion === this.version) {
      return this.cache;
    }
    const lines = this.build(width);
    this.cache = lines;
    this.cachedWidth = width;
    this.cachedVersion = this.version;
    return lines;
  }

  private build(width: number): string[] {
    const { book, pos, fakeName } = this.state;
    if (!book) return [];

    const gutterWidth = Math.max(2, GUTTER.length);
    const bodyWidth = Math.max(12, width - gutterWidth);
    const page = pageAt(book, pos, bodyWidth, Math.max(4, this.state.readerLines));

    const out: string[] = [];
    out.push(`${this.theme.fg("dim", " ● ")}${this.theme.fg("toolTitle", `Read(${fakeName})`)}`);

    page.lines.forEach((line, index) => {
      const prefix = index === 0 ? GUTTER : CONT;
      if (line.chapter) {
        out.push(`${this.theme.fg("dim", prefix)}${this.theme.fg("accent", line.text)}`);
      } else {
        out.push(`${this.theme.fg("dim", prefix)}${this.paint(line.text)}`);
      }
    });

    // The final page is 100% even though its first line is a few characters
    // short of the end of the book.
    const percent =
      this.state.percent?.() ??
      (atBookEnd(book, pos, bodyWidth, Math.max(4, this.state.readerLines))
        ? 100
        : percentAt(book, pos, width, gutterWidth));
    const chapter = chapterAt(book, pos);
    const meta = [`${percent}%`];
    if (chapter) meta.push(`ch.${chapter.number}`);
    meta.push(`${Math.min(pos.para + 1, book.paragraphs.length)}/${book.paragraphs.length}`);
    out.push(this.theme.fg("dim", `${CONT}… ${meta.join("  ·  ")}`));

    const auto = this.state.autoSeconds > 0 ? ` · a auto ${this.state.autoSeconds}s` : "";
    out.push(
      this.theme.fg(
        "dim",
        `${CONT}click next · right prev · / find · n N match · [ ] chapter · b hide · q close${auto}`,
      ),
    );
    return out;
  }

  /** Body text in dim, with every occurrence of the active query in accent. */
  private paint(text: string): string {
    const query = this.state.highlight;
    const dim = this.theme.fg("dim", text);
    if (!query) return dim;

    const needle = query.toLowerCase();
    const haystack = text.toLowerCase();
    if (!haystack.includes(needle)) return dim;

    let out = "";
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) {
        out += this.theme.fg("dim", text.slice(from));
        return out;
      }
      out += this.theme.fg("dim", text.slice(from, at));
      out += this.theme.fg("accent", text.slice(at, at + needle.length));
      from = at + needle.length;
    }
  }

  dispose(): void {
    this.cache = null;
  }
}
