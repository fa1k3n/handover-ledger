// #47: the checks of a commit as they happened: each attempt, which check failed, and none.
// @code_class tests
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { events as ledgerEvents, openLedger, type LedgerEvent } from "../src/ledger/ledger.ts";
import { attemptsOf } from "../src/observe/attempts.ts";
import { LocalHost as LocalReader } from "../src/observe/local.ts";
import { Observer } from "../src/observe/observe.ts";
import { happensBefore } from "../src/observe/order.ts";
import { People } from "../src/observe/people.ts";
import type { Change, CheckRun } from "../src/observe/port.ts";
import { folder, howl, PROJECT, rawLines } from "./helpers.ts";
import { at, LocalHost, SHA } from "./local-host.ts";
import { m } from "./story.ts";

const agent = { login: "agent-bot" };
const lead = { login: "lead" };
const ID = "local:team/product:";
const DAY = 24 * 60 * 60_000;
/** The machine's clock in a test, on the host's own time line: `minutes` after midnight on 2026-01-01. */
const clock = (minutes: number) => new Date(Date.parse(at(0)) + minutes * 60_000);

interface Direct {
  host: LocalHost;
  ledger: string;
  cursorPath: string;
  /** A round at the machine's time `now`: the events it appended. */
  round(now: Date): Promise<LedgerEvent[]>;
  /** What the last round warned. */
  said(): string;
  cursor(): Record<string, any>;
  close(): void;
  /** The observer stopped and started again over the same ledger, cursor and host; `between` runs while it is stopped. */
  restart(between?: () => void): void;
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
      warn: (message) => warnings.push(message),
    });
    return { writer, observer };
  };
  let { writer, observer } = start();
  return {
    host,
    ledger,
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
    restart(between) {
      writer.close();
      between?.();
      ({ writer, observer } = start());
    },
  };
}

/** Change 7 with head `SHA.a` made at minute 0, open unless `over` says otherwise. */
function change(d: Direct, over: Partial<Change> = {}): void {
  d.host.change({
    number: 7,
    branch: "task-1-x",
    openedAt: at(0),
    openedBy: agent,
    head: { sha: SHA.a, at: at(0) },
    tasks: [],
    reviews: [],
    updatedAt: at(1),
    ...over,
  });
}

const merged = (minute: number): Partial<Change> => ({ mergedAt: at(minute), mergedBy: lead, closedAt: at(minute), updatedAt: at(minute) });
const checked = (events: LedgerEvent[]) => events.filter((e) => e.type.startsWith("checks."));
const summary = (events: LedgerEvent[]) => checked(events).map((e) => [e.type, e.id.slice(ID.length), (e.data as any).attempt, e.time]);

