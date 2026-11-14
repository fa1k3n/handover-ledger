// #51: a claim never counts as what the code host showed, in the handovers, the figures, the rounds or the end.
// @code_class tests
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { claimText } from "../src/dashboard/format.ts";
import { texts } from "../src/dashboard/texts.ts";
import { openLedger } from "../src/ledger/ledger.ts";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { observed } from "../src/read/observed.ts";
import { handovers, keyFigures } from "../src/read/overview.ts";
import { show } from "../src/read/show.ts";
import { startServer } from "../src/serve/server.ts";
import { folder, howl, PROJECT, workspace } from "./helpers.ts";

const T0 = Date.UTC(2026, 0, 1, 8, 0, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const NOW = T0 + 3600_000;
const SHA = { a: "a".repeat(40), b: "b".repeat(40) };

let n = 0;
function event(kind: "observed" | "claimed", type: LedgerEvent["type"], minute: number, actor: string, extra: Partial<LedgerEvent> = {}): LedgerEvent {
  const made: LedgerEvent = {
    v: 0,
    id: `e-${++n}`,
    time: at(minute),
    type,
    source: kind === "observed" ? { adapter: "github", kind } : { adapter: "emit", kind },
    project: PROJECT,
    actor: { kind: "agent", id: actor },
    change: "30",
    ...extra,
  };
  // `change: undefined` in `extra` means an event that names no change.
  if (made.change === undefined) delete made.change;
  return made;
}

const opening = () => event("observed", "change.opened", 0, "agent-a", { task: "12", branch: "task-12-x", sha: SHA.a });
/** An observed opening, then an approval and a merge of the kind given. */
const story = (kind: "observed" | "claimed") => [
  opening(),
  event(kind, "review.approved", 5, "agent-b", { task: "12" }),
  event(kind, "change.merged", 6, "agent-b", { task: "12" }),
];
const items = (events: LedgerEvent[]) => events.map((e, i) => ({ event: e, hash: `h${i}` }));

function ledgerOf(events: LedgerEvent[]): string {
  const path = join(folder(), "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  for (const e of events) writer.append(e);
  writer.close();
  return path;
}

test("observed() is true for what an adapter read, and false for what a session or a script sent", () => {
  assert.equal(observed(event("observed", "change.merged", 0, "agent-a")), true);
  assert.equal(observed(event("claimed", "change.merged", 0, "agent-a")), false);
});

test("a claimed approval and merge give no handover, and the change is open in the figures", () => {
  const events = story("claimed");
  assert.deepEqual(handovers(items(events)), []);
  const figures = keyFigures(events, NOW);
  assert.equal(figures.open, 1);
  assert.equal(figures.merged, 0);
  assert.equal(figures.reviewRoundsMean, null);
  assert.equal(figures.leadTimeMedianMs, null);
});

test("a claimed approval and merge give no round and no end in howl show, and are listed as claimed", () => {
  const events = story("claimed");
  const shown = show(events, { kind: "change", id: "30" }, null)!;
  assert.deepEqual(shown.reviews, []);
  assert.deepEqual(shown.end, { state: "open" });
  assert.equal(shown.summary.reviewRounds, 0);
  assert.equal(shown.summary.open, true);
  assert.deepEqual(shown.claimed, [
    { time: at(5), type: "review.approved", task: "12", change: "30", actor: { kind: "agent", id: "agent-b" } },
    { time: at(6), type: "change.merged", task: "12", change: "30", actor: { kind: "agent", id: "agent-b" } },
  ]);
  // Single events are still shown, with their mark.
  assert.deepEqual(
    shown.events.map((e) => [e.type, e.source.kind]),
    [
      ["change.opened", "observed"],
      ["review.approved", "claimed"],
      ["change.merged", "claimed"],
    ],
  );
});

test("howl show prints the claims under a heading of their own, and the change as open", () => {
  const run = howl(["show", "change:30", "--ledger", ledgerOf(story("claimed")), "--utc"]);
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.split("\n");
  assert.equal(lines[0], "Task 12: open");
  assert.equal(lines[lines.indexOf("Reviews") + 1], "  none");
  assert.equal(lines[lines.indexOf("End") + 1], "  open");
  const heading = lines.indexOf("Claimed, not seen at the code host");
  assert.ok(heading > 0, run.stdout);
  assert.match(lines[heading + 1]!, /claimed {2}review\.approved on change 30 by agent-b$/);
  assert.match(lines[heading + 2]!, /claimed {2}change\.merged on change 30 by agent-b$/);
  assert.ok(lines.includes("  review rounds: 0"));
});

test("the same with observed events gives the handovers, the round and the merge, as before", () => {
  const events = story("observed");
  assert.deepEqual(
    handovers(items(events)).map((h) => [h.from, h.to, h.step]),
    [
      ["agent-b", "merged", "Review → merge"],
      ["agent-a", "agent-b", "Implementation → review"],
    ],
  );
  const figures = keyFigures(events, NOW);
  assert.equal(figures.open, 0);
  assert.equal(figures.merged, 1);
  assert.equal(figures.reviewRoundsMean, 1);
  assert.equal(figures.leadTimeMedianMs, 6 * 60_000);
  const shown = show(events, { kind: "change", id: "30" }, null)!;
  assert.equal(shown.reviews.length, 1);
  assert.equal(shown.reviews[0]!.followedBy, "change.merged");
  assert.deepEqual(shown.end, { state: "merged", time: at(6), actor: { kind: "agent", id: "agent-b" } });
  assert.equal(shown.summary.reviewRounds, 1);
  assert.deepEqual(shown.claimed, []);
  const text = howl(["show", "change:30", "--ledger", ledgerOf(events), "--utc"]).stdout;
  assert.ok(!text.includes("Claimed, not seen"), "no heading when there is no claim");
});

test("a claimed opening, head, comment and closing are not the change's", () => {
  const events = [
    opening(),
    event("claimed", "change.updated", 3, "agent-b", { sha: SHA.b }),
    event("claimed", "change.commented", 4, "agent-b"),
    event("claimed", "change.closed", 5, "agent-b"),
    event("claimed", "change.opened", 7, "agent-b", { change: "31", task: "12" }),
  ];
  const shown = show(events, { kind: "task", id: "12" }, null)!;
  // Change 31 is named by a claim alone: it is no change of the task.
  assert.equal(shown.changes.length, 1);
  const [thirty] = shown.changes;
  assert.deepEqual(thirty!.opened, { time: at(0), actor: { kind: "agent", id: "agent-a" } });
  assert.deepEqual(thirty!.heads, [{ sha: SHA.a, time: at(0) }]);
  assert.equal(thirty!.comments, 0);
  assert.deepEqual(shown.end, { state: "open" });
  assert.deepEqual(
    shown.claimed.map((c) => c.type),
    ["change.updated", "change.commented", "change.closed", "change.opened"],
  );
  // The claimed opening of change 31 opens nothing in the figures, and the claimed closing closes nothing.
  assert.equal(keyFigures(events, NOW).open, 1);
  assert.deepEqual(handovers(items(events)), []);
});

test("a claimed review does not start a round or end one, beside observed reviews", () => {
  const events = [
    opening(),
    event("observed", "review.commented", 2, "agent-b"),
    event("claimed", "review.changes_requested", 3, "agent-c"),
    event("claimed", "change.updated", 4, "agent-a", { sha: SHA.b }),
    event("observed", "review.approved", 5, "agent-b"),
  ];
  const shown = show(events, { kind: "change", id: "30" }, null)!;
  assert.equal(shown.reviews.length, 1, "the claimed head starts no second round");
  assert.deepEqual(
    shown.reviews[0]!.reviews.map((r) => r.outcome),
    ["commented", "approved"],
  );
  assert.equal(shown.reviews[0]!.followedBy, null);
  assert.equal(handovers(items(events)).length, 2);
});

test("a change that only a claim names does not keep the assignment open", () => {
  const events = [
    opening(),
    event("claimed", "change.opened", 2, "agent-b", { change: "31", task: "12" }),
    event("observed", "change.closed", 9, "agent-a", { task: "12" }),
  ];
  const shown = show(events, { kind: "task", id: "12" }, null)!;
  assert.deepEqual(shown.end, { state: "closed", time: at(9), actor: { kind: "agent", id: "agent-a" } });
});

test("a claim moves no second of the summary: not its parts, its start, its end or who took part", () => {
  const merge = () => event("observed", "change.merged", 60, "agent-a", { task: "12" });
  const plain = show([opening(), merge()], { kind: "change", id: "30" }, null)!.summary;
  assert.deepEqual(plain.parts, { work: 0, person: 0, instructions: 0, checks: 0, review: 3600 });
  for (const type of ["review.approved", "review.changes_requested", "change.merged", "change.closed", "change.updated"] as const) {
    const claim = event("claimed", type, 5, "agent-z", { task: "12" });
    const { summary } = show([opening(), claim, merge()], { kind: "change", id: "30" }, null)!;
    assert.deepEqual(summary, plain, `a claimed ${type}`);
  }
  // Before the opening and after the last observed event of an open change.
  const early = event("claimed", "change.opened", -10, "agent-z", { task: "12" });
  const late = event("claimed", "change.merged", 30, "agent-z", { task: "12" });
  const open = show([early, opening(), event("observed", "review.commented", 20, "agent-b", { task: "12" }), late], { kind: "change", id: "30" }, null)!.summary;
  assert.equal(open.from, at(0));
  assert.equal(open.to, at(20));
  assert.equal(open.seconds, 1200);
  assert.deepEqual(open.actors.map((a) => a.id).sort(), ["agent-a", "agent-b"]);
});

test("the task of a handover and the branch of a change are the code host's, not a claim's", () => {
  const events = [
    event("claimed", "session.started", -1, "agent-a", { task: "99", branch: "main", session: "s1" }),
    opening(),
    event("claimed", "review.commented", 3, "agent-z", { task: "99" }),
    event("observed", "review.commented", 5, "agent-b"),
  ];
  const rows = handovers(items(events));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.task, "12");
  const shown = show(events, { kind: "change", id: "30" }, null)!;
  assert.equal(shown.changes[0]!.branch, "task-12-x");
});

test("a claimed task event is no hand-over: it starts no clock and is listed as claimed", () => {
  const events = [
    event("claimed", "task.opened", -30, "agent-z", { task: "12", change: undefined }),
    event("claimed", "task.assigned", -20, "agent-z", { task: "12", change: undefined }),
    opening(),
    event("observed", "change.merged", 60, "agent-a", { task: "12" }),
    event("claimed", "task.closed", 61, "agent-z", { task: "12", change: undefined }),
  ];
  const shown = show(events, { kind: "task", id: "12" }, null)!;
  assert.deepEqual(shown.handover, []);
  assert.equal(shown.summary.from, at(0));
  assert.equal(shown.summary.seconds, 3600);
  assert.deepEqual(
    shown.claimed.map((c) => [c.type, c.task]),
    [
      ["task.opened", "12"],
      ["task.assigned", "12"],
      ["task.closed", "12"],
    ],
  );
  const text = howl(["show", "task:12", "--ledger", ledgerOf(events), "--utc"]).stdout;
  const lines = text.split("\n");
  assert.equal(lines[lines.indexOf("Hand-over") + 1], "  given to no one in the ledger");
  assert.ok(!lines.some((l) => /task (opened|closed) by/.test(l)), text);
  assert.ok(lines.some((l) => /claimed {2}task\.assigned on task 12 by agent-z$/.test(l)), text);
  assert.equal(claimText(shown.claimed[1]!), "task.assigned · task 12 · agent-z");
  // An observed hand-over beside it is the hand-over, as before.
  const given = event("observed", "task.assigned", -5, "agent-a", { task: "12", change: undefined });
  const both = show([...events.slice(0, 2), given, ...events.slice(2)], { kind: "task", id: "12" }, null)!;
  assert.deepEqual(both.handover, [{ time: at(-5), actor: { kind: "agent", id: "agent-a" }, kind: "observed" }]);
  assert.equal(both.summary.from, at(-5));
});

test("a claimed review is not a session at the change: it stands behind no person's review", () => {
  const person = { kind: "person" as const, id: "person-0a0a0a0a" };
  const review = () => event("observed", "review.approved", 5, "", { actor: person });
  const claim = (agent: string) => event("claimed", "review.approved", 5, agent);
  const row = (events: LedgerEvent[]) => handovers(items(events)).find((h) => h.step === "Implementation → review")!;

  const claimedOnly = [opening(), review(), claim("agent-x")];
  assert.equal(row(claimedOnly).to, person.id);
  assert.equal(row(claimedOnly).via, undefined);
  assert.equal(keyFigures(claimedOnly, NOW).unattributed.count, 1);
  assert.equal(show(claimedOnly, { kind: "change", id: "30" }, null)!.reviews[0]!.reviews[0]!.by, undefined);

  // A session of its own at the change is still matched, and another agent's claim does not stand in its way.
  const session = event("claimed", "session.started", 4, "agent-r", { session: "s9" });
  const withSession = [opening(), session, review(), claim("agent-x")];
  assert.equal(row(withSession).to, "agent-r");
  assert.equal(row(withSession).via, person.id);
  assert.equal(keyFigures(withSession, NOW).unattributed.count, 0);
});

test("a claim of a change or a review links no change to a task; a session's own event still does", () => {
  const other = [
    event("observed", "change.opened", 1, "agent-c", { change: "40", branch: "other", sha: SHA.b }),
    event("observed", "change.merged", 10, "agent-c", { change: "40" }),
  ];
  const claim = event("claimed", "review.commented", 5, "agent-z", { change: "40", task: "12" });
  const shown = show([opening(), ...other, claim].sort((a, b) => a.time.localeCompare(b.time)), { kind: "change", id: "30" }, null)!;
  assert.deepEqual(shown.changes.map((c) => c.change), ["30"]);
  assert.deepEqual(shown.end, { state: "open" });

  const session = event("claimed", "session.started", 5, "agent-a", { change: "40", task: "12", session: "s1" });
  const linked = show([opening(), ...other, session].sort((a, b) => a.time.localeCompare(b.time)), { kind: "change", id: "30" }, null)!;
  assert.deepEqual(linked.changes.map((c) => c.change), ["30", "40"]);

  // The task of a change that is asked for: never from a claim of a change or a review.
  const fifty = event("observed", "change.opened", 0, "agent-a", { change: "50", sha: SHA.a });
  const named = (type: LedgerEvent["type"]) => event("claimed", type, 1, "agent-z", { change: "50", task: "77" });
  assert.equal(show([fifty, named("review.approved")], { kind: "change", id: "50" }, null)!.task, undefined);
  assert.equal(show([fifty, named("session.started")], { kind: "change", id: "50" }, null)!.task, "77");
});

test("an assignment that only claims name has an empty summary", () => {
  const events = [event("claimed", "review.approved", 5, "agent-x", { change: "60" }), event("claimed", "change.merged", 60, "agent-x", { change: "60" })];
  const shown = show(events, { kind: "change", id: "60" }, null)!;
  assert.equal(shown.claimed.length, 2);
  assert.deepEqual(shown.end, { state: "open" });
  assert.deepEqual(shown.summary, {
    from: at(5),
    to: at(5),
    open: true,
    seconds: 0,
    parts: { work: 0, person: 0, instructions: 0, checks: 0, review: 0 },
    reviewRounds: 0,
    actors: [],
  });
});

test("a script's howl emit review.approved and change.merged, taken in, merge nothing", () => {
  const ws = workspace();
  const writer = openLedger(ws.ledger, { project: PROJECT });
  writer.append(opening());
  writer.close();
  for (const type of ["review.approved", "change.merged"]) {
    assert.equal(howl(["emit", type, "--change", "30"], { cwd: ws.root, env: ws.env }).status, 0);
  }
  assert.equal(howl(["ingest"], { cwd: ws.root, env: ws.env }).status, 0);
  const run = howl(["show", "change:30", "--ledger", ws.ledger, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const shown = JSON.parse(run.stdout);
  assert.deepEqual(shown.end, { state: "open" });
  assert.deepEqual(shown.reviews, []);
  assert.deepEqual(
    shown.claimed.map((c: { type: string }) => c.type).sort(),
    ["change.merged", "review.approved"],
  );
});

test("the dashboard gets the claims from /api/show, and has a heading and a line for them", async () => {
  const server = await startServer({ ledger: ledgerOf(story("claimed")), port: 0, root: folder() });
  try {
    const body = await (await fetch(`${server.url}/api/show?what=change:30`)).json();
    assert.equal(body.claimed.length, 2);
    assert.equal(body.end.state, "open");
    assert.equal(claimText(body.claimed[0]), "review.approved · change 30 · agent-b");
    const overview = await (await fetch(`${server.url}/api/overview`)).json();
    assert.deepEqual(overview.handovers, []);
    assert.equal(overview.figures.open, 1);
  } finally {
    await server.close();
  }
  assert.equal(texts.change.claimed, "Claimed, not seen at the code host");
});
