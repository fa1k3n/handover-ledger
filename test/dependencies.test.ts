// The dashboard brings no runtime dependency to howl: the test of issue #12.
// @code_class tests
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("#12: the runtime dependencies of howl have not grown", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.dependencies), ["ajv"]);
});
