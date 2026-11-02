import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { collectBooks, expandHome, filterShelf, sortShelf, type ShelfEntry } from "../src/library.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-fish-lib-"));
}

test("collectBooks accepts a single txt file", () => {
  const dir = tempDir();
  const file = join(dir, "book.txt");
  writeFileSync(file, "hello");

  const result = collectBooks(file);
  assert.deepEqual(result.files, [file]);
  assert.equal(result.error, undefined);
});

test("collectBooks accepts a single epub file", () => {
  const dir = tempDir();
  const file = join(dir, "book.epub");
  writeFileSync(file, "x");

  const result = collectBooks(file);
  assert.deepEqual(result.files, [file]);
  assert.equal(result.error, undefined);
});

test("collectBooks rejects files that are not books", () => {
  const dir = tempDir();
  const file = join(dir, "cover.pdf");
  writeFileSync(file, "x");

  const result = collectBooks(file);
  assert.deepEqual(result.files, []);
  assert.match(result.error ?? "", /only \.txt, \.epub and \.md/);
});

test("collectBooks scans a folder for txt files only", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "b.txt"), "b");
  writeFileSync(join(dir, "a.txt"), "a");
  writeFileSync(join(dir, "c.epub"), "c");
  writeFileSync(join(dir, "cover.jpg"), "x");

  const result = collectBooks(dir);
  assert.equal(result.files.length, 3);
  assert.deepEqual(
    result.files.map((file) => file.split(/[\\/]/).pop()),
    ["a.txt", "b.txt", "c.epub"],
  );
});

test("collectBooks reports missing paths", () => {
  const result = collectBooks(join(tempDir(), "nope"));
  assert.deepEqual(result.files, []);
  assert.match(result.error ?? "", /not found/);
});

test("collectBooks reports empty folders", () => {
  const result = collectBooks(tempDir());
  assert.deepEqual(result.files, []);
  assert.match(result.error ?? "", /no \.txt/);
});

test("expandHome strips quotes and expands ~", () => {
  assert.equal(expandHome('"C:\\books\\a.txt"'), "C:\\books\\a.txt");
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  assert.equal(expandHome("~/books"), `${home}/books`);
});

function shelf(): ShelfEntry[] {
  return [
    { path: "/b/剑来.txt", title: "剑来.txt", percent: 7, chapter: 1, reading: true, updatedAt: 300 },
    { path: "/b/红楼梦.epub", title: "红楼梦.epub", percent: 0, chapter: 0, reading: false, updatedAt: 100 },
    { path: "/b/never.epub", title: "never.epub", percent: 0, chapter: 0, reading: false, updatedAt: 0 },
  ];
}

test("sortShelf puts the most recently read book first", () => {
  assert.deepEqual(sortShelf(shelf()).map((entry) => entry.title), ["剑来.txt", "红楼梦.epub", "never.epub"]);
  const original = shelf();
  sortShelf(original);
  assert.deepEqual(original, shelf(), "sorting must not mutate the library order");
});

test("filterShelf matches file names case-insensitively and ignores blank queries", () => {
  assert.deepEqual(filterShelf(shelf(), "").length, 3);
  assert.deepEqual(filterShelf(shelf(), "  ").length, 3);
  assert.deepEqual(filterShelf(shelf(), "EPUB").map((entry) => entry.title), ["红楼梦.epub", "never.epub"]);
  assert.deepEqual(filterShelf(shelf(), "剑").map((entry) => entry.title), ["剑来.txt"]);
  assert.deepEqual(filterShelf(shelf(), "maybe").length, 0);
});
