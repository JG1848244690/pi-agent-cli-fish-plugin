import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ensureManual, MANUAL_FILENAME, manualSource, manualTarget, stripMarkdown } from "../src/manual.ts";

test("stripMarkdown turns numbered sections into chapters", () => {
  const text = stripMarkdown(["# 标题", "## 1. 装好它", "先装再说", "## 2. 上手"].join("\n"));
  assert.match(text, /第1章 装好它/);
  assert.match(text, /第2章 上手/);
  assert.ok(text.startsWith("标题"), "the H1 stays as the book's opening line");
  assert.ok(!text.includes("#"), "no hash marks left");
});

test("stripMarkdown drops sub-heading marks but keeps the words", () => {
  const text = stripMarkdown("### 鼠标\n\n点击翻页");
  assert.match(text, /鼠标/);
  assert.ok(!text.includes("#"));
});

test("stripMarkdown keeps fenced code and removes the fence markers", () => {
  const text = stripMarkdown(["```", "/fish-find 陈平安", "// 注释", "```"].join("\n"));
  assert.equal(text.trim(), ["/fish-find 陈平安", "// 注释"].join("\n"));
});

test("stripMarkdown flattens tables and drops separator rows", () => {
  const text = stripMarkdown(["| 键 | 作用 |", "|---|---|", "| `space` | 下一页 |"].join("\n"));
  assert.equal(text.trim(), ["键 · 作用", "space · 下一页"].join("\n"));
});

test("stripMarkdown removes emphasis, inline code, links and rules", () => {
  const text = stripMarkdown(
    ["**粗体** 和 `代码`", "", "[教程](TUTORIAL.md) 里写了", "", "---", "", "![](.github/shot.png)"].join("\n"),
  );
  assert.equal(text.trim(), ["粗体 和 代码", "", "教程 里写了"].join("\n"));
});

test("stripMarkdown keeps blockquote text without the marker", () => {
  assert.equal(stripMarkdown("> 鼠标只在全屏模式可用").trim(), "鼠标只在全屏模式可用");
});

test("stripMarkdown collapses the blank-line runs markdown leaves behind", () => {
  const text = stripMarkdown(["a", "", "", "", "b"].join("\n"));
  assert.equal(text.trim(), ["a", "", "b"].join("\n"));
});

test("ensureManual writes the readable copy next to the state file", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-fish-manual-"));
  const target = ensureManual(agentDir);

  assert.ok(target, "a copy should be produced from the packaged TUTORIAL.md");
  assert.equal(target, manualTarget(agentDir));
  assert.equal(target, join(agentDir, "fish", MANUAL_FILENAME));
  assert.ok(existsSync(target));

  const copy = readFileSync(target, "utf8");
  assert.ok(copy.length > 500, "the manual is not empty");
  assert.ok(copy.includes("第1章"), "sections became chapters");
  assert.ok(!/^#/m.test(copy), "no markdown headings left");
  assert.ok(!copy.includes("```"), "no code fences left");
  assert.ok(copy.includes("fish-find"), "command examples survive");
});

test("ensureManual refreshes a copy older than the tutorial", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-fish-manual-"));
  const target = manualTarget(agentDir);
  assert.ok(ensureManual(agentDir));

  // Older than the packaged tutorial → rewritten on the next load.
  writeFileSync(target, "stale\n", "utf8");
  utimesSync(target, new Date(1), new Date(1));
  const refreshed = ensureManual(agentDir);
  assert.equal(refreshed, target);
  assert.ok(readFileSync(target, "utf8").length > 500);
});

test("ensureManual reuses a copy that is already current", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-fish-manual-"));
  const target = manualTarget(agentDir);
  assert.ok(ensureManual(agentDir));
  writeFileSync(target, "edited by hand\n", "utf8");
  utimesSync(target, new Date(), new Date());
  assert.equal(ensureManual(agentDir), target);
  assert.equal(readFileSync(target, "utf8"), "edited by hand\n", "a fresh copy is left alone");
});

test("the packaged tutorial exists where the manual looks for it", () => {
  assert.ok(existsSync(manualSource()), `${manualSource()} should ship with the package`);
});
