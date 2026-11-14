// `howl emit`: the tests of issue #2.
// @code_class tests
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { eventFaults } from "../src/ledger/schema.ts";
import { folder, howl, inboxEvents, inboxFiles, PROJECT, workspace } from "./helpers.ts";

test("howl emit with a type and data gives one inbox file", () => {
  const ws = workspace();
  const result = howl(["emit", "checks.passed", "--change", "123", "--task", "45", "--data", '{"check":"static-analysis"}'], {
    cwd: ws.root,
    env: ws.env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const events = inboxEvents(ws.inbox);
  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.type, "checks.passed");
  assert.equal(e.change, "123");
  assert.equal(e.task, "45");
  assert.deepEqual(e.data, { check: "static-analysis" });
  assert.deepEqual(e.source, { adapter: "emit", kind: "claimed" });
  assert.equal(e.project, PROJECT);
  assert.deepEqual(e.actor, { kind: "agent", id: "agent-1" });
  assert.deepEqual(eventFaults(e), []);
});

test("howl emit without an actor writes the event with no actor", () => {
  const ws = workspace({ actor: null });
  assert.equal(howl(["emit", "checks.passed"], { cwd: ws.root, env: ws.env }).status, 0);
  assert.equal(inboxEvents(ws.inbox)[0]?.actor, undefined);
});

test("howl emit takes the actor from .howl/actor", () => {
  const ws = workspace({ actor: null });
  writeFileSync(join(ws.root, ".howl", "actor"), "agent-from-file\n");
  assert.equal(howl(["emit", "checks.passed"], { cwd: ws.root, env: ws.env }).status, 0);
  assert.deepEqual(inboxEvents(ws.inbox)[0]?.actor, { kind: "agent", id: "agent-from-file" });
});

test("a wrong JSON ends with 1 and writes nothing", () => {
  const ws = workspace();
  for (const data of ["{not json", "[1,2]", '"text"', "null"]) {
    const result = howl(["emit", "checks.passed", "--data", data], { cwd: ws.root, env: ws.env });
    assert.equal(result.status, 1, data);
    assert.match(result.stderr, /--data/);
  }
  assert.deepEqual(inboxFiles(ws.inbox), []);
});

test("a wrong type ends with 1 and writes nothing", () => {
  const ws = workspace();
  for (const type of ["check.pased", "ledger.created"]) {
    const result = howl(["emit", type], { cwd: ws.root, env: ws.env });
    assert.equal(result.status, 1, type);
    assert.match(result.stderr, /type/);
  }
  assert.deepEqual(inboxFiles(ws.inbox), []);
});

test("howl emit without a type ends with 1", () => {
  const ws = workspace();
  assert.equal(howl(["emit"], { cwd: ws.root, env: ws.env }).status, 1);
});

test("outside a repository with .howl/howl.yml, howl emit writes nothing and ends with 0", () => {
  const ws = workspace();
  const result = howl(["emit", "checks.passed"], { cwd: folder(), env: ws.env });
  assert.equal(result.status, 0);
  assert.deepEqual(readdirSync(ws.home), []);
  assert.ok(!existsSync(ws.inbox));
});
