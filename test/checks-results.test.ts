// #47: the result of the checks of a commit, and its changes, worked out from the runs.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanName, pendingNames, resultsOf, stateOf } from "../src/observe/results.ts";
import type { CheckRun } from "../src/observe/port.ts";
import { at } from "./local-host.ts";

/** A run: `started` and `finished` are minutes after midnight on 2026-01-01; no `finished` is a run going. */
const run = (id: string, name: string | undefined, result: CheckRun["result"], started: number | undefined, finished?: number, suite = "s1"): CheckRun => ({
  id,
  ...(name !== undefined ? { name } : {}),
  suite,
  result,
  ...(started !== undefined ? { started: at(started) } : {}),
  ...(finished !== undefined ? { at: at(finished) } : {}),
});

const view = (runs: CheckRun[]) => resultsOf(runs).map((r) => [r.state, r.failed, r.at, r.run]);

test("#47: no run is no result; one run that names no check is one result", () => {
  assert.deepEqual(resultsOf([]), []);
  assert.deepEqual(view([run("1", undefined, "passed", undefined, 5)]), [["passed", [], at(5), "1"]]);
  assert.deepEqual(view([run("1", undefined, "failed", undefined, 5)]), [["failed", [], at(5), "1"]]);
});

test("#47: a check that failed and passed on a second run is two results, each with the time of the run that completed it", () => {
  assert.deepEqual(view([run("1", "lint", "failed", 1, 5), run("2", "lint", "passed", 10, 12)]), [
    ["failed", ["lint"], at(5), "1"],
    ["passed", [], at(12), "2"],
  ]);
});

test("#47: A and B fail, A is run again and passes, B is run again and passes: failed (A, B), failed (B), passed", () => {
  const runs = [run("a1", "A", "failed", 1, 5), run("b1", "B", "failed", 1, 6), run("a2", "A", "passed", 8, 12), run("b2", "B", "passed", 14, 20)];
  assert.deepEqual(view(runs), [
    ["failed", ["A", "B"], at(6), "b1"],
    ["failed", ["B"], at(12), "a2"],
    ["passed", [], at(20), "b2"],
  ]);
  // A round between the two reruns saw the first two of them: what it worked out is the first two results of the same.
  assert.deepEqual(view(runs.slice(0, 3)), view(runs).slice(0, 2));
  assert.deepEqual(stateOf(runs), { state: "passed", failed: [] });
});

test("#47: a result is of the whole set: while a run is going there is none, and a check that comes later changes the result then", () => {
  assert.deepEqual(view([run("a1", "A", "passed", 1, 5), run("b1", "B", "pending", 2)]), [], "B is going at 5: the set has no result");
  assert.deepEqual(view([run("a1", "A", "passed", 1, 5), run("b1", "B", "pending", 6)]), [["passed", [], at(5), "a1"]], "B began after: the result at 5 stands");
  // A run that never states when it began is going from the first moment: nothing is told before it finished.
  assert.deepEqual(view([run("a1", "A", "passed", 1, 5), run("b1", "B", "failed", undefined, 9)]), [["failed", ["B"], at(9), "b1"]]);
  assert.deepEqual(view([run("a1", "A", "passed", 1, 5), run("b1", "B", "failed", 7, 9)]), [
    ["passed", [], at(5), "a1"],
    ["failed", ["B"], at(9), "b1"],
  ]);
  assert.equal(stateOf([run("a1", "A", "passed", 1, 5), run("b1", "B", "pending", 6)]), null, "going now: no result now");
});

test("#47: two runs named alike in two suites are two checks: neither is a second run of the other", () => {
  const runs = [run("1", "build", "failed", 1, 5, "suite-1"), run("2", "build", "passed", 2, 6, "suite-2")];
  assert.deepEqual(view(runs), [["failed", ["build"], at(6), "2"]], "one result, failed, and never passed");
  assert.deepEqual(stateOf(runs), { state: "failed", failed: ["build"] });
  // The same two in one suite: the second is a second run of the first, and the commit passed.
  assert.deepEqual(stateOf([run("1", "build", "failed", 1, 5, "suite-1"), run("2", "build", "passed", 6, 7, "suite-1")]), { state: "passed", failed: [] });
});

test("#47: a result that says what the one before said is no result: a check posted twice with one state", () => {
  assert.deepEqual(view([run("1", "ci", "passed", 1, 5), run("2", "ci", "passed", 6, 8)]), [["passed", [], at(5), "1"]]);
  assert.deepEqual(view([run("1", "ci", "failed", 1, 5), run("2", "ci", "failed", 6, 8)]), [["failed", ["ci"], at(5), "1"]]);
});

test("#47: ids order the runs of one second; the run with the greatest id completes it", () => {
  const runs = [run("9", "A", "passed", 1, 5), run("10", "B", "passed", 1, 5)];
  assert.deepEqual(view(runs), [["passed", [], at(5), "10"]]);
});

test("#47: the names that failed are sorted and kept once; nothing else of a run is kept", () => {
  const [r] = resultsOf([run("1", "zeta", "failed", 1, 5), run("2", "alpha", "failed", 1, 5), run("3", "alpha", "failed", 1, 5, "s2")]);
  assert.deepEqual(r!.failed, ["alpha", "zeta"]);
  assert.deepEqual(Object.keys(r!).sort(), ["at", "failed", "run", "state"]);
});

test("#47: a run with no usable time is passed over, and throws nothing", () => {
  const bad = { id: "x", name: "bad", suite: "s", result: "passed" as const, started: "nonsense", at: "undefined" };
  assert.deepEqual(view([run("1", "A", "passed", 1, 5), bad]), [["passed", [], at(5), "1"]]);
  assert.deepEqual(stateOf([bad]), null);
});

test("#47: the names of the checks that are going, for a head let go", () => {
  assert.deepEqual(pendingNames([run("1", "slow", "pending", 1), run("2", "A", "passed", 1, 5), run("3", "also", "pending", 1)]), ["also", "slow"]);
});

test("#47: a name holds only what prints, and is cut to 200 characters whole, never inside one", () => {
  assert.equal(cleanName("lint\u001b[31m\u0007 x\r\n"), "lint[31m x");
  assert.equal(cleanName("a‮b c"), "abc", "a bidirectional control and a line separator are taken out");
  const long = `${"x".repeat(199)}😀tail`;
  const cut = cleanName(long);
  assert.equal([...cut].length, 200);
  assert.equal(cut, `${"x".repeat(199)}😀`);
  assert.ok(cut.isWellFormed());
  // A cut inside a character of two units would leave half of it.
  const half = cleanName(`${"y".repeat(200)}😀`);
  assert.ok(half.isWellFormed());
  assert.equal(half, "y".repeat(200));
  assert.ok(cleanName("lone \ud800 half").isWellFormed());
  assert.equal(cleanName("\u0007\u001b"), "");
});
