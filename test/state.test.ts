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
