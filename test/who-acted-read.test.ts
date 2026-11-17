// #45: what the readers do with `to` and with the four new types: the hand-over, the end of a change, the open changes
// of the overview, the state, the filter and the lines. Events as an adapter writes them, and events as they were
// written before this step.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { concerns, decodedFields } from "../src/dashboard/format.ts";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { happensBefore } from "../src/observe/order.ts";
import { handovers, keyFigures } from "../src/read/overview.ts";
import { readFilters } from "../src/read/filter.ts";
import { parseAsked, render, show, type Shown } from "../src/read/show.ts";
import { agentStates } from "../src/read/state.ts";
import { formatLine } from "../src/read/watch.ts";
import { PROJECT } from "./helpers.ts";

const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const BRANCH = "issue-40-x";
const SHA = { a: "a".repeat(40), b: "b".repeat(40) };
const person = { kind: "person" as const, id: "person-0a0a0a0a" };
const other = { kind: "person" as const, id: "person-0b0b0b0b" };
const agent = { kind: "agent" as const, id: "agent-1" };
const second = { kind: "agent" as const, id: "agent-2" };

let n = 0;
function observed(type: string, minute: number, extra: Record<string, unknown> = {}): LedgerEvent {
  return { v: 0, id: `ev-${++n}`, time: at(minute), type, source: { adapter: "github", kind: "observed" }, project: PROJECT, ...extra } as LedgerEvent;
}
function claimed(type: string, minute: number, extra: Record<string, unknown> = {}): LedgerEvent {
  return { v: 0, id: `ev-${++n}`, time: at(minute), type, source: { adapter: "claude-code-hook", kind: "claimed" }, project: PROJECT, actor: agent, ...extra } as LedgerEvent;
}
const of = (change: string, sha = SHA.a) => ({ task: "40", change, branch: BRANCH, sha });
const ask = (events: LedgerEvent[], what = "task:40"): Shown => show(events, parseAsked(what), null)!;
const lineOf = (text: string, start: string) => text.split("\n").find((l) => l.includes(start));

// The hand-over.

test("a giving that names its giver: the hand-over row has the receiver as `actor` and the giver as `by`", () => {
  const shown = ask([observed("task.opened", 0, { task: "40", actor: person }), observed("task.assigned", 1, { task: "40", actor: other, to: agent })]);
  assert.deepEqual(shown.handover, [{ time: at(1), actor: agent, by: other, kind: "observed" }]);
  const text = render(shown, { utc: true });
  assert.match(lineOf(text, "given to")!, /observed {2}given to agent-1 by person-0b0b0b0b$/);
});

test("an old giving, with no `to`: the actor is the receiver, as before", () => {
  const shown = ask([observed("task.opened", 0, { task: "40", actor: person }), observed("task.assigned", 1, { task: "40", actor: agent })]);
  assert.deepEqual(shown.handover, [{ time: at(1), actor: agent, kind: "observed" }]);
  assert.match(lineOf(render(shown, { utc: true }), "given to")!, /observed {2}given to agent-1$/);
});

test("two old givings of one task are both in the hand-over, as before", () => {
  const shown = ask([observed("task.assigned", 1, { task: "40", actor: agent }), observed("task.assigned", 2, { task: "40", actor: second })]);
  assert.deepEqual(shown.handover.map((h) => h.actor), [agent, second]);
});

test("a task given, taken back and given to another: every giving is shown, the first marked as taken back, and the taking back", () => {
  const shown = ask([
    observed("task.assigned", 1, { task: "40", actor: other, to: agent }),
    observed("task.unassigned", 2, { task: "40", actor: other, to: agent }),
    observed("task.assigned", 3, { task: "40", actor: other, to: second }),
  ]);
  assert.deepEqual(shown.handover, [
    { time: at(1), actor: agent, by: other, kind: "observed", takenBack: { time: at(2), by: other, kind: "observed" } },
    { time: at(3), actor: second, by: other, kind: "observed" },
  ]);
  assert.deepEqual(shown.takenBack, [{ time: at(2), actor: agent, by: other, kind: "observed" }]);
  const text = render(shown, { utc: true });
  const given = text.split("\n").filter((l) => /given to|taken from/.test(l));
  assert.equal(given.length, 3, text);
  assert.match(given[0]!, /given to agent-1 by person-0b0b0b0b/);
  assert.match(given[1]!, /taken from agent-1 by person-0b0b0b0b/);
  assert.match(given[2]!, /given to agent-2 by person-0b0b0b0b/);
  assert.doesNotMatch(text, /given to no one now/);
  // The summary is measured from the first giving, whether or not it was taken back, as before this step.
  assert.equal(shown.summary.from, at(1));
});

