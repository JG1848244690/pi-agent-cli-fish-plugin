/**
 * OpenCode TUI spike.
 *
 * The novel engine is still the one in the Pi package (`../../src`); it is pure
 * TypeScript with no Pi imports, so the TUI can reuse it while this port is
 * being validated. Once the interaction works, the engine moves into
 * `packages/core` and both plugins depend on it.
 */

import { Plugin } from "@opencode/plugin/tui";

import { basename, isAbsolute, resolve } from "node:path";

import { advanceFrom, anchorFor, atBookEnd, backFrom, charsAt, posFromChars } from "../../../src/paging.ts";
import { loadBook, pageAt, percentAt, type Book, type Pos } from "../../../src/reader.ts";

/** The single-line widget wraps at 66 columns, like the Pi version. */
const BODY_WIDTH = 66;
const GUTTER = "   ⎿  ";
const PROGRESS_SLOT = 6;
const GAP = 2;

interface Saved {
  path: string;
  para: number;
  chars: number;
  hidden: boolean;
  updatedAt: number;
}

export default Plugin.define({
  id: "fish.opencode",
  setup(context) {
    const [saved, updateSaved] = context.storage.store<Saved>("fish", {
      initial: { path: "", para: 0, chars: 0, hidden: false, updatedAt: 0 },
    });

    // Loaded book content. Progress itself lives in `saved`; this is the text.
    let book: Book | null = null;

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ message, variant });

    const currentPos = (): Pos | null => {
      if (!book) return null;
      const para = Math.max(0, Math.min(saved.para, book.paragraphs.length - 1));
      return posFromChars(book, para, saved.chars, BODY_WIDTH);
    };

    const commit = (pos: Pos): void => {
      if (!book) return;
      const chars = charsAt(book, pos, anchorFor(book, pos, BODY_WIDTH), BODY_WIDTH);
      void updateSaved((draft) => {
        draft.para = pos.para;
        draft.chars = chars;
        draft.updatedAt = Date.now();
      });
    };

    const open = (raw: string, resume?: { para: number; chars: number }): boolean => {
      const input = raw.trim() || saved.path;
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
      const para = Math.max(0, Math.min(resume?.para ?? 0, loaded.paragraphs.length - 1));
      const chars = Math.max(0, resume?.chars ?? 0);
      void updateSaved((draft) => {
        draft.path = file;
        draft.para = para;
        draft.chars = chars;
        draft.hidden = false;
        draft.updatedAt = Date.now();
      });
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
        commit(next.pos);
      } else {
        commit(backFrom(book, pos, null, BODY_WIDTH, 1, 1).pos);
      }
    };

    const save = (): void => {
      if (!book) {
        toast("fish: 没有打开的书", "warning");
        return;
      }
      const pos = currentPos();
      const percent = pos ? (atBookEnd(book, pos, BODY_WIDTH, 1) ? 100 : percentAt(book, pos, BODY_WIDTH)) : 0;
      void updateSaved((draft) => {
        draft.updatedAt = Date.now();
      });
      toast(`fish: 已保存 ${percent}% · ${basename(book.path)}`, "success");
    };

    const close = (): void => {
      book = null;
      void updateSaved((draft) => {
        draft.path = "";
        draft.para = 0;
        draft.chars = 0;
        draft.hidden = false;
        draft.updatedAt = Date.now();
      });
      toast("fish: 已合上", "info");
    };

    const toggle = (): void => {
      if (!book) return;
      void updateSaved((draft) => {
        draft.hidden = !draft.hidden;
      });
    };

    // Resume the last book on TUI start.
    if (saved.path) open(saved.path, { para: saved.para, chars: saved.chars });

    context.ui.slot({
      append: "session.composer.top",
      render: () => {
        if (saved.hidden || !book) return <text> </text>;
        const pos = currentPos();
        const line = pos ? pageAt(book, pos, BODY_WIDTH, 1).lines[0] : undefined;
        if (!pos || !line) return <text> </text>;
        const percent = atBookEnd(book, pos, BODY_WIDTH, 1) ? 100 : percentAt(book, pos, BODY_WIDTH);
        const body = `${GUTTER}${line.text}`;
        const pad = Math.max(GAP, BODY_WIDTH + GUTTER.length - line.text.length - PROGRESS_SLOT);
        return <text fg={context.theme.text.muted}>{`${body}${" ".repeat(pad)}${`${percent}%`.padStart(PROGRESS_SLOT)}`}</text>;
      },
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
          run: () => toggle(),
        },
        {
          id: "fish.open",
          title: "Fish: open a book",
          slash: { name: "fish", aliases: ["fish-open"], arguments: true },
          run: (input) => {
            if (input?.trim()) open(input);
            else if (saved.path) open(saved.path, { para: saved.para, chars: saved.chars });
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
      bindings: ["fish.next", "fish.prev", "fish.toggle"],
    }));
  },
});
