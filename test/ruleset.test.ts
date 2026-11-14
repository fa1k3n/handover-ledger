// #35: the ruleset and the workflow agree, and the script compares a file with the host's answer.
// @code_class tests
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findProject } from "../src/howl/project.ts";
import { folder } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ruleset = JSON.parse(readFileSync(join(ROOT, ".github/rulesets/main.json"), "utf8"));
const workflow = readFileSync(join(ROOT, ".github/workflows/check.yml"), "utf8");

function rule(type: string): any {
  return ruleset.rules.find((r: any) => r.type === type);
}

test("the status check the ruleset requires is the id of a job in the workflow", () => {
  const contexts = rule("required_status_checks").parameters.required_status_checks.map((c: any) => c.context);
  assert.deepEqual(contexts, ["check"]);
  assert.match(workflow, /^jobs:\n {2}check:\n(?: {4}.*\n)*? {4}name: check$/m);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.match(workflow, /pull_request/);
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
});

test("the ruleset requires a pull request, forbids force push and deletion, and has no bypass", () => {
  assert.equal(ruleset.target, "branch");
  assert.equal(ruleset.enforcement, "active");
  assert.deepEqual(ruleset.conditions.ref_name.include, ["~DEFAULT_BRANCH"]);
  assert.equal(rule("pull_request").parameters.required_approving_review_count, 0);
  assert.equal(rule("required_status_checks").parameters.strict_required_status_checks_policy, true);
  assert.ok(rule("non_fast_forward"));
  assert.ok(rule("deletion"));
  assert.deepEqual(ruleset.bypass_actors, []);
});

function check(file: string) {
  return spawnSync("sh", [join(ROOT, "scripts/ruleset.sh"), "--check", "--from", file], { encoding: "utf8" });
}

test("ruleset.sh --check ends with 0 for the same content and with 1 naming a different number of approvals", () => {
  const dir = folder();
  const same = join(dir, "same.json");
  writeFileSync(same, JSON.stringify({ id: 7, source_type: "Repository", ...ruleset }));
  assert.equal(check(same).status, 0);

  const other = structuredClone(ruleset);
  other.rules.find((r: any) => r.type === "pull_request").parameters.required_approving_review_count = 1;
  const diff = join(dir, "diff.json");
  writeFileSync(diff, JSON.stringify(other));
  const result = check(diff);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /required_approving_review_count/);
});

test("findProject on this repository gives handover-ledger and two patterns that compile", () => {
  const found = findProject(ROOT);
  assert.equal(found?.project, "handover-ledger");
  assert.equal(new RegExp(found!.taskFromBranch!).exec("issue-35-pull-requests")?.[1], "35");
  assert.ok(new RegExp(found!.reviewCommentPattern!).test("[review] looks fine"));
  assert.ok(!new RegExp(found!.reviewCommentPattern!).test("not [review]"));
});