test("the summary starts at the first giving: a task given to one agent, its change merged, then taken back and given to another", () => {
  const shown = ask([
    observed("task.opened", 0, { task: "40", actor: person }),
    observed("task.assigned", 1, { task: "40", actor: other, to: agent }),
    observed("change.opened", 2, { ...of("63"), actor: agent }),
    observed("change.merged", 4, { ...of("63"), actor: person }),
    observed("task.unassigned", 6, { task: "40", actor: other, to: agent }),
    observed("task.assigned", 6, { task: "40", actor: other, to: second }),
  ]);
  assert.equal(shown.summary.from, at(1));
  assert.equal(shown.summary.to, at(4));
  assert.equal(shown.summary.seconds, 180);
  assert.match(render(shown, { utc: true }), /hand-over to the end: 3m/);
});

test("the summary starts at the first giving: taken back after the merge, it does not start at the change's opening", () => {
  const shown = ask([
    observed("task.assigned", 1, { task: "40", actor: other, to: agent }),
    observed("change.opened", 10, { ...of("63"), actor: agent }),
    observed("change.merged", 20, { ...of("63"), actor: person }),
    observed("task.unassigned", 30, { task: "40", actor: other, to: agent }),
  ]);
  assert.equal(shown.summary.from, at(1));
  assert.equal(shown.summary.seconds, 19 * 60);
});

test("the summary starts at the first giving: given to a second agent, the first agent's time is not lost", () => {
  const shown = ask([
    observed("task.assigned", 1, { task: "40", actor: other, to: agent }),
    observed("task.assigned", 2, { task: "40", actor: other, to: second }),
    observed("task.unassigned", 3, { task: "40", actor: other, to: agent }),
    observed("change.opened", 10, { ...of("63"), actor: second }),
  ]);
  assert.equal(shown.summary.from, at(1));
});

test("a summary is never negative: a task given only after its change had ended", () => {
  const shown = ask([
    observed("change.opened", 2, { ...of("63"), actor: agent }),
    observed("change.merged", 4, { ...of("63"), actor: person }),
    observed("task.assigned", 6, { task: "40", actor: other, to: agent }),
  ]);
  assert.ok(shown.summary.seconds >= 0, String(shown.summary.seconds));
  assert.ok(Date.parse(shown.summary.from) <= Date.parse(shown.summary.to));
});

test("a task given only after its change had ended is measured from the first sign of work, with the label of that, not as 0s from a hand-over", () => {
  const shown = ask([
    observed("task.opened", 0, { task: "40", actor: person }),
    observed("change.opened", 10, { ...of("63"), actor: agent }),
    observed("change.merged", 40, { ...of("63"), actor: person }),
    observed("task.assigned", 45, { task: "40", actor: other, to: agent }),
  ]);
  assert.equal(shown.summary.from, at(10));
  assert.equal(shown.summary.to, at(40));
  assert.equal(shown.summary.seconds, 30 * 60);
  const text = render(shown, { utc: true });
  assert.match(text, /first event to the end: 30m/);
  assert.doesNotMatch(text, /hand-over to the end/);
  // The giving is still in the hand-over.
  assert.equal(shown.handover.length, 1);
});

test("a round whose change was closed, reopened and merged says what followed, in the order it happened", () => {
  const shown = ask([
    observed("task.opened", 0, { task: "40", actor: person }),
    observed("change.opened", 10, { ...of("63"), actor: agent }),
    observed("review.changes_requested", 15, { ...of("63"), actor: other }),
    observed("change.closed", 20, { ...of("63"), actor: other }),
    observed("change.reopened", 25, { ...of("63"), actor: other }),
    observed("change.merged", 40, { ...of("63"), actor: person }),
  ]);
  assert.equal(shown.reviews[0]!.followedBy, "change.closed");
  const text = render(shown, { utc: true });
  assert.match(text, /followed by closing the change, then opening it again, then the merge/);
  // With no reopening it reads as before.
  const plain = render(ask([observed("change.opened", 10, { ...of("63") }), observed("review.approved", 15, { ...of("63"), actor: other }), observed("change.merged", 20, { ...of("63") })]), { utc: true });
  assert.match(plain, /; followed by the merge\n/);
});

