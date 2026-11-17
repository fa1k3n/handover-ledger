// #160: the script that takes the figures of `howl` keeps its shape, makes the same inputs from the same seed, refuses
// a slow processor and leaves the demo's folder alone. A test never looks at a time.
// @code_class tests
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { folder } from "./helpers.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/bench.sh", import.meta.url));

function bench(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: folder(), ...env },
    encoding: "utf8",
    input: "",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Every file under a folder, by its path in it, with its bytes. */
function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.set(relative(dir, path), readFileSync(path).toString("base64"));
    }
  };
  walk(dir);
  return files;
}

const CASES = [
  "howl help",
  "howl hook (empty input)",
  "howl hook (PostToolUse)",
  "howl verify",
  "howl show <change>",
  "howl show <change> --json",
  "howl status --json",
  "howl watch --no-follow --filter '...'",
  "howl ingest (1000 inbox files)",
  "howl observe --once (first round)",
  "howl observe --once (nothing new)",
  "howl export --change <change>",
  "howl serve: first /api/overview",
];

test("one run on the 100-line ledger gives a line for each case", () => {
  const run = bench(["--json", "--runs", "1", "--sizes", "100", "--anyway"]);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.runs, 1);
  assert.deepEqual(result.sizes, [100]);
  assert.equal(typeof result.commit, "string");
  assert.equal(typeof result.machine.clock_mhz_max, "number");
  const names = result.cases.map((c: { name: string }) => c.name);
  for (const name of CASES) assert.ok(names.includes(name), `no line for ${name}: ${names.join(", ")}`);
  for (const c of result.cases) {
    // A case is timed, or says why it was not (the page is not built on a machine that has not built it).
    if (c.skipped !== undefined) assert.equal(typeof c.skipped, "string");
    else for (const field of ["median_ms", "p90_ms", "peak_kb"]) assert.equal(typeof c[field], "number", `${c.name}: ${field}`);
  }
  for (const name of CASES.filter((n) => !n.includes("serve"))) {
    const c = result.cases.find((x: { name: string }) => x.name === name);
    assert.equal(c.skipped, undefined, `${name} was skipped: ${c.skipped}`);
  }
  assert.ok(result.installed.length > 0);
});

test("the same seed gives byte-identical inputs, another seed does not", () => {
  const [a, b, c] = [folder(), folder(), folder()];
  for (const [dir, seed] of [[a, "5"], [b, "5"], [c, "6"]] as const) {
    const run = bench(["--make", dir, "--sizes", "100", "--seed", seed]);
    assert.equal(run.status, 0, run.stderr);
  }
  const first = snapshot(a);
  assert.ok(first.has("home-100/bench/ledger.jsonl") && first.has("home-100/bench/activity.jsonl"));
  assert.ok(first.has("repo/.howl/howl.yml") && first.has("manifest.json"));
  assert.equal([...first.keys()].filter((k) => k.startsWith("ingest-base/bench/inbox/")).length, 1000);
  assert.deepEqual(snapshot(b), first);
  assert.notDeepEqual(snapshot(c).get("home-100/bench/ledger.jsonl"), first.get("home-100/bench/ledger.jsonl"));
  const ledger = Buffer.from(first.get("home-100/bench/ledger.jsonl")!, "base64").toString("utf8");
  assert.equal(ledger.split("\n").length - 1, 100);
});

