// What a review round is, in one place: the tests of issue #42.
// A round is the reviews of a change between two heads. `howl show` and the overview count it the same way.
// @code_class tests
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { keyFigures } from "../src/read/overview.ts";
import * as roundsModule from "../src/read/rounds.ts";
import * as showModule from "../src/read/show.ts";
import { parseAsked, render, show } from "../src/read/show.ts";
import { texts } from "../src/dashboard/texts.ts";
import { PROJECT } from "./helpers.ts";

const T0 = Date.UTC(2026, 10, 14, 9, 0, 0);
const DAY = 24 * 3600_000;
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const SHA = { a: "a".repeat(40), b: "b".repeat(40), c: "c".repeat(40) };
const agent = { kind: "agent" as const, id: "agent-1" };
const person = { kind: "person" as const, id: "person-0a0a0a0a" };

let n = 0;
function observed(type: LedgerEvent["type"], minute: number, extra: Partial<LedgerEvent> = {}): LedgerEvent {
  return { v: 0, id: `r-${++n}`, time: at(minute), type, source: { adapter: "github", kind: "observed" }, project: PROJECT, ...extra };
}
const of = (change: string, sha: string, task = "40") => ({ task, change, branch: `branch-${change}`, sha });
const byTime = (events: LedgerEvent[]) => [...events].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

/** Change 63: three reviews on one head, a new head, one review on it, the merge. Two rounds. */
function threeAndOne(change = "63", from = 0, task = "40"): LedgerEvent[] {
  const c = (sha: string) => of(change, sha, task);
  return [
    observed("change.opened", from, { ...c(SHA.a), actor: agent }),
    observed("review.commented", from + 1, { ...c(SHA.a), actor: person }),
    observed("review.changes_requested", from + 2, { ...c(SHA.a), actor: person }),
    observed("review.commented", from + 3, { ...c(SHA.a), actor: person }),
    observed("change.updated", from + 4, { ...c(SHA.b), actor: agent }),
    observed("review.approved", from + 5, { ...c(SHA.b), actor: person }),
    observed("change.merged", from + 6, { ...c(SHA.b), actor: person }),
  ];
}

/** `rounds` as the module gives it; a missing one fails the test that calls it, not the file. */
function rounds(events: LedgerEvent[]) {
  const fn = (roundsModule as unknown as { rounds?: (all: LedgerEvent[]) => { change?: string; reviews: { outcome: string }[]; followedBy: string | null }[] }).rounds;
  assert.equal(typeof fn, "function", "src/read/rounds.ts exports no `rounds`");
  return fn!(byTime(events));
}
const outcomes = (r: { reviews: { outcome: string }[] }) => r.reviews.map((x) => x.outcome);

test("R42.1: `rounds` is exported by src/read/rounds.ts and gives the rounds of a change", () => {
  const given = rounds(threeAndOne());
  assert.equal(given.length, 2);
});

test("R42.1: src/read/show.ts no longer holds `rounds`; it imports it", () => {
  assert.ok(!("rounds" in showModule), "show.ts still exports `rounds`");
});