test("a task taken back from the one who had it and given to the same again: two givings, the first taken back", () => {
  const shown = ask([
    observed("task.assigned", 1, { task: "40", actor: other, to: agent }),
    observed("task.unassigned", 2, { task: "40", actor: other, to: agent }),
    observed("task.assigned", 3, { task: "40", actor: other, to: agent }),
  ]);
  assert.deepEqual(shown.handover.map((h) => [h.time, h.takenBack?.time]), [[at(1), at(2)], [at(3), undefined]]);
  assert.doesNotMatch(render(shown, { utc: true }), /given to no one now/);
});

test("taking back from one of two who have it leaves the other: both givings shown, one taken back", () => {
  const shown = ask([
    observed("task.assigned", 1, { task: "40", actor: other, to: agent }),
    observed("task.assigned", 2, { task: "40", actor: other, to: second }),
    observed("task.unassigned", 3, { task: "40", actor: other, to: agent }),
  ]);
  assert.deepEqual(shown.handover.map((h) => [h.actor, h.takenBack?.time]), [[agent, at(3)], [second, undefined]]);
});

test("an old giving is taken back by name: the actor of the old event is who had it", () => {
  const shown = ask([observed("task.assigned", 1, { task: "40", actor: agent }), observed("task.unassigned", 2, { task: "40", actor: other, to: agent })]);
  assert.deepEqual(shown.handover, [{ time: at(1), actor: agent, kind: "observed", takenBack: { time: at(2), by: other, kind: "observed" } }]);
  assert.equal(shown.takenBack.length, 1);
  assert.match(render(shown, { utc: true }), /given to no one now/);
});

const text = (events: LedgerEvent[]) => render(ask(events), { utc: true });

test("#48: given by someone to an account that is gone: the actor, no `to`, `to_account_removed`: the receiver is the one gone", () => {
  const shown = ask([observed("task.assigned", 1, { task: "40", actor: other, data: { to_account_removed: true } })]);
  assert.deepEqual(shown.handover, [{ time: at(1), by: other, kind: "observed", gone: ["to"] }]);
  assert.match(lineOf(render(shown, { utc: true }), "given to")!, /given to someone \(account removed\) by person-0b0b0b0b$/);
});

test("#48: given by an account that is gone: no actor, `to`, `account_removed`: the giver is the one gone", () => {
  const shown = ask([observed("task.assigned", 1, { task: "40", to: agent, data: { account_removed: true } })]);
  assert.deepEqual(shown.handover, [{ time: at(1), actor: agent, kind: "observed", gone: ["by"] }]);
  assert.match(lineOf(render(shown, { utc: true }), "given to")!, /given to agent-1 by someone \(account removed\)$/);
});

test("#48: both gone: no actor, no `to`, both flags: both are said gone", () => {
  const shown = ask([observed("task.assigned", 1, { task: "40", data: { account_removed: true, to_account_removed: true } })]);
  assert.deepEqual(shown.handover, [{ time: at(1), kind: "observed", gone: ["to", "by"] }]);
  assert.match(lineOf(render(shown, { utc: true }), "given to")!, /given to someone \(account removed\) by someone \(account removed\)$/);
});

test("#48: given to an account that is gone and the giver unsaid: no actor, no `to`, `to_account_removed` only", () => {
  const shown = ask([observed("task.assigned", 1, { task: "40", data: { to_account_removed: true } })]);
  assert.deepEqual(shown.handover, [{ time: at(1), kind: "observed", gone: ["to"] }]);
  assert.match(lineOf(render(shown, { utc: true }), "given to")!, /given to someone \(account removed\)$/);
});

test("an old giving to an account that is gone has no actor and no `to` and `account_removed`: the receiver is gone, as before", () => {
  const shown = ask([observed("task.assigned", 1, { task: "40", data: { account_removed: true } })]);
  assert.deepEqual(shown.handover, [{ time: at(1), kind: "observed", gone: ["to"] }]);
  assert.match(lineOf(render(shown, { utc: true }), "given to")!, /given to someone \(account removed\)$/);
});

