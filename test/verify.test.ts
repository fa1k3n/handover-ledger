// `howl verify`, run as a process of its own. The tests of issue #1, in its order.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { openLedger } from "../src/ledger/ledger.ts";
import { howl, ledgerWith, PROJECT, rawLines, sha256, writeLines } from "./helpers.ts";

/** Runs `howl verify` and expects it to name `line`, and no other line, and to end with 1. */
function failsAt(path: string, line: number, why?: RegExp): void {
  const result = howl(["verify", "--ledger", path]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const named = result.stdout.match(/^line \d+/gm) ?? [];
  assert.deepEqual(named, [`line ${line}`], result.stdout);
  if (why) assert.match(result.stdout, why);
}

test("howl verify on an untouched ledger ends with 0 and the count", () => {
  const path = ledgerWith(4);
  const result = howl(["verify", "--ledger", path]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\b5 lines\b/);
});

test("with one line changed it names the first line that fails and ends with 1", () => {
  const path = ledgerWith(4);
  const lines = rawLines(path);
  // Line 3 is changed and is still a valid event. Line 4 holds the hash of what it was.
  const changed = JSON.parse(lines[2]!);
  changed.task = "another";
  lines[2] = JSON.stringify(changed);
  writeLines(path, lines);
  failsAt(path, 4, /prev/);
});

test("with one line removed it names the first line that fails and ends with 1", () => {
  const path = ledgerWith(4);
  const lines = rawLines(path);
  lines.splice(2, 1);
  writeLines(path, lines);
  failsAt(path, 3, /prev/);
});

test("with the first line removed it names line 1", () => {
  const path = ledgerWith(4);
  writeLines(path, rawLines(path).slice(1));
  failsAt(path, 1, /prev/);
});

test("with two lines swapped it names the first line that fails and ends with 1", () => {
  const path = ledgerWith(4);
  const lines = rawLines(path);
  [lines[2], lines[3]] = [lines[3]!, lines[2]!];
  writeLines(path, lines);
  failsAt(path, 3, /prev/);
});

test("a line that is not JSON is named", () => {
  const path = ledgerWith(4);
  const lines = rawLines(path);
  lines[2] = "this is not JSON";
  writeLines(path, lines);
  failsAt(path, 3, /JSON/);
});

test("a line that does not follow the schema is named", () => {
  const path = ledgerWith(2);
  const lines = rawLines(path);
  // Chained as it should be, but with a field the schema does not know.
  const extra = { ...JSON.parse(lines[2]!), colour: "red", prev: sha256(lines[2]!) };
  writeLines(path, [...lines, JSON.stringify(extra)]);
  failsAt(path, 4, /colour/);
});

test("an empty file, and a last line without its line break, fail", () => {
  const path = ledgerWith(2);
  const whole = readFileSync(path, "utf8");
  writeFileSync(path, whole.slice(0, -1));
  failsAt(path, 3, /line break/);
  writeFileSync(path, "");
  failsAt(path, 1);
});

test("howl verify leaves the file and its time stamp as they were", () => {
  const path = ledgerWith(4);
  for (const broken of [false, true]) {
    if (broken) writeLines(path, rawLines(path).reverse());
    const then = new Date("2026-01-01T00:00:00Z");
    utimesSync(path, then, then);
    const bytes = readFileSync(path);
    const entries = readdirSync(dirname(path));

    assert.equal(howl(["verify", "--ledger", path]).status, broken ? 1 : 0);

    assert.equal(statSync(path).mtimeMs, then.getTime());
    assert.deepEqual(readFileSync(path), bytes);
    assert.deepEqual(readdirSync(dirname(path)), entries);
  }
});

test("howl verify takes no lock: it runs while a writer holds it", () => {
  const path = ledgerWith(2);
  const writer = openLedger(path, { project: PROJECT });
  try {
    assert.equal(howl(["verify", "--ledger", path]).status, 0);
  } finally {
    writer.close();
  }
});

test("howl verify without a ledger to read ends with 2", () => {
  const path = ledgerWith(0);
  assert.equal(howl(["verify", "--ledger", `${path}.missing`]).status, 2);
  assert.equal(howl(["verify"]).status, 2);
});
