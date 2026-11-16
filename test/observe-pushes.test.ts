// #44: each head of a change with who pushed it and when, as the code host says it.
// @code_class tests
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { openLedger } from "../src/ledger/ledger.ts";
import type { Change, Push } from "../src/observe/port.ts";
import { howl, lines, PROJECT, workspace, folder, type Workspace } from "./helpers.ts";
import { at, LocalHost, SHA } from "./local-host.ts";

interface Setup {
  ws: Workspace;
  host: LocalHost;
}

function setup(): Setup {
  const dir = folder();
  const ws = workspace({
    yml: `project: ${PROJECT}
host: local
local: ${dir}
repository: team/product
agents: [agent-bot]
`,
  });
  return { ws, host: new LocalHost(dir) };
}

/** Runs a round and expects it to go through. Returns the events it appended. */
function round(s: Setup): Record<string, any>[] {
  const before = existsSync(s.ws.ledger) ? lines(s.ws.ledger).length : 1;
  const result = howl(["observe", "--once"], { cwd: s.ws.root, env: s.ws.env });
  assert.equal(result.status, 0, result.stderr);
  return lines(s.ws.ledger).slice(before).map((l) => l.event);
}

const person = (login: string) => ({ login });
const agent = { login: "agent-bot" };
const ID = "local:team/product:";
/** A time on 2026-01-01, to the second. */
const atSecond = (minutes: number, seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes, seconds)).toISOString();

/** Change 40 on `work`, opened at minute 10 by the agent, with the pushes given; its head is the last of them. */
function change(s: Setup, pushes: Push[] | undefined, more: Partial<Change> = {}): void {
  const last = pushes?.at(-1);
  s.host.change({
    number: 40,
    branch: "work",
    openedAt: at(10),
    openedBy: agent,
    head: { sha: last?.sha ?? SHA.a, at: at(1) },
    tasks: [],
    reviews: [],
    updatedAt: last?.at ?? at(10),
    ...(pushes !== undefined ? { pushes } : {}),
    ...more,
  });
}

const created: Push = { id: "p1", sha: SHA.a, at: at(9), by: agent };

test("#44: three pushes between two rounds give three change.updated, each with its pusher and its time", () => {
  const s = setup();
  change(s, [created]);
  const first = round(s);
  assert.deepEqual(first.map((e) => [e.type, e.sha]), [["change.opened", SHA.a]]);
  assert.equal(first[0]!.data.inferred, undefined, "the opening head is the host's: the push before it");

  change(s, [
    created,
    { id: "p2", sha: SHA.b, at: at(20), by: agent },
    { id: "p3", sha: SHA.c, at: atSecond(20, 30), by: person("alice") },
    { id: "p4", sha: SHA.d, at: at(21), by: agent },
  ]);
  const second = round(s);
  const updated = second.filter((e) => e.type === "change.updated");
  assert.deepEqual(
    updated.map((e) => [e.sha, e.time, e.actor?.kind]),
    [
      [SHA.b, at(20), "agent"],
      [SHA.c, atSecond(20, 30), "person"],
      [SHA.d, at(21), "agent"],
    ],
  );
  assert.deepEqual(updated[0]!.actor, { kind: "agent", id: "agent-bot" });
  assert.notEqual(updated[1]!.actor.id, "alice", "a person is named by a pseudonym");
  assert.deepEqual(updated.map((e) => e.id), [SHA.b, SHA.c, SHA.d].map((sha) => `${ID}change:40:head:${sha}`), "a head seen once keeps the id it had");
  assert.ok(updated.every((e) => e.data.inferred === undefined && e.source.kind === "observed"), "what the host said is not marked as inferred");
  assert.deepEqual(round(s), [], "read again, nothing is written twice");
});