function showText(d: Direct, what = "change:7"): string {
  const run = howl(["show", what, "--utc", "--ledger", d.ledger]);
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

// ---- the attempts of a set of runs ----

const run = (name: string | undefined, result: CheckRun["result"], attempt: number, finished?: number): CheckRun => ({
  ...(name !== undefined ? { name } : {}),
  result,
  attempt,
  ...(finished !== undefined ? { at: at(finished) } : {}),
});

test("#47: no run is no attempt; one run with no name is one attempt, as the older file of the local host gives it", () => {
  assert.deepEqual(attemptsOf([]), []);
  assert.deepEqual(attemptsOf([run(undefined, "passed", 1, 5)]), [{ n: 1, state: "passed", at: at(5), failed: [] }]);
  assert.deepEqual(attemptsOf([run(undefined, "failed", 1, 5)]), [{ n: 1, state: "failed", at: at(5), failed: [] }]);
});

test("#47: a failed run run again is two attempts: the first failed, the second the verdict of the whole set", () => {
  const attempts = attemptsOf([run("lint", "failed", 1, 5), run("unit", "passed", 1, 6), run("lint", "passed", 2, 12)]);
  assert.deepEqual(attempts, [
    { n: 1, state: "failed", at: at(6), failed: ["lint"] },
    // The latest run of each name: the second of lint, the first of unit.
    { n: 2, state: "passed", at: at(12), failed: [] },
  ]);
});

test("#47: the checks that failed run again twice: three attempts, each of the latest run of each name", () => {
  const attempts = attemptsOf([
    run("lint", "failed", 1, 5),
    run("unit", "failed", 1, 6),
    run("lint", "passed", 2, 12),
    run("unit", "failed", 2, 13),
    run("unit", "passed", 3, 20),
  ]);
  assert.deepEqual(
    attempts.map((a) => [a.n, a.state, a.failed]),
    [
      [1, "failed", ["lint", "unit"]],
      [2, "failed", ["unit"]],
      [3, "passed", []],
    ],
  );
  assert.equal(attempts[2]!.at, at(20));
});

test("#47: an attempt is finished when every run in it is: a run going holds it, and the later attempts that hold the same run", () => {
  const going = attemptsOf([run("lint", "failed", 1, 5), run("unit", "pending", 1)]);
  assert.deepEqual(going, [{ n: 1, state: "pending", failed: ["lint"] }]);
  // unit is still going when lint is run again: the second attempt is made of it as well.
  const later = attemptsOf([run("lint", "failed", 1, 5), run("unit", "pending", 1), run("lint", "passed", 2, 9)]);
  assert.deepEqual(
    later.map((a) => [a.n, a.state]),
    [
      [1, "pending"],
      [2, "pending"],
    ],
  );
  // The first run of a name that has a second one that is going does not hold the second: it is not in it.
  const replaced = attemptsOf([run("lint", "failed", 1, 5), run("lint", "pending", 2)]);
  assert.deepEqual(
    replaced.map((a) => [a.n, a.state]),
    [
      [1, "failed"],
      [2, "pending"],
    ],
  );
});

test("#47: the names that failed are sorted and kept once, each cut to 200 characters, and nothing else of a run is kept", () => {
  const long = "x".repeat(300);
  const [a] = attemptsOf([run("zeta", "failed", 1, 5), run("alpha", "failed", 1, 5), run("alpha", "failed", 1, 6), run(long, "failed", 1, 5)]);
  assert.deepEqual(a!.failed, ["alpha", "x".repeat(200), "zeta"]);
  assert.deepEqual(Object.keys(a!).sort(), ["at", "failed", "n", "state"]);
});

// ---- the observer ----

test("#47: a commit whose checks fail and pass on a second attempt gives checks.failed and checks.passed, in order, and howl show lists both", async () => {
  const d = direct();
  change(d);
  d.host.runs(SHA.a, [
    { name: "static-analysis", result: "failed", at: at(5) },
    { name: "unit", result: "passed", at: at(6) },
  ]);
  const first = await d.round(clock(10));
  assert.deepEqual(summary(first), [["checks.failed", `checks:${SHA.a}`, 1, at(6)]]);
  assert.deepEqual((checked(first)[0]!.data as any).failed, ["static-analysis"]);
  assert.equal(first.find((e) => e.type === "change.opened")!.sha, SHA.a);
  assert.deepEqual(first.map((e) => e.type), ["change.opened", "checks.failed"]);

  // The failed check is run again, and passes: the change at the host is not updated.
  d.host.runs(SHA.a, [
    { name: "static-analysis", result: "failed", at: at(5) },
    { name: "unit", result: "passed", at: at(6) },
    { name: "static-analysis", result: "passed", at: at(12) },
  ]);
  const second = await d.round(clock(15));
  assert.deepEqual(summary(second), [["checks.passed", `checks:${SHA.a}:2`, 2, at(12)]]);
  assert.equal((checked(second)[0]!.data as any).failed, undefined);
  assert.equal(checked(second)[0]!.sha, SHA.a);
  assert.equal(checked(second)[0]!.change, "7");

  const text = showText(d);
  assert.match(text, /checks, attempt 1: failed at \S+ \(static-analysis\)/);
  assert.match(text, /checks, attempt 2: passed at \S+/);
  assert.ok(text.indexOf("attempt 1") < text.indexOf("attempt 2"));
  const json = JSON.parse(howl(["show", "change:7", "--json", "--ledger", d.ledger]).stdout);
  assert.deepEqual(
    json.changes[0].heads[0].attempts.map((a: any) => [a.n, a.result, a.failed]),
    [
      [1, "failed", ["static-analysis"]],
      [2, "passed", undefined],
    ],
  );
  assert.equal(json.changes[0].heads[0].checks, "passed");
  d.close();
});

test("#47: a failed attempt names the checks that failed and nothing of their output", async () => {
  const d = direct();
  change(d);
  const secret = "SECRET-OUTPUT token=abc123 /home/someone/key";
  d.host.runs(SHA.a, [
    { name: "static-analysis", result: "failed", at: at(5), output: { title: secret, summary: secret, text: secret }, url: `https://example.test/${secret}`, details: secret },
    { name: "unit", result: "passed", at: at(6), output: { text: secret } },
  ]);
  const events = checked(await d.round(clock(10)));
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]!.data!).sort(), ["attempt", "failed", "seen"]);
  assert.deepEqual((events[0]!.data as any).failed, ["static-analysis"]);
  const text = readFileSync(d.ledger, "utf8");
  assert.ok(!text.includes("SECRET") && !text.includes("abc123") && !text.includes("example.test"), "the ledger holds no output, link or text of a check");
  assert.ok(!showText(d).includes("SECRET"));
  d.close();
});

