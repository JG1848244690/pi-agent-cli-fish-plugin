/**
 * OpenCode TUI spike.
 *
 * Progress is deliberately stored in the same file as the Pi plugin
 * (`<agent dir>/fish/state.json`) through the shared state module, so reading a
 * book in Pi and then opening it in OpenCode lands on the same line. The state
 * module's lock + per-book merge keeps two running instances from rolling each
 * other back.
 *
 * The novel engine is also reused from the Pi package for now; both move to
 * `packages/core` once this interaction is validated.
 */

import { Plugin } from "@opencode/plugin/tui";

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { advanceFrom, anchorFor, atBookEnd, backFrom, charsAt, posFromChars } from "../../../src/paging.ts";
import { chapterAt, loadBook, pageAt, percentAt, type Book, type Pos } from "../../../src/reader.ts";
import { loadState, saveState, watchState, type FishState } from "../../../src/state.ts";

/** The single-line widget wraps at 66 columns, like the Pi version. */
const BODY_WIDTH = 66;
const GUTTER = "   ⎿  ";
const PROGRESS_SLOT = 6;
const GAP = 2;

/** Pi's agent directory, so both plugins resolve the same fish/state.json. */
function piAgentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!env) return join(homedir(), ".pi", "agent");
  if (env === "~") return homedir();
  if (env.startsWith("~/") || env.startsWith("~\\")) return join(homedir(), env.slice(2));
  return env;
}

