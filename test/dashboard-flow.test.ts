// The change view draws a change as a flow graph: the lanes and arrows made from a change's events (#192).
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { show } from "../src/read/show.ts";
import { eventFilter, flowOf, rowName } from "../src/dashboard/flow.ts";
import { texts } from "../src/dashboard/texts.ts";
import { ledgerEvents, m, REVIEWER, MERGER, SHA } from "./story.ts";

let n = 0;
/** An event of change 30 of task 12 with the time `minute`, observed unless said. */
function ev(type: LedgerEvent["type"], minute: number, over: Partial<LedgerEvent> = {}, kind: "observed" | "claimed" = "observed"): LedgerEvent {
  return { v: 0, id: `flow-${++n}`, time: m(minute), type, source: { adapter: kind === "observed" ? "local" : "claude-code-hook", kind }, project: "example", ...over };
}
const of = (sha: string, more: Partial<LedgerEvent> = {}): Partial<LedgerEvent> => ({ change: "30", branch: "task-12-x", sha, task: "12", ...more });
const person = (id: string) => ({ kind: "person" as const, id });
const agent = (id: string) => ({ kind: "agent" as const, id });
const view = (events: LedgerEvent[], what: { kind: "change" | "task"; id: string } = { kind: "change", id: "30" }) => {
  const shown = show(events, what, null);
  assert.ok(shown !== null);
  return shown;
};
const key = (kind: string, id: string) => `${kind}:${id}`;

test("#192: the lanes are in the order each first appears; the story's change 30 has the code host, the agent, the checks and the two people", () => {
  const flow = flowOf(view(ledgerEvents()));
  assert.deepEqual(
    flow.lanes.map((l) => [l.key, l.label, l.kind]),
    [
      ["host", "Code host", "host"],
      [key("agent", "agent-1"), "agent-1", "agent"],
      ["checks", "Checks", "checks"],
      [key("person", REVIEWER), REVIEWER, "person"],
      [key("person", MERGER), MERGER, "person"],
    ],
  );
});

test("#192: a task given is an arrow from the giver to the receiver; one written before `to` has no giver and comes from the code host", () => {
  const given = flowOf(view([ev("task.assigned", 0, { task: "12", actor: person("person-aaaa"), to: agent("agent-7") }), ev("change.opened", 5, of(SHA.a, { actor: agent("agent-7") }))]));
  const [first] = given.rows;
  assert.equal(first!.kind, "arrow");
  assert.equal(first!.from, key("person", "person-aaaa"));
  assert.equal(first!.to, key("agent", "agent-7"));
  assert.equal(first!.label, "task given");
  assert.equal(first!.origin, "observed");
  assert.deepEqual(given.lanes.map((l) => l.key).slice(0, 2), [key("person", "person-aaaa"), key("agent", "agent-7")]);

  const old = flowOf(view(ledgerEvents()));
  assert.equal(old.rows[0]!.from, "host");
  assert.equal(old.rows[0]!.to, key("agent", "agent-1"));
  assert.equal(old.rows[0]!.label, "task given");
});

test("#192: the arrows of the story: direction, label and time, in the order of time", () => {
  const flow = flowOf(view(ledgerEvents()));
  const arrows = flow.rows.filter((r) => r.kind === "arrow").map((r) => [r.time, r.from, r.to, r.label]);
  const a = key("agent", "agent-1");
  assert.deepEqual(arrows, [
    [m(0), "host", a, "task given"],
    [m(10), a, "host", `change opened · head ${SHA.a.slice(0, 7)}`],
    [m(12), "checks", "host", `checks passed · head ${SHA.a.slice(0, 7)}`],
    [m(20), key("person", REVIEWER), a, "changes asked for"],
    [m(30), a, "host", `new head ${SHA.b.slice(0, 7)}`],
    [m(33), "checks", "host", `checks failed · head ${SHA.b.slice(0, 7)}`],
    [m(40), a, "host", `new head ${SHA.c.slice(0, 7)}`],
    [m(45), "checks", "host", `checks passed · head ${SHA.c.slice(0, 7)}`],
    [m(55), key("person", REVIEWER), a, "approved"],
    [m(60), key("person", MERGER), "host", "merged"],
  ]);
  // The times never go backwards.
  const times = flow.rows.map((r) => Date.parse(r.time));
  assert.deepEqual(times, [...times].sort((x, y) => x - y));
});