test("a claimed taking back is shown as a claim and takes nothing back", () => {
  const shown = ask([
    observed("task.assigned", 1, { task: "40", actor: other, to: agent }),
    claimed("task.unassigned", 2, { task: "40", to: agent }),
  ]);
  assert.deepEqual(shown.handover.map((h) => h.actor), [agent]);
  assert.deepEqual(shown.takenBack, []);
  assert.deepEqual(shown.claimed.map((c) => c.type), ["task.unassigned"]);
});

test("the view of one change shows the task's giving with the giver and the receiver, as the task's view does", () => {
  const events = [
    observed("task.opened", 0, { task: "40", actor: person }),
    observed("task.assigned", 1, { task: "40", actor: other, to: agent }),
    observed("change.opened", 10, { ...of("63"), actor: agent }),
    observed("change.opened", 60, { ...of("65", SHA.b), actor: agent }),
  ];
  const one = ask(events, "change:65");
  assert.deepEqual(one.handover, ask(events, "task:40").handover);
  assert.match(lineOf(render(one, { utc: true }), "given to")!, /given to agent-1 by person-0b0b0b0b$/);
});

test("a task reopened is shown with the task's closing", () => {
  const shown = ask([
    observed("task.opened", 0, { task: "40", actor: person }),
    observed("task.closed", 5, { task: "40", actor: other }),
    observed("task.reopened", 6, { task: "40", actor: person }),
    observed("change.opened", 10, { ...of("63"), actor: agent }),
  ]);
  const text = render(shown, { utc: true });
  assert.match(text, /task closed by person-0b0b0b0b/);
  assert.match(text, /task reopened by person-0a0a0a0a/);
  assert.equal(shown.end.state, "open", "the tracker decides nothing about the end");
});

// The end of a change that is opened again.

const lifeOfOne = (...rest: LedgerEvent[]) => [
  observed("task.opened", 0, { task: "40", actor: person }),
  observed("change.opened", 10, { ...of("63"), actor: agent }),
  ...rest,
];

test("a change closed, reopened and merged: open between the two, merged at the merge, once", () => {
  const closed = observed("change.closed", 20, { ...of("63"), actor: other });
  const reopened = observed("change.reopened", 25, { ...of("63"), actor: other });
  const merged = observed("change.merged", 40, { ...of("63"), actor: person });

  assert.deepEqual(ask(lifeOfOne(closed)).end, { state: "closed", time: at(20), actor: other });
  const between = ask(lifeOfOne(closed, reopened));
  assert.deepEqual(between.end, { state: "open" }, "a closing before a reopening ends nothing");
  assert.deepEqual(between.changes[0]!.end, { state: "open" });
  assert.equal(between.summary.open, true);
  assert.equal(between.summary.to, at(25), "to the last event");
  assert.equal(render(between, { utc: true }).split("\n")[0], "Task 40: open");

  const done = ask(lifeOfOne(closed, reopened, merged));
  assert.deepEqual(done.end, { state: "merged", time: at(40), actor: person });
  assert.deepEqual(done.changes[0]!.end, done.end);
  assert.equal(done.summary.to, at(40));
  assert.equal(done.events.filter((e) => e.type === "change.merged").length, 1);
  assert.equal(render(done, { utc: true }).split("\n")[0], "Task 40: merged");
  // The same in the view of the change.
  assert.deepEqual(ask(lifeOfOne(closed, reopened), "change:63").end, { state: "open" });
  assert.deepEqual(ask(lifeOfOne(closed, reopened, merged), "change:63").end, done.end);
});

test("a change closed, reopened and closed again: closed at the last closing", () => {
  const shown = ask(
    lifeOfOne(
      observed("change.closed", 20, { ...of("63"), actor: other }),
      observed("change.reopened", 25, { ...of("63"), actor: other }),
      observed("change.closed", 30, { ...of("63"), actor: person }),
    ),
  );
  assert.deepEqual(shown.end, { state: "closed", time: at(30), actor: person });
});

test("the lines of the ledger in another order than time give the same end", () => {
  const events = lifeOfOne(
    observed("change.merged", 40, { ...of("63"), actor: person }),
    observed("change.reopened", 25, { ...of("63"), actor: other }),
    observed("change.closed", 20, { ...of("63"), actor: other }),
  );
  assert.deepEqual(ask(events).end, { state: "merged", time: at(40), actor: person });
});

