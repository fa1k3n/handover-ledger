// #88: howl trace reads the requirements in the repository's tables and the
// tests that name them, and gives the matrix and its gaps. It only reads.
// @code_class tests
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findTrace, trace, workingTree, type Gap, type TraceReport } from "../src/howl/trace.ts";
import { folder, git, howl, sha256 } from "./helpers.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/trace/", import.meta.url));
const TABLE = "requirements/brake.md";

/**
 * A repository with the fixture's files, `over` written over them (null takes
 * a file away), the settings in `.howl/howl.yml`, and every file added to git.
 */
function repo(over: Record<string, string | null> = {}, yml?: string): string {
  const root = folder();
  cpSync(FIXTURE, root, { recursive: true });
  mkdirSync(join(root, ".howl"));
  renameSync(join(root, "howl.yml"), join(root, ".howl", "howl.yml"));
  if (yml !== undefined) writeFileSync(join(root, ".howl", "howl.yml"), yml);
  for (const [name, text] of Object.entries(over)) {
    if (text === null) rmSync(join(root, name));
    else {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), text);
    }
  }
  git(root, "init", "-q");
  git(root, "add", "-A");
  return root;
}

/** A small repository of its own: one table, one file of tests, the settings given. */
function small(table: string, tests: string, yml: string): string {
  const root = folder();
  mkdirSync(join(root, ".howl"));
  writeFileSync(join(root, ".howl", "howl.yml"), yml);
  writeFileSync(join(root, "reqs.md"), table);
  writeFileSync(join(root, "checks.js"), tests);
  git(root, "init", "-q");
  git(root, "add", "-A");
  return root;
}

const SMALL_YML = `project: example
requirements_in: [reqs.md]
requirement_pattern: 'R-[0-9]+'
tests_in: [checks.js]
test_pattern: ['\\btest\\(\\s*"([^"]+)"']
`;

const report = (root: string): TraceReport => trace(findTrace(root)!, workingTree(root));
const requirement = (r: TraceReport, id: string) => r.requirements.find((q) => q.id === id)!;
const places = (refs: { file: string; line: number }[]) => refs.map((t) => `${t.file}:${t.line}`);
const gaps = (r: TraceReport, kind: Gap["kind"]) => r.gaps.filter((g) => g.kind === kind);

test("#88: a table with the headings ID, Ver and Status gives each requirement with its ID, method, status, file and line", () => {
  const r = report(repo());
  assert.deepEqual(
    r.requirements.map((q) => q.id),
    ["REQ-BRK-010", "REQ-BRK-011", "REQ-BRK-012", "REQ-BRK-013", "REQ-BRK-014", "REQ-BRK-020", "REQ-BRK-021"],
    "two tables in one file are both read; the table with no ID heading, the block of code and the row with no ID are passed over",
  );
  const first = requirement(r, "REQ-BRK-010");
  assert.deepEqual(
    { id: first.id, method: first.method, status: first.status, file: first.file, line: first.line },
    { id: "REQ-BRK-010", method: "T", status: "Implemented", file: TABLE, line: 15 },
  );
  assert.equal(requirement(r, "REQ-BRK-020").line, 34);
  assert.equal(requirement(r, "REQ-BRK-012").status, "Verified", "the row of dashes with its colons is no requirement and shifts nothing");
});

test("#88: headings by other names are read when requirement_columns names them; with only the ID's, every requirement asks for a test and is taken as built", () => {
  const table = "| Nr | Text | How | State |\n|---|---|---|---|\n| R-1 | One. | review | open |\n| R-2 | Two. | test | closed |\n";
  const named = report(
    small(table, 'test("R-2 two", () => {});\n', `${SMALL_YML}requirement_columns: [nr, How, State]\nrequirement_by_test: [Test]\nrequirement_done: [closed]\n`),
  );
  assert.deepEqual(
    named.requirements.map((q) => [q.id, q.method, q.status, q.by_test, q.built]),
    [
      ["R-1", "review", "open", false, false],
      ["R-2", "test", "closed", true, true],
    ],
    "a heading and a value are compared ignoring case",
  );
  assert.deepEqual(named.gaps, []);

  const idOnly = report(small(table, 'test("R-2 two", () => {});\n', `${SMALL_YML}requirement_columns: [Nr]\n`));
  assert.deepEqual(
    idOnly.requirements.map((q) => [q.id, q.method, q.status, q.by_test, q.built]),
    [
      ["R-1", undefined, undefined, true, true],
      ["R-2", undefined, undefined, true, true],
    ],
  );
  assert.deepEqual(
    gaps(idOnly, "no_test").map((g) => g.id),
    ["R-1"],
  );
});

