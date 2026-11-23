// The seam between the two versions of `howl` while the move to Rust goes on: the tests of issue #137.
// With HOWL_BIN set, `howl()` starts the Rust binary; with HOWL_COMPARE as well, it runs a read-only command through both.
// @code_class tests
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { ACTIVITY_FILE, LEDGER_FILE } from "../src/ledger/names.ts";
import { howl } from "./helpers.ts";

const USAGE = readFileSync(new URL("../src/cli/usage.txt", import.meta.url), "utf8");

test("#137: howl help, -h and --help print the usage text of src/cli/usage.txt, byte for byte", () => {
  for (const arg of ["help", "-h", "--help"]) {
    const run = howl([arg]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, USAGE);
    assert.equal(run.stderr, "");
  }
});

test("#137: a command that is not there ends with 2, names it and gives the usage text on standard error", () => {
  const run = howl(["nonsense"]);
  assert.equal(run.status, 2);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, `howl: no command nonsense\n\n${USAGE}`);
  const none = howl([]);
  assert.equal(none.status, 2);
  assert.equal(none.stderr, `howl: no command\n\n${USAGE}`);
});

test("#137: the file names in usage.txt are those of src/ledger/names.ts", () => {
  assert.ok(USAGE.includes(`in a folder named after the project: ${LEDGER_FILE}, ${ACTIVITY_FILE}, inbox/,`));
});

const bin = process.env.HOWL_BIN;

test("#137: without HOWL_FALLBACK the binary refuses a command it does not do yet, with 2, and names it", { skip: bin ? false : "HOWL_BIN is not set" }, () => {
  const run = spawnSync(resolve(bin!), ["show", "1"], { env: { PATH: process.env.PATH ?? "" }, input: "", encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "howl: show is not built yet\n");
});

test("#137: the binary does help on its own, with no HOWL_FALLBACK", { skip: bin ? false : "HOWL_BIN is not set" }, () => {
  const run = spawnSync(resolve(bin!), ["help"], { env: { PATH: process.env.PATH ?? "" }, input: "", encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, USAGE);
});