test("#47: a merged change whose head never had checks gives checks.none, with the time of the merge, once", async () => {
  const d = direct();
  change(d, merged(30));
  const first = await d.round(clock(40));
  assert.deepEqual(first.map((e) => e.type), ["change.opened", "checks.none", "change.merged"]);
  const none = first.find((e) => e.type === "checks.none")!;
  assert.equal(none.id, `${ID}checks:${SHA.a}:none`);
  assert.equal(none.time, at(30));
  assert.equal(none.sha, SHA.a);
  assert.equal(none.change, "7");
  assert.equal(none.source.kind, "observed");
  assert.deepEqual(d.cursor().watch, [], "the head is let go");
  assert.deepEqual(await d.round(clock(41)), []);
  d.restart();
  assert.deepEqual(await d.round(clock(42)), []);
  assert.match(showText(d), /no checks/);
  d.close();
});

test("#47: a change closed without a merge gives checks.none as well", async () => {
  const d = direct();
  change(d, { closedAt: at(20), closedBy: lead, updatedAt: at(20) });
  const events = await d.round(clock(40));
  assert.deepEqual(events.map((e) => e.type), ["change.opened", "checks.none", "change.closed"]);
  assert.equal(events.find((e) => e.type === "checks.none")!.time, at(20));
  d.close();
});

test("#47: a commit that has not got its checks yet is not given checks.none: its head is asked about until five minutes have passed", async () => {
  const d = direct();
  change(d, { head: { sha: SHA.a, at: at(28) }, ...merged(30) });
  const early = await d.round(clock(32));
  assert.deepEqual(early.map((e) => e.type), ["change.opened", "change.merged"], "two minutes after the merge: not yet");
  assert.equal(d.cursor().watch.length, 1, "and the head is watched");
  // The checks come, after the merge.
  d.host.runs(SHA.a, [{ name: "unit", result: "passed", at: at(33) }]);
  const later = await d.round(clock(36));
  assert.deepEqual(summary(later), [["checks.passed", `checks:${SHA.a}`, 1, at(33)]]);
  assert.deepEqual(d.cursor().watch, []);
  d.close();
});

test("#47: a head the host still shows no checks for five minutes after the merge gets checks.none then, and not before", async () => {
  const d = direct();
  change(d, { head: { sha: SHA.a, at: at(28) }, ...merged(30) });
  await d.round(clock(32));
  assert.deepEqual(checked(await d.round(clock(34))), []);
  const events = await d.round(clock(36));
  assert.deepEqual(summary(events), [["checks.none", `checks:${SHA.a}:none`, undefined, at(30)]]);
  d.close();
});

test("#47: a round that reads the same attempts again writes nothing, also with the cursor gone and the observer restarted", async () => {
  const d = direct();
  change(d);
  d.host.runs(SHA.a, [
    { name: "lint", result: "failed", at: at(5) },
    { name: "lint", result: "passed", at: at(9) },
  ]);
  const first = await d.round(clock(10));
  assert.deepEqual(first.map((e) => e.type), ["change.opened", "checks.failed", "checks.passed"], "both attempts are finished: both are written, in order");
  assert.deepEqual(await d.round(clock(11)), []);
  d.restart();
  assert.deepEqual(await d.round(clock(12)), []);
  writeFileSync(d.cursorPath, "{}");
  assert.deepEqual(await d.round(clock(13)), []);
  d.close();
});