test("#88: a method or a status heading needs the values that count, and a wrong pattern is said in one line", () => {
  const table = "| ID | Ver | Status |\n|---|---|---|\n| R-1 | T | Done |\n";
  for (const [extra, said] of [
    ["requirement_columns: [ID, Ver]\n", /requirement_by_test/],
    ["requirement_columns: [ID, Ver, Status]\nrequirement_by_test: [T]\n", /requirement_done/],
    ["requirement_pattern: 'R-[0-9+'\n", /requirement_pattern is not a regular expression/],
  ] as const) {
    const yml = extra.startsWith("requirement_pattern") ? SMALL_YML.replace(/requirement_pattern.*\n/, extra) : SMALL_YML + extra;
    const run = howl(["trace"], { cwd: small(table, "", yml) });
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, said);
    assert.equal(run.stderr.trim().split("\n").length, 1, "one line, no stack");
  }
  const noTests = howl(["trace"], { cwd: small(table, "", SMALL_YML.replace(/tests_in.*\n/, "")) });
  assert.equal(noTests.status, 2);
  assert.match(noTests.stderr, /tests_in/);
});

test("#88: an ID in two rows is a gap that names both places", () => {
  const r = report(repo());
  assert.deepEqual(gaps(r, "twice"), [{ kind: "twice", id: "REQ-BRK-010", file: TABLE, line: 36, first: { file: TABLE, line: 15 } }]);
  assert.equal(requirement(r, "REQ-BRK-010").status, "Implemented", "the first row is the requirement");
});

test("#88: the version of a row holds when the table is lined up again and when its status changes, and not when its text changes", () => {
  const before = report(repo());
  assert.equal(requirement(before, "REQ-BRK-010").version, sha256("REQ-BRK-010\tA released pedal asks for no pressure.\tT"));
  assert.equal(requirement(before, "REQ-BRK-014").version, sha256("REQ-BRK-014\tA demand of a | b is one cell.\tT"), "an escaped | is part of its cell");

  const text = readFileSync(join(FIXTURE, TABLE), "utf8");
  const row = "| REQ-BRK-010 | A released pedal asks for no pressure.                    | T   | Implemented |";
  assert.ok(text.includes(row));
  const versionWith = (line: string) => requirement(report(repo({ [TABLE]: text.replace(row, line) })), "REQ-BRK-010").version;
  assert.equal(versionWith("|REQ-BRK-010|A released pedal asks for no pressure.|T|Implemented|"), requirement(before, "REQ-BRK-010").version, "lined up again");
  assert.equal(versionWith("| REQ-BRK-010 | A released pedal asks for no pressure. | T | Verified |"), requirement(before, "REQ-BRK-010").version, "its status changed");
  assert.notEqual(versionWith("| REQ-BRK-010 | A released pedal asks for no pressure at all. | T | Implemented |"), requirement(before, "REQ-BRK-010").version, "its text changed");
});

test("#88: a test whose name starts with an ID covers it; an ID in brackets is touched; case and _ for - do not matter", () => {
  const r = report(repo());
  assert.deepEqual(places(requirement(r, "REQ-BRK-012").covered_by), ["checks/ramp.spec.js:3", "src/ramp.rs:18", "src/ramp.rs:24", "src/ramp.rs:30"]);
  assert.deepEqual(places(requirement(r, "REQ-BRK-010").covered_by), ["src/ramp.rs:12"]);
  assert.deepEqual(places(requirement(r, "REQ-BRK-010").touched_by), ["checks/ramp.spec.js:2"], "in brackets: touched, not covered");
  assert.equal(requirement(r, "REQ-BRK-012").covered_by[1]!.name, "req_brk_012_a_rise_is_limited_per_cycle");
  assert.equal(r.tests.find((t) => t.name === "helper_that_is_no_test"), undefined, "a function with no #[test] is no test");
  assert.equal(r.tests.find((t) => t.name === "limit"), undefined);
  assert.equal(
    r.tests.find((t) => t.name === "req_brk_012_a_small_rise_reaches_the_target")!.line,
    24,
    "a test with a second attribute is found, at the line of its name",
  );
});

