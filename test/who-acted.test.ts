// #45: `actor` is always the one who acted. Who a task was given to, taken from and what was opened again are
// recorded: `howl observe` against the local host, then what `howl show` says of it.
// @code_class tests
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { folder, howl, lines, PROJECT, workspace, type Workspace } from "./helpers.ts";
import { at, LocalHost, SHA } from "./local-host.ts";

type Row = Record<string, any>;

function setup(agents = "[agent-bot]"): { ws: Workspace; host: LocalHost } {
  const dir = folder();
  const ws = workspace({ yml: `project: ${PROJECT}\nhost: local\nlocal: ${dir}\nrepository: team/product\nagents: ${agents}\n` });
  return { ws, host: new LocalHost(dir) };
}

/** One round; the events it appended. */
function round(s: { ws: Workspace }): Row[] {
  const before = existsSync(s.ws.ledger) ? lines(s.ws.ledger).length : 1;
  const run = howl(["observe", "--once"], { cwd: s.ws.root, env: s.ws.env });
  assert.equal(run.status, 0, run.stderr);
  return lines(s.ws.ledger).slice(before).map((l) => l.event);
}

function show(s: { ws: Workspace }, what: string): string {
  const run = howl(["show", what, "--utc", "--ledger", s.ws.ledger]);
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

function handover(text: string): string[] {
  const all = text.split("\n");
  const from = all.indexOf("Hand-over");
  return all.slice(from + 1, all.indexOf("Sessions") - 1);
}

/** The first event of a type; a test that finds none fails here, with the type. */
function one(events: Row[], type: string): Row {
  const found = events.find((e) => e.type === type);
  assert.ok(found, `no ${type} was written: ${events.map((e) => e.type).join(", ")}`);
  return found;
}

const alice = { login: "alice" };
const bob = { login: "bob" };
const agent = { login: "agent-bot" };
const lead = { login: "lead" };

test("a task given by one account to another: actor is the giver, `to` the receiver, and howl show names both", () => {
  const s = setup();
  s.host.task({ number: 1, openedAt: at(0), openedBy: alice, assignments: [{ id: "a1", assignee: agent, by: bob, at: at(1) }], updatedAt: at(1) });
  const given = one(round(s), "task.assigned");
  assert.equal(given.actor?.kind, "person");
  assert.notEqual(given.actor?.id, "bob");
  assert.deepEqual(given.to, { kind: "agent", id: "agent-bot" });
  const text = handover(show(s, "task:1")).join("\n");
  assert.match(text, new RegExp(`given to agent-bot by ${given.actor.id}`));
  // The giver is a person, the same pseudonym as everywhere else; no account name is in the ledger.
  const ledger = readFileSync(s.ws.ledger, "utf8");
  for (const name of ["alice", "bob"]) assert.ok(!ledger.includes(name), name);
});

test("a task given to a person: `to` is that person's pseudonym, the same as when they act", () => {
  const s = setup();
  s.host.task({ number: 1, openedAt: at(0), openedBy: alice, assignments: [{ id: "a1", assignee: bob, by: agent, at: at(1) }], updatedAt: at(1) });
  s.host.change({ number: 5, branch: "x", openedAt: at(2), openedBy: bob, head: { sha: SHA.a, at: at(2) }, tasks: [1], reviews: [], updatedAt: at(2) });
  const events = round(s);
  const given = one(events, "task.assigned");
  assert.deepEqual(given.actor, { kind: "agent", id: "agent-bot" });
  assert.equal(given.to.kind, "person");
  assert.equal(given.to.id, one(events, "change.opened").actor.id);
});

test("a host that does not say who gave the task: `to` and no actor, and nothing said of a removed account", () => {
  const s = setup();
  s.host.task({ number: 1, openedAt: at(0), openedBy: alice, assignments: [{ id: "a1", assignee: agent, at: at(1) }], updatedAt: at(1) });
  const given = one(round(s), "task.assigned");
  assert.equal("actor" in given, false);
  assert.deepEqual(given.to, { kind: "agent", id: "agent-bot" });
  assert.equal("account_removed" in given.data, false);
  assert.match(show(s, "task:1"), /given to agent-bot\n/);
});

test("a task taken back and given to another: task.unassigned and a second task.assigned, and the hand-over shows the last", () => {
  const s = setup("[agent-bot, agent-two]");
  s.host.task({
    number: 1,
    openedAt: at(0),
    openedBy: alice,
    assignments: [
      { id: "a1", assignee: agent, by: lead, at: at(1) },
      { id: "a2", assignee: { login: "agent-two" }, by: lead, at: at(3) },
    ],
    unassignments: [{ id: "u1", assignee: agent, by: lead, at: at(2) }],
    updatedAt: at(3),
  });
  const events = round(s).filter((e) => e.type.startsWith("task."));
  assert.deepEqual(events.map((e) => [e.type, e.to?.id, e.time]), [
    ["task.opened", undefined, at(0)],
    ["task.assigned", "agent-bot", at(1)],
    ["task.unassigned", "agent-bot", at(2)],
    ["task.assigned", "agent-two", at(3)],
  ]);
  const taken = one(events, "task.unassigned");
  assert.equal(taken.actor?.kind, "person", "the actor is the one who took it back");
  assert.equal(taken.actor?.id, one(events, "task.assigned").actor.id);

  const json = JSON.parse(howl(["show", "task:1", "--json", "--ledger", s.ws.ledger]).stdout);
  assert.deepEqual(json.handover.map((h: Row) => h.actor.id), ["agent-two"], "the giving that stands");
  const text = handover(show(s, "task:1")).join("\n");
  assert.match(text, /given to agent-two by /);
  assert.doesNotMatch(text, /given to agent-bot/, "what was taken back is not a hand-over");
  assert.match(text, /taken from agent-bot by /);
});

test("a task taken back and given to no one: the hand-over says so, and says who it was taken from", () => {
  const s = setup();
  s.host.task({
    number: 1,
    openedAt: at(0),
    openedBy: alice,
    assignments: [{ id: "a1", assignee: agent, by: lead, at: at(1) }],
    unassignments: [{ id: "u1", assignee: agent, by: lead, at: at(2) }],
    updatedAt: at(2),
  });
  round(s);
  const text = handover(show(s, "task:1")).join("\n");
  assert.match(text, /taken from agent-bot by /);
  assert.match(text, /given to no one now/);
  assert.doesNotMatch(text, /given to no one in the ledger/);
});

test("#48: a task given to an account that is gone: the giver is the actor, there is no `to`, and the event says an account is gone", () => {
  const s = setup();
  s.host.task({ number: 1, openedAt: at(0), openedBy: alice, assignments: [{ id: "a1", assignee: { removed: true }, by: lead, at: at(1) }], updatedAt: at(1) });
  const given = one(round(s), "task.assigned");
  assert.equal(given.actor?.kind, "person");
  assert.equal("to" in given, false);
  assert.equal(given.data.account_removed, true, "as before, so that it is not taken for an event nobody did");
  const text = handover(show(s, "task:1")).join("\n");
  assert.match(text, /given to someone by /, "the giver is never named as the receiver");
});

test("#48: given by an account that is gone: no actor, `account_removed` as everywhere, and `to` is there", () => {
  const s = setup();
  s.host.task({ number: 1, openedAt: at(0), openedBy: alice, assignments: [{ id: "a1", assignee: agent, by: { removed: true }, at: at(1) }], updatedAt: at(1) });
  const given = one(round(s), "task.assigned");
  assert.equal("actor" in given, false);
  assert.equal(given.data.account_removed, true);
  assert.deepEqual(given.to, { kind: "agent", id: "agent-bot" });
});

test("#46: an agent that has a name other than its account: `to` is the name, the account is kept in data.to_account", () => {
  const s = setup("[agent-1=agent-1-bot]");
  s.host.task({
    number: 1,
    openedAt: at(0),
    openedBy: alice,
    assignments: [{ id: "a1", assignee: { login: "agent-1-bot" }, by: lead, at: at(1) }],
    updatedAt: at(1),
  });
  const given = one(round(s), "task.assigned");
  assert.deepEqual(given.to, { kind: "agent", id: "agent-1" });
  assert.equal(given.data.to_account, "agent-1-bot");
  assert.equal("account" in given.data, false, "the giver is a person: no account kept for them");
});

test("#46: an agent that gives, and a plain entry that receives: data.account for the giver, no to_account", () => {
  const s = setup("[agent-1=agent-1-bot, agent-2]");
  s.host.task({
    number: 1,
    openedAt: at(0),
    openedBy: alice,
    assignments: [{ id: "a1", assignee: { login: "agent-2" }, by: { login: "agent-1-bot" }, at: at(1) }],
    updatedAt: at(1),
  });
  const given = one(round(s), "task.assigned");
  assert.deepEqual(given.actor, { kind: "agent", id: "agent-1" });
  assert.equal(given.data.account, "agent-1-bot");
  assert.deepEqual(given.to, { kind: "agent", id: "agent-2" });
  assert.equal("to_account" in given.data, false);
});

test("a task reopened is written as task.reopened, by whoever reopened it, and howl show says so", () => {
  const s = setup();
  s.host.task({
    number: 1,
    openedAt: at(0),
    openedBy: alice,
    assignments: [],
    closedAt: at(10),
    closedBy: alice,
    reopenings: [{ id: "r1", by: lead, at: at(20) }],
    updatedAt: at(20),
  });
  const events = round(s);
  const reopened = one(events, "task.reopened");
  assert.equal(reopened.time, at(20));
  assert.equal(reopened.task, "1");
  assert.equal(reopened.actor?.kind, "person");
  assert.match(show(s, "task:1"), /task reopened by person-/);
});

test("a change closed, reopened and merged: three events in three rounds, each once", () => {
  const s = setup();
  const change = (over: Row) =>
    s.host.change({ number: 7, branch: "x", openedAt: at(0), openedBy: agent, head: { sha: SHA.a, at: at(0) }, tasks: [], reviews: [], updatedAt: at(10), ...over } as any);
  change({ closedAt: at(10), closedBy: lead });
  assert.deepEqual(round(s).map((e) => e.type), ["change.opened", "change.closed"]);
  change({ reopenings: [{ id: "r1", by: lead, at: at(20) }], updatedAt: at(20) });
  const reopened = round(s);
  assert.deepEqual(reopened.map((e) => e.type), ["change.reopened"]);
  assert.deepEqual([reopened[0]!.change, reopened[0]!.branch, reopened[0]!.sha, reopened[0]!.time], ["7", "x", SHA.a, at(20)]);
  assert.equal(reopened[0]!.actor?.kind, "person");
  change({ reopenings: [{ id: "r1", by: lead, at: at(20) }], closedAt: at(30), mergedAt: at(30), mergedBy: lead, updatedAt: at(30) });
  assert.deepEqual(round(s).map((e) => e.type), ["change.merged"]);
  assert.deepEqual(round(s), []);

  const text = show(s, "change:7");
  assert.equal(text.split("\n")[0], "Change 7: merged");
});

test("a review that is dismissed is written as review.dismissed, by whoever dismissed it, with the review's id and no text", () => {
  const s = setup();
  s.host.change({
    number: 7,
    branch: "x",
    openedAt: at(0),
    openedBy: agent,
    head: { sha: SHA.a, at: at(0) },
    tasks: [],
    reviews: [],
    dismissals: [{ id: "d1", review: "r-9", state: "changes_requested", by: lead, at: at(15) }],
    updatedAt: at(15),
  } as any);
  const dismissed = one(round(s), "review.dismissed");
  assert.equal(dismissed.time, at(15));
  assert.equal(dismissed.change, "7");
  assert.equal(dismissed.actor?.kind, "person");
  assert.deepEqual([dismissed.data.review, dismissed.data.state], ["r-9", "changes_requested"]);
  assert.equal(dismissed.source.kind, "observed");
  assert.deepEqual(round(s), []);
});

test("a ledger written before this step is read as it is: the same task read again writes nothing twice", () => {
  const s = setup();
  s.host.task({ number: 1, openedAt: at(0), openedBy: alice, assignments: [{ id: "a1", assignee: agent, at: at(1) }], updatedAt: at(1) });
  assert.ok(round(s).length > 0);
  // A host that now says who gave it: the giving is the same giving, with the same id.
  s.host.task({ number: 1, openedAt: at(0), openedBy: alice, assignments: [{ id: "a1", assignee: agent, by: lead, at: at(1) }], updatedAt: at(2) });
  assert.deepEqual(round(s), []);
});

test("one team member taken back and given the task again in the same second holds it: the host's ids are not numbers, so the taking back comes first", () => {
  const s = setup();
  s.host.task({ number: 1, openedAt: at(0), openedBy: alice, assignments: [{ id: "a1", assignee: agent, by: lead, at: at(1) }], updatedAt: at(1) });
  round(s);
  s.host.task({
    number: 1,
    openedAt: at(0),
    openedBy: alice,
    assignments: [
      { id: "a1", assignee: agent, by: lead, at: at(1) },
      { id: "a2", assignee: agent, by: lead, at: at(5) },
    ],
    unassignments: [{ id: "u1", assignee: agent, by: lead, at: at(5) }],
    updatedAt: at(5),
  });
  const written = round(s).map((e) => e.type);
  assert.deepEqual(written, ["task.unassigned", "task.assigned"]);
  const json = JSON.parse(howl(["show", "task:1", "--json", "--ledger", s.ws.ledger]).stdout);
  assert.deepEqual(json.handover.map((h: Row) => h.time), [at(5)], "agent-bot holds it from the second giving");
  assert.doesNotMatch(show(s, "task:1"), /given to no one now/);
});

test("the host's own order is kept when its ids are numbers: given and taken back in one second leaves it with no one; taken back and given again leaves it with the one", () => {
  const s = setup();
  s.host.task({
    number: 1,
    openedAt: at(0),
    openedBy: alice,
    assignments: [{ id: "902", assignee: agent, by: lead, at: at(5) }],
    unassignments: [{ id: "903", assignee: agent, by: lead, at: at(5) }],
    updatedAt: at(5),
  });
  s.host.task({
    number: 2,
    openedAt: at(0),
    openedBy: alice,
    assignments: [{ id: "912", assignee: agent, by: lead, at: at(5) }],
    unassignments: [{ id: "911", assignee: agent, by: lead, at: at(5) }],
    updatedAt: at(5),
  });
  const written = round(s).filter((e) => e.type.startsWith("task.") && e.type !== "task.opened");
  assert.deepEqual(written.map((e) => [e.task, e.type]), [
    ["1", "task.assigned"],
    ["1", "task.unassigned"],
    ["2", "task.unassigned"],
    ["2", "task.assigned"],
  ]);
  const holds = (n: string) => JSON.parse(howl(["show", `task:${n}`, "--json", "--ledger", s.ws.ledger]).stdout).handover.length;
  assert.deepEqual([holds("1"), holds("2")], [0, 1]);
});
