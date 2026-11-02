/**
 * Preview the widget rendering without starting Pi.
 *
 *   node test/preview.ts "..\小说.txt" [width] [pages]
 */

import { basename } from "node:path";
import { loadBook, pageAt, pageBack, percentAt } from "../src/reader.ts";
import { FishWidget } from "../src/widget.ts";

const files = process.argv[2];
if (!files) {
  console.error("usage: node test/preview.ts <novel.txt> [width] [pages]");
  process.exit(1);
}

const width = Number.parseInt(process.argv[3] ?? "80", 10);
const pageLines = Number.parseInt(process.argv[4] ?? "6", 10);

const book = loadBook(files);
const state = {
  book,
  pos: { para: 0, line: 0 },
  fakeName: "session.ts",
  pageLines,
};

const theme = { fg: (_token: string, text: string) => text };
const widget = new FishWidget(state, theme, { requestRender() {} });

console.log(`# ${basename(book.path)}  encoding=${book.encoding}  paragraphs=${book.paragraphs.length}  chapters=${book.chapterParas.length}`);
console.log("");

let page = pageAt(book, state.pos, width - 6, pageLines);
for (const line of widget.render(width)) console.log(line);

console.log("");
console.log("--- next ---");
state.pos = page.end;
page = pageAt(book, state.pos, width - 6, pageLines);
for (const line of widget.render(width)) console.log(line);

console.log("");
console.log("--- prev ---");
state.pos = pageBack(book, state.pos, width - 6, pageLines);
for (const line of widget.render(width)) console.log(line);

console.log("");
console.log(`percent at page 2: ${percentAt(book, state.pos)}%`);
