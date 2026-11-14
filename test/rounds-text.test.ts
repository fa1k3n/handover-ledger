// A review round in words, with repeats folded: the same reviewer and outcome in a row is one entry with a count.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { roundText } from "../src/read/rounds.ts";

const r = (who: string, outcome: string, by?: string) => ({ time: "2026-01-01T00:00:00Z", actor: { kind: "person" as const, id: who }, outcome, by });

test("sixteen comments by one account in a row are one entry, ×16", () => {
  assert.equal(roundText(Array.from({ length: 16 }, () => r("person-aaaa", "commented"))), "person-aaaa commented ×16");
});

test("different reviewers or outcomes stay apart, in order; a single one has no count", () => {
  assert.equal(
    roundText([r("bob", "commented"), r("bob", "commented"), r("bob", "changes_requested"), r("carol", "approved")]),
    "bob commented ×2, bob changes requested, carol approved",
  );
});

test("the agent behind an account is named, and folds by agent", () => {
  assert.equal(roundText([r("person-aaaa", "commented", "agent-1"), r("person-aaaa", "commented", "agent-1"), r("person-aaaa", "commented")]), "agent-1 via person-aaaa commented ×2, person-aaaa commented");
});
