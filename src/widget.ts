/**
 * Always-on widget. It is *always* exactly one dim line — no header, no second
 * row, no multi-line mode — with the reading percentage tucked against the
 * right edge of that same line. Multi-line reading lives in reader-view.ts and
 * is only opened by a command.
 */

import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

import { atBookEnd } from "./paging.ts";
import { pageAt, percentAt, textWidth, type Book, type Pos } from "./reader.ts";
import { WheelBurst } from "./wheel.ts";

export interface WidgetTheme {
  fg(token: string, text: string): string;
}

export interface WidgetHost {
  requestRender(): void;
}

/** Paging hooks owned by index.ts; supplied only when a book is open. */
export interface WidgetPaging {
  /** Move forward/back by `lines` wrapped lines. */
  advance(lines: number): void;
  back(lines: number): void;
  /** Wrapped lines per focused-reader screen (double-click / alt+wheel). */
  screenLines(): number;
  /**
   * Called before building at a new render width so the session can re-anchor
   * its position. Without it a terminal resize would show a line that skips or
   * repeats a few characters until the next page turn.
   */
  sync?(width: number): void;
}

/** Mutable view of the reader session, owned by index.ts. */
export interface WidgetState {
  book: Book | null;
  pos: Pos;
  fakeName: string;
  /**
   * The unified, character based percentage of the whole book. Supplied by the
   * session so the widget, the reader meta line, the palette and the bookshelf
   * can never disagree; omitted in unit tests, which fall back to percentAt.
   */
  percent?: () => number;
}

const GUTTER = "   ⎿  ";
const MAX_WIDTH = 72;

/** Right-aligned "100%" — fixed so the text start never shifts while reading. */
const PROGRESS_SLOT = 4;
/** Minimum blank columns between the text and the percentage. */
const PROGRESS_GAP = 2;
/** Below this much body the percentage would eat the text, so it is dropped. */
const PROGRESS_MIN_BODY = 30;

/** Body columns the line may use before the percentage takes its slot. */
function baseBodyWidth(width: number): number {
  return Math.min(Math.max(12, width - GUTTER.length), MAX_WIDTH);
}

/** Whether the one line has room for a right-aligned percentage. */
export function showsProgress(width: number): boolean {
  return baseBodyWidth(width) >= PROGRESS_MIN_BODY;
}

/**
 * Body width for the single line. Long lines stand out, so cap them; the
 * percentage keeps the text a slot narrower so the whole line keeps the same
 * footprint as before.
 */
export function widgetBodyWidth(width: number): number {
  const base = baseBodyWidth(width);
  return showsProgress(width) ? Math.max(12, base - PROGRESS_SLOT - PROGRESS_GAP) : base;
}

export class FishWidget {
  readonly host: WidgetHost;
  private readonly theme: WidgetTheme;
  private readonly state: WidgetState;

  private cache: string[] | null = null;
  private cachedWidth = 0;
  private version = 0;
  private cachedVersion = -1;

  /** Last rendered width, used by commands to page without a render. */
  width = 80;

  private readonly paging: WidgetPaging | null;

  /** Last click's button, so a right click after a left click is not a double click. */
  private lastClickButton: TuiMouseEvent["button"] | null = null;

  /** Collapses the extra wheel reports Orca-style terminals send per notch. */
  private readonly wheelBurst = new WheelBurst();

  constructor(state: WidgetState, theme: WidgetTheme, host: WidgetHost, paging: WidgetPaging | null = null) {
    this.state = state;
    this.theme = theme;
    this.host = host;
    this.paging = paging;
  }

  /**
   * Mouse paging for the one dim line:
   *   left click            next line
   *   double click          next screen (readerLines lines)
   *   right / middle / shift+click   previous line (double: screen)
   *   wheel                 one line per notch, alt+wheel one screen
   *
   * The press must be claimed (not handled yet) because Pi turns a press +
   * release on the same component into the "click" event that carries
   * clickCount; an unclaimed press falls through to text selection.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.state.book || !this.paging) return undefined;

    if (event.type === "press") {
      return event.button === "left" || event.button === "right" || event.button === "middle"
        ? { handled: true }
        : undefined;
    }

    if (event.type === "click") {
      // Pi counts double clicks per component and position, not per button, so a
      // right click right after a left click arrives with clickCount 2. Only a
      // repeat of the same button may escalate from one line to one screen.
      const repeat = this.lastClickButton === event.button;
      this.lastClickButton = event.button;
      const clicks = repeat ? (event.clickCount ?? 1) : 1;
      const steps = clicks >= 2 ? this.paging.screenLines() : 1;
      // Right, middle and shift+left go back; everything else advances.
      if (event.button !== "left" || event.shift) this.paging.back(steps);
      else this.paging.advance(steps);
      return { handled: true };
    }

    if (event.type === "wheel") {
      const delta = event.wheelDelta ?? 0;
      if (!delta) return undefined;
      const direction = delta > 0 ? 1 : -1;
      // Some terminals replay one notch as several reports; only the first one
      // may page, or a single notch would skip a handful of lines.
      if (this.wheelBurst.duplicate(direction)) return { handled: true, render: false };
      // `wheelDelta` is not a notch count: Pi's wheel accelerator scales it
      // with event velocity (up to 6 lines per event in fullscreen), so using
      // its magnitude here turned one notch into a jump of several lines.
      // The single-line widget promises one wrapped line per notch, so only
      // the direction matters; alt+wheel still moves a full screen.
      const steps = event.alt ? this.paging.screenLines() : 1;
      if (delta > 0) this.paging.advance(steps);
      else this.paging.back(steps);
      return { handled: true };
    }

    return undefined;
  }

  invalidate(): void {
    this.version++;
    this.cache = null;
  }

  refresh(): void {
    this.invalidate();
    this.host.requestRender();
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
    const { book } = this.state;
    if (!book) return [];

    // Wide enough to be real, and a width change means the stored line index no
    // longer points at the same text.
    if (width >= 20 && width !== this.cachedWidth) this.paging?.sync?.(width);

    const bodyWidth = widgetBodyWidth(width);
    const page = pageAt(book, this.state.pos, bodyWidth, 1);
    const line = page.lines[0];
    if (!line) return [];

    // A lone dim line under the transcript: reads as the tail of some tool
    // output, not as a reader.
    const body = `${GUTTER}${line.text}`;
    if (!showsProgress(width)) return [this.theme.fg("dim", body)];

    // Percentage measured at the width the line was wrapped for, so paging a
    // long paragraph keeps growing smoothly instead of stepping per paragraph.
    // The final page reads 100% even though it stops mid-paragraph.
    const percent =
      this.state.percent?.() ??
      (atBookEnd(book, this.state.pos, bodyWidth, 1) ? 100 : percentAt(book, this.state.pos, bodyWidth));
    const label = `${percent}%`.padStart(PROGRESS_SLOT);
    const pad = Math.max(PROGRESS_GAP, baseBodyWidth(width) - textWidth(line.text) - PROGRESS_SLOT);
    return [this.theme.fg("dim", body) + " ".repeat(pad) + this.theme.fg("muted", label)];
  }

  dispose(): void {
    this.cache = null;
  }
}
