import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { advanceFrom, anchorFor, backFrom } from "../src/paging.ts";
import { charWidth, loadBook, textWidth } from "../src/reader.ts";
import { FishWidget, showsProgress, widgetBodyWidth, type WidgetPaging } from "../src/widget.ts";

function makeBook(): ReturnType<typeof loadBook> {
  const dir = mkdtempSync(join(tmpdir(), "pi-fish-widget-"));
  const file = join(dir, "book.txt");
  writeFileSync(file, ["第一章 一", "甲乙丙丁戊己庚辛壬癸".repeat(12), "乙".repeat(40)].join("\n"), "utf8");
  return loadBook(file);
}

const theme = { fg: (_token: string, text: string) => text };
const host = { requestRender() {} };

function widget() {
  const state = {
    book: makeBook(),
    pos: { para: 0, line: 0 },
    fakeName: "session.ts",
  };
  return { state, view: new FishWidget(state, theme, host) };
}

test("renders exactly one line, always", () => {
  const { view } = widget();
  const lines = view.render(80);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("第一章"));
});

test("stays one line and hides everything except the text and the percentage", () => {
  for (const width of [80, 200]) {
    const { view } = widget();
    const lines = view.render(width);
    const text = lines.join("\n");
    assert.equal(lines.length, 1, "one line, always");
    assert.ok(!text.includes("Read("), "header leaked");
    assert.ok(!text.includes("paragraphs"), "progress footer leaked");
    assert.match(lines[0], /\d{1,3}%$/, "percentage at the very end");
  }
});

test("advances the start position between renders", () => {
  const { state, view } = widget();

  state.pos = { para: 1, line: 0 };
  view.invalidate();
  const first = view.render(80)[0];

  state.pos = { para: 1, line: 1 };
  view.invalidate();
  const second = view.render(80)[0];

  assert.notEqual(first, second);
});

test("caps line width so long lines do not stand out", () => {
  const { view } = widget();
  const line = view.render(200)[0];
  // gutter (6) + capped body (72) worst case; the percentage only re-uses the
  // space the body already gave up, so the footprint is unchanged.
  assert.ok(textWidth(line) <= 72 + 6, `expected capped width, got ${textWidth(line)}`);
});

test("resize invalidates the cache", () => {
  const { state, view } = widget();
  state.pos = { para: 1, line: 0 };
  const wide = view.render(200)[0];
  const narrow = view.render(40)[0];
  assert.notEqual(wide, narrow);
  assert.equal(view.render(40)[0], narrow);
});

test("widgetBodyWidth reserves the percentage slot and caps at 72", () => {
  assert.equal(widgetBodyWidth(200), 72 - 6); // 72 body - "100%" - gap
  assert.equal(widgetBodyWidth(40), 34 - 6);
  assert.equal(widgetBodyWidth(30), 24, "too narrow for a percentage: full width");
  assert.equal(widgetBodyWidth(10), 12);
  assert.equal(showsProgress(80), true);
  assert.equal(showsProgress(30), false);
});

function percentOf(line: string): number {
  const match = /(\d{1,3})%$/.exec(line);
  assert.ok(match, `no percentage at the end of ${JSON.stringify(line)}`);
  return Number(match[1]);
}

function pager() {
  const book = makeBook();
  const state = { book, pos: { para: 0, line: 0 }, fakeName: "session.ts" };
  const width = widgetBodyWidth(80);
  let anchor = anchorFor(book, state.pos, width);
  const view = new FishWidget(state, theme, host, {
    advance: (lines) => {
      const step = advanceFrom(book, state.pos, anchor, width, lines);
      state.pos = step.pos;
      anchor = step.anchor;
      view.invalidate();
    },
    back: (lines) => {
      const step = backFrom(book, state.pos, anchor, width, lines);
      state.pos = step.pos;
      anchor = step.anchor;
      view.invalidate();
    },
    screenLines: () => 5,
  });
  return { state, width, view };
}

test("percent is right aligned in a fixed slot so the text does not shift", () => {
  const { view, state } = pager();
  const endsAt: number[] = [];
  for (const line of [0, 1, 2]) {
    state.pos = { para: 1, line };
    view.invalidate();
    const rendered = view.render(80)[0];
    assert.equal(textWidth(rendered), 78, "line keeps a stable footprint");
    endsAt.push(textWidth(rendered));
  }
  assert.deepEqual(endsAt, [78, 78, 78]);
});