test("a task of two changes: the one that is opened again keeps the task open until it ends", () => {
  const events = [
    observed("task.opened", 0, { task: "40", actor: person }),
    observed("change.opened", 10, { ...of("63"), actor: agent }),
    observed("change.merged", 30, { ...of("63"), actor: person }),
    observed("change.opened", 60, { ...of("65", SHA.b), actor: agent }),
    observed("change.closed", 70, { ...of("65", SHA.b), actor: person }),
  ];
  assert.deepEqual(ask(events).end, { state: "merged", time: at(70), change: "65" });
  const reopened = [...events, observed("change.reopened", 75, { ...of("65", SHA.b), actor: person })];
  assert.deepEqual(ask(reopened).end, { state: "open" });
  assert.deepEqual(ask([...reopened, observed("change.merged", 80, { ...of("65", SHA.b), actor: person })]).end, { state: "merged", time: at(80), actor: person, change: "65" });
});

test("a claimed reopening reopens nothing", () => {
  const shown = ask(lifeOfOne(observed("change.closed", 20, { ...of("63"), actor: other }), claimed("change.reopened", 25, { ...of("63") })));
  assert.deepEqual(shown.end, { state: "closed", time: at(20), actor: other });
});

test("what a session did while its change was closed and opened again is of that change, not of the next one on the branch", () => {
  const events = [
    observed("task.opened", 0, { task: "40", actor: person }),
    observed("change.opened", 10, { ...of("63"), actor: agent }),
    observed("change.closed", 20, { ...of("63"), actor: other }),
    observed("change.reopened", 25, { ...of("63"), actor: other }),
    claimed("session.started", 30, { session: "s1", branch: BRANCH }),
    observed("change.opened", 60, { ...of("65", SHA.b), actor: agent }),
    observed("change.merged", 90, { ...of("65", SHA.b), actor: person }),
  ];
  const first = ask(events, "change:63");
  assert.ok(first.sessions.some((s) => s.session === "s1"), "the session at 30 is of the first change");
  const next = ask(events, "change:65");
  assert.ok(!next.sessions.some((s) => s.session === "s1"));
});

// The overview.

test("the overview counts a change that is opened again as open again, and merged once", () => {
  const events = [
    observed("change.opened", 10, { ...of("63"), actor: agent }),
    observed("change.closed", 20, { ...of("63"), actor: other }),
    observed("change.reopened", 25, { ...of("63"), actor: other }),
    observed("change.merged", 40, { ...of("63"), actor: person }),
  ];
  const now = T0 + 3600_000;
  const figures = (count: number) => keyFigures(events.slice(0, count), now);
  assert.deepEqual([1, 2, 3, 4].map((c) => figures(c).open), [1, 0, 1, 0]);
  assert.deepEqual([1, 2, 3, 4].map((c) => figures(c).merged), [0, 0, 0, 1]);
  // In another order of the lines, the same.
  assert.equal(keyFigures([...events].reverse(), now).open, 0);
});

test("a reopening after a merge does not open a merged change", () => {
  const events = [observed("change.opened", 10, { ...of("63") }), observed("change.merged", 40, { ...of("63") }), observed("change.reopened", 40, { ...of("63") })];
  assert.equal(keyFigures(events, T0 + 3600_000).open, 0);
});

test("a claimed reopening is not counted in the figures", () => {
  const events = [observed("change.opened", 10, of("63")), observed("change.closed", 20, of("63")), claimed("change.reopened", 25, of("63"))];
  assert.equal(keyFigures(events, T0 + 3600_000).open, 0);
});

// A review that is dismissed (#45): a review that happened, marked as dismissed.

const dismissal = (minute: number, review: string, extra: Record<string, unknown> = {}) =>
  observed("review.dismissed", minute, { ...of("63"), actor: person, data: { review }, ...extra });
const review = (type: string, minute: number, id: string, actor = other) => observed(type, minute, { ...of("63"), id: `github:1:review:${id}`, actor });

