// #38: the requirements a change's tests name, read from its commit and kept in
// the ledger as IDs and counts: observed, never test names.
// @code_class tests
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openLedger } from "../src/ledger/ledger.ts";
import { findTrace, summaryOf, trace, treeAt } from "../src/howl/trace.ts";
import { readTrace } from "../src/howl/trace-read.ts";
import { decodedFields } from "../src/dashboard/format.ts";
import { happensBefore } from "../src/observe/order.ts";
import { folder, git, howl, lines, PROJECT, workspace, type Workspace } from "./helpers.ts";
import { at, LocalHost } from "./local-host.ts";

const TABLE = "| ID | Requirement |\n|---|---|\n| R-1 | One. |\n| R-2 | Two. |\n| R-3 | Three. |\n";
const TRACE_YML = "requirements_in: [reqs.md]\nrequirement_pattern: 'R-[0-9]+'\ntests_in: [checks.js]\ntest_pattern: ['\\btest\\(\\s*\"([^\"]+)\"']\n";

interface Repo {
  ws: Workspace;
  host: LocalHost;
  /** Commits `tests` as the file of tests, and gives the commit. */
  commit(tests: string): string;
}

/** A repository that is observed through a local host, with its own commits. */
function repo(withTrace = true): Repo {
  const dir = folder();
  const ws = workspace({ yml: `project: ${PROJECT}\nhost: local\nlocal: ${dir}\nrepository: team/product\nagents: [agent-bot]\n${withTrace ? TRACE_YML : ""}` });
  git(ws.root, "init", "-q");
  writeFileSync(join(ws.root, "reqs.md"), TABLE);
  let n = 0;
  return {
    ws,
    host: new LocalHost(dir),
    commit(tests) {
      writeFileSync(join(ws.root, "checks.js"), tests);
      git(ws.root, "add", "-A");
      git(ws.root, "commit", "-q", "-m", `commit ${++n}`);
      return git(ws.root, "rev-parse", "HEAD");
    },
  };
}

const agent = { login: "agent-bot" };
const open = (r: Repo, number: number, sha: string, minute: number, extra: Record<string, unknown> = {}) =>
  r.host.change({ number, branch: "work", openedAt: at(minute), openedBy: agent, head: { sha, at: at(minute) }, tasks: [], reviews: [], updatedAt: at(minute), ...extra } as never);

function round(r: Repo): Record<string, any>[] {
  const run = howl(["observe", "--once"], { cwd: r.ws.root, env: r.ws.env });
  assert.equal(run.status, 0, run.stderr);
  return lines(r.ws.ledger).map((l) => l.event) as Record<string, any>[];
}
const reads = (events: Record<string, any>[]) => events.filter((e) => e.type === "trace.read");

/** The summary of a commit, read in this process. */
function summary(r: Repo, sha: string) {
  const source = treeAt(r.ws.root, sha);
  return summaryOf(trace(findTrace(r.ws.root, source)!, source));
}

test("#38: the summary of a commit has the IDs covered and touched, the tests, those that cover, a hash, and no test name", () => {
  const r = repo();
  const sha = r.commit('test("R-1 one (R-2)", () => {});\ntest("R-1 again", () => {});\ntest("a helper (R-3)", () => {});\ntest("a plain helper", () => {});\n');
  const found = summary(r, sha);
  assert.deepEqual(
    { covered: found.covered, touched: found.touched, tests: found.tests, covering: found.covering },
    { covered: ["R-1"], touched: ["R-2", "R-3"], tests: 3, covering: 2 },
    "the tests that name one are 3, and 2 of them cover: `covered by 2 tests` is of those",
  );
  assert.match(found.list, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(found).includes("again") && !JSON.stringify(found).includes("plain helper"), "no test name");
  const again = r.commit('test("a plain helper", () => {});\ntest("a helper (R-3)", () => {});\ntest("R-1 again", () => {});\ntest("R-1 one (R-2)", () => {});\n');
  assert.equal(summary(r, again).list, found.list, "the order of the file is no part of it");
  const more = r.commit('test("R-1 one (R-2)", () => {});\ntest("R-1 again", () => {});\ntest("a helper (R-3)", () => {});\ntest("R-3 new", () => {});\n');
  assert.notEqual(summary(r, more).list, found.list);
  // The hash is of the lines `howl trace --at <sha> --json` gives: an auditor can make it again.
  const json = JSON.parse(howl(["trace", "--at", sha, "--json"], { cwd: r.ws.root, env: r.ws.env }).stdout) as { tests: { file: string; name: string; covers: string[]; touches: string[] }[] };
  const lines = json.tests.filter((t) => t.covers.length + t.touches.length > 0).map((t) => `${t.file}\t${t.name}\t${t.covers.join(",")}\t${t.touches.join(",")}`).sort().join("\n");
  assert.equal(createHash("sha256").update(lines, "utf8").digest("hex"), found.list);
});

