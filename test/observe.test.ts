// `howl observe` against the local adapter: the tests of issue #3.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixedForm } from "../src/ledger/fixed.ts";
import { openLedger } from "../src/ledger/ledger.ts";
import { event, folder, howl, inboxFiles, lines, PROJECT, workspace, type Workspace } from "./helpers.ts";
import { at, LocalHost, SHA } from "./local-host.ts";
import { mkdirSync, writeFileSync } from "node:fs";

interface Setup {
  ws: Workspace;
  host: LocalHost;
}

/** A repository observed through a local host, with `agent-bot` as an agent and tasks taken from branches like `task-12-x`. */
function setup(extra = ""): Setup {
  const dir = folder();
  const ws = workspace({
    yml: `project: ${PROJECT}
host: local
local: ${dir}
repository: team/product
agents: [agent-bot]
task_from_branch: '^task-([0-9]+)'
${extra}`,
  });
  return { ws, host: new LocalHost(dir) };
}

function observe({ ws }: Setup) {
  return howl(["observe", "--once"], { cwd: ws.root, env: ws.env });
}

/** Runs a round and expects it to go through. Returns the events it appended. */
function round(s: Setup): Record<string, any>[] {
  const before = existsSync(s.ws.ledger) ? lines(s.ws.ledger).length : 1;
  const result = observe(s);
  assert.equal(result.status, 0, result.stderr);
  return lines(s.ws.ledger).slice(before).map((l) => l.event);
}

const person = (login: string) => ({ login });
const agent = { login: "agent-bot" };
const app = { login: "ci-helper[bot]", bot: true };

/** One of everything in the table. */
function everything(s: Setup): void {
  s.host
    .task({
      number: 1,
      openedAt: at(0),
      openedBy: person("alice"),
      assignments: [{ id: "as-1", assignee: agent, at: at(1) }],
      closedAt: at(50),
      closedBy: person("alice"),
      updatedAt: at(50),
    })
    .change({
      number: 10,
      branch: "task-1-feature",
      openedAt: at(2),
      openedBy: agent,
      head: { sha: SHA.a, at: at(2) },
      tasks: [1],
      reviews: [
        { id: "r-1", by: person("bob"), state: "changes_requested", at: at(10), sha: SHA.a },
        { id: "r-2", by: app, state: "commented", at: at(11), sha: SHA.a },
        { id: "r-3", by: person("bob"), state: "approved", at: at(20), sha: SHA.a },
      ],
      mergedAt: at(30),
      mergedBy: person("carol"),
      closedAt: at(30),
      updatedAt: at(30),
    })
    .change({
      number: 11,
      branch: "spike",
      openedAt: at(3),
      openedBy: person("dave"),
      head: { sha: SHA.b, at: at(3) },
      tasks: [],
      reviews: [],
      closedAt: at(40),
      closedBy: person("dave"),
      updatedAt: at(40),
    })
    .checks(SHA.a, "passed", at(5))
    .checks(SHA.b, "failed", at(6));
}

test("each row of the table gives one event of its type, kind: observed, with the host's time", () => {
  const s = setup();
  everything(s);
  const first = round(s);

  // A new head commit on an open change: change.updated.
  s.host.change({
    number: 12,
    branch: "task-2-more",
    openedAt: at(60),
    openedBy: agent,
    head: { sha: SHA.c, at: at(60) },
    tasks: [],
    reviews: [],
    updatedAt: at(60),
  });
  const second = round(s);
  s.host.change({
    number: 12,
    branch: "task-2-more",
    openedAt: at(60),
    openedBy: agent,
    head: { sha: SHA.d, at: at(70) },
    tasks: [],
    reviews: [],
    updatedAt: at(70),
  });
  const third = round(s);

  const all = [...first, ...second, ...third];
  const count = (type: string) => all.filter((e) => e.type === type).length;
  assert.deepEqual(
    Object.fromEntries(
      [
        "task.opened",
        "task.assigned",
        "task.closed",
        "change.opened",
        "change.updated",
        "change.closed",
        "checks.passed",
        "checks.failed",
        "review.approved",
        "review.changes_requested",
        "review.commented",
        "change.merged",
      ].map((t) => [t, count(t)]),
    ),
    {
      "task.opened": 1,
      "task.assigned": 1,
      "task.closed": 1,
      "change.opened": 3,
      "change.updated": 1,
      "change.closed": 1,
      "checks.passed": 1,
      "checks.failed": 1,
      "review.approved": 1,
      "review.changes_requested": 1,
      "review.commented": 1,
      "change.merged": 1,
    },
  );
  for (const e of all) {
    assert.deepEqual(e.source, { adapter: "local", kind: "observed" }, e.type);
    assert.equal(e.project, PROJECT);
    assert.equal(typeof e.data?.seen, "string", `${e.type} has data.seen`);
  }
  const time = (type: string) => all.find((e) => e.type === type)?.time;
  assert.equal(time("task.opened"), at(0));
  assert.equal(time("task.assigned"), at(1));
  assert.equal(time("review.changes_requested"), at(10));
  assert.equal(time("change.merged"), at(30));
  assert.equal(time("change.closed"), at(40));
  assert.equal(time("checks.passed"), at(5));
  assert.equal(time("change.updated"), at(70));
});

