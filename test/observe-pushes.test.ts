// #44: each head of a change with who pushed it and when, as the code host says it.
// @code_class tests
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { events as ledgerEvents, openLedger, type LedgerEvent } from "../src/ledger/ledger.ts";
import { LocalHost as LocalReader } from "../src/observe/local.ts";
import { Observer } from "../src/observe/observe.ts";
import { People } from "../src/observe/people.ts";
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

/** Runs a round and expects it to go through. Returns the events it appended, and what it said on standard error. */
function roundSaid(s: Setup): { events: Record<string, any>[]; stderr: string } {
  const before = existsSync(s.ws.ledger) ? lines(s.ws.ledger).length : 1;
  const result = howl(["observe", "--once"], { cwd: s.ws.root, env: s.ws.env });
  assert.equal(result.status, 0, result.stderr);
  return { events: lines(s.ws.ledger).slice(before).map((l) => l.event), stderr: result.stderr };
}

/** Runs a round and expects it to go through. Returns the events it appended. */
function round(s: Setup): Record<string, any>[] {
  return roundSaid(s).events;
}

const person = (login: string) => ({ login });
const agent = { login: "agent-bot" };
const ID = "local:team/product:";
/** A time on 2026-01-01, to the second. */
const atSecond = (minutes: number, seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes, seconds)).toISOString();

/** The machine's clock in a test: `minutes` after a fixed time, far from the host's times. */
function clock(minutes: number): Date {
  return new Date(Date.UTC(2026, 5, 1, 12, 0) + minutes * 60_000);
}

interface Direct {
  host: LocalHost;
  cursorPath: string;
  /** A round at the machine's time `now`: the events it appended. */
  round(now: Date): Promise<LedgerEvent[]>;
  /** What the last round warned, one line each. */
  said(): string;
  cursor(): Record<string, any>;
  close(): void;
  /** The observer stopped and started again over the same ledger, cursor and host. */
  restart(): void;
}

/** An observer run directly, so that each round is given the machine's time. */
function direct(): Direct {
  const dir = folder();
  const hostDir = join(dir, "host");
  const state = join(dir, "state");
  mkdirSync(join(state, "inbox"), { recursive: true });
  const ledger = join(state, "ledger.jsonl");
  const cursorPath = join(state, "observe.json");
  const host = new LocalHost(hostDir);
  let warnings: string[] = [];
  const start = () => {
    const writer = openLedger(ledger, { project: PROJECT });
    const observer = new Observer({
      host: new LocalReader(hostDir, "team/product"),
      writer,
      ledgerPath: ledger,
      places: { project: PROJECT, inbox: join(state, "inbox"), activity: join(state, "activity.jsonl") },
      cursorPath,
      people: new People(join(state, "people.json")),
      settings: { project: PROJECT, activityDays: 30, agents: ["agent-bot"] },
      warn: (m) => warnings.push(m),
    });
    return { writer, observer };
  };
  let { writer, observer } = start();
  return {
    host,
    cursorPath,
    async round(now) {
      const before = [...ledgerEvents(ledger)].length;
      warnings = [];
      await observer.round(now);
      return [...ledgerEvents(ledger)].slice(before) as LedgerEvent[];
    },
    said: () => warnings.join("\n"),
    cursor: () => JSON.parse(readFileSync(cursorPath, "utf8")),
    close: () => writer.close(),
    restart() {
      writer.close();
      ({ writer, observer } = start());
    },
  };
}

