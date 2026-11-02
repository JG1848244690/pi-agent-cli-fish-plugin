import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadState, migrateLegacyDir, saveState, statePath } from "../src/state.ts";

const tempAgent = () => mkdtempSync(join(tmpdir(), "pi-fish-state-"));

test("state lives under fish/", () => {
  const agentDir = tempAgent();
  assert.equal(statePath(agentDir), join(agentDir, "fish", "state.json"));
});

test("a pre-rename moyu folder is migrated, progress intact", () => {
  const agentDir = tempAgent();
  const legacy = join(agentDir, "moyu");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(
    join(legacy, "state.json"),
    JSON.stringify({ last: "/b/剑来.txt", library: ["/b/剑来.txt"], books: { "/b/剑来.txt": { para: 12, chars: 40 } }, config: {} }),
  );
  writeFileSync(join(legacy, "手册.md"), "手册");

  migrateLegacyDir(agentDir);

  assert.equal(existsSync(legacy), false, "old folder is gone");
  assert.equal(existsSync(join(agentDir, "fish", "手册.md")), true, "handwritten manual moved too");
  const store = loadState(agentDir);
  assert.equal(store.last, "/b/剑来.txt");
  assert.deepEqual(store.library, ["/b/剑来.txt"]);
  assert.equal(store.books["/b/剑来.txt"]?.para, 12);
});

test("migration never overwrites an existing fish folder", () => {
  const agentDir = tempAgent();
  mkdirSync(join(agentDir, "moyu"), { recursive: true });
  writeFileSync(join(agentDir, "moyu", "state.json"), JSON.stringify({ library: ["/old.txt"], books: {}, config: {} }));
  saveState(agentDir, { library: ["/new.txt"], books: {}, config: { readerLines: 15, placement: "aboveEditor", resumeOnStart: true } });

  migrateLegacyDir(agentDir);

  assert.deepEqual(loadState(agentDir).library, ["/new.txt"]);
  assert.equal(existsSync(join(agentDir, "moyu")), true, "legacy folder is left alone for the user");
});

test("a fresh install simply has no state file", () => {
  const agentDir = tempAgent();
  assert.equal(existsSync(statePath(agentDir)), false);
  assert.deepEqual(loadState(agentDir).library, []);
});

test("round-trips progress and config", () => {
  const agentDir = tempAgent();
  saveState(agentDir, {
    last: "/b/a.epub",
    library: ["/b/a.epub"],
    books: { "/b/a.epub": { para: 3, chars: 9, percent: 12, chapter: 2, updatedAt: 7 } },
    config: { readerLines: 20, placement: "belowEditor", resumeOnStart: false, manualSeeded: true },
  });
  const store = loadState(agentDir);
  assert.equal(store.config.readerLines, 20);
  assert.equal(store.config.placement, "belowEditor");
  assert.equal(store.config.manualSeeded, true);
  assert.equal(store.books["/b/a.epub"]?.percent, 12);
  assert.match(readFileSync(statePath(agentDir), "utf8"), /a\.epub/);
});

test("a stale instance does not roll back another book's newer progress", () => {
  const agentDir = tempAgent();
  const config = { readerLines: 15, placement: "aboveEditor" as const, resumeOnStart: true };

  // Both books at para 1. Then another instance reads b far ahead.
  saveState(agentDir, {
    last: "/b/a.txt",
    library: ["/b/a.txt", "/b/b.txt"],
    books: { "/b/a.txt": { para: 1, updatedAt: 100 }, "/b/b.txt": { para: 1, updatedAt: 100 } },
    config,
  });
  saveState(agentDir, {
    last: "/b/b.txt",
    library: ["/b/a.txt", "/b/b.txt"],
    books: { "/b/a.txt": { para: 1, updatedAt: 100 }, "/b/b.txt": { para: 9, updatedAt: 200 } },
    config,
  });

  // The first instance now saves its own (stale view of b, newer a).
  saveState(agentDir, {
    last: "/b/a.txt",
    library: ["/b/a.txt", "/b/b.txt"],
    books: { "/b/a.txt": { para: 2, updatedAt: 150 }, "/b/b.txt": { para: 1, updatedAt: 100 } },
    config,
  });

  const store = loadState(agentDir);
  assert.equal(store.books["/b/a.txt"]?.para, 2, "our own book keeps our progress");
  assert.equal(store.books["/b/b.txt"]?.para, 9, "the other book keeps its newer progress");
});

test("library additions from two instances are unioned", () => {
  const agentDir = tempAgent();
  const config = { readerLines: 15, placement: "aboveEditor" as const, resumeOnStart: true };
  saveState(agentDir, { library: ["/b/a.txt"], books: {}, config });
  saveState(agentDir, { library: ["/b/c.txt"], books: {}, config });
  assert.deepEqual(loadState(agentDir).library, ["/b/a.txt", "/b/c.txt"]);
});

test("an untouched config field does not revert another instance's change", () => {
  const agentDir = tempAgent();
  const mine = loadState(agentDir);
  mkdirSync(join(agentDir, "fish"), { recursive: true });

  // Another process writes a new reader height directly.
  writeFileSync(
    statePath(agentDir),
    JSON.stringify({ ...mine, config: { ...mine.config, readerLines: 25 } }, null, 2),
  );

  // This instance never touched readerLines, so saving must keep 25.
  saveState(agentDir, mine);
  assert.equal(loadState(agentDir).config.readerLines, 25);

  // Once it changes the value itself, its value wins.
  mine.config.readerLines = 30;
  saveState(agentDir, mine);
  assert.equal(loadState(agentDir).config.readerLines, 30);
});

test("a save clears its lock and leaves no temp file", () => {
  const agentDir = tempAgent();
  saveState(agentDir, {
    library: [],
    books: {},
    config: { readerLines: 15, placement: "aboveEditor", resumeOnStart: true },
  });
  assert.equal(existsSync(`${statePath(agentDir)}.lock`), false);
  assert.equal(existsSync(`${statePath(agentDir)}.${process.pid}.tmp`), false);
});
