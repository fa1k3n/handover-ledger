// The schemas are the source. The TypeScript types are generated from them and
// kept in the repository; this test fails when the two have drifted apart.
// @code_class tests
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { eventFaults, lineFaults } from "../src/ledger/schema.ts";
import { event } from "./helpers.ts";

const root = new URL("../", import.meta.url);
const schema = (name: string) => JSON.parse(readFileSync(new URL(`schema/${name}`, root), "utf8"));

test("the generated types are current for both schemas", () => {
  const script = fileURLToPath(new URL("scripts/gen-types.ts", root));
  const result = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("the event schema names the fields that are always there, and refuses unknown ones", () => {
  const s = schema("event.v0.schema.json");
  assert.deepEqual([...s.required].sort(), ["id", "project", "source", "time", "type", "v"]);
  assert.equal(s.properties.v.const, 0);
  assert.equal(s.additionalProperties, false);
});

test("an event with prev is refused by the event schema", () => {
  assert.deepEqual(eventFaults(event()), []);
  assert.notDeepEqual(eventFaults({ ...event(), prev: null }), []);
  assert.notDeepEqual(eventFaults({ ...event(), prev: "0".repeat(64) }), []);
});

test("a line holds exactly prev, hash and event; an extra field is refused by the line schema", () => {
  const s = schema("line.v0.schema.json");
  assert.deepEqual([...s.required].sort(), ["event", "hash", "prev"]);
  assert.deepEqual(Object.keys(s.properties).sort(), ["event", "hash", "prev"]);

  const line = { prev: null, hash: "a".repeat(64), event: {} };
  assert.deepEqual(lineFaults(line), []);
  assert.deepEqual(lineFaults({ ...line, prev: "b".repeat(64) }), []);
  assert.notDeepEqual(lineFaults({ ...line, colour: "red" }), []);
  for (const field of ["prev", "hash", "event"] as const) {
    const without: Partial<typeof line> = { ...line };
    delete without[field];
    assert.notDeepEqual(lineFaults(without), [], field);
  }
  assert.notDeepEqual(lineFaults({ ...line, hash: "A".repeat(64) }), []);
  assert.notDeepEqual(lineFaults({ ...line, prev: "short" }), []);
});