test("an event of a change holds change, branch and sha; task comes from the host's link, else from task_from_branch, else it is absent", () => {
  const s = setup();
  const base = { openedAt: at(0), openedBy: agent, reviews: [], updatedAt: at(0) };
  s.host
    .change({ ...base, number: 20, branch: "task-7-linked", head: { sha: SHA.a, at: at(0) }, tasks: [5] })
    .change({ ...base, number: 21, branch: "task-8-from-branch", head: { sha: SHA.b, at: at(0) }, tasks: [] })
    .change({ ...base, number: 22, branch: "no-task-here", head: { sha: SHA.c, at: at(0) }, tasks: [] });
  const opened = round(s).filter((e) => e.type === "change.opened");
  const by = (n: string) => opened.find((e) => e.change === n);
  assert.deepEqual([by("20")?.branch, by("20")?.sha, by("20")?.task], ["task-7-linked", SHA.a, "5"]);
  assert.deepEqual([by("21")?.branch, by("21")?.sha, by("21")?.task], ["task-8-from-branch", SHA.b, "8"]);
  assert.deepEqual([by("22")?.branch, by("22")?.sha, by("22")?.task], ["no-task-here", SHA.c, undefined]);
  assert.equal(by("22")?.repo, "team/product");
});

test("an account in agents, or an app account, is an agent named by its account; any other is a person named by a pseudonym, the same in every round", () => {
  const s = setup();
  everything(s);
  const first = round(s);
  const actor = (type: string, events = first) => events.find((e) => e.type === type)?.actor;

  assert.deepEqual(actor("change.opened"), { kind: "agent", id: "agent-bot" });
  assert.deepEqual(actor("review.commented"), { kind: "agent", id: "ci-helper[bot]" });
  const bob = actor("review.approved");
  assert.equal(bob?.kind, "person");
  assert.notEqual(bob?.id, "bob");
  assert.deepEqual(actor("review.changes_requested"), bob, "the same person gets the same pseudonym");
  assert.notDeepEqual(actor("change.merged"), bob, "another person gets another pseudonym");

  // The pseudonyms are kept beside the ledger, and stay the same in a later round.
  const people = JSON.parse(readFileSync(join(s.ws.home, PROJECT, "people.json"), "utf8"));
  assert.equal(people.bob, bob?.id);
  s.host.task({
    number: 3,
    openedAt: at(80),
    openedBy: person("bob"),
    assignments: [],
    updatedAt: at(80),
  });
  assert.deepEqual(actor("task.opened", round(s)), bob);
});

test("no event in the ledger holds a person's account name, also not in data", () => {
  const s = setup();
  everything(s);
  round(s);
  const text = readFileSync(s.ws.ledger, "utf8");
  for (const name of ["alice", "bob", "carol", "dave"]) assert.ok(!text.includes(name), name);
});

test("a second round over the same state appends nothing", () => {
  const s = setup();
  everything(s);
  assert.ok(round(s).length > 0);
  assert.deepEqual(round(s), []);
});

test("with the file of the last round removed, the next round appends nothing twice", () => {
  const s = setup();
  everything(s);
  round(s);
  rmSync(join(s.ws.home, PROJECT, "observe.json"));
  assert.deepEqual(round(s), []);
});