test("#192: an observed event is solid, a claimed one dashed, and each says so in words", () => {
  const flow = flowOf(
    view([
      ev("change.opened", 1, of(SHA.a, { actor: agent("agent-1") })),
      ev("review.approved", 2, of(SHA.a, { actor: person("person-bbbb") }), "claimed"),
      ev("change.merged", 3, of(SHA.a, { actor: person("person-bbbb") })),
    ]),
  );
  const [opened, approved, merged] = flow.rows;
  assert.equal(opened!.origin, "observed");
  assert.equal(opened!.line, "solid");
  assert.equal(approved!.origin, "claimed");
  assert.equal(approved!.line, "dashed");
  assert.equal(merged!.line, "solid");
  assert.equal(texts.flow.origin[approved!.origin], "claimed");
  assert.equal(texts.flow.origin[opened!.origin], "observed");
});

test("#192: a kind of source the page does not know is dotted and never taken as observed", () => {
  const odd = ev("change.opened", 1, of(SHA.a, { actor: agent("agent-1") }));
  (odd.source as { kind: string }).kind = "derived";
  const [row] = flowOf(view([odd])).rows;
  assert.equal(row!.origin, "unknown");
  assert.equal(row!.line, "dotted");
});

test("#192: a wait for a person is a note in its agent's lane with its length; a wait for instructions is none", () => {
  const flow = flowOf(view(ledgerEvents()));
  const notes = flow.rows.filter((r) => r.kind === "note");
  assert.equal(notes.length, 1);
  const [note] = notes;
  assert.equal(note!.time, m(5));
  assert.equal(note!.from, key("agent", "agent-1"));
  assert.equal(note!.to, key("agent", "agent-1"));
  assert.equal(note!.label, "waited for a person 3 min");
  assert.equal(note!.origin, "claimed");
  assert.equal(note!.line, "dashed");
  assert.equal(note!.event.type, "agent.waiting");
});

test("#192: a wait that is not answered says it is still going; one whose session names no actor takes the session's agent", () => {
  const wait = ev("agent.waiting", 5, { task: "12", session: "s9", branch: "task-12-x", data: { waits_for: "person" } }, "claimed");
  const start = ev("session.started", 1, { task: "12", session: "s9", branch: "task-12-x", actor: agent("agent-3") }, "claimed");
  const flow = flowOf(view([ev("task.assigned", 0, { task: "12", actor: agent("agent-3") }), start, wait], { kind: "task", id: "12" }));
  const note = flow.rows.find((r) => r.kind === "note")!;
  assert.equal(note.label, "still waiting for a person");
  assert.equal(note.from, key("agent", "agent-3"));
});

test("#192: a change with one actor has the code host and that one lane", () => {
  const flow = flowOf(view([ev("change.opened", 1, of(SHA.a, { actor: agent("agent-1") })), ev("change.merged", 5, of(SHA.a, { actor: agent("agent-1") }))]));
  assert.deepEqual(
    flow.lanes.map((l) => l.key),
    [key("agent", "agent-1"), "host"],
  );
  assert.equal(flow.rows.length, 2);
  assert.deepEqual(
    flow.rows.map((r) => [r.from, r.to]),
    [
      [key("agent", "agent-1"), "host"],
      [key("agent", "agent-1"), "host"],
    ],
  );
});

test("#192: a change with no review draws no review arrow and no reviewer lane", () => {
  const flow = flowOf(view([ev("change.opened", 1, of(SHA.a, { actor: agent("agent-1") })), ev("checks.passed", 2, of(SHA.a)), ev("change.merged", 5, of(SHA.a, { actor: person("person-cccc") }))]));
  assert.equal(flow.rows.some((r) => /approved|changes asked|review/.test(r.label)), false);
  assert.deepEqual(
    flow.lanes.map((l) => l.key),
    [key("agent", "agent-1"), "host", "checks", key("person", "person-cccc")],
  );
});

test("#192: a change with no event at all that the graph draws has no lane and no row", () => {
  const flow = flowOf(view([ev("change.commented", 1, of(SHA.a, { actor: person("person-dddd") }))]));
  assert.deepEqual(flow.lanes, []);
  assert.deepEqual(flow.rows, []);
});

test("#192: the agent behind a person's account is the lane, and the account is `via`", () => {
  const events = [
    ev("session.started", 0, { task: "12", session: "s1", branch: "task-12-x", actor: agent("agent-1") }, "claimed"),
    ev("change.opened", 1, of(SHA.a, { actor: person("person-aaaa") })),
  ];
  const [row] = flowOf(view(events)).rows;
  assert.equal(row!.from, key("agent", "agent-1"));
  assert.equal(row!.via, "person-aaaa");
  assert.match(rowName(row!, flowOf(view(events)).lanes, "10:00"), /via person-aaaa/);
});