test("a request for changes that is dismissed before the merge: the round shows it with its outcome, and as dismissed by whom; the counts are as before", () => {
  const events = [
    observed("task.opened", 0, { task: "40", actor: person }),
    observed("change.opened", 10, { ...of("63"), actor: agent }),
    review("review.changes_requested", 20, "9"),
    dismissal(25, "9"),
    observed("change.merged", 40, { ...of("63"), actor: person }),
  ];
  const shown = ask(events);
  assert.equal(shown.reviews.length, 1);
  assert.deepEqual(shown.reviews[0]!.reviews.map((r) => [r.outcome, r.dismissed]), [["changes_requested", { time: at(25), actor: person }]]);
  assert.match(render(shown, { utc: true }), /round 1: person-0b0b0b0b changes requested \(dismissed by person-0a0a0a0a at 2026-11-16T09:25:00Z\)/);
  assert.equal(shown.summary.reviewRounds, 1);
  const plain = events.filter((e) => e.type !== "review.dismissed");
  assert.deepEqual(handovers(events.map((event) => ({ event }))), handovers(plain.map((event) => ({ event }))));
  assert.equal(keyFigures(events, T0 + 3600_000).reviewRoundsMean, keyFigures(plain, T0 + 3600_000).reviewRoundsMean);
  assert.equal(keyFigures(events, T0 + 3600_000).unattributed!.count, keyFigures(plain, T0 + 3600_000).unattributed!.count);
});

test("a dismissal is no review on its own: no round, and no matching to an agent", () => {
  const alone = [observed("change.opened", 10, { ...of("63"), actor: agent }), dismissal(25, "9", { actor: other }), observed("change.merged", 40, { ...of("63"), actor: other })];
  assert.equal(handovers(alone.map((event) => ({ event }))).filter((h) => h.step !== "Review → merge").length, 0);
  assert.equal(keyFigures(alone, T0 + 3600_000).unattributed!.count, 0);
  assert.equal(ask(alone).reviews.length, 0);
});

test("a dismissal that does not say which review: said so, nothing said of the ledger, and the summary does not guess that an approval was dismissed", () => {
  const unnamed = observed("review.dismissed", 25, { ...of("63"), actor: person, data: { review_unnamed: true } });
  const events = [
    observed("change.opened", 10, { ...of("63"), actor: agent }),
    review("review.approved", 20, "9"),
    unnamed,
    observed("change.merged", 40, { ...of("63"), actor: person }),
  ];
  const shown = ask(events);
  assert.deepEqual(shown.unnamedDismissals, [{ time: at(25), actor: person, change: "63" }]);
  assert.deepEqual(shown.unseenDismissals, []);
  const text = render(shown, { utc: true });
  assert.match(text, /a review was dismissed; the host did not say which \(by person-0a0a0a0a\)/);
  assert.doesNotMatch(text, /not in the ledger/);
  assert.equal(shown.reviews[0]!.reviews[0]!.dismissed, undefined, "the approval is not marked: which review it was is not known");
  // The change is not said to wait for review on a guess: the approval stands, as before the dismissal.
  const without = ask(events.filter((e) => e !== unnamed)).summary.parts;
  assert.deepEqual(shown.summary.parts, without);
});

test("an approval that is dismissed: from then the summary counts waiting for review, not waiting for a person", () => {
  const before = [
    observed("change.opened", 10, { ...of("63"), actor: agent }),
    review("review.approved", 20, "9"),
    observed("change.merged", 40, { ...of("63"), actor: person }),
  ];
  const withDismissal = [before[0]!, before[1]!, dismissal(25, "9"), before[2]!];
  const a = ask(before).summary.parts;
  const b = ask(withDismissal).summary.parts;
  assert.equal(a.person, 20 * 60);
  assert.equal(a.review, 10 * 60);
  assert.equal(b.person, 5 * 60, "waiting for a person until the dismissal");
  assert.equal(b.review, 10 * 60 + 15 * 60, "and for review again from it");
});

test("a dismissal that names no review the ledger holds is said so", () => {
  const unseen = observed("review.dismissed", 25, { ...of("63"), actor: person, data: { review_unseen: true } });
  const shown = ask([observed("change.opened", 10, { ...of("63"), actor: agent }), unseen]);
  assert.deepEqual(shown.unseenDismissals, [{ time: at(25), actor: person, change: "63" }]);
  assert.deepEqual(shown.reviews, []);
  assert.match(render(shown, { utc: true }), /a review that is not in the ledger was dismissed by person-0a0a0a0a/);
});

// The state, the filter and the lines.

test("the state: an agent that got a task has a row, and an agent that gave one has one", () => {
  const rows = agentStates([observed("task.assigned", 1, { task: "40", actor: person, to: agent }), observed("task.assigned", 2, { task: "41", actor: second, to: other })], T0 + 3600_000);
  assert.deepEqual(rows.map((r) => r.agent).sort(), ["agent-1", "agent-2"]);
  // Before this step the actor was the receiver.
  const old = agentStates([observed("task.assigned", 1, { task: "40", actor: agent })], T0 + 3600_000);
  assert.deepEqual(old.map((r) => [r.agent, r.last]), [["agent-1", at(1)]]);
  // A person who gave a task to an agent is no row.
  assert.deepEqual(agentStates([observed("task.assigned", 1, { task: "40", actor: person, to: other })], T0 + 3600_000), []);
});

