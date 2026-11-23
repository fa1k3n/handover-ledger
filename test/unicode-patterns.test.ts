// #138: the patterns of .howl/howl.yml are compiled with the u flag, as Rust's regex reads them. A pattern that does not
// compile with it is a fault of the settings, named as such.
// @code_class tests
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { headerClass } from "../src/howl/classes.ts";
import { settingPattern } from "../src/howl/project.ts";
import { findTrace } from "../src/howl/trace.ts";
import { folder, git, howl, inboxEvents, workspace } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// `\_` and `\-` are escapes of nothing: V8 lets them through without u and refuses them with it.
const NO_U = ["^task\\_([0-9]+)", "^task\\-([0-9]+)", "([0-9]+\\_)"];

test("#138: the patterns used below do compile without u and not with it", () => {
  for (const source of NO_U) {
    assert.doesNotThrow(() => new RegExp(source), source);
    assert.throws(() => new RegExp(source, "u"), source);
  }
});

test("#138: task_from_branch and review_comment_pattern are compiled with u, and a fault names the setting", () => {
  assert.throws(() => settingPattern({ taskFromBranch: NO_U[0], reviewCommentPattern: undefined }, "task_from_branch"), /task_from_branch in \.howl\/howl\.yml is not a regular expression/);
  assert.throws(() => settingPattern({ taskFromBranch: undefined, reviewCommentPattern: NO_U[1] }, "review_comment_pattern"), /review_comment_pattern in \.howl\/howl\.yml is not a regular expression/);
  assert.equal(settingPattern({ taskFromBranch: "^(\\p{L}+)-", reviewCommentPattern: undefined }, "task_from_branch")?.flags, "u");
  assert.equal(settingPattern({ taskFromBranch: "^(\\p{L}+)-", reviewCommentPattern: undefined }, "task_from_branch")?.exec("åsa-12")?.[1], "åsa");
});

test("#138: howl observe refuses a task_from_branch and a review_comment_pattern that do not compile with u, with one line and status 2", () => {
  for (const setting of ["task_from_branch", "review_comment_pattern"]) {
    const ws = workspace({ yml: `project: example\n${setting}: '${NO_U[0]}'\n` });
    const run = howl(["observe", "--once"], { cwd: ws.root, env: ws.env });
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, new RegExp(`^howl: ${setting} in \\.howl/howl\\.yml is not a regular expression`));
    assert.equal(run.stderr.trim().split("\n").length, 1);
  }
});

test("#138: howl hook records nothing for a task_from_branch that does not compile with u, as for one that does not compile at all", () => {
  const ws = workspace({ yml: `project: example\ntask_from_branch: '${NO_U[0]}'\n` });
  git(ws.root, "init", "-q");
  git(ws.root, "checkout", "-q", "-b", "task_12-x");
  git(ws.root, "commit", "-q", "--allow-empty", "-m", "first");
  const input = JSON.stringify({ session_id: "s", transcript_path: "/nowhere/t.jsonl", cwd: ws.root, hook_event_name: "SessionStart", source: "startup", model: "m" });
  const run = howl(["hook"], { cwd: ws.root, env: ws.env, input });
  assert.equal(run.status, 0);
  assert.equal(run.stdout + run.stderr, "");
  assert.deepEqual(inboxEvents(ws.inbox), []);
});

/** A repository with `yml` as its settings and one file. */
function repo(yml: string): string {
  const root = folder();
  git(root, "init", "-q");
  mkdirSync(join(root, ".howl"));
  writeFileSync(join(root, ".howl", "howl.yml"), yml);
  mkdirSync(dirname(join(root, "src/a.ts")), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "// @code_class high\n");
  writeFileSync(join(root, "reqs.md"), "| ID |\n|---|\n| R_1 |\n");
  writeFileSync(join(root, "checks.js"), 'test("R_1 one", () => {});\n');
  git(root, "add", "-A");
  return root;
}

test("#138: a class_header that does not compile with u is refused by howl classes, status 2, in one line", () => {
  const yml = `project: example\nclasses:\n  - name: high\n    paths: [src/**]\nclass_header: '@code_class\\_(\\S+)'\nclass_header_in: ['*.ts']\n`;
  const run = howl(["classes", "--check"], { cwd: repo(yml) });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stderr, /^howl: class_header is not a regular expression/);
  assert.equal(run.stderr.trim().split("\n").length, 1);
});

test("#138: a requirement_pattern and a test_pattern that do not compile with u are refused by howl trace, status 2, in one line", () => {
  const base = "project: example\nrequirements_in: [reqs.md]\ntests_in: [checks.js]\n";
  for (const [yml, key] of [
    [`${base}requirement_pattern: 'R\\_[0-9]+'\ntest_pattern: ['\\btest\\(\\s*"([^"]+)"']\n`, "requirement_pattern"],
    [`${base}requirement_pattern: 'R_[0-9]+'\ntest_pattern: ['\\btest\\_\\(\\s*"([^"]+)"']\n`, "test_pattern"],
  ] as const) {
    const run = howl(["trace"], { cwd: repo(yml) });
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stderr, new RegExp(`^howl: ${key} is not a regular expression`));
    assert.equal(run.stderr.trim().split("\n").length, 1);
  }
});

test("#138: the patterns of a team are Unicode patterns: a letter class reads a letter that is not ASCII", () => {
  const root = repo("project: example\nrequirements_in: [reqs.md]\ntests_in: [checks.js]\nrequirement_pattern: '[\\p{L}]+_[0-9]+'\ntest_pattern: ['\\btest\\(\\s*\"([^\"]+)\"']\n");
  assert.ok(findTrace(root));
  assert.equal(headerClass("// @code_class høg", /@code_class\s+(\p{L}+)/u), "høg");
});

test("#138: this repository's own howl.yml still passes howl classes --check", () => {
  const run = howl(["classes", "--check"], { cwd: ROOT });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