test("#38: reading a commit says read, later (not on the machine), or never (nothing can be read of it)", () => {
  const r = repo();
  const sha = r.commit('test("R-1 one", () => {});\n');
  const read = readTrace(r.ws.root, sha);
  assert.equal(read.state, "read");
  assert.equal(readTrace(r.ws.root, "f".repeat(40)).state, "later", "a fetch may mend it");
  // A commit whose tables are gone.
  git(r.ws.root, "rm", "-q", "reqs.md");
  git(r.ws.root, "commit", "-q", "-m", "no tables");
  const noTables = readTrace(r.ws.root, git(r.ws.root, "rev-parse", "HEAD"));
  assert.equal(noTables.state, "never");
  assert.equal((noTables as { quiet: boolean }).quiet, false, "this is said");
  // A commit from before the settings were there is passed over without a word.
  const before = repo(false);
  const old = before.commit('test("R-1 one", () => {});\n');
  const result = readTrace(before.ws.root, old);
  assert.deepEqual([result.state, (result as { quiet?: boolean }).quiet], ["never", true]);
});

/** A commit whose own settings make the reading go wrong: a pattern, and the text it is put to. */
function hostile(r: Repo, pattern: string, text: string): string {
  writeFileSync(join(r.ws.root, ".howl", "howl.yml"), readFileSync(join(r.ws.root, ".howl", "howl.yml"), "utf8").replace(/test_pattern:.*\n/, () => `test_pattern: ['${pattern}']\n`));
  return r.commit(text);
}

test("#38: a commit whose settings never end, or overflow the stack, stops that reading and nothing else", () => {
  const r = repo();
  const started = Date.now();
  const slow = hostile(r, "(a+)+$", `${"a".repeat(40)}!\n`);
  const result = readTrace(r.ws.root, slow, 1500);
  assert.equal(result.state, "never");
  assert.match((result as { why: string }).why, /took more than 2 s/);
  assert.ok(Date.now() - started < 8000, "the process was killed at the limit, not left to finish");

  // Deep enough to overflow the stack of the process that reads, and no deeper: it ends at once, not at the limit.
  const deep = hostile(r, "(a|b)*c", `${"a".repeat(5_000_000)}\n`);
  const crashed = readTrace(r.ws.root, deep, 15_000);
  assert.equal(crashed.state, "never");
  assert.match((crashed as { why: string }).why, /RangeError|Maximum call stack/);
});

