// One fold for what an agent is doing: the state of the overview and the parts of a summary agree (#39).
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { parseAsked, show, type Shown } from "../src/read/show.ts";
import { agentStates } from "../src/read/state.ts";
import { texts } from "../src/dashboard/texts.ts";
import { PROJECT } from "./helpers.ts";
import { activityEvents, ledgerEvents } from "./story.ts";

const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const SHA = { a: "a".repeat(40), b: "b".repeat(40) };
const person = { kind: "person" as const, id: "person-0a0a0a0a" };
const agent = { kind: "agent" as const, id: "agent-1" };

let n = 0;
function observed(type: string, minute: number, extra: Record<string, unknown> = {}): LedgerEvent {
  return { v: 0, id: `ev-${++n}`, time: at(minute), type, source: { adapter: "github", kind: "observed" }, project: PROJECT, ...extra } as LedgerEvent;
}
/** A session's own event: claimed, on the branch of its checkout. */
function hook(type: string, minute: number, branch: string, extra: Record<string, unknown> = {}): LedgerEvent {
  return { v: 0, id: `ev-${++n}`, time: at(minute), type, source: { adapter: "claude-code-hook", kind: "claimed" }, project: PROJECT, actor: agent, session: "s1", branch, ...extra } as LedgerEvent;
}
const of = (change: string, branch: string, sha: string) => ({ task: "40", change, branch, sha });
/** Every summary this file asks for, so that the last test can look at them all. */
const asked: { what: string; summary: Shown["summary"] }[] = [];
const ask = (events: LedgerEvent[], what = "task:40"): Shown => {
  const shown = show(events, parseAsked(what), null)!;
  asked.push({ what, summary: shown.summary });
  return shown;
};
const parts = (events: LedgerEvent[], what = "task:40") => ask(events, what).summary.parts as Record<string, number>;
const sum = (s: Shown["summary"]) => Object.values(s.parts as Record<string, number>).reduce((a, b) => a + b, 0);

const none = { work: 0, person: 0, instructions: 0, checks: 0, review: 0, unknown: 0 };

/** The part a state of the overview is counted in, where the change waits for nothing. */
const PART: Record<string, string> = { working: "work", "needs-input": "person", waiting: "instructions", idle: "unknown", ended: "unknown" };

/**
 * The part of the summary's last minute: the one part that grows when the last event, which moves nothing
 * of the agent and nothing the change waits for, comes a minute later.
 */
function lastPart(build: (end: number) => LedgerEvent[], end: number, what: string): string {
  const before = parts(build(end - 1), what);
  const after = parts(build(end), what);
  const grown = Object.keys(after).filter((k) => after[k] !== before[k]);
  assert.equal(grown.length, 1, `one part grows: ${JSON.stringify({ before, after })}`);
  assert.equal(after[grown[0]!]! - before[grown[0]!]!, 60);
  return grown[0]!;
}

/** The end of a session at minute `t`, one way or another. */
const endings: Record<string, (t: number, branch: string) => LedgerEvent[]> = {
  working: (t, b) => [hook("tool.used", t, b, { data: { tool: "Edit", target: "src/a.ts", outcome: "succeeded" } })],
  "a wait for a person": (t, b) => [hook("agent.waiting", t, b, { data: { waits_for: "person" } })],
  "a wait for instructions": (t, b) => [hook("agent.waiting", t, b, { data: { waits_for: "instructions" } })],
  "a stopped turn": (t, b) => [hook("session.stopped", t, b)],
  "an ended session": (t, b) => [hook("session.ended", t, b)],
  "nothing for five minutes": () => [],
};
const stateOf: Record<string, string> = {
  working: "working",
  "a wait for a person": "needs-input",
  "a wait for instructions": "waiting",
  "a stopped turn": "waiting",
  "an ended session": "ended",
  "nothing for five minutes": "idle",
};

test("the story, minute by minute: work, the waits and unknown", () => {
  const all = [...ledgerEvents(), ...activityEvents()].map((event, i) => ({ event, i }));
  all.sort((a, b) => Date.parse(a.event.time) - Date.parse(b.event.time) || a.i - b.i);
  const s = show(all.map((x) => x.event), { kind: "task", id: "12" }, null)!.summary;
  asked.push({ what: "the story", summary: s });
  assert.equal(s.seconds, 3600);
  assert.deepEqual(s.parts, {
    // 2 to 5 (started, tool calls at 3 and 4), 6 to 8 (tool calls at 6 and 7, the stopped turn at 8), 22 to 30 (a tool call at 25, ended at 30).
    work: 3 * 60 + 2 * 60 + 8 * 60,
    // 5 to 6 the permission prompt; 55 to 60 approved, not merged.
    person: 60 + 5 * 60,
    // 8 to 9 the stopped turn, 9 to 10 the idle prompt.
    instructions: 60 + 60,
    // 10 to 12, 30 to 33, 40 to 45: each head until its checks.
    checks: 2 * 60 + 3 * 60 + 5 * 60,
    // 12 to 20 and 45 to 55.
    review: 8 * 60 + 10 * 60,
    // 0 to 2 no session yet; 20 to 22 after s1 ended, changes requested; 33 to 40 after s2 ended, checks failed.
    unknown: 2 * 60 + 2 * 60 + 7 * 60,
  });
});

