/**
 * The bundled manual: TUTORIAL.md, rewritten as a plain book.
 *
 * The whole point of this plugin is that you read inside the widget, so the
 * documentation is shipped the same way — the first time it runs, the plugin copies
 * the tutorial into the agent directory as `手册.md`, puts it at the top of the
 * bookshelf and opens it. Markdown is stripped down to prose and headings are
 * turned into `第N章 …` so the manual paginates and jumps like a real book.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** File name inside `<agent dir>/fish/`. */
export const MANUAL_FILENAME = "手册.md";

/** The tutorial that ships with the package (src/../TUTORIAL.md). */
export function manualSource(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "TUTORIAL.md");
}

/** Where the readable copy lives. */
export function manualTarget(agentDir: string): string {
  return join(agentDir, "fish", MANUAL_FILENAME);
}

/**
 * Turn the tutorial's markdown into book text: chapters for `## 1. …`,
 * plain lines for sub-headings, tables flattened to `a · b · c`, and all
 * markup (`#`, `**`, backticks, links, rules) removed. Code fences keep their
 * contents — those are the command examples.
 */
export function stripMarkdown(markdown: string): string {
  const out: string[] = [];
  let fence = false;

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");

    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }

    if (!fence) {
      const chapter = line.match(/^#{1,2}\s+(\d+)\.\s*(.+)$/);
      if (chapter) {
        out.push("", `第${chapter[1]}章 ${chapter[2].trim()}`, "");
        continue;
      }

      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (heading) {
        out.push("", heading[1].trim(), "");
        continue;
      }

      if (/^\s*\|/.test(line)) {
        // Table separator rows carry no text; rows become "cell · cell".
        const cells = line
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((cell) => cell.trim())
          .filter((cell) => cell && !/^:?-{2,}:?$/.test(cell));
        if (cells.length) out.push(cells.join(" · "));
        continue;
      }

      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) continue;
    }

    out.push(line.replace(/^\s*>\s?/, ""));
  }

  return `${out
    .join("\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

/**
 * Write (or refresh) the readable manual. Returns its path, or null when the
 * packaged tutorial is missing and no copy exists yet.
 */
export function ensureManual(agentDir: string): string | null {
  const target = manualTarget(agentDir);
  const source = manualSource();

  if (!existsSync(source)) return existsSync(target) ? target : null;

  const stale = !existsSync(target) || statSync(target).mtimeMs < statSync(source).mtimeMs;
  if (stale) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, stripMarkdown(readFileSync(source, "utf8")), "utf8");
  }

  return target;
}