test("a ledger made for the cases verifies", () => {
  const dir = folder();
  assert.equal(bench(["--make", dir, "--sizes", "100,300"]).status, 0);
  const cli = fileURLToPath(new URL("../src/cli/howl.ts", import.meta.url));
  for (const size of ["100", "300"]) {
    const run = spawnSync(process.execPath, [cli, "verify", "--ledger", join(dir, `home-${size}`, "bench", "ledger.jsonl")], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  }
});

/** A demo folder that does nothing but print what it was asked and leave a mark where it ran. */
function fakeDemo(): string {
  const dir = folder();
  mkdirSync(join(dir, "demo"));
  writeFileSync(join(dir, "demo", "run"), '#!/bin/sh\necho "$@"\ntouch ran-here\n');
  chmodSync(join(dir, "demo", "run"), 0o755);
  return dir;
}

test("a low clock is refused, and --anyway runs anyway", () => {
  const dir = folder();
  writeFileSync(join(dir, "cpuinfo"), "processor\t: 0\ncpu MHz\t\t: 200.000\n\nprocessor\t: 1\ncpu MHz\t\t: 400.000\n");
  writeFileSync(join(dir, "max"), "3900000\n");
  const env = { BENCH_CPUINFO: join(dir, "cpuinfo"), BENCH_MAX_FREQ: join(dir, "max") };
  const demo = fakeDemo();
  const refused = bench(["--only", "demo", "--demo", demo, "--runs", "1"], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /400 MHz, below half of its 3900 MHz/);
  assert.equal(refused.stdout, "");
  const allowed = bench(["--only", "demo", "--demo", demo, "--runs", "1", "--anyway"], env);
  assert.equal(allowed.status, 0, allowed.stderr);
});

test("--demo times each step of a fake demo and leaves its folder untouched", () => {
  const demo = fakeDemo();
  const before = snapshot(demo);
  const kept = folder();
  const run = bench(["--json", "--only", "demo", "--demo", demo, "--runs", "2", "--anyway", "--keep", kept]);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  const steps = result.cases.filter((c: { group: string }) => c.group === "demo").map((c: { name: string }) => c.name);
  for (const step of ["reset", "history", "task", "open", "review", "fix", "approve", "merge", "busy", "claim", "tamper", "cut", "secret"]) {
    assert.ok(steps.includes(`demo ${step}`), `no line for ${step}`);
  }
  for (const c of result.cases) {
    assert.equal(c.skipped, undefined);
    for (const field of ["median_ms", "p90_ms", "peak_kb"]) assert.equal(typeof c[field], "number");
  }
  assert.deepEqual(snapshot(demo), before, "the demo's folder was changed");
  assert.ok(readdirSync(kept).some((n) => n.endsWith(".show.txt")) && readdirSync(kept).some((n) => n.endsWith(".status.json")));
  assert.ok(statSync(demo).isDirectory());
});

test("the text form has a line for each case, says what it ran on, and has no demo without a folder", () => {
  const run = bench(["--runs", "1", "--sizes", "100", "--anyway"]);
  assert.equal(run.status, 0, run.stderr);
  for (const name of CASES) assert.ok(run.stdout.includes(name), `no line for ${name}`);
  assert.match(run.stdout, /^# machine: .*clock \d+ MHz/m);
  assert.match(run.stdout, /^# runs: 1 after one warm-up; seed: 1; sizes: 100/m);
  assert.doesNotMatch(run.stdout, /demo reset/);
});

test("--compare masks times and ids and names what still differs", () => {
  const [a, b] = [folder(), folder()];
  writeFileSync(join(a, "1.show.txt"), "2026-11-17 08:49:22  head 13b63c3 by person-599cbb79, 19s\nround 1\n");
  writeFileSync(join(b, "1.show.txt"), "2026-11-18 09:01:00  head ec039de by person-a545e572, 24s\nround 1\n");
  const same = bench(["--compare", a, b]);
  assert.equal(same.status, 0, same.stdout);
  writeFileSync(join(b, "1.show.txt"), "2026-11-18 09:01:00  head ec039de by person-a545e572, 24s\nround 2\n");
  const different = bench(["--compare", a, b]);
  assert.equal(different.status, 1);
  assert.match(different.stdout, /differs: 1\.show\.txt/);
});

test("a wrong option is refused with status 2", () => {
  assert.equal(bench(["--runs", "0"]).status, 2);
  assert.equal(bench(["--sizes", "a"]).status, 2);
  assert.equal(bench(["--nonsense"]).status, 2);
});