test("#47: when only the checks that failed are run again, the second attempt is the verdict of the whole set", async () => {
  const d = direct();
  change(d);
  d.host.runs(SHA.a, [
    { name: "lint", result: "failed", at: at(5) },
    { name: "unit", result: "failed", at: at(6) },
    { name: "lint", result: "passed", at: at(12) },
    { name: "unit", result: "failed", at: at(14) },
  ]);
  const events = checked(await d.round(clock(20)));
  assert.deepEqual(
    events.map((e) => [e.type, (e.data as any).attempt, (e.data as any).failed]),
    [
      ["checks.failed", 1, ["lint", "unit"]],
      ["checks.failed", 2, ["unit"]],
    ],
  );
  d.close();
});

test("#47: an attempt is written when every run in it has finished, with the time of the last", async () => {
  const d = direct();
  change(d);
  d.host.runs(SHA.a, [
    { name: "lint", result: "failed", at: at(5) },
    { name: "unit", result: "pending" },
  ]);
  assert.deepEqual(checked(await d.round(clock(10))), []);
  d.host.runs(SHA.a, [
    { name: "lint", result: "failed", at: at(5) },
    { name: "unit", result: "passed", at: at(14) },
  ]);
  assert.deepEqual(summary(await d.round(clock(15))), [["checks.failed", `checks:${SHA.a}`, 1, at(14)]]);
  d.close();
});

test("#47: a first attempt of the older file of the local host keeps its id, its time and a check with no name", async () => {
  const d = direct();
  change(d);
  d.host.checks(SHA.a, "failed", at(5));
  const events = checked(await d.round(clock(10)));
  assert.deepEqual(summary(events), [["checks.failed", `checks:${SHA.a}`, 1, at(5)]]);
  assert.deepEqual((events[0]!.data as any).failed, []);
  d.host.checks(SHA.a, "pending");
  d.close();
});

test("#47: a ledger of before, with one checks event of the id it had, is not written to again for that attempt", async () => {
  const d = direct();
  d.restart(() => {
    const writer = openLedger(d.ledger, { project: PROJECT });
    const base = { v: 0 as const, source: { adapter: "local", kind: "observed" as const }, project: PROJECT, repo: "team/product", change: "7", branch: "task-1-x", sha: SHA.a };
    writer.append({ ...base, id: `${ID}change:7:opened`, time: at(0), type: "change.opened", actor: { kind: "agent", id: "agent-bot" }, data: { seen: at(1) } });
    writer.append({ ...base, id: `${ID}checks:${SHA.a}`, time: at(5), type: "checks.failed", data: { seen: at(6) } });
    writer.close();
  });
  change(d);
  d.host.runs(SHA.a, [{ name: "lint", result: "failed", at: at(5) }]);
  assert.deepEqual(checked(await d.round(clock(10))), [], "its first attempt is in the ledger");
  d.host.runs(SHA.a, [
    { name: "lint", result: "failed", at: at(5) },
    { name: "lint", result: "passed", at: at(12) },
  ]);
  assert.deepEqual(summary(await d.round(clock(15))), [["checks.passed", `checks:${SHA.a}:2`, 2, at(12)]], "a second attempt is new");
  // The older form of the file: one verdict, the attempt the ledger holds.
  d.host.checks(SHA.a, "failed", at(5));
  assert.deepEqual(await d.round(clock(16)), []);
  d.close();
});

test("#47: a ledger of before, a commit with one checks event, a merged change: nothing is written for its first attempt", async () => {
  const d = direct();
  d.restart(() => {
    const writer = openLedger(d.ledger, { project: PROJECT });
    writer.append({ v: 0, id: `${ID}checks:${SHA.a}`, time: at(5), type: "checks.passed", source: { adapter: "local", kind: "observed" }, project: PROJECT, repo: "team/product", change: "7", sha: SHA.a, data: { seen: at(6) } });
    writer.close();
  });
  change(d, merged(30));
  d.host.runs(SHA.a, [{ name: "unit", result: "passed", at: at(5) }]);
  assert.deepEqual(checked(await d.round(clock(40))), []);
  d.close();
});

