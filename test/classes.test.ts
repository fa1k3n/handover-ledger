// #60: a code class for every file, by path in .howl/howl.yml and read from the file's header.
// @code_class tests
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classByPath, findClasses, headerClass, matchesGlob, sameClass } from "../src/howl/classes.ts";
import { folder, git, howl } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const YML = `project: example
classes:                                   # from the highest demand to the lowest
  - name: high
    paths: [src/core/**, schema/**]
    owner: ignored
    checks: [one, two]
  - name: middle
    paths:
      - src/**
      - tsconfig*.json
  - name: low
    paths: [docs/**, "*.md", .howl/**]
class_header: '@code_class\\s+(\\S+)'
class_header_in: ['*.ts', '*.sh']
`;

/** A repository with the settings above, the files given, and every file added to git. */
function repo(files: Record<string, string>, yml = YML): string {
  const root = folder();
  git(root, "init", "-q");
  mkdirSync(join(root, ".howl"));
  writeFileSync(join(root, ".howl", "howl.yml"), yml);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  git(root, "add", "-A");
  return root;
}

const GOOD = {
  "src/core/a.ts": "// A file.\n// @code_class high\n",
  "src/b.ts": "// B.\n// @code_class middle\n",
  "docs/x.md": "text\n",
  "tsconfig.build.json": "{}\n",
};

test("findClasses reads the classes in order with their paths, class_header and class_header_in", () => {
  const found = findClasses(repo(GOOD));
  assert.deepEqual(found?.classes, [
    { name: "high", paths: ["src/core/**", "schema/**"] },
    { name: "middle", paths: ["src/**", "tsconfig*.json"] },
    { name: "low", paths: ["docs/**", "*.md", ".howl/**"] },
  ]);
  assert.equal(found?.header, "@code_class\\s+(\\S+)");
  assert.deepEqual(found?.headerIn, ["*.ts", "*.sh"]);
});

test("findClasses: a howl.yml without classes, or no howl.yml, gives none", () => {
  assert.equal(findClasses(repo({}, "project: example\n")), null);
  assert.equal(findClasses(folder()), null);
});

test("findClasses finds the nearest howl.yml above the folder", () => {
  const root = repo(GOOD);
  assert.equal(findClasses(join(root, "src", "core"))?.root, root);
});

test("the globs: ** across folders, * within one, no slash means the name in any folder", () => {
  assert.ok(matchesGlob("src/a/**", "src/a/b/c.ts"));
  assert.ok(!matchesGlob("src/a/**", "src/ab/c.ts"));
  assert.ok(matchesGlob("*.md", "docs/x.md"));
  assert.ok(matchesGlob("*.md", "x.md"));
  assert.ok(matchesGlob("tsconfig*.json", "tsconfig.build.json"));
  assert.ok(!matchesGlob("src/*.ts", "src/a/b.ts"));
  assert.ok(matchesGlob("src/*.ts", "src/b.ts"));
  assert.ok(matchesGlob("**/x.ts", "x.ts"));
  assert.ok(matchesGlob("**/x.ts", "a/b/x.ts"));
  assert.ok(matchesGlob(".howl/**", ".howl/howl.yml"));
});

test("the first matching class wins by path", () => {
  const found = findClasses(repo(GOOD))!;
  assert.equal(classByPath(found.classes, "src/core/a.ts"), "high");
  assert.equal(classByPath(found.classes, "src/b.ts"), "middle");
  assert.equal(classByPath(found.classes, "README.md"), "low");
  assert.equal(classByPath(found.classes, "elsewhere/z.txt"), undefined);
});

test("the header is found in a Doxygen block and in a // comment, not after line 50", () => {
  const re = /@code_class\s+(\S+)/;
  assert.equal(headerClass("/**\n * @file a.c\n * @code_class ASIL-B\n */\n", re), "ASIL-B");
  assert.equal(headerClass("// @code_class qm\n", re), "qm");
  assert.equal(headerClass("# @code_class one\n# @code_class two\n", re), "one");
  const late = "x\n".repeat(50) + "// @code_class qm\n";
  assert.equal(headerClass(late, re), undefined);
  const last = "x\n".repeat(49) + "// @code_class qm\n";
  assert.equal(headerClass(last, re), "qm");
});

test("ASIL B, ASIL_B and asil-b are one class", () => {
  assert.ok(sameClass("ASIL B", "asil-b"));
  assert.ok(sameClass("ASIL_B", "asil-b"));
  assert.ok(!sameClass("asil-b", "asil-c"));
});

test("howl classes lists a file per line with its class by path and by header", () => {
  const root = repo(GOOD);
  const run = howl(["classes"], { cwd: root });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /^src\/core\/a\.ts\b.*\bhigh\b/m);
  assert.match(run.stdout, /^docs\/x\.md\b.*\blow\b/m);
  const json = JSON.parse(howl(["classes", "--json"], { cwd: root }).stdout);
  const a = json.files.find((f: any) => f.file === "src/core/a.ts");
  assert.deepEqual(a, { file: "src/core/a.ts", path: "high", header: "high", class: "high" });
});

test("howl classes --check ends with 0 and a summary when all agree", () => {
  const run = howl(["classes", "--check"], { cwd: repo(GOOD) });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /high: 1/);
  assert.match(run.stdout, /middle: 2/);
  assert.match(run.stdout, /low: 2/);
});

test("howl classes --check names each of the four faults", () => {
  const root = repo({
    ...GOOD,
    "other/none.txt": "x\n",
    "src/nohead.ts": "// No header.\n",
    "src/unknown.ts": "// @code_class made-up\n",
    "src/differs.ts": "// @code_class low\n",
  });
  const run = howl(["classes", "--check"], { cwd: root });
  assert.equal(run.status, 1);
  const lines = run.stdout.split("\n");
  for (const file of ["other/none.txt", "src/nohead.ts", "src/unknown.ts", "src/differs.ts"]) {
    assert.ok(lines.some((l) => l.startsWith(file)), `${file} is named`);
  }
  assert.ok(!lines.some((l) => l.startsWith("src/b.ts")));
});

test("an untracked file is not looked at", () => {
  const root = repo(GOOD);
  writeFileSync(join(root, "src", "untracked.ts"), "// nothing\n");
  assert.equal(howl(["classes", "--check"], { cwd: root }).status, 0);
  assert.ok(!howl(["classes"], { cwd: root }).stdout.includes("untracked"));
});

test("a header higher than the path's class is in force, and --check still names the file", () => {
  const root = repo({ ...GOOD, "src/up.ts": "// @code_class high\n" });
  const json = JSON.parse(howl(["classes", "--json"], { cwd: root }).stdout);
  assert.equal(json.files.find((f: any) => f.file === "src/up.ts").class, "high");
  const run = howl(["classes", "--check"], { cwd: root });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^src\/up\.ts/m);
});

test("with no class_header there is only the path", () => {
  const yml = "project: example\nclasses:\n  - name: all\n    paths: ['**']\n";
  const root = repo({ "a.ts": "x\n", "b.json": "{}\n" }, yml);
  assert.equal(howl(["classes", "--check"], { cwd: root }).status, 0);
});

test("on this repository: howl classes --check ends with 0 and every class has a file", () => {
  const run = howl(["classes", "--check"], { cwd: ROOT });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const found = findClasses(ROOT)!;
  const json = JSON.parse(howl(["classes", "--json"], { cwd: ROOT }).stdout);
  for (const { name } of found.classes) {
    assert.ok(
      json.files.some((f: any) => f.class === name),
      `a file of class ${name}`,
    );
  }
});
