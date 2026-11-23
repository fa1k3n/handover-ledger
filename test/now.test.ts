// The present time of a reader: HOWL_NOW, read by both versions from the same cases (#137).
// @code_class tests
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseNow, presentTime } from "../src/read/now.ts";

/** test/fixtures/howl-now.tsv, which the Rust tests read too. */
const CASES = readFileSync(new URL("./fixtures/howl-now.tsv", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map((line) => line.split("\t") as [string, string]);

test("#137: parseNow takes and refuses the values of test/fixtures/howl-now.tsv", () => {
  assert.ok(CASES.length > 20);
  for (const [text, want] of CASES) assert.equal(parseNow(text), want === "-" ? null : Number(want), text);
});

test("#137: presentTime is HOWL_NOW when it is set and not empty, else the clock; another value is refused", () => {
  assert.equal(presentTime({ HOWL_NOW: "2026-01-01T08:00:00Z" }), 1_767_254_400_000);
  const before = Date.now();
  for (const env of [{}, { HOWL_NOW: "" }]) {
    const now = presentTime(env);
    assert.ok(now >= before && now - before < 60_000);
  }
  assert.throws(() => presentTime({ HOWL_NOW: "yesterday" }), { message: "HOWL_NOW yesterday: give an ISO time with Z or an offset, as 2026-11-23T10:00:00Z" });
});