test("a task whose only session ended an hour before the merge: none of that hour is waiting for instructions", () => {
  const events = [
    observed("task.assigned", 0, { task: "40", actor: person, to: agent }),
    hook("session.started", 0, "b1"),
    hook("tool.used", 4, "b1", { data: { tool: "Edit", target: "src/a.ts", outcome: "succeeded" } }),
    observed("change.opened", 5, { ...of("63", "b1", SHA.a), actor: agent }),
    observed("review.changes_requested", 8, { ...of("63", "b1", SHA.a), actor: person }),
    hook("tool.used", 9, "b1", { data: { tool: "Edit", target: "src/a.ts", outcome: "succeeded" } }),
    hook("session.stopped", 10, "b1"),
    hook("session.ended", 20, "b1"),
    observed("change.merged", 80, { ...of("63", "b1", SHA.a), actor: person }),
  ];
  // 0 to 10 work (the agent works, before and after the review); 10 to 20 the stopped turn waits for
  // instructions; 20 to 80 the session has ended and the change waits for nothing: unknown.
  assert.deepEqual(parts(events), { ...none, work: 600, instructions: 600, unknown: 3600 });
});

test("a session with one tool call and nothing for two hours, then a wait: five minutes of work, not two hours", () => {
  const events = [
    observed("task.assigned", 0, { task: "40", actor: person, to: agent }),
    hook("tool.used", 0, "b1", { task: "40", data: { tool: "Read", target: "src/a.ts", outcome: "succeeded" } }),
    hook("agent.waiting", 120, "b1", { task: "40", data: { waits_for: "person" } }),
  ];
  const shown = ask(events);
  assert.equal(shown.summary.seconds, 7200);
  assert.deepEqual(shown.summary.parts, { ...none, work: 300, unknown: 6900 });
});

test("the state of an agent and the last part of the summary of its task agree", () => {
  for (const [ending, make] of Object.entries(endings)) {
    const build = (end: number) => [
      observed("task.assigned", 0, { task: "40", actor: person, to: agent }),
      hook("session.started", 1, "b1"),
      hook("tool.used", 2, "b1", { data: { tool: "Read", target: "src/a.ts", outcome: "succeeded" } }),
      observed("change.opened", 3, { ...of("63", "b1", SHA.a), actor: agent }),
      observed("review.changes_requested", 4, { ...of("63", "b1", SHA.a), actor: person }),
      hook("tool.used", 6, "b1", { data: { tool: "Edit", target: "src/a.ts", outcome: "succeeded" } }),
      ...make(10, "b1"),
      // A comment moves nothing of the agent, and the change still waits for nothing.
      observed("change.commented", end, { ...of("63", "b1", SHA.a), actor: person }),
    ];
    const [row] = agentStates(build(13), T0 + 13 * 60_000);
    assert.equal(row!.state, stateOf[ending], ending);
    assert.equal(lastPart(build, 13, "task:40"), PART[row!.state], ending);
  }
});

test("the parts of a summary add up to its whole, with unknown, in every view", () => {
  const twoChanges = [
    observed("task.assigned", 0, { task: "40", actor: person, to: agent }),
    hook("session.started", 1, "b1"),
    observed("change.opened", 3, { ...of("63", "b1", SHA.a), actor: agent }),
    hook("session.ended", 8, "b1"),
    observed("change.merged", 10, { ...of("63", "b1", SHA.a), actor: person }),
    hook("session.started", 60, "b2", { session: "s2" }),
    observed("change.opened", 61, { ...of("65", "b2", SHA.b), actor: agent }),
    observed("checks.passed", 63, { ...of("65", "b2", SHA.b) }),
    hook("tool.used", 64, "b2", { session: "s2", data: { tool: "Edit", target: "src/b.ts", outcome: "succeeded" } }),
    observed("review.approved", 70, { ...of("65", "b2", SHA.b), actor: person }),
  ];
  const merged = [...twoChanges, observed("change.merged", 90, { ...of("65", "b2", SHA.b), actor: person })];
  const noSession = merged.filter((e) => e.session === undefined);
  const onlyClaims = [hook("review.approved", 5, "b1", { change: "60" }), hook("change.merged", 60, "b1", { change: "60" })];
  const views: [string, LedgerEvent[], string][] = [
    ["a task", merged, "task:40"],
    ["its first change", merged, "change:63"],
    ["its second change", merged, "change:65"],
    ["an open task", twoChanges, "task:40"],
    ["an open change", twoChanges, "change:65"],
    ["a task with no session", noSession, "task:40"],
    ["a change with only claims", onlyClaims, "change:60"],
  ];
  for (const [name, events, what] of views) {
    const s = ask(events, what).summary;
    assert.deepEqual(Object.keys(s.parts).sort(), ["checks", "instructions", "person", "review", "unknown", "work"], name);
    assert.equal(sum(s), s.seconds, name);
  }
});

