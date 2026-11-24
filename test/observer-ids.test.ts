// #203: the ids an observer makes are known beforehand, so the way in for a session never takes them (A), and the
// observer never skips an id that a line of another event holds in silence (B).
// @code_class tests
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { openLedger, type LedgerEvent } from "../src/ledger/ledger.ts";
import { folder, howl, inboxFiles, lines, PROJECT, rawLines, workspace, type Workspace } from "./helpers.ts";
import { at, LocalHost, SHA } from "./local-host.ts";
import { send, up } from "./up-helpers.ts";

const ID = "local:4242:change:10:merged";

/** A repository of id 4242 with change 10, merged by carol, on a local host. */
function setup() {
  const dir = folder();
  const ws = workspace({ yml: `project: ${PROJECT}\nhost: local\nlocal: ${dir}\nrepository: team/product\nagents: [agent-bot]\n` });
  const host = new LocalHost(dir);
  host.repository(4242);
  host.change({
    number: 10,
    branch: "feature",
    openedAt: at(2),
    openedBy: { login: "agent-bot" },
    head: { sha: SHA.a, at: at(2) },
    tasks: [],
    reviews: [],
    mergedAt: at(30),
    mergedBy: { login: "carol" },
    closedAt: at(30),
    updatedAt: at(30),
  } as never);
  return { ws, host };
}

function observe(ws: Workspace) {
  return howl(["observe", "--once"], { cwd: ws.root, env: ws.env });
}

function leave(ws: Workspace, name: string, content: unknown): void {
  mkdirSync(ws.inbox, { recursive: true });
  writeFileSync(join(ws.inbox, name), JSON.stringify(content));
}

/** A claim as a session's hook would send it. */
function claim(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 0,
    id: "claimed-1",
    time: at(1),
    type: "session.started",
    source: { adapter: "claude-code-hook", kind: "claimed" },
    project: PROJECT,
    session: "x",
    actor: { kind: "agent", id: "agent-bot" },
    ...over,
  };
}

/** What the observer would never take from a session: its ids, and its adapters' names. */
const THEIRS: [string, Record<string, unknown>][] = [
  ["an id of a local host", { id: ID }],
  ["an id of a github host", { id: "github:123456:change:10:merged" }],
  ["the adapter github", { source: { adapter: "github", kind: "claimed" } }],
  ["the adapter local", { source: { adapter: "local", kind: "claimed" } }],
  ["a checks.passed claimed to be observed by github", { id: "gh-x", type: "checks.passed", sha: SHA.a, source: { adapter: "github", kind: "observed" } }],
];

