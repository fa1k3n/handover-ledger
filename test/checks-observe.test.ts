// #47: the checks of a commit as they happened: each change of the result, which check failed, and none.
// @code_class tests
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LedgerError } from "../src/ledger/errors.ts";
import { events as ledgerEvents, openLedger, type LedgerEvent } from "../src/ledger/ledger.ts";
import { LocalHost as LocalReader } from "../src/observe/local.ts";
import { Observer } from "../src/observe/observe.ts";
import { happensBefore } from "../src/observe/order.ts";
import { People } from "../src/observe/people.ts";
import type { Change, ChecksState, CodeHost } from "../src/observe/port.ts";
import { folder, howl, PROJECT, rawLines } from "./helpers.ts";
import { at, LocalHost, SHA } from "./local-host.ts";
import { m } from "./story.ts";

const agent = { login: "agent-bot" };
const lead = { login: "lead" };
const ID = "local:team/product:";
const MIN = 60_000;
/** The machine's clock in a test, on the host's own time line: `minutes` after midnight on 2026-01-01. */
const clock = (minutes: number) => new Date(Date.parse(at(0)) + minutes * MIN);

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

interface DirectOptions {
  /** Wraps the host, as a test that counts its calls does. */
  wrap?: (host: CodeHost) => CodeHost;
  /** Events the writer refuses, as one the schema would not take. */
  refuse?: (event: LedgerEvent) => boolean;
}

