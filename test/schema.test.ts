// The schema is the source. The TypeScript types are generated from it and
// kept in the repository; this test fails when the two have drifted apart.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

test("the TypeScript types are those the schema gives", () => {
  const script = fileURLToPath(new URL("scripts/gen-types.ts", root));
  const result = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("the schema names the fields that are always there, and refuses unknown ones", () => {
  const schema = JSON.parse(readFileSync(new URL("schema/event.v0.schema.json", root), "utf8"));
  assert.deepEqual(
    [...schema.required].sort(),
    ["id", "prev", "project", "source", "time", "type", "v"],
  );
  assert.equal(schema.properties.v.const, 0);
  assert.equal(schema.additionalProperties, false);
});
