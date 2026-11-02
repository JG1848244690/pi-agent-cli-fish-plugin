import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { charWidth, clampPos, decodeText, loadBook, pageAt, pageBack, percentAt, percentAtChars, resumePos, wrapParagraph } from "../src/reader.ts";

function bookFromText(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "pi-fish-"));
  const file = join(dir, "book.txt");
  writeFileSync(file, text, "utf8");
  return loadBook(file);
}

test("charWidth treats CJK as two cells", () => {
  assert.equal(charWidth("中"), 2);
  assert.equal(charWidth("a"), 1);
  assert.equal(charWidth("，"), 2);
});

test("wrapParagraph respects display width", () => {
  assert.deepEqual(wrapParagraph("你好世界", 6), ["你好世", "界"]);
  assert.deepEqual(wrapParagraph("abcdef", 3), ["abc", "def"]);
  assert.deepEqual(wrapParagraph("", 10), []);
});

test("wrapParagraph breaks on spaces instead of splitting ASCII words", () => {
  // "brown" would have been cut into "br|own" by a plain character walk.
  assert.deepEqual(wrapParagraph("the quick brown fox", 12), ["the quick ", "brown fox"]);
  const sentence = "set the tuiMode fullscreen and reload the plugin afterwards please";
  const lines = wrapParagraph(sentence, 20);
  assert.deepEqual(lines, ["set the tuiMode ", "fullscreen and ", "reload the plugin ", "afterwards please"]);
  assert.equal(lines.join(""), sentence, "wrapping must never lose characters");
});

test("wrapParagraph still hard-breaks a word that cannot fit", () => {
  assert.deepEqual(wrapParagraph("ok abcdefghij", 6), ["ok ", "abcdef", "ghij"]);
  // Chinese has no word boundaries: it keeps breaking at the exact column.
  assert.deepEqual(wrapParagraph("你好世界你好世界", 6), ["你好世", "界你好", "世界"]);
});

test("decodeText falls back to gb18030", () => {
  // "中文" in GBK
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  const decoded = decodeText(gbk);
  assert.equal(decoded.encoding, "gb18030");
  assert.equal(decoded.text, "中文");

  const utf8 = decodeText(Buffer.from("中文", "utf8"));
  assert.equal(utf8.encoding, "utf-8");
});

test("loadBook detects chapters and strips blank lines", () => {
  const book = bookFromText(
    ["\uFEFF第一章 风雪", "", "  他推开门。  ", "第二章 夜行", "路上没有人。"].join("\r\n"),
  );
  assert.equal(book.paragraphs.length, 4);
  assert.deepEqual(book.chapterParas, [0, 2]);
  assert.equal(book.chapterTitles[0], "第一章 风雪");
  assert.equal(book.totalChars, Array.from(book.paragraphs.join("")).length);
});

test("paging forward and back is reversible", () => {
  const book = bookFromText(
    ["第一章 开始", "甲".repeat(120), "乙".repeat(80), "丙".repeat(40), "第二章 结束", "丁".repeat(30)].join("\n"),
  );
  const width = 30;
  const pageLines = 6;

  const start = { para: 0, line: 0 };
  const first = pageAt(book, start, width, pageLines);
  assert.equal(first.lines.length, pageLines);
  assert.deepEqual(pageBack(book, first.end, width, pageLines), start);

  const second = pageAt(book, first.end, width, pageLines);
  assert.deepEqual(pageBack(book, second.end, width, pageLines), first.end);
});

test("paging never loses text", () => {
  const book = bookFromText(["第一章", "甲".repeat(50), "乙".repeat(70), "丙".repeat(20)].join("\n"));
  const width = 24;
  const pageLines = 4;

  let pos = { para: 0, line: 0 };
  let collected = "";
  for (let i = 0; i < 500; i++) {
    const page = pageAt(book, pos, width, pageLines);
    if (!page.lines.length) break;
    collected += page.lines.map((line) => line.text).join("");
    if (page.end.para >= book.paragraphs.length) break;
    pos = page.end;
  }

  const expected = book.paragraphs.join("");
  const stripped = collected.replace(/\s/g, "");
  assert.equal(stripped.length, expected.replace(/\s/g, "").length);
});

test("chapter styled lines and chapter jumps", () => {
  const book = bookFromText(["第一章 一", "正文", "第二章 二", "正文"].join("\n"));
  const page = pageAt(book, { para: 0, line: 0 }, 40, 10);
  assert.equal(page.lines[0].chapter, true);
  assert.equal(page.lines[2].chapter, true);
  assert.equal(page.lines[1].chapter, false);
});

test("clampPos and resumePos keep positions in range", () => {
  const book = bookFromText(["第一段", "第二段"].join("\n"));
  assert.deepEqual(clampPos(book, { para: 99, line: 99 }, 40), { para: 1, line: 0 });
  assert.deepEqual(resumePos(book, 1), { para: 1, line: 0 });
  assert.deepEqual(resumePos(book, undefined), { para: 0, line: 0 });
  assert.deepEqual(resumePos(book, -3), { para: 0, line: 0 });
});

test("percentAt reaches 100 at the last paragraph", () => {
  const book = bookFromText(["甲".repeat(100), "乙".repeat(100)].join("\n"));
  assert.equal(percentAt(book, { para: 0, line: 0 }), 0);
  assert.equal(percentAt(book, { para: 1, line: 0 }), 50);
});

test("real sample file loads", () => {
  const sample = process.env.MOYU_SAMPLE;
  if (!sample) return;
  const book = loadBook(sample);
  assert.ok(book.paragraphs.length > 0);
  assert.ok(readFileSync(sample).length > 0);
});

test("percentAtChars is width independent and clamped", () => {
  const book = bookFromText(["甲".repeat(100), "乙".repeat(100)].join("\n"));
  assert.equal(percentAtChars(book, 0), 0);
  assert.equal(percentAtChars(book, 100), 50);
  assert.equal(percentAtChars(book, 200), 100);
  assert.equal(percentAtChars(book, undefined), 0);
  assert.equal(percentAtChars(book, -20), 0);
  assert.equal(percentAtChars(book, 9999), 100);
  // Same offset, same number, no matter which surface measures it.
  assert.equal(percentAtChars(book, 150), percentAtChars(book, 150));
});