test("#88: a comment covers: or touches: counts for the next test below it, and for no other", () => {
  const r = report(repo());
  const together = r.tests.find((t) => t.name === "the_limits_hold_together")!;
  assert.deepEqual(together.covers, ["REQ-BRK-011", "REQ-BRK-012"]);
  const rise = r.tests.find((t) => t.name === "req_brk_012_a_rise_is_limited_per_cycle")!;
  assert.deepEqual({ covers: rise.covers, touches: rise.touches }, { covers: ["REQ-BRK-012"], touches: ["REQ-BRK-013"] });
  const after = r.tests.find((t) => t.name === "req_brk_051_a_fault_is_counted_once")!;
  assert.deepEqual({ covers: after.covers, touches: after.touches }, { covers: ["REQ-BRK-051"], touches: [] }, "the comment above the test before it does not reach it");
  assert.deepEqual(places(requirement(r, "REQ-BRK-011").covered_by), ["checks/ramp.spec.js:2", "src/ramp.rs:30"]);
});

test("#88: a test that names an ID no table holds is a gap, with the test's file and line", () => {
  const r = report(repo());
  assert.deepEqual(gaps(r, "unknown_id"), [{ kind: "unknown_id", id: "REQ-BRK-051", file: "src/ramp.rs", line: 35, test: "req_brk_051_a_fault_is_counted_once" }]);
});

test("#88: a built requirement by test with no covering test is a gap; touched only is still one; not built or by inspection is none", () => {
  const r = report(repo());
  assert.deepEqual(
    gaps(r, "no_test").map((g) => [g.id, g.file, g.line]),
    [
      ["REQ-BRK-013", TABLE, 18],
      ["REQ-BRK-020", TABLE, 34],
    ],
  );
  assert.ok(requirement(r, "REQ-BRK-013").touched_by.length > 0, "REQ-BRK-013 is touched, and still a gap");
  assert.deepEqual(
    [requirement(r, "REQ-BRK-014").built, requirement(r, "REQ-BRK-014").covered_by.length],
    [false, 0],
    "not yet built: no gap",
  );
  assert.deepEqual([requirement(r, "REQ-BRK-021").by_test, requirement(r, "REQ-BRK-021").built], [false, true], "by inspection: no gap");
  assert.equal(r.gaps.length, 4);
});

test("#88: tests that name no requirement are counted and are no gap", () => {
  const r = report(repo());
  assert.deepEqual(r.counts, { requirements: 7, tests: 9, tests_naming_none: 2, gaps: 4 });
  assert.deepEqual(
    r.tests.filter((t) => t.covers.length === 0 && t.touches.length === 0).map((t) => t.name),
    ["a check that names nothing", "rounding_is_to_nearest"],
  );
});

test("#88: howl trace prints a line per requirement and then the gaps", () => {
  const run = howl(["trace"], { cwd: repo() });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^REQ-BRK-012\s+T\s+Verified\s+4 tests$/m);
  assert.match(run.stdout, /^REQ-BRK-010\s+T\s+Implemented\s+1 test$/m);
  assert.match(run.stdout, /^REQ-BRK-020\s+T\s+Implemented\s+no test$/m);
  assert.match(run.stdout, /^REQ-BRK-021\s+I\s+Implemented\s+-$/m, "by inspection: howl reads no test for it");
  assert.match(run.stdout, /^7 requirements, 9 tests \(2 name no requirement\), 4 gaps, in the working tree$/m);
  assert.match(run.stdout, /^requirements\/brake\.md:18 REQ-BRK-013: built and by test, and no test covers it \(2 touch it\)$/m);
  assert.match(run.stdout, /^requirements\/brake\.md:34 REQ-BRK-020: built and by test, and no test covers it$/m);
  assert.match(run.stdout, /^src\/ramp\.rs:35 req_brk_051_a_fault_is_counted_once: names REQ-BRK-051, which no table holds$/m);
  assert.match(run.stdout, /^requirements\/brake\.md:36 REQ-BRK-010: given twice, first at requirements\/brake\.md:15$/m);
});

test("#88: --check ends with 1 on a tree with a gap and 0 on one without", () => {
  const withGaps = howl(["trace", "--check"], { cwd: repo() });
  assert.equal(withGaps.status, 1);
  assert.equal(withGaps.stdout.trim().split("\n").length, 4, "the gaps and nothing else");

  const table = "| ID | Requirement |\n|---|---|\n| R-1 | One. |\n| R-2 | Two. |\n";
  const clean = howl(["trace", "--check"], { cwd: small(table, 'test("R-1 one (R-2)", () => {});\ntest("r_2 two", () => {});\ntest("a helper", () => {});\n', SMALL_YML) });
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout.trim(), "ok: 2 requirements, 3 tests (1 names no requirement)");
});