/** An observer run directly, so that each round is given the machine's time. */
function direct(options: DirectOptions = {}): Direct {
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
    const guarded = {
      ...writer,
      append(event: LedgerEvent) {
        if (options.refuse?.(event)) throw new LedgerError(`${event.id}: refused, as the test asks`);
        return writer.append(event);
      },
    };
    const reader = new LocalReader(hostDir, "team/product");
    const observer = new Observer({
      host: options.wrap ? options.wrap(reader) : reader,
      writer: guarded,
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
/** Type, the id after the repository's, and time of each checks event. */
const summary = (events: LedgerEvent[]) => checked(events).map((e) => [e.type, e.id.slice(ID.length), e.time]);

/** A run for the local host: `started` and `finished` are minutes; no `finished` is a run going. */
const run = (id: string, name: string, result: "passed" | "failed" | "pending", started: number, finished?: number, suite = "s1") => ({
  id,
  name,
  suite,
  result,
  started: at(started),
  ...(finished !== undefined ? { at: at(finished) } : {}),
});

function showText(d: Direct, what = "change:7"): string {
  const out = howl(["show", what, "--utc", "--ledger", d.ledger]);
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}

function showJson(path: string, what: string): any {
  const out = howl(["show", what, "--json", "--ledger", path]);
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

// ---- what is written ----

test("#47: one check that fails and then passes on a second run gives checks.failed and checks.passed, in order, and howl show lists both", async () => {
  const d = direct();
  change(d);
  d.host.runs(SHA.a, [run("c1", "static-analysis", "failed", 1, 5)]);
  const first = await d.round(clock(10));
  assert.deepEqual(first.map((e) => e.type), ["change.opened", "checks.failed"]);
  assert.deepEqual(summary(first), [["checks.failed", `checks:${SHA.a}`, at(5)]]);
  assert.deepEqual(checked(first)[0]!.data, { failed: ["static-analysis"], seen: clock(10).toISOString() });

  // The check is run again, and passes: the change at the host is not updated.
  d.host.runs(SHA.a, [run("c1", "static-analysis", "failed", 1, 5), run("c2", "static-analysis", "passed", 8, 12)]);
  const second = await d.round(clock(15));
  assert.deepEqual(summary(second), [["checks.passed", `checks:${SHA.a}:c2`, at(12)]]);
  assert.deepEqual(Object.keys(checked(second)[0]!.data!), ["seen"], "no number of an attempt, and nothing that failed");
  assert.equal(checked(second)[0]!.sha, SHA.a);
  assert.equal(checked(second)[0]!.change, "7");

  const text = showText(d);
  assert.match(text, /checks, result 1: failed at \S+ \(static-analysis\)/);
  assert.match(text, /checks, result 2: passed at \S+/);
  assert.ok(text.indexOf("result 1") < text.indexOf("result 2"));
  const json = showJson(d.ledger, "change:7");
  assert.deepEqual(
    json.changes[0].heads[0].results.map((r: any) => [r.n, r.result, r.failed]),
    [
      [1, "failed", ["static-analysis"]],
      [2, "passed", undefined],
    ],
  );
  assert.equal(json.changes[0].heads[0].checks, "passed");
  d.close();
});

test("#47: both runs there before the first round: the same two events, with the same ids and times", async () => {
  const d = direct();
  change(d);
  d.host.runs(SHA.a, [run("c1", "static-analysis", "failed", 1, 5), run("c2", "static-analysis", "passed", 8, 12)]);
  const events = await d.round(clock(15));
  assert.deepEqual(summary(events), [
    ["checks.failed", `checks:${SHA.a}`, at(5)],
    ["checks.passed", `checks:${SHA.a}:c2`, at(12)],
  ]);
  d.close();
});

test("#47: a failed result names the checks that failed and nothing of their output", async () => {
  const d = direct();
  change(d);
  const secret = "SECRET-OUTPUT token=abc123 /home/someone/key";
  d.host.runs(SHA.a, [
    { ...run("c1", "static-analysis", "failed", 1, 5), output: { title: secret, summary: secret, text: secret }, url: `https://example.test/${secret}`, details: secret },
    { ...run("c2", "unit", "passed", 1, 6), output: { text: secret } },
  ]);
  const events = checked(await d.round(clock(10)));
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]!.data!).sort(), ["failed", "seen"]);
  assert.deepEqual((events[0]!.data as any).failed, ["static-analysis"]);
  const text = readFileSync(d.ledger, "utf8");
  assert.ok(!text.includes("SECRET") && !text.includes("abc123") && !text.includes("example.test"), "the ledger holds no output, link or text of a check");
  assert.ok(!showText(d).includes("SECRET"));
  d.close();
});

test("#47: A and B fail, A is run again and passes, a round reads, B is run again and passes: three events, and the commit reads as passed", async () => {
  const d = direct();
  change(d);
  d.host.runs(SHA.a, [run("a1", "A", "failed", 1, 5), run("b1", "B", "failed", 1, 6)]);
  const first = await d.round(clock(10));
  assert.deepEqual(first.map((e) => [e.type, (e.data as any).failed]).filter((x) => x[0] !== "change.opened"), [["checks.failed", ["A", "B"]]]);
  d.host.runs(SHA.a, [run("a1", "A", "failed", 1, 5), run("b1", "B", "failed", 1, 6), run("a2", "A", "passed", 8, 12)]);
  const second = await d.round(clock(15));
  assert.deepEqual(checked(second).map((e) => [e.type, (e.data as any).failed]), [["checks.failed", ["B"]]]);
  d.host.runs(SHA.a, [run("a1", "A", "failed", 1, 5), run("b1", "B", "failed", 1, 6), run("a2", "A", "passed", 8, 12), run("b2", "B", "passed", 14, 20)]);
  const third = await d.round(clock(25));
  assert.deepEqual(summary(third), [["checks.passed", `checks:${SHA.a}:b2`, at(20)]]);
  const head = showJson(d.ledger, "change:7").changes[0].heads[0];
  assert.equal(head.checks, "passed");
  assert.deepEqual(head.results.map((r: any) => [r.result, r.failed]), [["failed", ["A", "B"]], ["failed", ["B"]], ["passed", undefined]]);
  d.close();
});

test("#47: the same three events when one round reads all four runs at once", async () => {
  const d = direct();
  change(d);
  d.host.runs(SHA.a, [run("a1", "A", "failed", 1, 5), run("b1", "B", "failed", 1, 6), run("a2", "A", "passed", 8, 12), run("b2", "B", "passed", 14, 20)]);
  const events = await d.round(clock(25));
  assert.deepEqual(checked(events).map((e) => [e.type, (e.data as any).failed, e.time]), [
    ["checks.failed", ["A", "B"], at(6)],
    ["checks.failed", ["B"], at(12)],
    ["checks.passed", undefined, at(20)],
  ]);
  d.close();
});

test("#47: two runs named alike in two suites, one failed and one passed, neither run again: one event, failed, and the commit never reads as passed", async () => {
  const d = direct();
  change(d);
  d.host.runs(SHA.a, [run("r1", "build", "failed", 1, 5, "suite-1"), run("r2", "build", "passed", 2, 6, "suite-2")]);
  const events = checked(await d.round(clock(10)));
  assert.deepEqual(events.map((e) => [e.type, (e.data as any).failed]), [["checks.failed", ["build"]]]);
  const head = showJson(d.ledger, "change:7").changes[0].heads[0];
  assert.equal(head.checks, "failed");
  assert.equal(head.results.length, 1);
  assert.ok(!showText(d).includes("then passed"));
  d.close();
});

test("#47: the host's own list of the latest runs says otherwise than the result worked out: the host's is written, and the event says so", async () => {
  const d = direct();
  change(d);
  // Worked out: the second run passed, so the commit passed. The host's list of the latest runs holds the first.
  d.host.runs(SHA.a, [run("r1", "lint", "failed", 1, 5), run("r2", "lint", "passed", 8, 12)], ["r1"]);
  const events = checked(await d.round(clock(20)));
  assert.deepEqual(events.map((e) => [e.type, (e.data as any).failed, (e.data as any).changes_untold]), [["checks.failed", ["lint"], true]]);
  assert.equal(events[0]!.time, at(5));
  // Where they agree nothing is marked.
  const agree = direct();
  change(agree);
  agree.host.runs(SHA.a, [run("r1", "lint", "failed", 1, 5), run("r2", "lint", "passed", 8, 12)], ["r2"]);
  const same = checked(await agree.round(clock(20)));
  assert.deepEqual(same.map((e) => [e.type, (e.data as any).changes_untold]), [["checks.failed", undefined], ["checks.passed", undefined]]);
  d.close();
  agree.close();
});

test("#47: a round that reads the same runs again writes nothing, also with the cursor removed and the observer restarted", async () => {
  const d = direct();
  change(d);
  d.host.runs(SHA.a, [run("a1", "A", "failed", 1, 5), run("a2", "A", "passed", 8, 12)]);
  assert.equal(checked(await d.round(clock(20))).length, 2);
  assert.deepEqual(await d.round(clock(21)), []);
  d.restart();
  assert.deepEqual(await d.round(clock(22)), []);
  writeFileSync(d.cursorPath, "{}");
  assert.deepEqual(await d.round(clock(23)), []);
  d.close();
});

test("#47: the older file of the local host, one verdict with no name, is one result with the id a commit's checks have had", async () => {
  const d = direct();
  change(d);
  d.host.checks(SHA.a, "failed", at(5));
  const events = checked(await d.round(clock(10)));
  assert.deepEqual(summary(events), [["checks.failed", `checks:${SHA.a}`, at(5)]]);
  assert.deepEqual((events[0]!.data as any).failed, []);
  d.close();
});

test("#47: a ledger of before, whose one event for a commit says passed, where the host lists a failed run before the passed one: nothing is written", async () => {
  const d = direct();
  d.restart(() => {
    const writer = openLedger(d.ledger, { project: PROJECT });
    const base = { v: 0 as const, source: { adapter: "local", kind: "observed" as const }, project: PROJECT, repo: "team/product", change: "7", branch: "task-1-x", sha: SHA.a };
    writer.append({ ...base, id: `${ID}change:7:opened`, time: at(0), type: "change.opened", actor: { kind: "agent", id: "agent-bot" }, data: { seen: at(1) } });
    writer.append({ ...base, id: `${ID}checks:${SHA.a}`, time: at(12), type: "checks.passed", data: { seen: at(13) } });
    writer.close();
  });
  change(d);
  d.host.runs(SHA.a, [run("r1", "lint", "failed", 1, 5), run("r2", "lint", "passed", 8, 12)]);
  assert.deepEqual(checked(await d.round(clock(20))), [], "nothing is put in front of the event that is there");
  // A run after that event that changes the result: one event.
  d.host.runs(SHA.a, [run("r1", "lint", "failed", 1, 5), run("r2", "lint", "passed", 8, 12), run("r3", "lint", "failed", 30, 33)]);
  const later = await d.round(clock(40));
  assert.deepEqual(summary(later), [["checks.failed", `checks:${SHA.a}:r3`, at(33)]]);
  assert.deepEqual(await d.round(clock(41)), []);
  d.close();
});

test("#47: a ledger of before whose ids hold the repository's name: nothing is written for a result that is there", async () => {
  const d = direct();
  d.restart(() => {
    const writer = openLedger(d.ledger, { project: PROJECT });
    writer.append({ v: 0, id: `${ID}checks:${SHA.a}`, time: at(5), type: "checks.passed", source: { adapter: "local", kind: "observed" }, project: PROJECT, repo: "team/product", change: "7", sha: SHA.a, data: { seen: at(6) } });
    writer.close();
  });
  change(d, merged(30));
  d.host.runs(SHA.a, [run("r1", "unit", "passed", 1, 5)]);
  assert.deepEqual(checked(await d.round(clock(100))), []);
  d.close();
});

// ---- checks.none ----

test("#47: a change merged a minute after its head, with checks that come later: no checks.none, and the result is written", async () => {
  const d = direct();
  change(d, { head: { sha: SHA.a, at: at(28) }, ...merged(29) });
  assert.deepEqual(checked(await d.round(clock(30))), [], "nothing yet");
  assert.deepEqual(checked(await d.round(clock(40))), [], "eleven minutes after the merge: nothing said of none");
  d.host.runs(SHA.a, [run("r1", "unit", "passed", 31, 45)]);
  const later = await d.round(clock(50));
  assert.deepEqual(summary(later), [["checks.passed", `checks:${SHA.a}`, at(45)]]);
  // An hour after the end, with the result there: still no none.
  assert.deepEqual(checked(await d.round(clock(100))), []);
  d.close();
});

test("#47: a head with no check an hour after the merge gets checks.none, with the time of the merge, after the merge in the order of that moment, and not before the hour", async () => {
  const d = direct();
  change(d, { head: { sha: SHA.a, at: at(28) }, ...merged(30) });
  const early = await d.round(clock(32));
  assert.deepEqual(early.map((e) => e.type), ["change.opened", "change.merged"]);
  assert.deepEqual(checked(await d.round(clock(75))), [], "forty-five minutes: not yet");
  assert.equal(d.cursor().watch.length, 1, "the head is watched until the hour");
  const events = await d.round(clock(91));
  assert.deepEqual(summary(events), [["checks.none", `checks:${SHA.a}:none`, at(30)]]);
  assert.deepEqual(d.cursor().watch, []);
  assert.deepEqual(await d.round(clock(92)), []);
  d.restart();
  assert.deepEqual(await d.round(clock(93)), []);
  assert.match(showText(d), /no checks/);
  d.close();
});

test("#47: checks.none comes after the merge or the closing of its moment, in the order of the ledger", async () => {
  const d = direct();
  change(d, merged(30));
  const events = await d.round(clock(200));
  assert.deepEqual(events.map((e) => e.type), ["change.opened", "change.merged", "checks.none"]);
  const e = (type: string, id: string) => ({ type, time: at(1), id });
  const sorted = [e("checks.none", "n"), e("change.closed", "c"), e("change.merged", "m"), e("change.updated", "u"), e("change.reopened", "r")].sort(happensBefore).map((x) => x.id);
  assert.deepEqual(sorted, ["u", "m", "c", "n", "r"]);
  d.close();
});

test("#47: a change closed without a merge gets checks.none as well", async () => {
  const d = direct();
  change(d, { closedAt: at(20), closedBy: lead, updatedAt: at(20) });
  const events = await d.round(clock(200));
  assert.deepEqual(events.map((e) => e.type), ["change.opened", "change.closed", "checks.none"]);
  assert.equal(events.find((e) => e.type === "checks.none")!.time, at(20));
  d.close();
});

test("#47: a check that comes after checks.none, on a change that is read again, is written as a result after it", async () => {
  const d = direct();
  change(d, { closedAt: at(10), closedBy: lead, updatedAt: at(10) });
  assert.deepEqual(summary(await d.round(clock(200))), [["checks.none", `checks:${SHA.a}:none`, at(10)]]);
  change(d, { reopenings: [{ id: "r1", by: lead, at: at(300) }], updatedAt: at(300) });
  d.host.runs(SHA.a, [run("r1", "lint", "passed", 301, 305)]);
  assert.deepEqual(summary(await d.round(clock(310))), [["checks.passed", `checks:${SHA.a}`, at(305)]]);
  const head = showJson(d.ledger, "change:7").changes[0].heads[0];
  assert.equal(head.checks, "passed", "the result after the none is what the head reads");
  d.close();
});

// ---- the calls to the host ----

/** A host that counts the calls for the checks of each commit. */
function counting(counts: Map<string, number>): (host: CodeHost) => CodeHost {
  return (host) =>
    new Proxy(host, {
      get(target, property, receiver) {
        if (property !== "checks") return Reflect.get(target, property, receiver);
        return (sha: string): Promise<ChecksState> => {
          counts.set(sha, (counts.get(sha) ?? 0) + 1);
          return target.checks(sha);
        };
      },
    });
}

const shaOf = (n: number) => n.toString(16).padStart(40, "0");

test("#47: a hundred open changes whose runs have all finished: the host is asked less and less, and far less than twice a head a round", async () => {
  const counts = new Map<string, number>();
  const d = direct({ wrap: counting(counts) });
  for (let n = 1; n <= 100; n++) {
    d.host.change({ number: n, branch: `b${n}`, openedAt: at(0), openedBy: agent, head: { sha: shaOf(n), at: at(0) }, tasks: [], reviews: [], updatedAt: at(1) });
    d.host.runs(shaOf(n), [run(`r${n}`, "unit", "passed", 1, 5)]);
  }
  const total = () => [...counts.values()].reduce((a, b) => a + b, 0);
  const perRound: number[] = [];
  for (let k = 0; k < 120; k++) {
    const before = total();
    await d.round(clock(10 + k));
    perRound.push(total() - before);
  }
  assert.equal(perRound[0], 100, "every head is asked about in the first round");
  assert.equal(perRound[1], 100, "and again after a minute");
  assert.ok(perRound[2] === 0 && perRound[3] === 100, `after two minutes more: ${perRound.slice(0, 8)}`);
  // 120 rounds of a minute: a head is asked after 1, 2, 4, 8, 16, 32 and 60 minutes more, and then every hour.
  assert.ok(total() <= 100 * 10, `${total()} calls`);
  assert.ok(total() < (100 * 2 * 120) / 10, "far below two a head a round");
  assert.ok(perRound.slice(70).filter((n) => n > 0).length <= 2, `at the end it is quiet: ${perRound.slice(70)}`);
  d.close();
});

test("#47: a head with a run going is asked about in every round; a change updated at the host starts the asking anew", async () => {
  const counts = new Map<string, number>();
  const d = direct({ wrap: counting(counts) });
  change(d);
  d.host.runs(SHA.a, [run("r1", "slow", "pending", 1)]);
  for (let k = 0; k < 10; k++) await d.round(clock(10 + k));
  assert.equal(counts.get(SHA.a), 10, "every round while it goes");
  d.host.runs(SHA.a, [run("r1", "slow", "passed", 1, 25)]);
  // The change is the last updated and read in every round; unchanged, it is not anew.
  counts.clear();
  for (let k = 0; k < 10; k++) await d.round(clock(30 + k));
  assert.ok((counts.get(SHA.a) ?? 0) <= 5, `${counts.get(SHA.a)} calls in ten minutes`);
  counts.clear();
  change(d, { updatedAt: at(50) });
  await d.round(clock(51));
  await d.round(clock(52));
  assert.equal(counts.get(SHA.a), 2, "updated: asked at once, and after a minute");
  d.close();
});

test("#47: what a round needs for the intervals is kept with the cursor: a restart asks no more than one that goes on", async () => {
  const counts = new Map<string, number>();
  const d = direct({ wrap: counting(counts) });
  change(d);
  d.host.runs(SHA.a, [run("r1", "unit", "passed", 1, 5)]);
  await d.round(clock(10));
  await d.round(clock(11));
  await d.round(clock(13));
  assert.equal(counts.get(SHA.a), 3);
  d.restart();
  await d.round(clock(14));
  await d.round(clock(15));
  assert.equal(counts.get(SHA.a), 3, "the next ask is after four minutes more: kept with the cursor");
  d.close();
});

// ---- runs that never finish ----

test("#47: a head let go while a run of it is still going: checks.unfinished with its name, once, at the time the watch ended", async () => {
  const d = direct();
  change(d, merged(30));
  d.host.runs(SHA.a, [run("r1", "unit", "passed", 1, 5), run("r2", "slow job", "pending", 2)]);
  const first = await d.round(clock(40));
  assert.deepEqual(checked(first), []);
  assert.equal(d.cursor().watch.length, 1, "asked about in every round while it goes");
  assert.deepEqual(checked(await d.round(clock(60))), []);
  const events = await d.round(clock(95));
  assert.deepEqual(summary(events), [["checks.unfinished", `checks:${SHA.a}:unfinished`, at(90)]]);
  assert.deepEqual((checked(events)[0]!.data as any).unfinished, ["slow job"]);
  assert.deepEqual(d.cursor().watch, []);
  assert.deepEqual(await d.round(clock(96)), []);
  d.restart();
  assert.deepEqual(await d.round(clock(97)), []);
  assert.match(showText(d), /still running when it was let go: slow job/);
  d.close();
});

test("#47: runs that finish after the change ended, within the hour, are results like any other", async () => {
  const d = direct();
  change(d, merged(30));
  d.host.runs(SHA.a, [run("r1", "unit", "passed", 1, 5), run("r2", "slow", "pending", 2)]);
  await d.round(clock(40));
  d.host.runs(SHA.a, [run("r1", "unit", "passed", 1, 5), run("r2", "slow", "failed", 2, 50)]);
  assert.deepEqual(summary(await d.round(clock(55))), [["checks.failed", `checks:${SHA.a}`, at(50)]]);
  d.close();
});

// ---- names, and a result the writer refuses ----

test("#47: a name of 300 characters with a character of more than one unit at the cut, and a name with a control character: written, cut whole and clean", async () => {
  const d = direct();
  change(d);
  d.host.runs(SHA.a, [
    run("r1", `${"x".repeat(199)}😀 and the rest of a very long name ${"y".repeat(100)}`, "failed", 1, 5),
    run("r2", "lint\u001b[31m\u0007", "failed", 1, 5),
  ]);
  const events = checked(await d.round(clock(10)));
  assert.equal(events.length, 1);
  const names = (events[0]!.data as any).failed as string[];
  assert.deepEqual(names, ["lint[31m", `${"x".repeat(199)}😀`]);
  assert.ok(names.every((n) => n.isWellFormed()));
  assert.ok(!readFileSync(d.ledger, "utf8").includes("\\u001b"));
  const text = showText(d);
  assert.ok(!text.includes("\u001b") && !text.includes("\u0007"));
  d.close();
});

test("#47: a result the writer refuses stops the checks of that commit for the round, with a warning that names it; the other commits of the round are written", async () => {
  const d = direct({ refuse: (e) => e.type === "checks.failed" && e.sha === SHA.a });
  change(d);
  d.host.change({ number: 8, branch: "other", openedAt: at(0), openedBy: agent, head: { sha: SHA.b, at: at(0) }, tasks: [], reviews: [], updatedAt: at(1) });
  d.host.runs(SHA.a, [run("a1", "lint", "failed", 1, 5), run("a2", "lint", "passed", 8, 12)]);
  d.host.runs(SHA.b, [run("b1", "unit", "failed", 1, 6)]);
  const events = await d.round(clock(20));
  assert.deepEqual(checked(events).map((e) => [e.type, e.sha]), [["checks.failed", SHA.b]], "the later result of the refused commit is not written in front of its refused one");
  assert.ok(events.some((e) => e.type === "change.opened" && e.change === "8"));
  assert.match(d.said(), new RegExp(SHA.a.slice(0, 7)));
  // The next round asks again, says so again, and the round goes through.
  const again = await d.round(clock(25));
  assert.deepEqual(checked(again), []);
  d.close();
});

test("#47: a check run whose time cannot be read is passed over, and the round goes through", async () => {
  const d = direct();
  change(d);
  d.host.runs(SHA.a, [run("r1", "lint", "passed", 1, 5), { id: "r2", name: "odd", suite: "s1", result: "failed", started: "nonsense", at: "undefined" }]);
  const events = await d.round(clock(10));
  assert.deepEqual(summary(events), [["checks.passed", `checks:${SHA.a}`, at(5)]]);
  d.close();
});

// ---- a claim changes nothing ----

function ledgerOf(events: [string, number, Record<string, unknown>?, ("observed" | "claimed")?][]): string {
  const path = join(folder(), "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  const of = { change: "40", branch: "b", sha: SHA.a, task: "20" };
  let n = 0;
  writer.append({ v: 0, id: "t", time: m(0), type: "task.opened", source: { adapter: "local", kind: "observed" }, project: PROJECT, task: "20" });
  for (const [type, minute, data, kind] of events) {
    n++;
    writer.append({ v: 0, id: `e${n}`, time: m(minute), type: type as LedgerEvent["type"], source: { adapter: "local", kind: kind ?? "observed" }, project: PROJECT, ...of, ...(data ? { data } : {}) });
  }
  writer.close();
  return path;
}

test("#47: a claimed checks.passed on a head whose observed checks failed: howl show and the summary are as without it", () => {
  const without = ledgerOf([["change.opened", 10], ["checks.failed", 15, { failed: ["lint"] }], ["change.merged", 40]]);
  const withClaim = ledgerOf([["change.opened", 10], ["checks.failed", 15, { failed: ["lint"] }], ["checks.passed", 30, { attempt: 5 }, "claimed"], ["change.merged", 40]]);
  const a = showJson(without, "20");
  const b = showJson(withClaim, "20");
  assert.deepEqual(b.summary, a.summary);
  assert.deepEqual(b.changes, a.changes);
  assert.equal(b.changes[0].heads[0].checks, "failed");
  assert.deepEqual(b.claimed.map((c: any) => c.type), ["checks.passed"], "shown as a claim");
  const text = howl(["show", "20", "--utc", "--ledger", withClaim]).stdout;
  assert.match(text, /head aaaaaaa, checks failed at \S+ \(lint\)\n/);
  assert.match(text, /claimed {2}checks\.passed on change 40/);
  // A claim alone gives no result and no wait.
  const alone = showJson(ledgerOf([["change.opened", 10], ["checks.passed", 30, undefined, "claimed"], ["change.merged", 40]]), "20");
  assert.equal(alone.changes[0].heads[0].checks, undefined);
  assert.equal(alone.summary.parts.checks, 0);
});

// ---- the readers ----

function parts(path: string): Record<string, number> {
  return showJson(path, "20").summary.parts;
}

test("#47: the summary waits for checks until the last result: a failed result that another follows leaves it waiting", () => {
  const path = ledgerOf([
    ["change.opened", 10],
    ["checks.failed", 15, { failed: ["lint"] }],
    ["checks.passed", 25],
    ["change.merged", 40],
  ]);
  assert.deepEqual(parts(path), { work: 0, person: 0, instructions: 0, checks: 900, review: 900, unknown: 0 });
});

test("#47: the last result ends the wait for checks: when it failed the change waits for nothing", () => {
  const path = ledgerOf([
    ["change.opened", 10],
    ["checks.failed", 15, { failed: ["lint", "unit"] }],
    ["checks.failed", 25, { failed: ["unit"] }],
    ["change.merged", 40],
  ]);
  assert.deepEqual(parts(path), { work: 0, person: 0, instructions: 0, checks: 900, review: 0, unknown: 900 });
});

test("#47: a head with one failed result waits for nothing after it, as before", () => {
  const path = ledgerOf([["change.opened", 10], ["checks.failed", 15], ["change.merged", 40]]);
  assert.deepEqual(parts(path), { work: 0, person: 0, instructions: 0, checks: 300, review: 0, unknown: 1500 });
});

test("#47: a head that has checks.none waits for its review, not for checks", () => {
  const path = ledgerOf([["change.opened", 10], ["checks.none", 40], ["change.merged", 40]]);
  assert.deepEqual(parts(path), { work: 0, person: 0, instructions: 0, checks: 0, review: 1800, unknown: 0 });
});

test("#47: howl show lists the results of a head in the order of time, each with its time and the names where it failed; one result as before", () => {
  const path = ledgerOf([
    ["change.opened", 10],
    ["checks.passed", 25],
    ["checks.failed", 15, { failed: ["lint", "unit"] }],
    ["change.merged", 40],
  ]);
  const text = howl(["show", "20", "--utc", "--ledger", path]).stdout;
  assert.match(text, /head aaaaaaa\n/);
  assert.match(text, /checks, result 1: failed at 2026-01-01T08:15:00Z \(lint, unit\)\n/);
  assert.match(text, /checks, result 2: passed at 2026-01-01T08:25:00Z\n/);
  const one = howl(["show", "20", "--utc", "--ledger", ledgerOf([["change.opened", 10], ["checks.failed", 15, { failed: ["lint"] }]])]).stdout;
  assert.match(one, /head aaaaaaa, checks failed at 2026-01-01T08:15:00Z \(lint\)\n/);
  const old = howl(["show", "20", "--utc", "--ledger", ledgerOf([["change.opened", 10], ["checks.passed", 15]])]).stdout;
  assert.match(old, /head aaaaaaa, checks passed at 2026-01-01T08:15:00Z\n/);
});

test("#47: a name in the ledger with a control character does not reach the terminal", () => {
  const path = ledgerOf([["change.opened", 10], ["checks.failed", 15, { failed: ["lint\u001b[31mred"] }]]);
  const text = howl(["show", "20", "--utc", "--ledger", path]).stdout;
  assert.ok(!text.includes("\u001b"));
  assert.match(text, /\(lint\[31mred\)/);
});

test("#47: howl watch shows the names that failed, and what a head let go was still running", () => {
  const path = ledgerOf([
    ["change.opened", 10],
    ["checks.failed", 15, { failed: ["lint", "unit"] }],
    ["checks.unfinished", 30, { unfinished: ["slow job"] }],
    ["checks.none", 31],
  ]);
  const out = howl(["watch", "--no-follow", "--utc", "--ledger", path]).stdout;
  assert.match(out, /checks\.failed\s+task 20  change 40  aaaaaaa lint, unit/);
  assert.match(out, /checks\.unfinished\s+.*aaaaaaa slow job/);
  assert.match(out, /checks\.none\s+.*aaaaaaa/);
});

test("#47: the view of one change and a bundle show the results of their own change's heads, as the task's view does", async () => {
  const { buildBundle } = await import("../src/export/export.ts");
  const path = join(folder(), "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  let n = 0;
  const observed = (type: LedgerEvent["type"], minute: number, change: string, sha: string, data?: Record<string, unknown>) =>
    writer.append({ v: 0, id: `e${++n}`, time: m(minute), type, source: { adapter: "local", kind: "observed" }, project: PROJECT, task: "20", change, branch: "b", sha, ...(data ? { data } : {}) });
  observed("change.opened", 10, "40", SHA.a);
  observed("checks.failed", 15, "40", SHA.a, { failed: ["lint"] });
  observed("checks.passed", 25, "40", SHA.a);
  observed("change.merged", 30, "40", SHA.a);
  observed("change.opened", 50, "41", SHA.b);
  observed("checks.none", 70, "41", SHA.b);
  observed("change.merged", 70, "41", SHA.b);
  writer.close();
  const heads = (shown: { changes: { change: string; heads: { checks?: string; results?: { n: number; result: string }[] }[] }[] }, change: string) =>
    shown.changes.find((c) => c.change === change)!.heads.map((h) => [h.checks, h.results?.map((a) => `${a.n}:${a.result}`)]);
  const one = showJson(path, "change:40");
  assert.equal(one.changes.length, 1);
  assert.deepEqual(heads(one, "40"), [["passed", ["1:failed", "2:passed"]]]);
  const bundle = buildBundle(path, { kind: "task", id: "20" }, { version: "test" });
  const timeline = JSON.parse(bundle.get("timeline.json")!.toString());
  assert.deepEqual(heads(timeline, "40"), [["passed", ["1:failed", "2:passed"]]]);
  assert.deepEqual(heads(timeline, "41"), [["none", undefined]]);
  const selected = JSON.parse(bundle.get("selection.json")!.toString()).lines as number[];
  const types = rawLines(path).filter((_, i) => selected.includes(i + 1)).map((l) => (JSON.parse(l) as { event: LedgerEvent }).event.type);
  assert.equal(types.filter((t) => t.startsWith("checks.")).length, 3, "every result and the word of none is selected");
});
