// #38: the requirements a change's tests name, read from its commit and kept in
// the ledger as IDs and counts: observed, never test names.
// @code_class tests
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findTrace, summaryAt } from "../src/howl/trace.ts";
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

test("#38: the summary of a commit has the IDs covered and touched, the number of tests and a hash of them, and no test name", () => {
  const r = repo();
  const sha = r.commit('test("R-1 one (R-2)", () => {});\ntest("R-1 again", () => {});\ntest("a helper", () => {});\n');
  const found = findTrace(r.ws.root)!;
  const summary = summaryAt(r.ws.root, found, sha)!;
  assert.deepEqual({ covered: summary.covered, touched: summary.touched, tests: summary.tests }, { covered: ["R-1"], touched: ["R-2"], tests: 2 });
  assert.match(summary.list, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(summary).includes("one") && !JSON.stringify(summary).includes("again"), "no test name");
  // The same tests in another order and file give the same hash; another test gives another.
  const again = r.commit('test("R-1 again", () => {});\ntest("a helper", () => {});\ntest("R-1 one (R-2)", () => {});\n');
  assert.equal(summaryAt(r.ws.root, found, again)!.list, summary.list, "the order of the file is no part of it");
  const more = r.commit('test("R-1 one (R-2)", () => {});\ntest("R-1 again", () => {});\ntest("R-3 new", () => {});\n');
  assert.notEqual(summaryAt(r.ws.root, found, more)!.list, summary.list);
});

test("#38: a commit that is not on the machine, or whose tables cannot be read, has no summary", () => {
  const r = repo();
  r.commit('test("R-1 one", () => {});\n');
  const found = findTrace(r.ws.root)!;
  assert.equal(summaryAt(r.ws.root, found, "f".repeat(40)), null);
  // A commit whose tables are gone: the settings name a file that is not there.
  git(r.ws.root, "rm", "-q", "reqs.md");
  git(r.ws.root, "commit", "-q", "-m", "no tables");
  assert.equal(summaryAt(r.ws.root, found, git(r.ws.root, "rev-parse", "HEAD")), null);
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
  assert.ok(!readFileSync(r.ws.ledger, "utf8").includes("a helper"), "no test name is in the ledger");
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