test("#203 A: the inbox refuses an event with the observer's id or adapter, with the reason, to rejected/", () => {
  const ws = workspace();
  THEIRS.forEach(([, over], i) => leave(ws, `000${i}.json`, claim(over)));
  leave(ws, "0009.json", claim({ id: "fine" }));
  const result = howl(["ingest"], { cwd: ws.root, env: ws.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /5 rejected/);
  assert.deepEqual(inboxFiles(ws.inbox), []);
  const rejected = join(ws.inbox, "rejected");
  for (let i = 0; i < THEIRS.length; i++) {
    assert.match(readFileSync(join(rejected, `000${i}.json.reason`), "utf8"), /this id is the observer's; the observer writes its own events, never through the inbox/);
  }
  assert.deepEqual(lines(ws.ledger).map((l) => l.event.id).slice(1), ["fine"]);
});

test("#203 A: POST /api/events refuses the same with 400 and the reason, and leaves nothing", async () => {
  const running = await up();
  try {
    for (const [what, over] of THEIRS) {
      const answer = await send(running.url, running.token, claim(over));
      assert.equal(answer.status, 400, what);
      assert.match(((await answer.json()) as { error: string }).error, /this id is the observer's; the observer writes its own events, never through the inbox/, what);
    }
    assert.equal((await send(running.url, running.token, claim({ id: "fine-over-http" }))).status, 200);
    assert.deepEqual(inboxFiles(running.ws.inbox).length <= 1, true);
    assert.ok(!existsSync(join(running.ws.inbox, "rejected")));
  } finally {
    await running.stop();
  }
});

/** A line written straight into the ledger, as one that got past A or was there before it. */
function plant(ws: Workspace, planted: Record<string, unknown>): void {
  const writer = openLedger(ws.ledger, { project: PROJECT });
  writer.append(planted as unknown as LedgerEvent);
  writer.close();
}

test("#203 B: a planted line under the id of a merge is warned of, the made event is kept in rejected/, and the round goes on", () => {
  const { ws } = setup();
  plant(ws, claim({ id: ID }));
  const result = observe(ws);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /local:4242:change:10:merged/);
  assert.match(result.stderr, /another event/);

  const all = lines(ws.ledger).map((l) => l.event);
  assert.equal(all.find((e) => e.id === ID)?.type, "session.started", "the planted line is untouched");
  assert.ok(all.some((e) => e.type === "change.opened"), "the round went on: the rest is written");
  assert.ok(!all.some((e) => e.type === "change.merged"));

  const rejected = join(ws.inbox, "rejected");
  const names = readdirSync(rejected).sort();
  assert.equal(names.length, 2, names.join(", "));
  const [json, reason] = [names.find((n) => n.endsWith(".json"))!, names.find((n) => n.endsWith(".reason"))!];
  assert.equal(reason, `${json}.reason`);
  const made = JSON.parse(readFileSync(join(rejected, json), "utf8")) as LedgerEvent;
  assert.equal(made.id, ID);
  assert.equal(made.type, "change.merged");
  assert.match(readFileSync(join(rejected, reason), "utf8"), /another event/);

  // The next round says nothing more and adds nothing.
  const before = rawLines(ws.ledger);
  const again = observe(ws);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stderr, "");
  assert.deepEqual(readdirSync(rejected).sort(), names);
  assert.deepEqual(rawLines(ws.ledger), before);
});

test("#203 B: a line of the observer's own adapter and kind that differs in its time is another event too", () => {
  const { ws } = setup();
  plant(ws, claim({ id: ID, type: "change.merged", time: at(99), source: { adapter: "local", kind: "observed" }, change: "10" }));
  const result = observe(ws);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /local:4242:change:10:merged/);
  assert.equal(readdirSync(join(ws.inbox, "rejected")).length, 2);
});

test("#203 B: a repeat round reads the observer's own events as its own: no warning, nothing in rejected/, nothing written", () => {
  const { ws } = setup();
  assert.equal(observe(ws).status, 0);
  const before = rawLines(ws.ledger);
  assert.ok(before.length > 2);
  for (let i = 0; i < 2; i++) {
    const again = observe(ws);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stderr, "");
  }
  assert.deepEqual(rawLines(ws.ledger), before);
  assert.ok(!existsSync(join(ws.inbox, "rejected")));
});

test("#203 B: an observer started again over its ledger passes over its observe.started, made with a new time", () => {
  const { ws } = setup();
  assert.equal(howl(["observe", "--once", "--since", "2026-01-01T00:00:00Z"], { cwd: ws.root, env: ws.env }).status, 0);
  assert.ok(lines(ws.ledger).some((l) => l.event.type === "observe.started"));
  // Without its cursor the observer starts again, and makes observe.started again with the time of the round.
  rmSync(join(dirname(ws.ledger), "observe.json"));
  const before = rawLines(ws.ledger);
  const again = howl(["observe", "--once", "--since", "2026-01-01T00:00:00Z"], { cwd: ws.root, env: ws.env });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stderr, "");
  assert.deepEqual(rawLines(ws.ledger), before);
  assert.ok(!existsSync(join(ws.inbox, "rejected")));
});

/** A change of the local host with what a test changes. */
const change = (over: Record<string, unknown> = {}) =>
  ({ number: 10, branch: "feature", openedAt: at(2), openedBy: { login: "agent-bot" }, head: { sha: SHA.a, at: at(2) }, tasks: [], reviews: [], updatedAt: at(2), ...over }) as never;

const rejectedOf = (ws: Workspace) => (existsSync(join(ws.inbox, "rejected")) ? readdirSync(join(ws.inbox, "rejected")).sort() : []);
const typesOf = (ws: Workspace) => lines(ws.ledger).map((l) => l.event.type);