test("a task with two changes, the second opened an hour after the first was merged, with no session in between: that hour is unknown, not work", () => {
  const events = [
    observed("task.assigned", 0, { task: "40", actor: person, to: agent }),
    observed("change.opened", 1, { ...of("63", "b1", SHA.a), actor: agent }),
    observed("change.merged", 10, { ...of("63", "b1", SHA.a), actor: person }),
    observed("change.opened", 70, { ...of("65", "b2", SHA.b), actor: agent }),
    observed("change.merged", 80, { ...of("65", "b2", SHA.b), actor: person }),
  ];
  // 0 to 1 no change yet and no session; 1 to 10 and 70 to 80 waiting for review; 10 to 70 between the changes.
  assert.deepEqual(parts(events), { ...none, review: 540 + 600, unknown: 60 + 3600 });
});

test("a change closed, and opened again an hour later, with no session in between: that hour is unknown", () => {
  const events = [
    observed("task.assigned", 0, { task: "40", actor: person, to: agent }),
    observed("change.opened", 1, { ...of("63", "b1", SHA.a), actor: agent }),
    observed("change.closed", 10, { ...of("63", "b1", SHA.a), actor: person }),
    observed("change.reopened", 70, { ...of("63", "b1", SHA.a), actor: person }),
    observed("change.merged", 80, { ...of("63", "b1", SHA.a), actor: person }),
  ];
  for (const what of ["change:63", "task:40"]) assert.deepEqual(parts(events, what), { ...none, review: 540 + 600, unknown: 60 + 3600 }, what);
});

test("the view of one change, the view of its task, and the overview's state of the agent agree on what the agent does at the end, for a task with two changes", () => {
  for (const [ending, make] of Object.entries(endings)) {
    const build = (end: number) => [
      observed("task.assigned", 0, { task: "40", actor: person, to: agent }),
      observed("change.opened", 1, { ...of("63", "b1", SHA.a), actor: agent }),
      observed("change.merged", 10, { ...of("63", "b1", SHA.a), actor: person }),
      hook("session.started", 60, "b2"),
      observed("change.opened", 61, { ...of("65", "b2", SHA.b), actor: agent }),
      observed("review.changes_requested", 62, { ...of("65", "b2", SHA.b), actor: person }),
      hook("tool.used", 66, "b2", { data: { tool: "Edit", target: "src/b.ts", outcome: "succeeded" } }),
      ...make(70, "b2"),
      observed("change.commented", end, { ...of("65", "b2", SHA.b), actor: person }),
    ];
    const [row] = agentStates(build(73), T0 + 73 * 60_000);
    assert.equal(row!.state, stateOf[ending], ending);
    assert.equal(lastPart(build, 73, "change:65"), PART[row!.state], `${ending}: the view of the change`);
    assert.equal(lastPart(build, 73, "task:40"), PART[row!.state], `${ending}: the view of the task`);
  }
});

test("agent.waiting as the first sign of work starts a summary that has no hand-over", () => {
  const events = [
    observed("task.opened", 0, { task: "40", actor: person }),
    hook("agent.waiting", 10, "b1", { task: "40", data: { waits_for: "person" } }),
    hook("tool.used", 12, "b1", { task: "40", data: { tool: "Edit", target: "src/a.ts", outcome: "succeeded" } }),
    hook("session.stopped", 20, "b1", { task: "40" }),
  ];
  const s = ask(events).summary;
  assert.equal(s.from, at(10), "from the wait, not from the tool call after it");
  // 10 to 12 the wait for a person; 12 to 17 work; 17 to 20 nothing for five minutes.
  assert.deepEqual(s.parts, { ...none, person: 120, work: 300, unknown: 180 });
});

test("the dashboard's summary line keeps unknown apart from what is waited for", () => {
  assert.equal(
    texts.change.summary("1h 0m", "13m", "10m", "18m", "8m", "11m", 2),
    "1h 0m in all: work 13m, waiting for checks 10m, for review 18m, for a person or instructions 8m; not known 11m (no sign of what the agent does); 2 review rounds",
  );
  assert.match(texts.change.summary("5m", "5m", "0s", "0s", "0s", "0s", 1), /; 1 review round$/);
});

// Last: every summary the tests above asked for.
test("no part of a summary is negative, in any case above", () => {
  assert.ok(asked.length > 40, `${asked.length} summaries`);
  for (const { what, summary } of asked) {
    for (const [part, seconds] of Object.entries(summary.parts)) assert.ok(seconds >= 0, `${what}: ${part} ${seconds}`);
    assert.ok(summary.seconds >= 0, what);
  }
});