test("#38: a round whose first head is hostile still writes the rest, and says why", () => {
  const r = repo();
  const bad = hostile(r, "(a+)+$", `${"a".repeat(40)}!\n`);
  const good = r.commit('test("R-1 one", () => {});\n');
  open(r, 40, bad, 10);
  open(r, 41, good, 11);
  const run = howl(["observe", "--once"], { cwd: r.ws.root, env: { ...r.ws.env, HOWL_TRACE_LIMIT_MS: "1500" } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /trace [0-9a-f]{7} of change 40: took more than 2 s/);
  const events = lines(r.ws.ledger).map((l) => l.event as Record<string, any>);
  assert.ok(events.some((e) => e.type === "change.opened" && e.change === "41"), "the other change is in");
  assert.deepEqual(reads(events).map((e) => e.change), ["41"], "the hostile head is read as nothing, and not again");
  const again = howl(["observe", "--once"], { cwd: r.ws.root, env: { ...r.ws.env, HOWL_TRACE_LIMIT_MS: "1500" } });
  assert.doesNotMatch(again.stderr, /took more than/, "a head that cannot be read is let go, not tried every round");
});

test("#38: a head whose commit comes to the machine later is read in a later round, though its change did not change", () => {
  const r = repo();
  const elsewhere = repo();
  const sha = elsewhere.commit('test("R-1 one", () => {});\n');
  r.commit('test("a helper", () => {});\n');
  open(r, 40, sha, 10);
  assert.equal(reads(round(r)).length, 0, "not on the machine yet");
  git(r.ws.root, "fetch", "-q", elsewhere.ws.root, "HEAD");
  const found = reads(round(r));
  assert.deepEqual(found.map((e) => [e.change, e.sha, e.data.covered]), [["40", sha, ["R-1"]]], "found by the retry: nothing at the host moved");
  assert.equal(reads(round(r)).length, 1, "and once");
});

test("#38: a fault in the settings of the working tree is said once, not for every head", () => {
  const r = repo();
  const a = r.commit('test("R-1 one", () => {});\n');
  const b = r.commit('test("R-2 two", () => {});\n');
  open(r, 40, a, 10);
  open(r, 41, b, 11);
  writeFileSync(join(r.ws.root, ".howl", "howl.yml"), readFileSync(join(r.ws.root, ".howl", "howl.yml"), "utf8").replace("'R-[0-9]+'", "'R-[0-9+'"));
  const run = howl(["observe", "--once"], { cwd: r.ws.root, env: r.ws.env });
  assert.equal(run.status, 0, run.stderr);
  assert.equal((run.stderr.match(/settings of howl trace .* cannot be read/g) ?? []).length, 1);
  assert.equal(reads(lines(r.ws.ledger).map((l) => l.event as Record<string, any>)).length, 0);
});

test("#38: at most ten heads are read in a round, and the rest in the next", () => {
  const r = repo();
  const shas = Array.from({ length: 13 }, (_, i) => r.commit(`test("R-1 version ${i}", () => {});\n`));
  shas.forEach((sha, i) => open(r, 100 + i, sha, 10 + i));
  assert.equal(reads(round(r)).length, 10);
  assert.equal(reads(round(r)).length, 13);
});

test("#38: the event dialog has decoded fields for a trace.read", () => {
  const r = repo();
  open(r, 40, r.commit('test("R-1 one (R-2)", () => {});\n'), 10);
  const event = reads(round(r))[0]!;
  const fields = Object.fromEntries(decodedFields({ from: "ledger", n: 5, hash: "h", prev: "p", event, raw: "{}" } as never).map((f) => [f.k, f.v]));
  assert.deepEqual([fields["Covered"], fields["Touched only"], fields["Tests naming one"]], ["R-1", "R-2", "1, 1 of them covering"]);
  assert.match(fields["List hash"]!, /^[0-9a-f]{64}$/);
});

test("#38: howl show reads several heads, each with its own line", () => {
  const r = repo();
  const first = r.commit('test("a helper", () => {});\n');
  open(r, 40, first, 10);
  round(r);
  const second = r.commit('test("R-2 two", () => {});\n');
  open(r, 40, second, 20);
  round(r);
  const text = howl(["show", "change:40"], { cwd: r.ws.root, env: r.ws.env }).stdout;
  assert.match(text, /head [0-9a-f]{7}\n\s+no test names a requirement\n[^\n]*new head [0-9a-f]{7}\n\s+requirements: R-2 covered by 1 test/);
});

test("#203: a trace.read under an id that a line of another event holds is warned of and kept in rejected/, not passed over in silence", () => {
  const r = repo();
  const sha = r.commit('test("R-1 one", () => {});\n');
  open(r, 40, sha, 10);
  const id = `local:team/product:trace:40:${sha}`;
  const writer = openLedger(r.ws.ledger, { project: PROJECT });
  writer.append({ v: 0, id, time: at(1), type: "session.started", source: { adapter: "claude-code-hook", kind: "claimed" }, project: PROJECT, session: "x" } as never);
  writer.close();
  const run = howl(["observe", "--once"], { cwd: r.ws.root, env: r.ws.env });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, new RegExp(id));
  assert.match(run.stderr, /not of this host and observed/);
  assert.equal(reads(lines(r.ws.ledger).map((l) => l.event as Record<string, any>)).length, 0);
  assert.equal(readdirSync(join(r.ws.inbox, "rejected")).length, 2);
});

test("#38: the time of a trace.read is its head's", () => {
  const r = repo();
  open(r, 40, r.commit('test("R-1 one", () => {});\n'), 17);
  assert.equal(reads(round(r))[0]!.time, at(17));
});
test("#38: a round gives one trace.read for a head, observed, with IDs and counts and no test name", () => {
  const r = repo();
  const sha = r.commit('test("R-1 one (R-2)", () => {});\ntest("a helper", () => {});\n');
  open(r, 40, sha, 10);
  const events = round(r);
  const found = reads(events);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.source.kind, "observed");
  assert.deepEqual({ change: found[0]!.change, sha: found[0]!.sha, branch: found[0]!.branch }, { change: "40", sha, branch: "work" });
  assert.deepEqual({ covered: found[0]!.data.covered, touched: found[0]!.data.touched, tests: found[0]!.data.tests }, { covered: ["R-1"], touched: ["R-2"], tests: 1 });
  const ledger = readFileSync(r.ws.ledger, "utf8");
  assert.ok(!ledger.includes("a helper") && !ledger.includes("one (R-2)") && !ledger.includes("checks.js"), "no test name and no file name is in the ledger");
  assert.equal(reads(round(r)).length, 1, "a second round over the same state writes nothing");
  assert.equal(howl(["verify", "--project", PROJECT], { cwd: r.ws.root, env: r.ws.env }).status, 0);
});