test("#47: an open change is watched after a verdict: a second attempt days later is found, and a head quiet for seven days is let go", async () => {
  const d = direct();
  change(d);
  d.host.runs(SHA.a, [{ name: "lint", result: "passed", at: at(5) }]);
  assert.deepEqual(summary(await d.round(clock(10))), [["checks.passed", `checks:${SHA.a}`, 1, at(5)]]);
  // Another change, updated later, so that change 7 is not read again with every round.
  d.host.change({ number: 8, branch: "other", openedAt: at(20), openedBy: agent, head: { sha: SHA.b, at: at(20) }, tasks: [], reviews: [], updatedAt: at(20) });
  await d.round(clock(21));
  assert.ok(d.cursor().watch.some((w: any) => w.sha === SHA.a), "the verdict does not end the watch of an open change");
  d.host.runs(SHA.a, [
    { name: "lint", result: "passed", at: at(5) },
    { name: "lint", result: "failed", at: at(3 * 24 * 60) },
  ]);
  const days = await d.round(new Date(Date.parse(at(0)) + 3 * DAY + 60_000));
  assert.deepEqual(summary(days), [["checks.failed", `checks:${SHA.a}:2`, 2, at(3 * 24 * 60)]]);
  // Seven days after the last finish: let go.
  await d.round(new Date(Date.parse(at(0)) + 11 * DAY));
  assert.ok(!d.cursor().watch.some((w: any) => w.sha === SHA.a), "quiet for seven days: not asked about for ever");
  d.host.runs(SHA.a, [
    { name: "lint", result: "passed", at: at(5) },
    { name: "lint", result: "failed", at: at(3 * 24 * 60) },
    { name: "lint", result: "passed", at: at(12 * 24 * 60) },
  ]);
  assert.deepEqual(checked(await d.round(new Date(Date.parse(at(0)) + 12 * DAY + 60_000))), [], "not asked about: the change was not updated");
  // The change is updated at the host: its head is watched again.
  d.host.change({ number: 7, branch: "task-1-x", openedAt: at(0), openedBy: agent, head: { sha: SHA.a, at: at(0) }, tasks: [], reviews: [], updatedAt: at(12 * 24 * 60 + 2) });
  assert.deepEqual(summary(await d.round(new Date(Date.parse(at(0)) + 12 * DAY + 2 * 60_000))), [["checks.passed", `checks:${SHA.a}:3`, 3, at(12 * 24 * 60)]]);
  d.close();
});

test("#47: a head with no checks yet on an open change is asked about, and let go seven days after its time", async () => {
  const d = direct();
  change(d);
  d.host.change({ number: 8, branch: "other", openedAt: at(20), openedBy: agent, head: { sha: SHA.b, at: at(20) }, tasks: [], reviews: [], updatedAt: at(20) });
  await d.round(clock(21));
  assert.deepEqual(checked(await d.round(clock(60))), []);
  assert.ok(d.cursor().watch.some((w: any) => w.sha === SHA.a));
  d.host.runs(SHA.a, [{ name: "lint", result: "passed", at: at(90) }]);
  assert.deepEqual(summary(await d.round(clock(100))), [["checks.passed", `checks:${SHA.a}`, 1, at(90)]]);
  d.close();
});

test("#47: runs still going when the change is merged are written when they finish, with their own time, after the merge", async () => {
  const d = direct();
  change(d, merged(30));
  d.host.runs(SHA.a, [
    { name: "lint", result: "passed", at: at(5) },
    { name: "slow", result: "pending" },
  ]);
  const first = await d.round(clock(40));
  assert.deepEqual(first.map((e) => e.type), ["change.opened", "change.merged"]);
  assert.equal(d.cursor().watch.length, 1, "asked about again: the change is no excuse for silence");
  assert.deepEqual(await d.round(clock(50)), []);
  d.host.runs(SHA.a, [
    { name: "lint", result: "passed", at: at(5) },
    { name: "slow", result: "failed", at: at(70) },
  ]);
  const late = await d.round(clock(80));
  assert.deepEqual(summary(late), [["checks.failed", `checks:${SHA.a}`, 1, at(70)]]);
  assert.deepEqual((late[0]!.data as any).failed, ["slow"]);
  assert.deepEqual(d.cursor().watch, []);
  d.close();
});

test("#47: runs that are still going seven days after the change ended are let go, and the round says so once", async () => {
  const d = direct();
  change(d, merged(30));
  d.host.runs(SHA.a, [{ name: "slow", result: "pending" }]);
  await d.round(clock(40));
  assert.equal(d.said(), "");
  const over = await d.round(new Date(Date.parse(at(30)) + 7 * DAY + 60_000));
  assert.deepEqual(over, []);
  assert.match(d.said(), new RegExp(`${SHA.a.slice(0, 7)}.*change 7.*still running`));
  assert.deepEqual(d.cursor().watch, []);
  await d.round(new Date(Date.parse(at(30)) + 8 * DAY));
  assert.equal(d.said(), "", "once");
  d.close();
});