test("a filter never sees the pseudonym of a person in `to`, as it never does in `actor`", () => {
  const e = observed("task.assigned", 1, { task: "40", actor: person, to: other });
  const one = (text: string) => readFilters([text]).test(e);
  assert.equal(one('event.to.id == "a person"'), true);
  assert.equal(one('event.to.id == "person-0b0b0b0b"'), false);
  assert.equal(one('event.actor.id == "a person"'), true);
  const toAgent = observed("task.assigned", 1, { task: "40", actor: person, to: agent });
  assert.equal(readFilters(['event.to.id == "agent-1"']).test(toAgent), true);
});

test("the line of the stream and the decoded view name the receiver of a giving", () => {
  const e = observed("task.assigned", 1, { task: "40", actor: other, to: agent });
  const line = formatLine(e, false, true);
  assert.match(line, /person-0b0b0b0b +task\.assigned +task 40 +to agent-1/);
  const back = observed("task.unassigned", 2, { task: "40", actor: other, to: agent });
  assert.match(formatLine(back, false, true), /task\.unassigned +task 40 +taken from agent-1/);
  assert.doesNotMatch(formatLine(back, false, true), / to agent-1/);
  assert.equal(concerns({ event: back } as any), "task 40 · taken from agent-1");
  assert.equal(concerns({ event: e } as any), "task 40 · to agent-1");
  const unassigned = decodedFields({ event: back, from: "ledger", n: 3, prev: null } as any);
  assert.deepEqual(unassigned.find((f) => f.k === "Taken from"), { k: "Taken from", v: "agent-1 (agent)" });
  assert.equal(unassigned.some((f) => f.k === "To"), false);
  const fields = decodedFields({ event: e, from: "ledger", n: 2, prev: null } as any);
  assert.deepEqual(fields.find((f) => f.k === "To"), { k: "To", v: "agent-1 (agent)" });
  assert.equal(decodedFields({ event: observed("task.assigned", 1, { task: "40", actor: agent }), from: "ledger", n: 2, prev: null } as any).some((f) => f.k === "To"), false);
});

// The order of one moment.

test("#112: at one moment a taking back comes before a giving, a reopening follows the closing, a dismissal follows a review", () => {
  const e = (type: string, id: string) => ({ type, time: at(1), id });
  const sorted = (events: { type: string; time: string; id: string }[]) => [...events].sort(happensBefore).map((x) => x.type);
  // With no order of the host's own (ids that are no numbers), a taking back comes before a giving: it can only take back what was given before.
  assert.deepEqual(sorted([e("task.assigned", "z"), e("task.unassigned", "a")]), ["task.unassigned", "task.assigned"]);
  // With the host's ids, its order: it numbered them as they happened.
  const host = (type: string, id: number) => e(type, `github:1:task:5:${type === "task.assigned" ? "assigned" : "unassigned"}:${id}`);
  const ids = (events: { type: string; time: string; id: string }[]) => [...events].sort(happensBefore).map((x) => x.id.split(":").at(-1));
  assert.deepEqual(ids([{ ...host("task.unassigned", 902) }, { ...host("task.assigned", 901) }]), ["901", "902"]);
  assert.deepEqual(ids([{ ...host("task.assigned", 902) }, { ...host("task.unassigned", 901) }]), ["901", "902"]);
  assert.deepEqual(ids([{ ...host("task.assigned", 9) }, { ...host("task.unassigned", 10) }]), ["9", "10"], "ids as numbers");
  assert.deepEqual(sorted([e("change.reopened", "a"), e("change.closed", "z")]), ["change.closed", "change.reopened"]);
  assert.deepEqual(sorted([e("task.reopened", "a"), e("task.closed", "z")]), ["task.closed", "task.reopened"]);
  assert.deepEqual(sorted([e("review.dismissed", "a"), e("review.approved", "z")]), ["review.approved", "review.dismissed"]);
  assert.deepEqual(sorted([e("change.merged", "z"), e("review.dismissed", "a")]), ["review.dismissed", "change.merged"]);
});
