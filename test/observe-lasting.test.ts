// #48: ids that survive a renamed repository, and removed accounts that are not one person.
// @code_class tests
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { events as ledgerEvents, openLedger, type LedgerEvent } from "../src/ledger/ledger.ts";
import { Observer } from "../src/observe/observe.ts";
import { People } from "../src/observe/people.ts";
import { LocalHost as LocalReader } from "../src/observe/local.ts";
import type { CodeHost } from "../src/observe/port.ts";
import { roundText } from "../src/read/rounds.ts";
import { folder, howl, lines, PROJECT, workspace, type Workspace } from "./helpers.ts";
import { at, LocalHost, SHA } from "./local-host.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/observe-before-lasting-ids.jsonl", import.meta.url));
const person = (login: string) => ({ login });
const agent = { login: "agent-bot" };
const removed = { removed: true as const };

/** What `howl observe` read of one repository, once, before the lasting ids: in a fixture, as that howl wrote it. */
function scenario(host: LocalHost): void {
  host
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
      files: [".howl/howl.yml", "src/a.ts"],
      reviews: [
        { id: "r-1", by: person("bob"), state: "changes_requested", at: at(10), sha: SHA.a },
        { id: "r-3", by: person("bob"), state: "approved", at: at(20), sha: SHA.a },
      ],
      comments: [
        { id: "k1", by: person("carol"), at: at(12), review: true },
        { id: "k2", by: person("carol"), at: at(13), review: false },
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
    .change({
      number: 12,
      branch: "task-2-more",
      openedAt: at(60),
      openedBy: agent,
      head: { sha: SHA.d, at: at(70) },
      tasks: [],
      files: [".howl/rules.yml"],
      reviews: [],
      updatedAt: at(70),
    })
    .checks(SHA.a, "passed", at(5))
    .checks(SHA.b, "failed", at(6))
    .checks(SHA.d, "passed", at(71));
}

/** A ledger as the howl before this change left it: the events of the fixture, ids made from `team/product`. */
function oldLedger(path: string): Partial<LedgerEvent>[] {
  const old = readFileSync(FIXTURE, "utf8").trim().split("\n").map((l) => JSON.parse(l) as LedgerEvent);
  const writer = openLedger(path, { project: PROJECT });
  for (const e of old) writer.append(e);
  writer.close();
  return old;
}

interface Run {
  dir: string;
  ledger: string;
  host: LocalHost;
  observer(repository: string, start?: string, over?: Partial<{ host: CodeHost; warn: (m: string) => void; hostDir: string }>): { observer: Observer; close(): void };
}

/** The folders of an observer run directly, so that a round can be given a `traceAt` and a start. */
function run(): Run {
  const dir = folder();
  const hostDir = join(dir, "host");
  const state = join(dir, "state");
  mkdirSync(join(state, "inbox"), { recursive: true });
  const ledger = join(state, "ledger.jsonl");
  const host = new LocalHost(hostDir);
  return {
    dir,
    ledger,
    host,
    observer(repository, start, over = {}) {
      const writer = openLedger(ledger, { project: PROJECT });
      const observer = new Observer({
        host: over.host ?? new LocalReader(over.hostDir ?? hostDir, repository),
        writer,
        ledgerPath: ledger,
        places: { project: PROJECT, inbox: join(state, "inbox"), activity: join(state, "activity.jsonl") },
        cursorPath: join(state, "observe.json"),
        people: new People(join(state, "people.json")),
        settings: { project: PROJECT, activityDays: 30, agents: ["agent-bot"], taskFromBranch: "^task-([0-9]+)" },
        warn: over.warn ?? (() => {}),
        start,
        traceAt: () => ({ state: "read", summary: { covered: ["R-1"], touched: [], tests: 1, covering: 1, list: "0".repeat(64) } }),
      });
      return { observer, close: () => writer.close() };
    },
  };
}

/** One round, closed again; the events it wrote. */
async function round(r: Run, repository: string, start?: string): Promise<Record<string, any>[]> {
  const before = existsSync(r.ledger) ? ledgerCount(r.ledger) : 0;
  const { observer, close } = r.observer(repository, start);
  try {
    await observer.round(new Date(at(200)));
  } finally {
    close();
  }
  return [...ledgerEvents(r.ledger)].slice(before) as Record<string, any>[];
}

const ledgerCount = (path: string) => [...ledgerEvents(path)].length;

test("#48: a ledger of ids made from team/product, then the repository is team/renamed: a round that reads everything again writes nothing, for every kind of event", async () => {
  const r = run();
  scenario(r.host);
  r.host.repository("4711", ["team/product"]);
  const old = oldLedger(r.ledger);
  // The case is of every kind of event the observer writes, so that none can be forgotten.
  const types = new Set(old.map((e) => e.type));
  for (const t of [
    "task.opened", "task.assigned", "task.closed",
    "change.opened", "change.updated", "change.commented", "change.merged", "change.closed",
    "checks.passed", "checks.failed",
    "review.approved", "review.changes_requested", "review.commented",
    "config.changed", "trace.read", "observe.started",
  ]) assert.ok(types.has(t as LedgerEvent["type"]), `the fixture holds ${t}`);
  assert.ok(old.every((e) => e.id!.startsWith("local:team/product:")), "the fixture is of the old form");
  const before = ledgerCount(r.ledger);

  // No cursor and a start: observe.started is asked for once more, and passed over, as every other event.
  assert.deepEqual(await round(r, "team/renamed", at(0)), []);
  assert.equal(ledgerCount(r.ledger), before);
  // Again, with the cursor of the round before.
  assert.deepEqual(await round(r, "team/renamed"), []);
});

test("#48: the review's case: a ledger of one repository, then of another with the same change numbers; the observer then on the second, with a lasting id, writes each new opening and no head that never was", async () => {
  const r = run();
  const change = (n: number, branch: string, sha: string, minute: number) => ({
    number: n,
    branch,
    openedAt: at(minute),
    openedBy: agent,
    head: { sha, at: at(minute) },
    tasks: [],
    reviews: [],
    updatedAt: at(minute),
  });
  // Before this change: team/a with changes 1 to 3, then team/b with a change 1; ids made from the names.
  const a = new LocalHost(join(r.dir, "host-a"));
  a.change(change(1, "a-1", SHA.a, 1)).change(change(2, "a-2", SHA.a, 2)).change(change(3, "a-3", SHA.a, 3));
  const b = new LocalHost(join(r.dir, "host-b"));
  b.change(change(1, "b-1", SHA.b, 10));
  for (const [dir, name] of [["host-a", "team/a"], ["host-b", "team/b"]] as const) {
    const o = r.observer(name, undefined, { hostDir: join(r.dir, dir) });
    await o.observer.round(new Date(at(100)));
    o.close();
    rmSync(join(r.dir, "state", "observe.json"));
  }
  const before = ledgerCount(r.ledger);
  // Now team/b has a lasting id, and new changes 2 and 3 that team/a has numbers for too.
  b.repository("222").change(change(2, "b-2", SHA.c, 20)).change(change(3, "b-3", SHA.d, 21));
  const o = r.observer("team/b", undefined, { hostDir: join(r.dir, "host-b") });
  await o.observer.round(new Date(at(200)));
  o.close();
  const added = [...ledgerEvents(r.ledger)].slice(before) as Record<string, any>[];
  const ids = added.map((e) => e.id);
  assert.ok(ids.includes("local:222:change:2:opened"), "the opening of change 2 of team/b is written");
  assert.ok(ids.includes("local:222:change:3:opened"), "the opening of change 3 of team/b is written");
  assert.ok(!ids.includes("local:222:change:1:opened"), "change 1 of team/b was written before, under its name");
  assert.deepEqual(added.filter((e) => e.type === "change.updated"), [], "no new head that did not happen");
  assert.ok(added.every((e) => e.repo === "team/b" && e.id.startsWith("local:222:")));
});

test("#48: an old name that is another repository: its events are not matched, and what the host shows is written in the new form", async () => {
  const r = run();
  scenario(r.host);
  oldLedger(r.ledger);
  // The host says nothing of team/product as a former name: it is another repository.
  r.host.repository("4711");
  const written = await round(r, "team/renamed", at(0));
  assert.ok(written.length > 20, "everything the host shows is written again, for it is not what team/product was");
  assert.ok(written.every((e) => e.id.startsWith("local:4711:")));
});

test("#48: an old name the host cannot answer for: nothing observed is written, the cursor stays, and the warning names the old name", async () => {
  const r = run();
  scenario(r.host);
  oldLedger(r.ledger);
  const inner = new LocalReader(join(r.dir, "host"), "team/renamed");
  let answers = false;
  const asked: string[] = [];
  const host: CodeHost = {
    name: inner.name,
    repository: inner.repository,
    repositoryId: async () => "4711",
    isSameRepository: async (name) => {
      asked.push(name);
      if (!answers) throw new Error("GitHub answered 502");
      return true;
    },
    listUpdated: (s) => inner.listUpdated(s),
    task: (n) => inner.task(n),
    change: (n) => inner.change(n),
    checks: (s) => inner.checks(s),
  };
  const before = ledgerCount(r.ledger);
  const warned: string[] = [];
  const first = r.observer("team/renamed", at(0), { host, warn: (m) => warned.push(m) });
  const result = await first.observer.round(new Date(at(200)));
  assert.equal(result.complete, false);
  assert.equal(result.appended, 0);
  assert.equal(ledgerCount(r.ledger), before);
  assert.equal(existsSync(join(r.dir, "state", "observe.json")), false, "the cursor did not move");
  assert.match(warned.join("\n"), /team\/product/);
  assert.match(warned.join("\n"), /GitHub answered 502/);
  // The same observer asks again in the next round, and goes on when it is answered.
  answers = true;
  const next = await first.observer.round(new Date(at(201)));
  first.close();
  assert.equal(next.complete, true);
  assert.equal(next.appended, 0, "confirmed, the old ids are the same events");
  assert.deepEqual(asked, ["team/product", "team/product"], "only the old name is asked for, never the current one");
});

test("#48: the repository.json of the local host says what the repository was called: `was`, a list of names; anything else is an error", async () => {
  const dir = folder();
  const host = new LocalHost(dir);
  host.repository(7, ["team/old", "team/older"]);
  const reader = new LocalReader(dir, "team/new");
  assert.equal(await reader.repositoryId(), "7");
  assert.equal(await reader.isSameRepository("team/old"), true);
  assert.equal(await reader.isSameRepository("team/older"), true);
  assert.equal(await reader.isSameRepository("team/other"), false);
  writeFileSync(join(dir, "repository.json"), JSON.stringify({ id: 7, was: "team/old" }));
  await assert.rejects(reader.isSameRepository("team/old"), /was/);
  // With no file the id is the name, and no other name is this repository.
  rmSync(join(dir, "repository.json"));
  assert.equal(await reader.repositoryId(), "team/new");
  assert.equal(await reader.isSameRepository("team/old"), false);
});

test("#48: the same repository under its old name, with the lasting id now read: nothing is written twice", async () => {
  const r = run();
  scenario(r.host);
  oldLedger(r.ledger);
  r.host.repository("4711");
  assert.deepEqual(await round(r, "team/product", at(0)), []);
});

test("#48: without a repository.json the id is the name, so the old form goes on as it was", async () => {
  const r = run();
  scenario(r.host);
  oldLedger(r.ledger);
  assert.deepEqual(await round(r, "team/product", at(0)), []);
});

test("#48: after a rename a new head of a change opened before it is a new head (the opened head is read by the old name too)", async () => {
  const r = run();
  scenario(r.host);
  r.host.repository("4711", ["team/product"]);
  oldLedger(r.ledger);
  r.host.change({
    number: 12,
    branch: "task-2-more",
    openedAt: at(60),
    openedBy: agent,
    head: { sha: "e".repeat(40), at: at(90) },
    tasks: [],
    reviews: [],
    updatedAt: at(90),
  });
  const written = await round(r, "team/renamed");
  const updated = written.filter((e) => e.type === "change.updated");
  assert.equal(updated.length, 1);
  assert.equal(updated[0]!.id, `local:4711:change:12:head:${"e".repeat(40)}`);
  assert.equal(updated[0]!.repo, "team/renamed", "repo stays the name, as people read it");
  assert.deepEqual(await round(r, "team/renamed"), [], "and a second round writes nothing");
});

test("#48: what is new after a rename has the lasting id, repo is the name now, and is written once", async () => {
  const r = run();
  scenario(r.host);
  r.host.repository("4711", ["team/product"]);
  oldLedger(r.ledger);
  r.host.task({ number: 2, openedAt: at(100), openedBy: person("alice"), assignments: [], updatedAt: at(100) });
  const written = await round(r, "team/renamed");
  assert.deepEqual(written.map((e) => e.id), ["local:4711:task:2:opened"]);
  assert.equal(written[0]!.repo, "team/renamed");
  assert.deepEqual(await round(r, "team/renamed"), []);
});

test("#48: names are read from what the adapter observed, not from any id: a claimed event with such an id holds nothing", async () => {
  const r = run();
  scenario(r.host);
  r.host.repository("4711");
  const writer = openLedger(r.ledger, { project: PROJECT });
  // Looks like the old form of another name, but a session sent it about itself: it is not what the host showed.
  writer.append({ v: 0, id: "local:team/other:task:1:opened", time: at(0), type: "task.opened", source: { adapter: "local", kind: "claimed" }, project: PROJECT, repo: "team/other", task: "1", data: {} });
  writer.close();
  const written = await round(r, "team/product");
  assert.ok(written.some((e) => e.id === "local:4711:task:1:opened"), "task 1 is written: the claimed id is not an id of this repository");
});

test("#48: a host that cannot tell its repository's id writes nothing and says so; the next round goes on", async () => {
  const r = run();
  scenario(r.host);
  const inner = new LocalReader(join(r.dir, "host"), "team/product");
  let fails = true;
  const host: CodeHost = {
    name: inner.name,
    repository: inner.repository,
    repositoryId: async () => {
      if (fails) throw new Error("the host does not answer");
      return "4711";
    },
    isSameRepository: (n) => inner.isSameRepository(n),
    listUpdated: (s) => inner.listUpdated(s),
    task: (n) => inner.task(n),
    change: (n) => inner.change(n),
    checks: (s) => inner.checks(s),
  };
  const warned: string[] = [];
  const first = r.observer("team/product", undefined, { host, warn: (m) => warned.push(m) });
  const failed = await first.observer.round(new Date(at(200)));
  first.close();
  assert.equal(failed.complete, false);
  assert.equal(failed.appended, 0);
  assert.match(warned.join("\n"), /the host does not answer/);
  assert.equal(existsSync(join(r.dir, "state", "observe.json")), false, "the cursor did not move");
  fails = false;
  r.host.repository("4711");
  const written = await round(r, "team/product");
  assert.ok(written.length > 0 && written.every((e) => e.id.startsWith("local:4711:")));
});

// --- through the command, with a ledger of its own --------------------------------------------------------------

function setup(extra = ""): { ws: Workspace; host: LocalHost } {
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

function observe(ws: Workspace) {
  const result = howl(["observe", "--once"], { cwd: ws.root, env: ws.env });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

const written = (ws: Workspace, before: number) => lines(ws.ledger).slice(before).map((l) => l.event as Record<string, any>);

test("#48: a new ledger has ids with the lasting id, and repo is the name; renamed, a round reading everything again writes nothing", () => {
  const s = setup();
  scenario(s.host);
  s.host.repository(4711);
  observe(s.ws);
  const all = lines(s.ws.ledger).slice(1).map((l) => l.event as Record<string, any>);
  assert.ok(all.length > 10);
  for (const e of all) {
    assert.ok(e.id.startsWith("local:4711:"), e.id);
    assert.equal(e.repo, "team/product");
    assert.ok(!e.id.includes("team/product"), "no name in an id");
  }
  const count = lines(s.ws.ledger).length;

  // The repository is renamed, and the cursor is gone: everything is read again.
  writeFileSync(join(s.ws.root, ".howl", "howl.yml"), readFileSync(join(s.ws.root, ".howl", "howl.yml"), "utf8").replace("team/product", "team/renamed"));
  rmSync(join(s.ws.home, PROJECT, "observe.json"));
  observe(s.ws);
  assert.equal(lines(s.ws.ledger).length, count, "nothing is written twice");

  // What is new carries the new name in repo, and the same lasting id.
  s.host.task({ number: 2, openedAt: at(100), openedBy: person("alice"), assignments: [], updatedAt: at(100) });
  observe(s.ws);
  const [fresh, ...none] = written(s.ws, count);
  assert.equal(none.length, 0);
  assert.equal(fresh!.id, "local:4711:task:2:opened");
  assert.equal(fresh!.repo, "team/renamed");
});

test("#48: a repository.json whose id is not text or a number is refused with its name, and nothing is written", () => {
  const s = setup();
  scenario(s.host);
  writeFileSync(join(s.host.dir, "repository.json"), JSON.stringify({ id: { not: "an id" } }));
  const result = howl(["observe", "--once"], { cwd: s.ws.root, env: s.ws.env });
  assert.equal(result.status, 0, "a round that fails does not end the command");
  assert.match(result.stderr, /repository\.json/);
  assert.equal(existsSync(s.ws.ledger) ? lines(s.ws.ledger).length : 1, 1);
});

test("#48: two reviews by two removed accounts have no actor, say account_removed, and are not one reviewer", () => {
  const s = setup();
  s.host.repository(4711);
  s.host.change({
    number: 30,
    branch: "task-5-x",
    openedAt: at(0),
    openedBy: removed,
    head: { sha: SHA.a, at: at(0) },
    tasks: [5],
    reviews: [
      { id: "r-1", by: removed, state: "approved", at: at(10), sha: SHA.a },
      { id: "r-2", by: removed, state: "approved", at: at(11), sha: SHA.a },
    ],
    comments: [{ id: "k1", by: removed, at: at(12), review: false }],
    mergedAt: at(20),
    mergedBy: removed,
    closedAt: at(20),
    updatedAt: at(20),
  });
  s.host.task({ number: 5, openedAt: at(0), openedBy: removed, assignments: [{ id: "as-1", assignee: removed, at: at(1) }], closedAt: at(40), closedBy: removed, updatedAt: at(40) });
  observe(s.ws);
  const all = lines(s.ws.ledger).slice(1).map((l) => l.event as Record<string, any>);
  const byRemoved = all.filter((e) => !["change.updated", "config.changed", "trace.read"].includes(e.type) && !e.type.startsWith("checks."));
  assert.ok(byRemoved.length >= 8, "the events of the removed accounts are there");
  for (const e of byRemoved) {
    assert.equal(e.actor, undefined, `${e.type} has no actor`);
    assert.equal(e.data.account_removed, true, `${e.type} says the account is removed`);
  }
  assert.equal(all.filter((e) => e.type === "review.approved").length, 2);
  // Nobody is named: no pseudonym was made up for them, and no "ghost".
  assert.ok(!existsSync(join(s.ws.home, PROJECT, "people.json")), "no pseudonym is made for a removed account");
  assert.ok(!readFileSync(s.ws.ledger, "utf8").includes("ghost"));
  // And a reader does not take them for one reviewer who approved twice.
  const reviews = all.filter((e) => e.type === "review.approved").map((e) => ({ time: e.time, actor: e.actor, outcome: "approved" }));
  assert.equal(roundText(reviews), "someone approved, someone approved");
  assert.equal(howl(["verify", "--project", PROJECT], { cwd: s.ws.root, env: s.ws.env }).status, 0);
});

test("#48: an account that is there gets no account_removed", () => {
  const s = setup();
  scenario(s.host);
  s.host.repository(4711);
  observe(s.ws);
  const all = lines(s.ws.ledger).slice(1).map((l) => l.event as Record<string, any>);
  assert.ok(all.every((e) => e.data.account_removed === undefined));
});