test("R42.1: src/read/rounds.ts has no Node: no import of a `node:` module", () => {
  const source = readFileSync(new URL("../src/read/rounds.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']node:/);
  assert.doesNotMatch(source, /require\(/);
});

test("R42.2: three reviews on one head and one on the next are two rounds, split at the new head", () => {
  const given = rounds(threeAndOne());
  assert.deepEqual(given.map(outcomes), [["commented", "changes_requested", "commented"], ["approved"]]);
  assert.deepEqual(given.map((r) => r.followedBy), ["change.updated", "change.merged"]);
});

test("R42.2: reviews on one head are one round however many they are, and a head with no review adds none", () => {
  const events = [
    observed("change.opened", 0, { ...of("63", SHA.a), actor: agent }),
    observed("review.commented", 1, { ...of("63", SHA.a), actor: person }),
    observed("review.commented", 2, { ...of("63", SHA.a), actor: person }),
    observed("change.updated", 3, { ...of("63", SHA.b), actor: agent }),
    observed("change.updated", 4, { ...of("63", SHA.c), actor: agent }),
  ];
  const given = rounds(events);
  assert.equal(given.length, 1);
  assert.deepEqual(outcomes(given[0]!), ["commented", "commented"]);
});

test("R42.3: a merged change with three reviews on one head and one on the next gives two rounds in the overview's mean", () => {
  const figures = keyFigures(threeAndOne(), T0 + DAY);
  assert.equal(figures.merged, 1);
  assert.equal(figures.reviewRoundsMean, 2, "two rounds, not four reviews");
});

test("R42.3: the mean is of the rounds of each merged change", () => {
  const events = [...threeAndOne("63", 0, "40"), ...threeAndOne("65", 100, "41").slice(0, 2), observed("change.merged", 110, { ...of("65", SHA.a, "41"), actor: person })];
  const figures = keyFigures(events, T0 + DAY);
  assert.equal(figures.merged, 2);
  assert.equal(figures.reviewRoundsMean, 1.5, "change 63 has two rounds, change 65 one");
});

test("R42.4: the same change gives two rounds in `howl show`", () => {
  const shown = show(byTime(threeAndOne()), parseAsked("change:63"), null)!;
  assert.equal(shown.reviews.length, 2);
  assert.deepEqual(shown.reviews.map(outcomes), [["commented", "changes_requested", "commented"], ["approved"]]);
  assert.equal(shown.summary.reviewRounds, 2);
  assert.match(render(shown, { utc: true }), /review rounds: 2/);
});

test("R42.4: the overview and `howl show` give the same number of rounds for the same change", () => {
  const events = threeAndOne();
  const shown = show(byTime(events), parseAsked("change:63"), null)!;
  assert.equal(keyFigures(events, T0 + DAY).reviewRoundsMean, shown.summary.reviewRounds);
});

test("R42.6: the overview says rounds, and its note keeps `mean of N merged changes, last D days`", () => {
  assert.match(texts.overview.rounds, /rounds/i);
  assert.equal(texts.overview.roundsNote(30, 4), "mean of 4 merged changes, last 30 days");
});

/** Two changes of task 40: 63 has two reviews on one head; 65 has a review on each of two heads. Their events are interleaved. */
function twoChanges(): LedgerEvent[] {
  return [
    observed("change.opened", 0, { ...of("63", SHA.a), actor: agent }),
    observed("change.opened", 1, { ...of("65", SHA.b), actor: agent }),
    observed("review.commented", 2, { ...of("63", SHA.a), actor: person }),
    observed("review.changes_requested", 3, { ...of("65", SHA.b), actor: person }),
    observed("change.updated", 4, { ...of("65", SHA.c), actor: agent }),
    observed("review.approved", 5, { ...of("63", SHA.a), actor: person }),
    observed("review.approved", 6, { ...of("65", SHA.c), actor: person }),
    observed("change.merged", 7, { ...of("63", SHA.a), actor: person }),
    observed("change.merged", 8, { ...of("65", SHA.c), actor: person }),
  ];
}

test("R42.8: `rounds` counts per change, and a Round names its change; a head of one change ends no round of the other", () => {
  const given = rounds(twoChanges());
  const sorted = [...given].sort((a, b) => Number(a.change) - Number(b.change));
  assert.deepEqual(
    sorted.map((r) => [r.change, outcomes(r)]),
    [
      ["63", ["commented", "approved"]],
      ["65", ["changes_requested"]],
      ["65", ["approved"]],
    ],
  );
});

test("R42.8: `howl show` of a task with reviews on two changes gives the same rounds", () => {
  const shown = show(byTime(twoChanges()), parseAsked("task:40"), null)!;
  assert.deepEqual(
    shown.reviews.map((r) => [r.change, outcomes(r)]),
    [
      ["63", ["commented", "approved"]],
      ["65", ["changes_requested"]],
      ["65", ["approved"]],
    ],
  );
  assert.equal(shown.summary.reviewRounds, 3);
});

test("R42.9: the overview counts the rounds per change, as `howl show` does: change 63 one, change 65 two, mean 1.5", () => {
  const figures = keyFigures(twoChanges(), T0 + DAY);
  assert.equal(figures.merged, 2);
  assert.equal(figures.reviewRoundsMean, 1.5);
});

test("R42.13: the rounds of a merged change are of its reviews before its merge: a review after the merge adds no round", () => {
  const c = (sha: string) => of("63", sha);
  const events = [
    observed("change.opened", 0, { ...c(SHA.a), actor: agent }),
    observed("review.commented", 1, { ...c(SHA.a), actor: person }),
    observed("review.approved", 2, { ...c(SHA.a), actor: person }),
    observed("change.merged", 3, { ...c(SHA.a), actor: person }),
    observed("change.updated", 4, { ...c(SHA.b), actor: agent }),
    observed("review.commented", 5, { ...c(SHA.b), actor: person }),
  ];
  const figures = keyFigures(events, T0 + DAY);
  assert.equal(figures.merged, 1);
  assert.equal(figures.reviewRoundsMean, 1, "one round before the merge; the review on a later head adds none");
});

test("R42.15: README's paragraph `A review is a review` says what a round is and that both views count it the same way", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const paragraph = readme.split("\n\n").find((p) => p.startsWith("**A review is a review.**"));
  assert.ok(paragraph, "the paragraph is not there");
  assert.match(paragraph, /between two heads/);
  assert.match(paragraph, /the same way/);
  assert.match(paragraph, /overview/);
  assert.match(paragraph, /howl show/);
});
