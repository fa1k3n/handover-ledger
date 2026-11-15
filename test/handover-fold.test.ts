// #108: the handover table shows a reviewer's reviews in a row as one line with a count.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { stepText } from "../src/dashboard/format.ts";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { handovers } from "../src/read/overview.ts";
import { event } from "./helpers.ts";

const at = (minute: number, second = 0) => `2026-01-02T08:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`;
let n = 0;
/** An event read from the code host, with a hash of its own as a line of the ledger has. */
const seen = (type: LedgerEvent["type"], time: string, actor: string, change = "30"): { event: LedgerEvent; hash: string } => {
  n++;
  return {
    event: event({ id: `e-${n}`, type, time, change, task: "7", source: { adapter: "github", kind: "observed" }, actor: { kind: "agent", id: actor } }),
    hash: `hash-${n}`,
  };
};
/** The rows oldest first, as [step, from, to, n]. */
const rows = (items: { event: LedgerEvent; hash: string }[]) =>
  handovers(items)
    .reverse()
    .map((h) => [h.step, h.from, h.to, h.n]);

test("#108: sixteen comments of one reviewer on one change give one row with the count, the time and the hash of the first", () => {
  const opened = seen("change.opened", at(0), "agent-a");
  const comments = Array.from({ length: 16 }, (_, i) => seen("review.commented", at(5, i), "agent-b"));
  const all = handovers([opened, ...comments]);
  assert.equal(all.length, 1);
  assert.deepEqual(
    { step: all[0]!.step, from: all[0]!.from, to: all[0]!.to, n: all[0]!.n, time: all[0]!.time, hash: all[0]!.hash },
    { step: "Implementation → review", from: "agent-a", to: "agent-b", n: 16, time: at(5, 0), hash: comments[0]!.hash },
  );
});

test("#108: a row of one event has no count, and two reviewers give two rows", () => {
  const one = handovers([seen("change.opened", at(0), "agent-a"), seen("review.commented", at(5), "agent-b")]);
  assert.equal(one.length, 1);
  assert.equal("n" in one[0]!, false);

  assert.deepEqual(
    rows([seen("change.opened", at(0), "agent-a"), seen("review.commented", at(5), "agent-b"), seen("review.commented", at(5, 1), "agent-b"), seen("review.commented", at(6), "agent-c"), seen("review.commented", at(6, 1), "agent-b")]),
    [
      ["Implementation → review", "agent-a", "agent-b", 2],
      ["Implementation → review", "agent-a", "agent-c", undefined],
      ["Implementation → review", "agent-a", "agent-b", undefined],
    ],
    "another reviewer in between ends the run",
  );
});

test("#108: a review, a request for changes and a second review are three rows, none folded", () => {
  assert.deepEqual(
    rows([
      seen("change.opened", at(0), "agent-a"),
      seen("review.commented", at(5), "agent-b"),
      seen("review.changes_requested", at(6), "agent-b"),
      seen("review.commented", at(9), "agent-b"),
      seen("review.approved", at(10), "agent-b"),
      seen("change.merged", at(12), "agent-c"),
    ]),
    [
      ["Implementation → review", "agent-a", "agent-b", undefined],
      ["Review → fix", "agent-b", "agent-a", undefined],
      ["Implementation → review", "agent-a", "agent-b", 2],
      ["Review → merge", "agent-c", "merged", undefined],
    ],
    "the comment and the approval after the fix are one reviewer's reviews in a row",
  );
});

test("#108: reviews on two changes that alternate are not folded across the changes", () => {
  assert.deepEqual(
    rows([
      seen("change.opened", at(0), "agent-a", "30"),
      seen("change.opened", at(1), "agent-a", "31"),
      seen("review.commented", at(5), "agent-b", "30"),
      seen("review.commented", at(5, 1), "agent-b", "31"),
      seen("review.commented", at(5, 2), "agent-b", "30"),
      seen("review.commented", at(5, 3), "agent-b", "31"),
    ]).map((r) => r[3]),
    [2, 2],
    "each change has its own run: the rows of one change follow each other, whatever lies between them",
  );
});

test("#108: the step's cell says the count of a folded row", () => {
  assert.equal(stepText({ step: "Implementation → review", n: 16 }), "Implementation → review ×16");
  assert.equal(stepText({ step: "Implementation → review" }), "Implementation → review");
  assert.equal(stepText({ step: "Review → merge", n: 1 }), "Review → merge");
});