test("#88: --json is one JSON value on standard output and holds no requirement's text", () => {
  const run = howl(["trace", "--json"], { cwd: repo() });
  assert.equal(run.status, 0, run.stderr);
  const json = JSON.parse(run.stdout) as TraceReport;
  assert.equal(json.at, null);
  assert.deepEqual(json.counts, { requirements: 7, tests: 9, tests_naming_none: 2, gaps: 4 });
  assert.deepEqual(Object.keys(json.requirements[0]!), ["id", "method", "status", "file", "line", "version", "by_test", "built", "covered_by", "touched_by"]);
  assert.match(json.requirements[0]!.version, /^[0-9a-f]{64}$/);
  for (const text of ["A released pedal asks for no pressure.", "The wiring diagram names every sensor.", "Given a second time."]) {
    assert.ok(!run.stdout.includes(text), `the text of a requirement is not in the answer: ${text}`);
  }
  const checked = howl(["trace", "--json", "--check"], { cwd: repo() });
  assert.equal(checked.status, 1, "with --check the status tells of the gaps");
  assert.deepEqual(JSON.parse(checked.stdout), json);
});

test("#88: --at reads that commit and nothing from the working tree", () => {
  const root = repo();
  git(root, "commit", "-q", "-m", "the example");
  const head = git(root, "rev-parse", "HEAD");
  // After the commit: a test that covers REQ-BRK-020, and settings that read no table at all.
  writeFileSync(join(root, "checks", "more.spec.js"), 'test("REQ-BRK-020 the larger reading", () => {});\n');
  git(root, "add", "-A");

  const now = JSON.parse(howl(["trace", "--json"], { cwd: root }).stdout) as TraceReport;
  assert.ok(!now.gaps.some((g) => g.id === "REQ-BRK-020"), "the working tree has the new test");
  const then = JSON.parse(howl(["trace", "--json", "--at", "HEAD"], { cwd: root }).stdout) as TraceReport;
  assert.equal(then.at, head);
  assert.ok(then.gaps.some((g) => g.kind === "no_test" && g.id === "REQ-BRK-020"), "the commit has not");
  assert.equal(then.counts.tests, 9);

  writeFileSync(join(root, ".howl", "howl.yml"), "project: example\n");
  const settingsThen = howl(["trace", "--check", "--at", head], { cwd: root });
  assert.equal(settingsThen.status, 1, "the settings are the commit's too");
  assert.match(howl(["trace", "--at", head], { cwd: root }).stdout, new RegExp(`at ${head.slice(0, 12)}$`, "m"));

  const wrong = howl(["trace", "--at", "no-such-commit"], { cwd: root });
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /no commit no-such-commit/);
});

test("#88: without requirements_in the command says so and reads nothing", () => {
  const run = howl(["trace"], { cwd: repo({}, "project: example\n") });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^howl: no requirements_in in \.howl\/howl\.yml/);
  const nowhere = howl(["trace"], { cwd: folder() });
  assert.equal(nowhere.status, 2);
});

test("#88: outside a git repository howl trace ends with 2 and says so", () => {
  const root = folder();
  cpSync(FIXTURE, root, { recursive: true });
  mkdirSync(join(root, ".howl"));
  renameSync(join(root, "howl.yml"), join(root, ".howl", "howl.yml"));
  const run = howl(["trace"], { cwd: root, env: { GIT_CEILING_DIRECTORIES: dirname(root) } });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /git/);
});

test("#88: an untracked file is not read", () => {
  const root = repo();
  writeFileSync(join(root, "checks", "untracked.spec.js"), 'test("REQ-BRK-020 the larger reading", () => {});\n');
  assert.ok(report(root).gaps.some((g) => g.id === "REQ-BRK-020"));
});

test("#88: howl trace changes no file in the repository and none in howl's home, and takes no lock", () => {
  const root = repo();
  git(root, "commit", "-q", "-m", "the example");
  const home = folder();
  const listing = () => git(root, "status", "--porcelain", "--ignored") + "\n" + readdirSync(root, { recursive: true }).sort().join("\n");
  const before = listing();
  for (const args of [["trace"], ["trace", "--check"], ["trace", "--json"], ["trace", "--at", "HEAD"]]) {
    const run = howl(args, { cwd: root, env: { HOWL_HOME: home } });
    assert.ok(run.status === 0 || run.status === 1, run.stderr);
  }
  assert.equal(listing(), before);
  assert.deepEqual(readdirSync(home), [], "nothing in howl's home: no ledger, no lock");
});
