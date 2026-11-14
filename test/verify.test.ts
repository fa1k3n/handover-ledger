// `howl verify`, run as a process of its own: the tests of issues #1 and #5.
// @code_class tests
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { eventHash, fixedForm } from "../src/ledger/fixed.ts";
import { openLedger } from "../src/ledger/ledger.ts";
import { howl, ledgerWith, PROJECT, rawLines, sha256, writeLines, type Line } from "./helpers.ts";

/** Runs `howl verify` and expects it to name `line`, and no other line, and to end with 1. */
function failsAt(path: string, line: number, why?: RegExp): void {
  const result = howl(["verify", "--ledger", path]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const named = result.stdout.match(/^line \d+/gm) ?? [];
  assert.deepEqual(named, [`line ${line}`], result.stdout);
  if (why) assert.match(result.stdout, why);
}

/** Changes line `n` (from 1) of the ledger with `change`, writing the line back with its event in fixed form. */
function changeLine(path: string, n: number, change: (line: Line) => void): void {
  const raw = rawLines(path);
  const line = JSON.parse(raw[n - 1]!) as Line;
  change(line);
  raw[n - 1] =
    `{"prev":${JSON.stringify(line.prev)},"hash":${JSON.stringify(line.hash)},"event":${fixedForm(line.event).toString("utf8")}}`;
  writeLines(path, raw);
}

test("howl verify passes an untouched ledger, and ends with 0 and the count", () => {
  const path = ledgerWith(4);
  const result = howl(["verify", "--ledger", path]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\b5 lines\b/);
});

test("with a field of an event changed and hash left as it was, it names that line: the hash does not match", () => {
  const path = ledgerWith(4);
  changeLine(path, 3, (line) => {
    line.event.task = "another";
  });
  failsAt(path, 3, /hash: .*not the hash of the event/);
});

test("with a field of an event changed and hash set right, it names the next line: prev does not match", () => {
  const path = ledgerWith(4);
  changeLine(path, 3, (line) => {
    line.event.task = "another";
    line.hash = eventHash(line.event as never);
  });
  failsAt(path, 4, /prev: /);
});

test("with one line removed it names the first line that fails and ends with 1", () => {
  const path = ledgerWith(4);
  const raw = rawLines(path);
  raw.splice(2, 1);
  writeLines(path, raw);
  failsAt(path, 3, /prev: /);
});

test("with the first line removed it names line 1", () => {
  const path = ledgerWith(4);
  writeLines(path, rawLines(path).slice(1));
  failsAt(path, 1, /prev: /);
});

test("with two lines swapped it names the first line that fails and ends with 1", () => {
  const path = ledgerWith(4);
  const raw = rawLines(path);
  [raw[2], raw[3]] = [raw[3]!, raw[2]!];
  writeLines(path, raw);
  failsAt(path, 3, /prev: /);
});

test("a line that is not JSON is named", () => {
  const path = ledgerWith(4);
  const raw = rawLines(path);
  raw[2] = "this is not JSON";
  writeLines(path, raw);
  failsAt(path, 3, /not JSON/);
});

test("a line that does not follow the line schema is named", () => {
  const path = ledgerWith(2);
  const raw = rawLines(path);
  const extra = { ...(JSON.parse(raw[2]!) as Line), colour: "red" };
  raw[2] = JSON.stringify(extra);
  writeLines(path, raw);
  failsAt(path, 3, /line: colour/);
});

test("an event that does not follow the event schema is named, also when hash and prev are right", () => {
  const path = ledgerWith(2);
  const raw = rawLines(path);
  const event = { ...(JSON.parse(raw[2]!) as Line).event, colour: "red" };
  const line = `{"prev":"${sha256(raw[2]!)}","hash":"${eventHash(event as never)}","event":${fixedForm(event).toString("utf8")}}`;
  writeLines(path, [...raw, line]);
  failsAt(path, 4, /event: colour/);
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
