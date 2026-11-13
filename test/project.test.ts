// Reading .howl/howl.yml: only the top-level `key: value` lines that #2 needs.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findProject } from "../src/howl/project.ts";
import { folder } from "./helpers.ts";

function repo(yml: string): string {
  const root = folder();
  mkdirSync(join(root, ".howl"));
  writeFileSync(join(root, ".howl", "howl.yml"), yml);
  return root;
}

test("the project and activity_days are read; nested settings are passed over", () => {
  const root = repo(`# a comment
project: "example"   # the name
activity_days: 7
classes:
  - name: qm
    paths: [tools/**]
    project: not-this-one
`);
  assert.deepEqual(findProject(root), { root, project: "example", activityDays: 7 });
});

test("activity_days is 30 when it is not given", () => {
  const root = repo("project: example\n");
  assert.equal(findProject(root)?.activityDays, 30);
});

test("the nearest .howl/howl.yml above the folder is found", () => {
  const root = repo("project: example\n");
  const below = join(root, "a", "b");
  mkdirSync(below, { recursive: true });
  assert.equal(findProject(below)?.root, root);
});

test("no .howl/howl.yml, or one without a project, gives none", () => {
  assert.equal(findProject(folder()), null);
  assert.equal(findProject(repo("activity_days: 3\n")), null);
});

test("a project name that is not a plain folder name, or a wrong activity_days, gives none", () => {
  assert.equal(findProject(repo("project: ../x\n")), null);
  assert.equal(findProject(repo("project: example\nactivity_days: soon\n")), null);
  assert.equal(findProject(repo("project: example\nactivity_days: 0\n")), null);
});