test("#38: a new head gives a new trace.read, and the old one stays", () => {
  const r = repo();
  const first = r.commit('test("a helper", () => {});\n');
  open(r, 40, first, 10);
  round(r);
  const second = r.commit('test("R-2 two", () => {});\n');
  open(r, 40, second, 20);
  const found = reads(round(r));
  assert.deepEqual(found.map((e) => [e.sha === first ? "first" : "second", e.data.covered]), [["first", []], ["second", ["R-2"]]]);
});

test("#38: nothing is written without the settings, or for a commit the machine does not have", () => {
  const without = repo(false);
  open(without, 40, without.commit('test("R-1 one", () => {});\n'), 10);
  assert.equal(reads(round(without)).length, 0, "without requirements_in nothing of this is read or written");

  const absent = repo();
  absent.commit('test("R-1 one", () => {});\n');
  open(absent, 41, "c".repeat(40), 10);
  assert.equal(reads(round(absent)).length, 0, "howl never fetches: a commit it cannot read is not recorded");
});

test("#38: howl show says what a head names, that no test names a requirement, or that it is not recorded", () => {
  const r = repo();
  const named = r.commit('test("R-1 one", () => {});\ntest("R-3 three", () => {});\n');
  const none = r.commit('test("a helper", () => {});\n');
  open(r, 40, named, 10);
  open(r, 41, none, 11);
  open(r, 42, "d".repeat(40), 12);
  round(r);
  const text = (change: string) => howl(["show", `change:${change}`], { cwd: r.ws.root, env: r.ws.env }).stdout;
  assert.match(text("40"), /requirements: R-1, R-3 covered by 2 tests/);
  assert.match(text("41"), /no test names a requirement/);
  assert.match(text("42"), /requirements: not recorded/);
});

test("#38: a trace.read that a session sends is a claim and counts for nothing", () => {
  const r = repo();
  const sha = r.commit('test("a helper", () => {});\n');
  open(r, 40, sha, 10);
  round(r);
  const run = howl(["emit", "trace.read", "--change", "40", "--data", JSON.stringify({ covered: ["R-1", "R-2"], touched: [], tests: 9, list: "0".repeat(64) })], { cwd: r.ws.root, env: r.ws.env });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(howl(["ingest"], { cwd: r.ws.root, env: r.ws.env }).status, 0);
  const text = howl(["show", "change:40"], { cwd: r.ws.root, env: r.ws.env }).stdout;
  assert.match(text, /no test names a requirement/, "the head still says what the commit says");
  assert.doesNotMatch(text, /R-1/);
});

test("#38: the overview gives the share of merged changes whose merged head names a requirement", () => {
  const r = repo();
  const named = r.commit('test("R-1 one", () => {});\n');
  const none = r.commit('test("a helper", () => {});\n');
  const now = new Date();
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
  for (const [number, sha] of [[40, named], [41, none], [42, named]] as const) {
    r.host.change({ number, branch: `b${number}`, openedAt: hoursAgo(5), openedBy: agent, head: { sha, at: hoursAgo(5) }, tasks: [], reviews: [], mergedAt: hoursAgo(1), mergedBy: { login: "lead" }, updatedAt: hoursAgo(1) } as never);
  }
  r.host.change({ number: 43, branch: "b43", openedAt: hoursAgo(5), openedBy: agent, head: { sha: named, at: hoursAgo(5) }, tasks: [], reviews: [], updatedAt: hoursAgo(5) } as never);
  const events = round(r);
  // The figure is read from the ledger's events, the way the page's overview is.
  return import("../src/read/overview.ts").then(({ keyFigures }) => {
    const figures = keyFigures(events as never, now.getTime());
    assert.deepEqual(figures.requirementsNamed, { merged: 3, named: 2, without: ["41"], unrecorded: 0 });
  });
});

test("#38: in one moment a head's trace.read comes after the head and its configuration, and before its checks", () => {
  const e = (type: string, id: string) => ({ type, time: at(5), id });
  const sorted = [e("checks.passed", "c"), e("trace.read", "t"), e("change.merged", "m"), e("config.changed", "g"), e("change.updated", "u")].sort(happensBefore).map((x) => x.id);
  assert.deepEqual(sorted, ["u", "g", "t", "c", "m"]);
});