test("#44: a force push back to the first head is recorded, with the push's own id in its id", () => {
  const s = setup();
  change(s, [created, { id: "p2", sha: SHA.b, at: at(20), by: agent }]);
  round(s);
  change(s, [created, { id: "p2", sha: SHA.b, at: at(20), by: agent }, { id: "p3", sha: SHA.a, before: SHA.b, at: at(30), by: agent, forced: true }]);
  const updated = round(s).filter((e) => e.type === "change.updated");
  assert.equal(updated.length, 1);
  assert.equal(updated[0]!.sha, SHA.a);
  assert.equal(updated[0]!.time, at(30));
  assert.equal(updated[0]!.data.forced, true);
  assert.equal(updated[0]!.id, `${ID}change:40:head:${SHA.a}:p3`);
  assert.deepEqual(round(s), []);
});

test("#44: a head pushed twice gets the push's id in its id the second time", () => {
  const s = setup();
  change(s, [
    created,
    { id: "p2", sha: SHA.b, at: at(20), by: agent },
    { id: "p3", sha: SHA.c, at: at(21), by: agent, forced: true },
    { id: "p4", sha: SHA.b, at: at(22), by: agent, forced: true },
  ]);
  const ids = round(s).filter((e) => e.type === "change.updated").map((e) => e.id.slice(ID.length));
  assert.deepEqual(ids, [`change:40:head:${SHA.b}`, `change:40:head:${SHA.c}`, `change:40:head:${SHA.b}:p4`]);
});

test("#44: a change first read after two pushes is opened with its first head", () => {
  const s = setup();
  change(s, [created, { id: "p2", sha: SHA.b, at: at(20), by: agent }, { id: "p3", sha: SHA.c, at: at(30), by: agent }]);
  const first = round(s);
  const opened = first.find((e) => e.type === "change.opened")!;
  assert.equal(opened.sha, SHA.a);
  assert.equal(opened.time, at(10));
  assert.deepEqual(first.filter((e) => e.type === "change.updated").map((e) => e.sha), [SHA.b, SHA.c]);
});

test("#44: where the list no longer holds the push before the opening, the head before the first push is the opening head", () => {
  const s = setup();
  change(s, [{ id: "p2", sha: SHA.b, before: SHA.a, at: at(20), by: agent }]);
  const first = round(s);
  assert.equal(first.find((e) => e.type === "change.opened")!.sha, SHA.a);
  assert.deepEqual(first.filter((e) => e.type === "change.updated").map((e) => e.sha), [SHA.b]);
});

test("#44: a comment made between the first and the second push carries the first head; a review without a commit too", () => {
  const s = setup();
  change(s, [created, { id: "p2", sha: SHA.b, at: at(20), by: agent }, { id: "p3", sha: SHA.c, at: at(30), by: agent }], {
    comments: [
      { id: "k1", by: person("carol"), at: at(15), review: false },
      { id: "k2", by: person("carol"), at: at(25), review: false },
    ],
    reviews: [{ id: "r1", by: person("bob"), state: "commented", at: at(16) }],
  });
  const events = round(s);
  const of = (id: string) => events.find((e) => e.id === `${ID}${id}`)!;
  assert.equal(of("review:ck1").sha, SHA.a);
  assert.equal(of("review:ck2").sha, SHA.b);
  assert.equal(of("review:r1").sha, SHA.a);
});

test("#44: a host with no pushes gives today's events, marked as inferred", () => {
  const s = setup();
  change(s, undefined, { head: { sha: SHA.a, at: at(5) } });
  const first = round(s);
  const opened = first.find((e) => e.type === "change.opened")!;
  assert.equal(opened.sha, SHA.a);
  assert.equal(opened.data.inferred, true, "the opening's head is the one the round saw");
  change(s, undefined, { head: { sha: SHA.b, at: at(25) }, updatedAt: at(25) });
  const second = round(s);
  assert.deepEqual(second.map((e) => [e.type, e.sha, e.time, e.actor, e.data.inferred]), [["change.updated", SHA.b, at(25), undefined, true]]);
  assert.equal(second[0]!.id, `${ID}change:40:head:${SHA.b}`);
});

