import assert from "node:assert/strict";
import { test } from "node:test";

import { WheelBurst } from "../src/wheel.ts";

test("the first report of a gesture always pages", () => {
  const burst = new WheelBurst();
  assert.equal(burst.duplicate(1, 0), false);
  assert.equal(burst.duplicate(-1, 1), false);
});

test("extra reports from one notch are duplicates", () => {
  const burst = new WheelBurst();
  assert.equal(burst.duplicate(1, 0), false);
  // Orca replays one notch as several reports in the same tick.
  for (let i = 1; i < 6; i++) {
    assert.equal(burst.duplicate(1, i * 0.1), true);
  }
});

test("a new notch after the burst pages again", () => {
  const burst = new WheelBurst();
  burst.duplicate(1, 0);
  assert.equal(burst.duplicate(1, 4.9), true);
  assert.equal(burst.duplicate(1, 5.1), false);
  assert.equal(burst.duplicate(1, 60), false);
});

test("reversing direction ends the burst immediately", () => {
  const burst = new WheelBurst();
  burst.duplicate(1, 0);
  assert.equal(burst.duplicate(-1, 0.2), false);
  assert.equal(burst.duplicate(1, 0.4), false);
});