/** Change 40 on `work`, opened at minute 10 by the agent, with the pushes given; its head is the last of them. */
function change(s: { host: LocalHost }, pushes: Push[] | undefined, more: Partial<Change> = {}): void {
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

test("#44: a list that holds only a push made after the opening: the opening has the head that push replaced, marked as inferred", () => {
  const s = setup();
  change(s, [{ id: "p2", sha: SHA.b, before: SHA.a, at: at(20), by: agent }]);
  const first = round(s);
  const opened = first.find((e) => e.type === "change.opened")!;
  assert.equal(opened.sha, SHA.a);
  assert.equal(opened.data.inferred, true, "it rests on the list having dropped no push in between");
  const updated = first.filter((e) => e.type === "change.updated");
  assert.deepEqual(updated.map((e) => [e.sha, e.data.inferred]), [[SHA.b, undefined]], "the push itself is the host's");
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

/** Change 40 with pushes A (before the opening) and B, a comment on A and a review on B, and C as its head now. */
function lagging(s: { host: LocalHost }, updatedAt: string, pushes: Push[] = [created, { id: "p2", sha: SHA.b, at: at(20), by: agent }]): void {
  change(s, pushes, {
    head: { sha: SHA.c, at: at(26) },
    updatedAt,
    comments: [{ id: "k1", by: person("carol"), at: at(15), review: false }],
    reviews: [{ id: "r1", by: person("bob"), state: "commented", at: at(25) }],
  });
}

test("#44: a head the list does not reach yet is waited for: nothing of the change is written, and the next round writes it as the host says", () => {
  const s = setup();
  const now = Date.now();
  // Updated a minute ago: the list may still lag.
  const updated = new Date(now - 60_000).toISOString();
  lagging(s, updated);
  // Another change of the same round, updated after it: it is written, and the cursor must still not pass change 40.
  s.host.change({ number: 41, branch: "other", openedAt: at(5), openedBy: agent, head: { sha: SHA.d, at: at(5) }, tasks: [], reviews: [], updatedAt: new Date(now).toISOString() });
  const first = round(s);
  assert.deepEqual(first.filter((e) => e.change === "40"), [], "nothing of the change that waits");
  assert.ok(first.some((e) => e.change === "41" && e.type === "change.opened"), "the other change is written");

  // The list now holds the push of the head; the change was not updated at the host again.
  lagging(s, updated, [created, { id: "p2", sha: SHA.b, at: at(20), by: agent }, { id: "p3", sha: SHA.c, at: at(28), by: person("alice") }]);
  const second = round(s).filter((e) => e.change === "40");
  assert.equal(second.find((e) => e.type === "change.opened")!.sha, SHA.a);
  assert.deepEqual(
    second.filter((e) => e.type === "change.updated").map((e) => [e.sha, e.time, e.actor?.kind]),
    [
      [SHA.b, at(20), "agent"],
      [SHA.c, at(28), "person"],
    ],
  );
  assert.equal(second.find((e) => e.id === `${ID}review:ck1`)!.sha, SHA.a);
  assert.equal(second.find((e) => e.id === `${ID}review:r1`)!.sha, SHA.b);
  assert.ok(second.every((e) => e.data.inferred === undefined), "no head is inferred");
});

test("#44: a change that waits keeps its head among the watched commits", () => {
  const s = setup();
  change(s, [created], { head: { sha: SHA.a, at: at(9) } });
  s.host.checks(SHA.a, "pending");
  round(s);
  // A new head the list does not reach yet: the change waits, and the checks of the head before are still asked for.
  lagging(s, new Date(Date.now() - 60_000).toISOString());
  s.host.checks(SHA.a, "passed", at(30));
  const second = round(s);
  assert.deepEqual(second.map((e) => [e.type, e.sha]), [["checks.passed", SHA.a]]);
});

test("#44: a head the list does not reach five minutes after a round first found it missing: that head is inferred, and what was made before it stands on the heads the pushes give", async () => {
  const d = direct();
  // The list holds A, B and a later push D; the head now, C, it does not hold. The review at :25 comes before D.
  lagging(d, at(40), [created, { id: "p2", sha: SHA.b, at: at(20), by: agent }, { id: "p3", sha: SHA.d, at: at(27), by: agent }]);
  assert.deepEqual(await d.round(clock(0)), [], "the first round that finds the head missing waits, whatever the host's time");
  const events = await d.round(clock(5));
  assert.deepEqual(
    events.filter((e) => e.type === "change.updated").map((e) => [e.sha, e.time, e.data?.inferred, e.actor?.id]),
    [
      [SHA.b, at(20), undefined, "agent-bot"],
      [SHA.c, at(26), true, undefined],
      [SHA.d, at(27), undefined, "agent-bot"],
    ],
  );
  assert.equal(events.find((e) => e.id === `${ID}review:ck1`)!.sha, SHA.a);
  assert.equal(events.find((e) => e.id === `${ID}review:r1`)!.sha, SHA.b);
  d.close();
});

test("#44: an empty list, five minutes after a round first found it so: the old way, marked as inferred", async () => {
  const d = direct();
  change(d, [], { head: { sha: SHA.a, at: at(5) } });
  assert.deepEqual(await d.round(clock(0)), []);
  assert.equal((await d.round(clock(5))).find((e) => e.type === "change.opened")!.data?.inferred, true);
  d.close();
});

test("#44: a list of pushes the host refuses in two rounds running: written in the second with its heads inferred, and every round after warns with the count", async () => {
  const d = direct();
  change(d, undefined, { head: { sha: SHA.b, at: at(5) }, pushesRefused: true });
  assert.deepEqual(await d.round(clock(0)), [], "the first refusal is not believed");
  assert.match(d.said(), /change 40: the list of pushes was refused once; it is asked again in the next round/);
  const second = await d.round(clock(1));
  assert.equal(second.find((e) => e.type === "change.opened")!.data?.inferred, true);
  assert.match(d.said(), /the list of pushes cannot be read[^\n]*1 head written as inferred because of it since /);
  assert.deepEqual(await d.round(clock(2)), []);
  assert.match(d.said(), /the list of pushes cannot be read[^\n]*1 head written as inferred/, "the next round warns again");
  // The list can be read again: the warning stops.
  change(d, [], { head: { sha: SHA.b, at: at(5) }, updatedAt: at(40) });
  await d.round(clock(3));
  assert.doesNotMatch(d.said(), /cannot be read/);
  d.close();
});

test("#44: a refusal in one round and the list in the next: nothing in the first, which says so and holds the cursor; the change with its pushers in the second", async () => {
  const d = direct();
  change(d, undefined, { head: { sha: SHA.b, at: at(20) }, updatedAt: at(30), pushesRefused: true });
  // Another change, updated later: it is written, and the cursor must still not pass change 40.
  d.host.change({ number: 41, branch: "other", openedAt: at(5), openedBy: agent, head: { sha: SHA.d, at: at(5) }, tasks: [], reviews: [], updatedAt: at(50) });
  const first = await d.round(clock(0));
  assert.deepEqual(first.filter((e) => e.change === "40"), []);
  assert.ok(first.some((e) => e.change === "41"));
  assert.match(d.said(), /change 40: the list of pushes was refused once/);
  assert.ok(d.cursor().since <= at(30), `the cursor stays at the refused change: ${d.cursor().since}`);
  change(d, [created, { id: "p2", sha: SHA.b, at: at(20), by: agent }], { head: { sha: SHA.b, at: at(20) }, updatedAt: at(30) });
  const second = (await d.round(clock(1))).filter((e) => e.change === "40");
  assert.deepEqual(second.filter((e) => e.type === "change.updated").map((e) => [e.sha, e.actor?.id]), [[SHA.b, "agent-bot"]]);
  assert.ok(second.every((e) => e.data?.inferred === undefined), "no head is inferred");
  assert.doesNotMatch(d.said(), /cannot be read/);
  d.close();
});

test("#44: a round that reads the list between two refusals starts the count again", async () => {
  const d = direct();
  change(d, undefined, { head: { sha: SHA.a, at: at(9) }, pushesRefused: true });
  await d.round(clock(0));
  change(d, [created], { head: { sha: SHA.a, at: at(9) }, updatedAt: at(11) });
  assert.equal((await d.round(clock(1))).filter((e) => e.type === "change.opened").length, 1);
  // A new head, and the list refused again: the first refusal of a new count.
  change(d, undefined, { head: { sha: SHA.b, at: at(20) }, updatedAt: at(21), pushesRefused: true });
  assert.deepEqual(await d.round(clock(2)), []);
  assert.match(d.said(), /change 40: the list of pushes was refused once/);
  d.close();
});

for (const [name, offset] of [["the same as the host's", 0], ["ten minutes ahead of the host's", 10], ["ten minutes behind the host's", -10]] as const) {
  test(`#44: a change the host updates every two minutes while the list never reaches its head waits five minutes from the first round that found it, said each round; the machine's clock ${name}`, async () => {
    const d = direct();
    for (const minute of [0, 2, 4]) {
      // The host updates the change in every round: its time follows the machine's, shifted.
      lagging(d, new Date(clock(minute).getTime() - offset * 60_000).toISOString());
      assert.deepEqual(await d.round(clock(minute)), [], `minute ${minute}`);
      assert.match(d.said(), /waiting for the list of pushes to reach the head of change 40\b/, `minute ${minute}`);
    }
    lagging(d, new Date(clock(5).getTime() - offset * 60_000).toISOString());
    const events = await d.round(clock(5));
    assert.deepEqual(events.filter((e) => e.type === "change.updated" && e.data?.inferred === true).map((e) => e.sha), [SHA.c]);
    assert.doesNotMatch(d.said(), /waiting for the list/);
    d.close();
  });
}

test("#44: a change waited for, then reached, then missing a later head: the five minutes start anew", async () => {
  const d = direct();
  lagging(d, at(30));
  await d.round(clock(0));
  // The list reaches C.
  lagging(d, at(30), [created, { id: "p2", sha: SHA.b, at: at(20), by: agent }, { id: "p3", sha: SHA.c, at: at(28), by: agent }]);
  assert.ok((await d.round(clock(1))).some((e) => e.sha === SHA.c && e.type === "change.updated"));
  // A later head D the list does not hold: the count starts at minute 2.
  change(d, [created, { id: "p2", sha: SHA.b, at: at(20), by: agent }, { id: "p3", sha: SHA.c, at: at(28), by: agent }], { head: { sha: SHA.d, at: at(35) }, updatedAt: at(36) });
  assert.deepEqual(await d.round(clock(2)), []);
  assert.deepEqual(await d.round(clock(6)), [], "six minutes after the first wait, but four after this one");
  assert.deepEqual((await d.round(clock(7))).map((e) => [e.sha, e.data?.inferred]), [[SHA.d, true]]);
  d.close();
});

/** A head of its own for each round of a test: commits that are none of SHA's. */
const nth = (i: number) => (i + 1).toString(16).padStart(2, "0").repeat(20);
/** The push of `nth(i)`, a minute apart from minute 20. */
const pushOf = (i: number): Push => ({ id: `q${i}`, sha: nth(i), at: at(20 + i), by: agent });

test("#44: the wait is for one head: when the list holds it and a newer head is missing, the newer head waits from then, and is not inferred a minute later", async () => {
  const d = direct();
  lagging(d, at(30));
  assert.deepEqual(await d.round(clock(0)), [], "C is waited for");
  // Four minutes on, the list holds C; the head now is D, pushed a moment ago, which the list does not hold yet.
  const withC = [created, { id: "p2", sha: SHA.b, at: at(20), by: agent }, { id: "p3", sha: SHA.c, at: at(28), by: agent }];
  change(d, withC, { head: { sha: SHA.d, at: at(33) }, updatedAt: at(34) });
  assert.deepEqual(await d.round(clock(4)), [], "D is waited for from now");
  assert.deepEqual(await d.round(clock(5)), [], "five minutes after C was first missing, one after D was");
  assert.deepEqual(await d.round(clock(8)), []);
  assert.deepEqual((await d.round(clock(9))).filter((e) => e.data?.inferred === true).map((e) => e.sha), [SHA.d], "D, five minutes after it was first missing");
  d.close();
});

test("#44: an observer stopped while it waited and started an hour later: a head pushed just now is waited for; the same head still missing is inferred at once", async () => {
  const d = direct();
  lagging(d, at(30));
  await d.round(clock(0));
  d.restart();
  // An hour later the list holds C, and D was pushed a second ago.
  const withC = [created, { id: "p2", sha: SHA.b, at: at(20), by: agent }, { id: "p3", sha: SHA.c, at: at(28), by: agent }];
  change(d, withC, { head: { sha: SHA.d, at: at(33) }, updatedAt: at(34) });
  assert.deepEqual(await d.round(clock(60)), [], "D is waited for, not inferred at once");
  d.close();

  const e = direct();
  lagging(e, at(30));
  await e.round(clock(0));
  e.restart();
  // An hour later C is still missing.
  assert.deepEqual((await e.round(clock(60))).filter((x) => x.data?.inferred === true).map((x) => x.sha), [SHA.c]);
  e.close();
});

test("#44: a change with a new head in every round while the list is one round behind: no head is inferred, and the change is written whole when the pushing stops", async () => {
  const d = direct();
  for (let i = 0; i < 8; i++) {
    const pushes = [created, ...Array.from({ length: i }, (_, j) => pushOf(j))];
    change(d, pushes, { head: { sha: nth(i), at: at(20 + i) }, updatedAt: at(20 + i) });
    assert.deepEqual(await d.round(clock(i)), [], `round ${i}: the head of this round is waited for`);
  }
  change(d, [created, ...Array.from({ length: 8 }, (_, j) => pushOf(j))], { updatedAt: at(28) });
  const events = await d.round(clock(8));
  assert.deepEqual(events.filter((e) => e.type === "change.updated").map((e) => e.sha), Array.from({ length: 8 }, (_, j) => nth(j)));
  assert.ok(events.every((e) => e.data?.inferred === undefined), "no head is inferred");
  d.close();
});

test("#44: after an inferred head is written, and after a merge, the cursor holds no entry of the change", async () => {
  const d = direct();
  lagging(d, at(30));
  await d.round(clock(0));
  assert.ok((await d.round(clock(5))).some((e) => e.data?.inferred === true));
  assert.equal(d.cursor().waiting?.["40"], undefined, "the wait is over once the head is written");
  // Refused twice and written; then merged, still refused.
  change(d, undefined, { number: 41, branch: "other", head: { sha: SHA.d, at: at(5) }, updatedAt: at(41), pushesRefused: true });
  await d.round(clock(6));
  await d.round(clock(7));
  assert.equal(d.cursor().refusals?.["41"], 2);
  change(d, undefined, { number: 41, branch: "other", head: { sha: SHA.d, at: at(5) }, updatedAt: at(45), mergedAt: at(45), mergedBy: agent, closedAt: at(45), pushesRefused: true });
  assert.ok((await d.round(clock(8))).some((e) => e.type === "change.merged"));
  assert.equal(d.cursor().refusals?.["41"], undefined, "a change that has ended keeps no count");
  assert.equal(d.cursor().waiting?.["41"], undefined);
  d.close();
});

test("#44: with observe.json removed, the refusal's count says from when it counts, and claims nothing of before", async () => {
  const d = direct();
  change(d, undefined, { head: { sha: SHA.b, at: at(5) }, pushesRefused: true });
  await d.round(clock(0));
  await d.round(clock(1));
  rmSync(d.cursorPath);
  // Nothing is remembered: the refusal is asked again, and believed in the round after; its count starts there.
  await d.round(clock(2));
  await d.round(clock(3));
  assert.match(d.said(), new RegExp(`0 heads written as inferred because of it since ${clock(3).toISOString()}`));
  d.close();
});

test("#44: a cursor written before this round's memory is read as nothing remembered, and the count it held is kept", async () => {
  const d = direct();
  change(d, undefined, { head: { sha: SHA.b, at: at(5) }, pushesRefused: true });
  // observe.json as the howl of #130 wrote it: no waiting, no refusals, a count with no start.
  writeFileSync(d.cursorPath, JSON.stringify({ since: null, watch: [], trace: [], refused: { heads: 2 } }));
  assert.deepEqual(await d.round(clock(0)), [], "no refusal was remembered: this is the first");
  await d.round(clock(1));
  assert.match(d.said(), /3 heads written as inferred because of it since the cursor in observe\.json was made/);
  // What this howl writes keeps the fields the howl of #130 reads, in the same form.
  const cursor = d.cursor();
  assert.equal(typeof cursor.refused.heads, "number");
  assert.ok(Array.isArray(cursor.watch) && Array.isArray(cursor.trace));
  d.close();
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