test("#44: an empty list of pushes is the fall-back too, and a list that does not reach the head now never loses it", () => {
  const s = setup();
  change(s, [], { head: { sha: SHA.a, at: at(5) } });
  assert.equal(round(s).find((e) => e.type === "change.opened")!.data.inferred, true);
  // The list holds the opening's push and one more; the head now is another, which the list does not hold.
  change(s, [created, { id: "p2", sha: SHA.b, at: at(20), by: agent }], { head: { sha: SHA.c, at: at(26) }, updatedAt: at(27) });
  const updated = round(s).filter((e) => e.type === "change.updated");
  assert.deepEqual(
    updated.map((e) => [e.sha, e.time, e.data.inferred, e.actor?.id]),
    [
      [SHA.b, at(20), undefined, "agent-bot"],
      [SHA.c, at(26), true, undefined],
    ],
  );
});

test("#44: a pusher whose account no longer exists gives no actor and says account_removed", () => {
  const s = setup();
  change(s, [created, { id: "p2", sha: SHA.b, at: at(20), by: { removed: true } }]);
  const updated = round(s).filter((e) => e.type === "change.updated");
  assert.equal(updated.length, 1);
  assert.equal(updated[0]!.actor, undefined);
  assert.equal(updated[0]!.data.account_removed, true);
  assert.equal(updated[0]!.data.inferred, undefined);
});

test("#44: pushes to the branch before the push the change was opened with, or after it was merged, are not its heads", () => {
  const s = setup();
  change(
    s,
    [
      { id: "p0", sha: SHA.d, at: at(1), by: agent },
      created,
      { id: "p2", sha: SHA.b, at: at(20), by: agent },
      { id: "p9", sha: SHA.c, at: at(40), by: agent },
    ],
    { head: { sha: SHA.b, at: at(19) }, mergedAt: at(30), mergedBy: person("carol"), closedAt: at(30), updatedAt: at(30) },
  );
  const events = round(s);
  assert.equal(events.find((e) => e.type === "change.opened")!.sha, SHA.a);
  assert.deepEqual(events.filter((e) => e.type === "change.updated").map((e) => e.sha), [SHA.b]);
  assert.equal(events.find((e) => e.type === "change.merged")!.sha, SHA.b);
});

test("#44: a ledger written before this is not written to again for the same heads", () => {
  const s = setup();
  // As the howl before this step wrote it: the opening with the head of the first round, a new head with the
  // commit's time and no actor.
  const writer = openLedger(s.ws.ledger, { project: PROJECT });
  const base = { v: 0 as const, source: { adapter: "local", kind: "observed" as const }, project: PROJECT, repo: "team/product", change: "40", branch: "work" };
  writer.append({ ...base, id: `${ID}change:40:opened`, time: at(10), type: "change.opened", actor: { kind: "agent", id: "agent-bot" }, sha: SHA.a, data: { seen: at(11) } });
  writer.append({ ...base, id: `${ID}change:40:head:${SHA.b}`, time: at(18), type: "change.updated", sha: SHA.b, data: { seen: at(21) } });
  writer.close();
  change(s, [created, { id: "p2", sha: SHA.b, at: at(20), by: agent }]);
  assert.deepEqual(round(s).filter((e) => e.type === "change.opened" || e.type === "change.updated"), []);
});

test("#44: a change opened before this with a later head than its first is not given that head again", () => {
  const s = setup();
  // Read first after two pushes, by the howl before: opened with the head of that round.
  const writer = openLedger(s.ws.ledger, { project: PROJECT });
  const base = { v: 0 as const, source: { adapter: "local", kind: "observed" as const }, project: PROJECT, repo: "team/product", change: "40", branch: "work" };
  writer.append({ ...base, id: `${ID}change:40:opened`, time: at(10), type: "change.opened", actor: { kind: "agent", id: "agent-bot" }, sha: SHA.b, data: { seen: at(25) } });
  writer.close();
  change(s, [created, { id: "p2", sha: SHA.b, at: at(20), by: agent }, { id: "p3", sha: SHA.c, at: at(30), by: agent }]);
  const updated = round(s).filter((e) => e.type === "change.updated");
  assert.deepEqual(updated.map((e) => e.sha), [SHA.c], "the pushes up to the head the ledger opened it with are not written");
});