test("#47: a closed change that is opened again watches its head again: checks that come then are written", async () => {
  const d = direct();
  change(d, { closedAt: at(10), closedBy: lead, updatedAt: at(10) });
  const first = await d.round(clock(30));
  assert.deepEqual(summary(first), [["checks.none", `checks:${SHA.a}:none`, undefined, at(10)]]);
  change(d, { reopenings: [{ id: "r1", by: lead, at: at(40) }], updatedAt: at(40) });
  d.host.runs(SHA.a, [{ name: "lint", result: "passed", at: at(50) }]);
  const second = await d.round(clock(60));
  assert.deepEqual(summary(second), [["checks.passed", `checks:${SHA.a}`, 1, at(50)]]);
  d.close();
});

test("#47: a failing call for the checks warns, and the next round brings what was missed", async () => {
  const d = direct();
  change(d);
  d.host.runs(SHA.a, [{ name: "lint", result: "failed", at: at(5) }]).fail(`checks ${SHA.a}`);
  const first = await d.round(clock(10));
  assert.deepEqual(first.map((e) => e.type), ["change.opened"]);
  assert.match(d.said(), /checks/);
  d.host.fail();
  assert.deepEqual(summary(await d.round(clock(11))), [["checks.failed", `checks:${SHA.a}`, 1, at(5)]]);
  d.close();
});

// ---- the readers ----

/** A ledger of one change with the given events at the given minutes. */
function ledgerOf(events: [string, number, Record<string, unknown>?][]): string {
  const path = join(folder(), "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  const of = { change: "40", branch: "b", sha: SHA.a, task: "20" };
  let n = 0;
  writer.append({ v: 0, id: "t", time: m(0), type: "task.opened", source: { adapter: "local", kind: "observed" }, project: PROJECT, task: "20" });
  for (const [type, minute, data] of events) {
    n++;
    writer.append({ v: 0, id: `e${n}`, time: m(minute), type: type as LedgerEvent["type"], source: { adapter: "local", kind: "observed" }, project: PROJECT, ...of, ...(data ? { data } : {}) });
  }
  writer.close();
  return path;
}

function parts(path: string): Record<string, number> {
  const out = howl(["show", "20", "--json", "--ledger", path]);
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout).summary.parts;
}

test("#47: the summary waits for checks until the last attempt: a failed attempt that is followed by another leaves it waiting", () => {
  const path = ledgerOf([
    ["change.opened", 10],
    ["checks.failed", 15, { attempt: 1, failed: ["lint"] }],
    ["checks.passed", 25, { attempt: 2 }],
    ["change.merged", 40],
  ]);
  assert.deepEqual(parts(path), { work: 0, person: 0, instructions: 0, checks: 900, review: 900, unknown: 0 });
});

test("#47: the last attempt ends the wait for checks: when it failed the change waits for nothing", () => {
  const path = ledgerOf([
    ["change.opened", 10],
    ["checks.failed", 15, { attempt: 1, failed: ["lint"] }],
    ["checks.failed", 25, { attempt: 2, failed: ["lint"] }],
    ["change.merged", 40],
  ]);
  assert.deepEqual(parts(path), { work: 0, person: 0, instructions: 0, checks: 900, review: 0, unknown: 900 });
});

test("#47: a head with one failed attempt waits for nothing after it, as before; an attempt with no number is the first", () => {
  const path = ledgerOf([
    ["change.opened", 10],
    ["checks.failed", 15],
    ["change.merged", 40],
  ]);
  assert.deepEqual(parts(path), { work: 0, person: 0, instructions: 0, checks: 300, review: 0, unknown: 1500 });
});

test("#47: a head that has checks.none waits for its review, not for checks", () => {
  const path = ledgerOf([
    ["change.opened", 10],
    ["checks.none", 40],
    ["change.merged", 40],
  ]);
  assert.deepEqual(parts(path), { work: 0, person: 0, instructions: 0, checks: 0, review: 1800, unknown: 0 });
});

