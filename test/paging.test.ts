import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  advanceFrom,
  anchorFor,
  atBookEnd,
  backFrom,
  charsAt,
  charsInParagraph,
  posFromChars,
  reanchor,
} from "../src/paging.ts";
import { loadBook, pageAt, wrapParagraph } from "../src/reader.ts";

function makeBook(): ReturnType<typeof loadBook> {
  const dir = mkdtempSync(join(tmpdir(), "pi-fish-paging-"));
  const file = join(dir, "book.txt");
  const body = [
    "第一章 开始",
    "甲乙丙丁戊己庚辛壬癸".repeat(9),
    "",
    "子丑寅卯辰巳午未申酉".repeat(7),
    "",
    "第二章 继续",
    "天地玄黄宇宙洪荒".repeat(11),
    "",
    "日月盈昃辰宿列张".repeat(5),
  ].join("\n");
  writeFileSync(file, body, "utf8");
  return loadBook(file);
}

const START = { para: 0, line: 0 };

test("one line at a time walks the wrapped text without gaps or repeats", () => {
  const book = makeBook();
  const width = 32;
  const seen: string[] = [];
  let pos = START;
  let anchor = null;

  for (let i = 0; i < 400; i++) {
    const page = pageAt(book, pos, width, 1);
    const line = page.lines[0];
    if (!line) break;
    seen.push(`${line.paragraph}:${line.text}`);
    const step = advanceFrom(book, pos, anchor, width, 1);
    if (!step.moved) break;
    pos = step.pos;
    anchor = step.anchor;
  }

  const expected: string[] = [];
  book.paragraphs.forEach((text, index) => {
    for (const line of wrapParagraph(text, width)) expected.push(`${index}:${line}`);
  });

  // Every wrapped line shows up exactly once, in order, including the tail.
  assert.deepEqual(seen, expected);
});

test("stops cleanly on the last page instead of cycling", () => {
  const book = makeBook();
  const width = 40;
  let pos = START;
  let anchor = null;

  for (let i = 0; i < 500; i++) {
    const step = advanceFrom(book, pos, anchor, width, 3);
    if (!step.moved) break;
    pos = step.pos;
    anchor = step.anchor;
  }

  const page = pageAt(book, pos, width, 3);
  assert.ok(page.lines.length > 0, "last page must still show text");
  assert.ok(atBookEnd(book, pos, width, 3), "should be parked on the tail page");

  // A further advance is a no-op, and the position stays renderable.
  const again = advanceFrom(book, pos, anchor, width, 3);
  assert.equal(again.moved, false);
  assert.deepEqual(again.pos, pos);
  assert.ok(pageAt(book, again.pos, width, 3).lines.length > 0);
});

test("re-anchoring keeps the reading position when the wrap width changes", () => {
  const book = makeBook();
  const narrow = 24;
  const wide = 60;

  let pos = { para: 1, line: 0 };
  for (let i = 0; i < 4; i++) pos = { ...advanceFrom(book, pos, anchorFor(book, pos, narrow), narrow, 1).pos };

  const anchor = anchorFor(book, pos, narrow);
  const before = charsInParagraph(book, pos, narrow);
  assert.ok(before > 0, "position must be inside the paragraph for this test");

  const moved = reanchor(book, pos, anchor, wide);
  const after = charsInParagraph(book, moved, wide);

  // Re-anchoring returns the line that *contains* the old offset, so the new
  // line starts at or before it and the old offset is still inside that line.
  assert.ok(after <= before, `jumped past the text: ${before} -> ${after}`);
  assert.ok(before < after + wide, `lost the text: ${before} -> ${after}`);
  assert.ok(before - after < narrow, `lost more than one narrow line: ${before} -> ${after}`);
});

test("back paging reverses forward paging", () => {
  const book = makeBook();
  const width = 28;
  const lines = 2;

  let pos = { para: 2, line: 0 };
  let anchor = anchorFor(book, pos, width);
  const trail = [pos];
  for (let i = 0; i < 5; i++) {
    const step = advanceFrom(book, pos, anchor, width, lines);
    assert.equal(step.moved, true);
    pos = step.pos;
    anchor = step.anchor;
    trail.push(pos);
  }

  let backPos = pos;
  let backAnchor = anchor;
  for (let i = 5; i > 0; i--) {
    const step = backFrom(book, backPos, backAnchor, width, lines);
    backPos = step.pos;
    backAnchor = step.anchor;
    assert.deepEqual(backPos, trail[i - 1], `step ${i} did not reverse`);
  }
});

test("char offsets survive a resume at another width", () => {
  const book = makeBook();
  const paragraph = 4;
  let pos = { para: paragraph, line: 0 };
  for (let i = 0; i < 3; i++) pos = { ...advanceFrom(book, pos, anchorFor(book, pos, 30), 30, 1).pos };

  const saved = charsAt(book, pos, anchorFor(book, pos, 30), 30);
  const resumed = posFromChars(book, paragraph, saved, 72);
  const wide = wrapParagraph(book.paragraphs[paragraph], 72);
  const lineStart = charsInParagraph(book, resumed, 72);

  // Resuming lands on the line that holds the saved offset: at or before it,
  // and still covering it.
  assert.ok(lineStart <= saved, `resumed past the saved offset: ${lineStart} > ${saved}`);
  assert.ok(saved < lineStart + wide[resumed.line].length, `resumed too early: ${lineStart}`);
  assert.ok(resumed.line < wide.length);
});

test("posFromChars clamps beyond the end of a paragraph", () => {
  const book = makeBook();
  const wrapped = wrapParagraph(book.paragraphs[1], 40);
  const far = posFromChars(book, 1, 1_000_000, 40);
  assert.deepEqual(far, { para: 1, line: wrapped.length - 1 });
});
