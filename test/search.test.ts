import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBook } from "../src/reader.ts";
import { MATCH_LIMIT, findMatches, indexFrom, normalizeQuery, snippetAt, windowMatches } from "../src/search.ts";

function bookOf(...paragraphs: string[]) {
  return buildBook("/tmp/book.txt", paragraphs, "utf-8");
}

test("normalizeQuery trims and collapses whitespace", () => {
  assert.equal(normalizeQuery("  陈平安  蹲在  "), "陈平安 蹲在");
  assert.equal(normalizeQuery("\t\n"), "");
});

test("findMatches returns document-ordered hits with offsets", () => {
  const book = bookOf("陈平安蹲在墙根下。", "风铃响了，陈平安抬头。", "没有别人。");
  const matches = findMatches(book, "陈平安");

  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map((m) => m.para), [0, 1]);
  assert.deepEqual(matches.map((m) => m.at), [0, 5]);
  assert.deepEqual(matches.map((m) => m.piece), ["陈平安", "陈平安"]);
});

test("findMatches is case-insensitive but reports the original text", () => {
  const book = bookOf("The Sea of Qi", "the sea was calm");
  const matches = findMatches(book, "THE SEA");

  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map((m) => m.piece), ["The Sea", "the sea"]);
});

test("findMatches finds several hits inside one paragraph without overlapping", () => {
  const book = bookOf("aa aa aa");
  const matches = findMatches(book, "aa");

  assert.deepEqual(matches.map((m) => m.at), [0, 3, 6]);
});

test("findMatches survives spaces in the query and empty input", () => {
  const book = bookOf("第一回 少年游", "第一回少年");
  assert.equal(findMatches(book, "  少年  ").length, 2);
  assert.equal(findMatches(book, "   ").length, 0);
  assert.equal(findMatches(book, "").length, 0);
});

test("findMatches stops at the limit", () => {
  const book = bookOf("的".repeat(MATCH_LIMIT + 50));
  assert.equal(findMatches(book, "的").length, MATCH_LIMIT);
  assert.equal(findMatches(book, "的", 10).length, 10);
});

test("snippetAt keeps context around the hit and marks truncation", () => {
  const text = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const at = text.indexOf("JKL");
  const snippet = snippetAt(text, at, 3, 4);
  assert.equal(snippet, "…FGHIJKLMNOP…");

  const whole = snippetAt("陈平安", 0, 3, 10);
  assert.equal(whole, "陈平安");
});

test("indexFrom walks forward and wraps at the end", () => {
  const book = bookOf("陈平安", "中间一段", "陈平安", "陈平安");
  const matches = findMatches(book, "陈平安");

  assert.equal(indexFrom(matches, 0, 0, 1), 1); // after para 0 / offset 0
  assert.equal(indexFrom(matches, 1, 0, 1), 1);
  assert.equal(indexFrom(matches, 3, 0, 1), 0); // wraps to the top
  assert.equal(indexFrom(matches, 99, 0, 1), 0);
});

test("indexFrom walks backward and wraps at the top", () => {
  const book = bookOf("陈平安", "中间一段", "陈平安");
  const matches = findMatches(book, "陈平安");

  assert.equal(indexFrom(matches, 2, 0, -1), 0);
  assert.equal(indexFrom(matches, 0, 0, -1), 1); // wraps to the bottom
  assert.equal(indexFrom([], 0, 0, 1), -1);
});

test("hits on a paragraph boundary are reached from both sides", () => {
  const book = bookOf("结尾提到陈平安", "陈平安开篇");
  const matches = findMatches(book, "陈平安");

  // Cursor sitting exactly on the last hit: forward wraps, backward finds the first.
  assert.equal(indexFrom(matches, 1, 0, 1), 0);
  assert.equal(indexFrom(matches, 1, 0, -1), 0);
  // Cursor just past the first hit: forward moves on, backward comes back to it.
  assert.equal(indexFrom(matches, 0, 5, 1), 1);
  assert.equal(indexFrom(matches, 0, 5, -1), 0);
});

test("windowMatches starts at the cursor and wraps around the book", () => {
  const book = bookOf("陈平安一", "中间", "陈平安二", "陈平安三");
  const all = findMatches(book, "陈平安");

  // Like indexFrom, the walk is strictly ahead of the cursor: sitting exactly
  // on the first hit lists the ones after it.
  const fromTop = windowMatches(book, "陈平安", { para: 0, at: 0 }, 2);
  assert.deepEqual(
    fromTop.hits.map((hit) => hit.para),
    [2, 3],
  );
  assert.equal(fromTop.total, 3);
  assert.equal(fromTop.capped, false);

  const fromMiddle = windowMatches(book, "陈平安", { para: 2, at: 0 }, 2);
  assert.deepEqual(
    fromMiddle.hits.map((hit) => hit.para),
    [3, 0],
  );

  // A cursor after the last hit wraps to the top without dropping anything.
  const fromEnd = windowMatches(book, "陈平安", { para: 3, at: 9 }, 2);
  assert.deepEqual(
    fromEnd.hits.map((hit) => hit.para),
    [0, 2],
  );
});

test("windowMatches keeps at most the requested number of hits", () => {
  const book = bookOf("陈平安", "陈平安", "陈平安", "陈平安", "陈平安", "陈平安", "陈平安");
  const window = windowMatches(book, "陈平安", { para: 0, at: 0 }, 5);

  assert.equal(window.hits.length, 5);
  assert.equal(window.total, 7);
});

test("windowMatches reports when the scan hit its limit", () => {
  const book = bookOf(...Array.from({ length: 40 }, () => "陈平安"));
  const window = windowMatches(book, "陈平安", { para: 0, at: 0 }, 5, 10);

  assert.equal(window.hits.length, 5);
  assert.equal(window.total, 10);
  assert.equal(window.capped, true);
});

test("windowMatches returns nothing for an empty or missing query", () => {
  const book = bookOf("陈平安", "风铃");
  for (const query of ["", "   ", "哈姆雷特"]) {
    const window = windowMatches(book, query, { para: 0, at: 0 });
    assert.deepEqual(window, { hits: [], total: 0, capped: false });
  }
});
