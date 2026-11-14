// `howl watch` shows the handovers by default and tool calls only when asked: the tests of issue #10.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { howl, rawLines } from "./helpers.ts";
import { writeStory } from "./story.ts";

function once(ledger: string, args: string[] = []) {
  return howl(["watch", "--ledger", ledger, "--no-follow", ...args]);
}

function eventLines(stdout: string): string[] {
  return stdout.split("\n").filter((l) => /^\d{4}-/.test(l));
}

test("#10: without --activity an activity line is not printed; a ledger line is", () => {
  const ledger = writeStory();
  const lines = eventLines(once(ledger).stdout);
  assert.equal(lines.length, rawLines(ledger).length - 1);
  assert.ok(!lines.some((l) => l.includes("tool.used")));
  assert.ok(lines.some((l) => l.includes("change.merged")));
});

test("#10: with --activity both are printed, in the order of time", () => {
  const ledger = writeStory();
  const lines = eventLines(once(ledger, ["--activity"]).stdout);
  assert.equal(lines.length, rawLines(ledger).length - 1 + 6);
  assert.ok(lines.some((l) => l.includes("tool.used")));
  const times = lines.map((l) => l.slice(0, 20));
  assert.deepEqual(times, [...times].sort());
});

test("#10: a filter on type=tool.used without --activity prints the tool calls", () => {
  const ledger = writeStory();
  assert.equal(eventLines(once(ledger, ["--filter", "type=tool.used"]).stdout).length, 6);
  assert.equal(eventLines(once(ledger, ["--filter", "type=tool.*"]).stdout).length, 6);
  assert.equal(eventLines(once(ledger, ["--filter", "type=review.*"]).stdout).length, 2);
});

test("#10: --json without --activity gives only the lines of the ledger", () => {
  const ledger = writeStory();
  const out = once(ledger, ["--json"]).stdout.split("\n").filter(Boolean);
  assert.deepEqual([...out].sort(), rawLines(ledger).slice(1).sort());
});