test("a new head commit gives change.updated once; its checks give one checks.* event for that commit", () => {
  const s = setup();
  const change = (sha: string, minute: number) =>
    s.host.change({
      number: 30,
      branch: "work",
      openedAt: at(0),
      openedBy: agent,
      head: { sha, at: at(minute) },
      tasks: [],
      reviews: [],
      updatedAt: at(minute),
    });
  change(SHA.a, 0);
  round(s);
  change(SHA.b, 10).checks(SHA.b, "pending");
  const updated = round(s);
  assert.deepEqual(updated.map((e) => [e.type, e.sha]), [["change.updated", SHA.b]]);
  assert.deepEqual(round(s), [], "pending checks give nothing, and the head is not given again");

  // The checks finish without the change being updated: the head is watched.
  s.host.checks(SHA.b, "failed", at(15));
  const checked = round(s);
  assert.deepEqual(checked.map((e) => [e.type, e.sha, e.change, e.branch]), [["checks.failed", SHA.b, "30", "work"]]);
  assert.equal(checked[0]?.time, at(15));
  assert.deepEqual(round(s), []);
});

test("a round brings the inbox in before it reads the host", () => {
  const s = setup();
  everything(s);
  mkdirSync(s.ws.inbox, { recursive: true });
  writeFileSync(join(s.ws.inbox, "0001.json"), fixedForm(event({ id: "from-the-inbox", type: "session.started" })));
  const appended = round(s);
  assert.equal(appended[0]?.id, "from-the-inbox");
  assert.ok(appended.length > 1);
  assert.deepEqual(inboxFiles(s.ws.inbox), []);
});

test("an event already in the ledger is passed over, also from the inbox", () => {
  const s = setup();
  const e = event({ id: "twice", type: "session.started" });
  mkdirSync(s.ws.inbox, { recursive: true });
  writeFileSync(join(s.ws.inbox, "0001.json"), fixedForm(e));
  round(s);
  writeFileSync(join(s.ws.inbox, "0002.json"), fixedForm(e));
  assert.deepEqual(round(s), []);
  assert.deepEqual(inboxFiles(s.ws.inbox), []);
});

test("a failing call warns, the other events of the round are written, and the next round brings what was missed", () => {
  const s = setup();
  everything(s);
  s.host.fail("change 10", "checks " + SHA.b);
  const result = observe(s);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /change 10/);
  assert.match(result.stderr, /checks/);
  const first = lines(s.ws.ledger).map((l) => l.event);
  assert.ok(first.some((e) => e.type === "task.opened"), "the task is written");
  assert.ok(!first.some((e) => e.change === "10"), "nothing of the change that could not be read");
  assert.ok(!first.some((e) => e.type === "checks.failed"));

  s.host.fail();
  const second = round(s);
  assert.ok(second.some((e) => e.type === "change.merged"));
  assert.ok(second.some((e) => e.type === "checks.failed"));
  assert.ok(!second.some((e) => e.type === "task.opened"), "nothing twice");
});

test("a failing list warns and writes nothing from the host; the next round reads it", () => {
  const s = setup();
  everything(s);
  s.host.fail("list");
  const result = observe(s);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /list/);
  assert.equal(lines(s.ws.ledger).length, 1);
  s.host.fail();
  assert.ok(round(s).length > 0);
});

test("howl verify passes after ten rounds", () => {
  const s = setup();
  for (let i = 0; i < 10; i++) {
    s.host.task({
      number: 100 + i,
      openedAt: at(i),
      openedBy: person(`p${i % 3}`),
      assignments: [{ id: `as-${i}`, assignee: agent, at: at(i) }],
      updatedAt: at(i),
    });
    round(s);
  }
  const result = howl(["verify", "--ledger", s.ws.ledger]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(lines(s.ws.ledger).length, 21);
});

test("a second howl observe is refused while the first runs", () => {
  const s = setup();
  everything(s);
  const writer = openLedger(s.ws.ledger, { project: PROJECT });
  try {
    const result = observe(s);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /ledger\.jsonl\.lock/);
  } finally {
    writer.close();
  }
});

test("howl observe outside a repository with .howl/howl.yml is refused", () => {
  const s = setup();
  assert.equal(howl(["observe", "--once"], { cwd: folder(), env: s.ws.env }).status, 2);
});