test("#203 B: a task that the host links to a change after it was written is not a plant: no warning, nothing refused, nothing new", () => {
  const { ws, host } = setup();
  const review = { id: "r-1", by: { login: "bob" }, state: "approved", at: at(5), sha: SHA.a };
  host.change(change({ reviews: [review], updatedAt: at(5) }));
  assert.equal(observe(ws).status, 0);
  const before = rawLines(ws.ledger);
  // The text of the change is edited to name task 7: the host now links it, and the change is updated.
  host.change(change({ tasks: [7], reviews: [review], updatedAt: at(40) }));
  const again = observe(ws);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stderr, "");
  assert.deepEqual(rejectedOf(ws), []);
  assert.deepEqual(rawLines(ws.ledger), before);
});

test("#203 B: the end of a commit's checks under a planted id is warned of, not passed over in silence", () => {
  // The control: the same change without the plant gets its checks.none.
  const control = setup();
  control.host.change(change({ mergedAt: at(30), mergedBy: { login: "carol" }, closedAt: at(30), updatedAt: at(30) }));
  assert.equal(observe(control.ws).status, 0);
  assert.ok(typesOf(control.ws).includes("checks.none"), "without a plant checks.none is written");

  const { ws, host } = setup();
  host.change(change({ mergedAt: at(30), mergedBy: { login: "carol" }, closedAt: at(30), updatedAt: at(30) }));
  const id = `local:4242:checks:${SHA.a}:none`;
  plant(ws, claim({ id }));
  const result = observe(ws);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(id));
  assert.equal(rejectedOf(ws).length, 2);
  assert.ok(typesOf(ws).includes("change.merged"), "the round went on");
  assert.equal(lines(ws.ledger).find((l) => l.event.id === id)?.event.type, "session.started");
});

test("#203 B: a review the host no longer lists, under a planted id, is warned of, not passed over in silence", () => {
  const dismissed = { id: "d1", review: "r-9", state: "changes_requested", by: { login: "carol" }, at: at(15), reviewed: { by: { login: "bob" }, at: at(10), sha: SHA.a } };
  const control = setup();
  control.host.change(change({ dismissals: [dismissed], updatedAt: at(15) }));
  assert.equal(observe(control.ws).status, 0);
  assert.ok(lines(control.ws.ledger).some((l) => l.event.id === "local:4242:review:r-9" && l.event.type === "review.changes_requested"), "without a plant the review is written");

  const { ws, host } = setup();
  host.change(change({ dismissals: [dismissed], updatedAt: at(15) }));
  const id = "local:4242:review:r-9";
  plant(ws, claim({ id }));
  const result = observe(ws);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(id));
  assert.equal(rejectedOf(ws).length, 2);
  assert.ok(typesOf(ws).includes("review.dismissed"), "the round went on");
});

test("#203 B: the warning says whether the line is of this host and observed, and in what it differs", () => {
  const foreign = setup();
  plant(foreign.ws, claim({ id: ID }));
  const a = observe(foreign.ws);
  assert.match(a.stderr, /not of this host and observed/);
  assert.match(a.stderr, /claude-code-hook/);

  const own = setup();
  plant(own.ws, claim({ id: ID, type: "change.merged", time: at(99), source: { adapter: "local", kind: "observed" }, change: "10" }));
  const b = observe(own.ws);
  assert.match(b.stderr, /of this host, observed/);
  assert.match(b.stderr, /differs in time/);
  const reason = readdirSync(join(own.ws.inbox, "rejected")).find((n) => n.endsWith(".reason"))!;
  assert.match(readFileSync(join(own.ws.inbox, "rejected", reason), "utf8"), /differs in time/);
});

test("#203 B: a change closed, reopened and closed again at the same head: its checks.none is the observer's own, no warning, nothing refused", () => {
  const { ws, host } = setup();
  host.change(change({ closedAt: at(30), closedBy: { login: "carol" }, updatedAt: at(30) }));
  assert.equal(observe(ws).status, 0);
  assert.ok(typesOf(ws).includes("checks.none"), "the first close gives checks.none");
  host.change(change({ closedAt: at(60), closedBy: { login: "carol" }, updatedAt: at(60), reopenings: [{ id: "ro-1", at: at(45), by: { login: "carol" } }] }));
  const again = observe(ws);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stderr, "");
  assert.deepEqual(rejectedOf(ws), []);
});