export default Plugin.define({
  id: "fish.opencode",
  setup(context) {
    const agentDir = piAgentDir();
    let piState: FishState = loadState(agentDir);

    // UI-only state: the displayed position and whether the line is hidden.
    // Kept in memory so the slot re-renders on every page turn; the durable
    // progress itself lives in Pi's state file.
    const [view, updateView] = context.storage.memory("fish.view", {
      initial: { para: 0, chars: 0, hidden: false },
    });

    // Loaded book content. Progress itself lives in `view` / Pi's state file.
    let book: Book | null = null;
    let unregisterSlot: (() => void) | null = null;
    /** Timestamp of the last entry this process wrote, to ignore our own watcher event. */
    let lastSavedAt = 0;

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ message, variant });

    const currentPos = (): Pos | null => {
      if (!book) return null;
      const para = Math.max(0, Math.min(view.para, book.paragraphs.length - 1));
      return posFromChars(book, para, view.chars, BODY_WIDTH);
    };

    const percentOf = (pos: Pos): number =>
      book ? (atBookEnd(book, pos, BODY_WIDTH, 1) ? 100 : percentAt(book, pos, BODY_WIDTH)) : 0;

    /** Write the current line into Pi's state file (merge happens there). */
    const persist = (): void => {
      if (!book) return;
      const pos = currentPos();
      if (!pos) return;
      const chars = charsAt(book, pos, anchorFor(book, pos, BODY_WIDTH), BODY_WIDTH);
      const chapter = chapterAt(book, pos);
      const updatedAt = Date.now();
      piState.last = book.path;
      piState.books[book.path] = {
        para: pos.para,
        chars,
        percent: percentOf(pos),
        ...(chapter ? { chapter: chapter.number } : {}),
        updatedAt,
      };
      if (!piState.library.includes(book.path)) piState.library.push(book.path);
      saveState(agentDir, piState);
      lastSavedAt = updatedAt;
    };

    const setPos = (pos: Pos): void => {
      if (!book) return;
      const chars = charsAt(book, pos, anchorFor(book, pos, BODY_WIDTH), BODY_WIDTH);
      updateView((draft) => {
        draft.para = pos.para;
        draft.chars = chars;
      });
      persist();
    };

    const open = (raw: string, resume?: { para: number; chars: number }): boolean => {
      // Refresh `last`/`books` so a book opened in Pi is picked up here too.
      piState = loadState(agentDir);
      const input = raw.trim() || piState.last || "";
      if (!input) {
        toast("fish: 用法 /fish <文件路径>", "warning");
        return false;
      }
      const file = isAbsolute(input) ? input : resolve(context.location?.directory ?? process.cwd(), input);
      let loaded: Book;
      try {
        loaded = loadBook(file);
      } catch (error) {
        toast(`fish: 打不开 ${file} — ${String(error)}`, "error");
        return false;
      }

      book = loaded;
      const saved = resume ?? piState.books[file];
      const para = Math.max(0, Math.min(saved?.para ?? 0, loaded.paragraphs.length - 1));
      const chars = Math.max(0, saved?.chars ?? 0);
      updateView((draft) => {
        draft.para = para;
        draft.chars = chars;
        draft.hidden = false;
      });
      mount();
      persist();
      toast(`fish: ${basename(file)}`, "success");
      return true;
    };

    const step = (direction: 1 | -1): void => {
      const pos = currentPos();
      if (!book || !pos) {
        toast("fish: 先 /fish <文件路径> 打开一本书", "warning");
        return;
      }
      if (direction > 0) {
        const next = advanceFrom(book, pos, null, BODY_WIDTH, 1, 1);
        if (!next.moved) {
          toast("fish: 已经读到结尾了", "info");
          return;
        }
        setPos(next.pos);
      } else {
        setPos(backFrom(book, pos, null, BODY_WIDTH, 1, 1).pos);
      }
    };

    const save = (): void => {
      if (!book) {
        toast("fish: 没有打开的书", "warning");
        return;
      }
      const pos = currentPos();
      persist();
      toast(`fish: 已保存 ${pos ? percentOf(pos) : 0}% · ${basename(book.path)}`, "success");
    };

    const close = (): void => {
      if (book) persist();
      book = null;
      unmount();
      toast("fish: 已合上", "info");
    };

    const hide = (): void => {
      if (!book) return;
      updateView((draft) => {
        draft.hidden = true;
      });
      unmount();
    };

    const show = (): void => {
      if (!book) return;
      updateView((draft) => {
        draft.hidden = false;
      });
      mount();
    };

    const toggle = (): void => {
      if (!book) return;
      if (view.hidden) show();
      else hide();
    };

    const mount = (): void => {
      if (unregisterSlot) return;
      unregisterSlot = context.ui.slot({
        append: "session.composer.top",
        render: () => {
          if (!book || view.hidden) return null;
          const pos = currentPos();
          const line = pos ? pageAt(book, pos, BODY_WIDTH, 1).lines[0] : undefined;
          if (!pos || !line) return null;
          const percent = percentOf(pos);
          const body = `${GUTTER}${line.text}`;
          const pad = Math.max(GAP, BODY_WIDTH + GUTTER.length - line.text.length - PROGRESS_SLOT);
          return <text fg={context.theme.text.muted}>{`${body}${" ".repeat(pad)}${`${percent}%`.padStart(PROGRESS_SLOT)}`}</text>;
        },
      });
    };

    const unmount = (): void => {
      unregisterSlot?.();
      unregisterSlot = null;
    };

    // Resume the last book on TUI start when Pi's resume setting allows it.
    if (piState.config.resumeOnStart && piState.last && existsSync(piState.last)) {
      open(piState.last);
    }

    // Live sync with Pi (and other OpenCode windows) through the shared file.
    // Adopting a position never writes back, so the two processes do not echo.
    const stopWatching = watchState(agentDir, (disk) => {
      piState = disk;
      const current = book;
      if (!current) return;
      const entry = disk.books[current.path];
      if (!entry) return;
      if (entry.para === view.para && (entry.chars ?? 0) === view.chars) {
        lastSavedAt = Math.max(lastSavedAt, entry.updatedAt);
        return;
      }
      if (entry.updatedAt < lastSavedAt) return;
      const para = Math.max(0, Math.min(entry.para, current.paragraphs.length - 1));
      updateView((draft) => {
        draft.para = para;
        draft.chars = Math.max(0, entry.chars ?? 0);
      });
      lastSavedAt = entry.updatedAt;
    });

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "fish.next",
          title: "Fish: next line",
          bind: "alt+j",
          slash: { name: "fish-next" },
          run: () => step(1),
        },
        {
          id: "fish.prev",
          title: "Fish: previous line",
          bind: "alt+k",
          slash: { name: "fish-prev" },
          run: () => step(-1),
        },
        {
          id: "fish.toggle",
          title: "Fish: show/hide",
          bind: "alt+m",
          slash: { name: "fish-toggle" },
          run: () => toggle(),
        },
        {
          id: "fish.toggle.h",
          title: "Fish: show/hide",
          bind: "alt+h",
          run: () => toggle(),
        },
        {
          id: "fish.hide",
          title: "Fish: hide the line",
          slash: { name: "fish-hide" },
          run: () => hide(),
        },
        {
          id: "fish.show",
          title: "Fish: show the line",
          slash: { name: "fish-show" },
          run: () => show(),
        },
        {
          id: "fish.open",
          title: "Fish: open a book",
          slash: { name: "fish", aliases: ["fish-open"], arguments: true },
          run: (input) => {
            open(input ?? "");
          },
        },
        {
          id: "fish.save",
          title: "Fish: save progress",
          slash: { name: "fish-save" },
          run: () => save(),
        },
        {
          id: "fish.close",
          title: "Fish: close the book",
          slash: { name: "fish-close" },
          run: () => close(),
        },
      ],
      bindings: ["fish.next", "fish.prev", "fish.toggle", "fish.toggle.h"],
    }));

    return () => {
      stopWatching();
      unmount();
    };
  },
});
