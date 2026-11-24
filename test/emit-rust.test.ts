// `howl emit` in the binary: the tests of issue #142. The binary says what the TypeScript says, with the same status,
// and leaves the event the TypeScript leaves. It is started without HOWL_FALLBACK.
// @code_class tests
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { VERSIONS, binary, leftIn, run, sameButForIdAndTime } from "./binary.ts";
import { folder, PROJECT, workspace } from "./helpers.ts";

test("#142: the same words, the same status and the same event from each version, for what a script may do", { skip: binary }, () => {
  const deep = (n: number) => `{"d":${"[".repeat(n)}${"]".repeat(n)}}`;
  const cases: [string, string[]][] = [
    ["a type and data", ["checks.passed", "--change", "123", "--task", "45", "--data", '{"check":"static-analysis"}']],
    ["only a type", ["checks.passed"]],
    ["words beyond ASCII", ["checks.passed", "--task", "å😀", "--data", '{"å":"é\\n\\u0001"}']],
    ["the options with =", ["checks.passed", "--change=9", "--data={\"a\":1}"]],
    ["numbers in data", ["checks.passed", "--data", '{"a":1e21,"b":0.1,"c":-0,"d":123456789012345678901234567890}']],
    ["no type", []],
    ["two types", ["a", "b"]],
    ["an option that is not there", ["a", "--nope"]],
    ["a short option", ["a", "-x"]],
    ["a value missing", ["a", "--data"]],
    ["a value that starts with a dash", ["a", "--task", "-1"]],
    ["data that is no JSON", ["checks.passed", "--data", "{not json"]],
    ["data that is no object", ["checks.passed", "--data", "[1,2]"]],
    ["data that is a text", ["checks.passed", "--data", '"text"']],
    ["data that is null", ["checks.passed", "--data", "null"]],
    ["data with a lone surrogate", ["checks.passed", "--data", '{"a":"\\ud800"}']],
    ["data too large for a double", ["checks.passed", "--data", '{"a":1e400}']],
    ["data 125 deep", ["checks.passed", "--data", deep(125)]],
    ["data 126 deep", ["checks.passed", "--data", deep(126)]],
    ["data 200 deep", ["checks.passed", "--data", deep(200)]],
    ["a type that is none", ["check.pased"]],
    ["the ledger's own type", ["ledger.created"]],
    ["a task that is empty", ["checks.passed", "--task", ""]],
    ["a change with a line break", ["checks.passed", "--change", "1\n2"]],
    ["an option given twice, the last holds", ["checks.passed", "--task", "1", "--task", "2"]],
    ["after --", ["--", "checks.passed"]],
  ];
  for (const [label, args] of cases) {
    const result = VERSIONS.map((version) => {
      const w = workspace();
      const done = run(version, ["emit", ...args], w.root, w.env);
      return { done, left: leftIn(w.home), root: w.root, home: w.home };
    });
    const [rust, ts] = result as [(typeof result)[0], (typeof result)[0]];
    // The words say no folder; none of these does.
    assert.deepEqual(rust.done, ts.done, label);
    assert.equal(rust.left.length, ts.left.length, label);
    for (const [i, f] of rust.left.entries()) assert.deepEqual(sameButForIdAndTime(f.event), sameButForIdAndTime(ts.left[i]!.event), label);
  }
});

test("#142: outside a project nothing is written and it ends with 0; the actor comes from .howl/actor", { skip: binary }, () => {
  for (const version of VERSIONS) {
    const w = workspace();
    const done = run(version, ["emit", "checks.passed"], folder(), w.env);
    assert.deepEqual(done, { status: 0, stdout: "", stderr: "" }, version);
    assert.ok(!existsSync(w.inbox), version);
    // Without an actor in the environment, the file of the repository says it.
    const named = workspace({ actor: null });
    writeFileSync(join(named.root, ".howl", "actor"), "\n  agent-from-file  \nother\n");
    assert.equal(run(version, ["emit", "checks.passed"], named.root, named.env).status, 0);
    assert.deepEqual(leftIn(named.home)[0]!.event.actor, { kind: "agent", id: "agent-from-file" }, version);
    // A folder below the root is in the project.
    const below = workspace();
    mkdirSync(join(below.root, "a", "b"), { recursive: true });
    assert.equal(run(version, ["emit", "checks.passed"], join(below.root, "a", "b"), below.env).status, 0);
    assert.equal(leftIn(below.home).length, 1, version);
  }
});

test("#142: the event is checked as the TypeScript checks it: a project, an actor and a task that the schema does not take", { skip: binary }, () => {
  const cases: [string, Record<string, string>, string[]][] = [
    ["an actor with a line break", { HOWL_ACTOR: "a\nb" }, ["checks.passed"]],
    ["a long task", {}, ["checks.passed", "--task", "x".repeat(300)]],
    ["a long data text", {}, ["checks.passed", "--data", JSON.stringify({ a: "x".repeat(100_000) })]],
  ];
  for (const [label, env, args] of cases) {
    const result = VERSIONS.map((version) => {
      const w = workspace();
      return { done: run(version, ["emit", ...args], w.root, { ...w.env, ...env }), left: leftIn(w.home).length };
    });
    assert.deepEqual(result[0], result[1], label);
  }
});

test("#142: an inbox that cannot be written ends as the TypeScript ends: with 2 and the words of the call", { skip: binary }, () => {
  for (const version of VERSIONS) {
    const w = workspace();
    // A file where the project's folder should be.
    writeFileSync(join(w.home, PROJECT), "x");
    const done = run(version, ["emit", "checks.passed"], w.root, w.env);
    assert.equal(done.status, 2, version);
    assert.equal(done.stdout, "", version);
    assert.equal(done.stderr, `howl: ENOTDIR: not a directory, mkdir '${w.inbox}'\n`, version);
  }
});