test("percent grows while paging and reads 100% on the last page", () => {
  const { view } = pager();
  let last = -1;
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) {
    const percent = percentOf(view.render(80)[0]);
    assert.ok(percent >= last, `percent went backwards: ${last} -> ${percent}`);
    assert.ok(percent >= 0 && percent <= 100);
    last = percent;
    seen.add(percent);
    view.handleMouse(mouse({ type: "click", clickCount: 1 }));
  }
  assert.ok(seen.size > 3, `percent actually moved (${seen.size} distinct values)`);
  assert.equal(percentOf(view.render(80)[0]), 100, "tail is 100%");
});

test("uses the session percentage provider when one is supplied", () => {
  const book = makeBook();
  const state = { book, pos: { para: 0, line: 0 }, fakeName: "session.ts", percent: () => 42 };
  const view = new FishWidget(state, theme, host, null);
  const line = view.render(80)[0];
  assert.match(line, /\s42%$/, "the session value wins over the local estimate");
  assert.ok(!/\s0%$/.test(line));
});

test("drops the percentage instead of squeezing a narrow line", () => {
  const { view } = widget();
  const line = view.render(30)[0];
  assert.ok(!line.includes("%"), "no percentage when there is no room");
  assert.ok(textWidth(line) <= 30);
});

function mouseWidget() {
  const calls: string[] = [];
  const paging: WidgetPaging = {
    advance: (lines) => calls.push(`next:${lines}`),
    back: (lines) => calls.push(`prev:${lines}`),
    screenLines: () => 6,
  };
  const state = { book: makeBook(), pos: { para: 0, line: 0 }, fakeName: "session.ts" };
  const view = new FishWidget(state, theme, host, paging);
  return { calls, view };
}

type Mouse = Parameters<FishWidget["handleMouse"]>[0];

function mouse(partial: Partial<Mouse>): Mouse {
  return {
    type: "click",
    button: "left",
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    width: 80,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
    ...partial,
  } as Mouse;
}

test("claims a left press so Pi can turn it into a click", () => {
  const { calls, view } = mouseWidget();
  const result = view.handleMouse(mouse({ type: "press" }));
  assert.deepEqual(result, { handled: true });
  assert.deepEqual(calls, [], "a press alone must not page");
});

test("ignores gestures it cannot page with", () => {
  const { calls, view } = mouseWidget();
  assert.equal(view.handleMouse(mouse({ type: "move", button: "none" })), undefined);
  assert.equal(view.handleMouse(mouse({ type: "drag" })), undefined);
  assert.deepEqual(calls, []);
});

test("claims a middle press too, so a middle click becomes previous", () => {
  const { calls, view } = mouseWidget();
  assert.deepEqual(view.handleMouse(mouse({ type: "press", button: "middle" })), { handled: true });
  view.handleMouse(mouse({ type: "click", button: "middle", clickCount: 1 }));
  assert.deepEqual(calls, ["prev:1"]);
});

test("left click advances one line", () => {
  const { calls, view } = mouseWidget();
  view.handleMouse(mouse({ type: "click", clickCount: 1 }));
  assert.deepEqual(calls, ["next:1"]);
});

test("double click advances one screen", () => {
  const { calls, view } = mouseWidget();
  view.handleMouse(mouse({ type: "click", clickCount: 1 }));
  view.handleMouse(mouse({ type: "click", clickCount: 2 }));
  assert.deepEqual(calls, ["next:1", "next:6"]);
});

test("right click and shift+click go back", () => {
  const { calls, view } = mouseWidget();
  view.handleMouse(mouse({ type: "click", button: "right", clickCount: 1 }));
  view.handleMouse(mouse({ type: "click", shift: true, clickCount: 1 }));
  view.handleMouse(mouse({ type: "click", button: "right", clickCount: 1 }));
  view.handleMouse(mouse({ type: "click", button: "right", clickCount: 2 }));
  assert.deepEqual(calls, ["prev:1", "prev:1", "prev:1", "prev:6"]);
});