test("#47: howl show reads a head's attempts, and a head with one attempt as before", () => {
  const path = ledgerOf([
    ["change.opened", 10],
    ["checks.failed", 15, { attempt: 1, failed: ["lint", "unit"] }],
    ["checks.passed", 25, { attempt: 2 }],
    ["change.merged", 40],
  ]);
  const text = howl(["show", "20", "--utc", "--ledger", path]).stdout;
  assert.match(text, /head aaaaaaa\n/);
  assert.match(text, /checks, attempt 1: failed at 2026-01-01T08:15:00Z \(lint, unit\)/);
  assert.match(text, /checks, attempt 2: passed at 2026-01-01T08:25:00Z/);
  const one = howl(["show", "20", "--utc", "--ledger", ledgerOf([["change.opened", 10], ["checks.failed", 15, { attempt: 1, failed: ["lint"] }]])]).stdout;
  assert.match(one, /head aaaaaaa, checks failed at 2026-01-01T08:15:00Z \(lint\)\n/);
  const old = howl(["show", "20", "--utc", "--ledger", ledgerOf([["change.opened", 10], ["checks.passed", 15]])]).stdout;
  assert.match(old, /head aaaaaaa, checks passed at 2026-01-01T08:15:00Z\n/);
});

test("#47: in one moment checks.none comes with the checks of a head: after the head, before the review and the merge", () => {
  const e = (type: string, id: string) => ({ type, time: at(1), id });
  const sorted = [e("change.merged", "m"), e("checks.none", "n"), e("review.approved", "r"), e("trace.read", "t"), e("change.updated", "u")].sort(happensBefore).map((x) => x.id);
  assert.deepEqual(sorted, ["u", "t", "n", "r", "m"]);
  const same = [e("checks.passed", "checks:b:2"), e("checks.failed", "checks:b")].sort(happensBefore).map((x) => x.id);
  assert.deepEqual(same, ["checks:b", "checks:b:2"], "two attempts of one moment come in the order of their attempts");
});

test("#47: the view of one change and a bundle show the attempts of their own change's heads, as the task's view does", async () => {
  const { buildBundle } = await import("../src/export/export.ts");
  const path = join(folder(), "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  let n = 0;
  const observed = (type: LedgerEvent["type"], minute: number, change: string, sha: string, data?: Record<string, unknown>) =>
    writer.append({ v: 0, id: `e${++n}`, time: m(minute), type, source: { adapter: "local", kind: "observed" }, project: PROJECT, task: "20", change, branch: "b", sha, ...(data ? { data } : {}) });
  observed("change.opened", 10, "40", SHA.a);
  observed("checks.failed", 15, "40", SHA.a, { attempt: 1, failed: ["lint"] });
  observed("checks.passed", 25, "40", SHA.a, { attempt: 2 });
  observed("change.merged", 30, "40", SHA.a);
  observed("change.opened", 50, "41", SHA.b);
  observed("checks.none", 70, "41", SHA.b);
  observed("change.merged", 70, "41", SHA.b);
  writer.close();
  const heads = (shown: { changes: { change: string; heads: { checks?: string; attempts?: { n: number; result: string }[] }[] }[] }, change: string) =>
    shown.changes.find((c) => c.change === change)!.heads.map((h) => [h.checks, h.attempts?.map((a) => `${a.n}:${a.result}`)]);
  const one = JSON.parse(howl(["show", "change:40", "--json", "--ledger", path]).stdout);
  assert.equal(one.changes.length, 1);
  assert.deepEqual(heads(one, "40"), [["passed", ["1:failed", "2:passed"]]]);
  const bundle = buildBundle(path, { kind: "task", id: "20" }, { version: "test" });
  const timeline = JSON.parse(bundle.get("timeline.json")!.toString());
  assert.deepEqual(heads(timeline, "40"), [["passed", ["1:failed", "2:passed"]]]);
  assert.deepEqual(heads(timeline, "41"), [["none", undefined]]);
  const selected = JSON.parse(bundle.get("selection.json")!.toString()).lines as number[];
  const types = rawLines(path).filter((_, i) => selected.includes(i + 1)).map((l) => (JSON.parse(l) as { event: LedgerEvent }).event.type);
  assert.equal(types.filter((t) => t.startsWith("checks.")).length, 3, "every attempt and the word of none is selected");
});