test("#192: a head that names no one and matches no agent is a mark in the code host's lane", () => {
  const [row] = flowOf(view([ev("change.updated", 1, of(SHA.b))])).rows;
  assert.equal(row!.kind, "arrow");
  assert.equal(row!.from, "host");
  assert.equal(row!.to, "host");
  assert.equal(row!.label, `new head ${SHA.b.slice(0, 7)}`);
});

test("#192: a review by the author of the change is a mark in that lane, not an arrow between two", () => {
  const flow = flowOf(view([ev("change.opened", 1, of(SHA.a, { actor: agent("agent-1") })), ev("review.commented", 2, of(SHA.a, { actor: agent("agent-1") }))]));
  const [, review] = flow.rows;
  assert.equal(review!.kind, "arrow");
  assert.equal(review!.from, review!.to);
  assert.equal(review!.label, "review comment");
});

test("#192: a review whose change has no known author goes to the code host", () => {
  const [row] = flowOf(view([ev("review.approved", 2, of(SHA.a, { actor: person("person-eeee") }))])).rows;
  assert.equal(row!.from, key("person", "person-eeee"));
  assert.equal(row!.to, "host");
});

test("#192: an account that no longer exists is one lane, named so, and has no pseudonym", () => {
  const events = [ev("task.assigned", 0, { task: "12", actor: person("person-aaaa"), data: { to_account_removed: true } }), ev("change.opened", 1, of(SHA.a, { actor: agent("agent-1") }))];
  const flow = flowOf(view(events, { kind: "task", id: "12" }));
  assert.equal(flow.rows[0]!.to, "gone");
  assert.equal(flow.lanes.find((l) => l.key === "gone")!.label, "An account that no longer exists");
});

test("#192: a task taken back is drawn from the one who took it to the one it was taken from", () => {
  const events = [
    ev("task.assigned", 0, { task: "12", actor: person("person-aaaa"), to: agent("agent-1") }),
    ev("task.unassigned", 4, { task: "12", actor: person("person-aaaa"), to: agent("agent-1") }),
    ev("change.opened", 5, of(SHA.a, { actor: agent("agent-2") })),
  ];
  const rows = flowOf(view(events, { kind: "task", id: "12" })).rows;
  assert.equal(rows[1]!.label, "task taken back");
  assert.equal(rows[1]!.from, key("person", "person-aaaa"));
  assert.equal(rows[1]!.to, key("agent", "agent-1"));
});

test("#192: where the view has more than one change, a label says which change it is of", () => {
  const events = [
    ev("task.assigned", 0, { task: "12", actor: person("person-aaaa"), to: agent("agent-1") }),
    ev("change.opened", 1, { change: "30", task: "12", branch: "b1", sha: SHA.a, actor: agent("agent-1") }),
    ev("change.opened", 2, { change: "31", task: "12", branch: "b2", sha: SHA.b, actor: agent("agent-1") }),
  ];
  const labels = flowOf(view(events, { kind: "task", id: "12" })).rows.map((r) => r.label);
  assert.equal(labels[0], "task given");
  assert.equal(labels[1], `change 30: change opened · head ${SHA.a.slice(0, 7)}`);
  assert.equal(labels[2], `change 31: change opened · head ${SHA.b.slice(0, 7)}`);
});

test("#192: a row carries the event it opens, and the filter that finds it by its id is escaped", () => {
  const flow = flowOf(view(ledgerEvents()));
  const merged = flow.rows.at(-1)!;
  assert.equal(merged.event.type, "change.merged");
  assert.equal(eventFilter("github:1:review:77"), 'event.id == "github:1:review:77"');
  assert.equal(eventFilter('a"b\\c'), 'event.id == "a\\"b\\\\c"');
});

test("#192: the name of an arrow says the time, what, from, to, and observed or claimed", () => {
  const flow = flowOf(view(ledgerEvents()));
  const approved = flow.rows.find((r) => r.label === "approved")!;
  assert.equal(rowName(approved, flow.lanes, "10:55"), `10:55, approved, from ${REVIEWER} to agent-1, observed`);
  const note = flow.rows.find((r) => r.kind === "note")!;
  assert.equal(rowName(note, flow.lanes, "08:05"), "08:05, waited for a person 3 min, in the lane of agent-1, claimed");
});