test("a right click after a left click is not a double click", () => {
  const { calls, view } = mouseWidget();
  view.handleMouse(mouse({ type: "click", button: "left", clickCount: 1 }));
  // Pi counts per component and position, so it still reports clickCount 2.
  view.handleMouse(mouse({ type: "click", button: "right", clickCount: 2 }));
  assert.deepEqual(calls, ["next:1", "prev:1"]);
});

test("wheel pages by a line and alt+wheel by a screen", () => {
  const { calls, view } = mouseWidget();
  // Pi accelerates wheelDelta with scroll velocity; the widget must still move
  // exactly one wrapped line per event, whatever the magnitude says.
  view.handleMouse(mouse({ type: "wheel", button: "none", wheelDelta: 3 }));
  view.handleMouse(mouse({ type: "wheel", button: "none", wheelDelta: -2 }));
  view.handleMouse(mouse({ type: "wheel", button: "none", wheelDelta: 1, alt: true }));
  view.handleMouse(mouse({ type: "wheel", button: "none", wheelDelta: -1, alt: true }));
  view.handleMouse(mouse({ type: "wheel", button: "none", wheelDelta: 99 }));
  assert.deepEqual(calls, ["next:1", "prev:1", "next:6", "prev:6", "next:1"]);
});

test("one notch replayed as several reports pages once", () => {
  const { calls, view } = mouseWidget();
  // Orca sends a physical notch as several wheel reports in the same tick.
  for (let i = 0; i < 6; i++) {
    view.handleMouse(mouse({ type: "wheel", button: "none", wheelDelta: 1 }));
  }
  assert.deepEqual(calls, ["next:1"]);
});

test("wheel without a delta is not swallowed", () => {
  const { calls, view } = mouseWidget();
  assert.equal(view.handleMouse(mouse({ type: "wheel", button: "none" })), undefined);
  assert.deepEqual(calls, []);
});

test("no book and no paging hook mean no mouse handling", () => {
  const empty = new FishWidget({ book: null, pos: { para: 0, line: 0 }, fakeName: "x" }, theme, host, {
    advance() {
      throw new Error("should not page without a book");
    },
    back() {},
    screenLines: () => 6,
  });
  assert.equal(empty.handleMouse(mouse({ type: "press" })), undefined);
  assert.equal(empty.handleMouse(mouse({ type: "click", clickCount: 1 })), undefined);

  const { view } = widget();
  assert.equal(view.handleMouse(mouse({ type: "click", clickCount: 1 })), undefined);
});

test("syncs the session when the render width changes", () => {
  const seen: number[] = [];
  const state = { book: makeBook(), pos: { para: 0, line: 0 }, fakeName: "session.ts" };
  const view = new FishWidget(state, theme, host, {
    advance() {},
    back() {},
    screenLines: () => 6,
    sync: (width) => seen.push(width),
  });

  view.render(80);
  view.render(80);
  view.render(60);
  view.render(60);
  assert.deepEqual(seen, [80, 60], "one sync per distinct width");
});

test("clicking through the widget reaches the tail and stops there", () => {
  const book = makeBook();
  const state = { book, pos: { para: 0, line: 0 }, fakeName: "session.ts" };
  const width = widgetBodyWidth(80);
  let anchor = anchorFor(book, state.pos, width);

  const view = new FishWidget(state, theme, host, {
    advance: (lines) => {
      const step = advanceFrom(book, state.pos, anchor, width, lines);
      state.pos = step.pos;
      anchor = step.anchor;
      view.invalidate(); // index.ts does this through the widget's refresh()
    },
    back: (lines) => {
      const step = backFrom(book, state.pos, anchor, width, lines);
      state.pos = step.pos;
      anchor = step.anchor;
      view.invalidate();
    },
    screenLines: () => 5,
  });

  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const line = view.render(80)[0];
    assert.equal(typeof line, "string", "the line never disappears");
    seen.add(line);
    view.handleMouse(mouse({ type: "click", clickCount: 1 }));
  }

  const tail = state.pos;
  assert.ok(seen.size >= 6, `paging actually moved through the book (${seen.size} lines)`);
  assert.ok(view.render(80)[0].includes("乙"), "tail page still shows text");

  // Past the end nothing moves, and the tail stays on screen.
  view.handleMouse(mouse({ type: "click", clickCount: 1 }));
  assert.deepEqual(state.pos, tail);
  assert.ok(view.render(80)[0].length > 0);
});
