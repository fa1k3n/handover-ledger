// A process that follows or repeats ends as soon as it is stopped: the tests of issue #7.
// @code_class tests
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { folder, PROJECT, workspace } from "./helpers.ts";
import { LocalHost } from "./local-host.ts";
import { writeStory } from "./story.ts";

const CLI = fileURLToPath(new URL("../src/cli/howl.ts", import.meta.url));

/** Starts howl, waits until `ready` is true, sends SIGTERM and returns how long it took to end. */
async function stopTime(args: string[], opts: { cwd?: string; env?: Record<string, string> }, ready: (out: string) => boolean): Promise<number> {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: opts.cwd, env: { PATH: process.env.PATH ?? "", ...opts.env } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  const end = Date.now() + 10_000;
  while (!ready(out)) {
    if (Date.now() > end) {
      child.kill("SIGKILL");
      throw new Error(`never ready: ${out}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const t = Date.now();
  child.kill("SIGTERM");
  // A process that does not end within 5 s has failed; it is killed so the test ends.
  const gaveUp = await Promise.race([closed.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 5000))]);
  if (gaveUp) {
    child.kill("SIGKILL");
    await closed;
  }
  return Date.now() - t;
}

test("#7: howl observe with a long interval ends at once on SIGTERM, and leaves no lock", async () => {
  const dir = folder();
  new LocalHost(dir);
  const ws = workspace({ yml: `project: ${PROJECT}\nhost: local\nlocal: ${dir}\nrepository: team/product\n` });
  const ms = await stopTime(["observe", "--interval", "600"], { cwd: ws.root, env: ws.env }, () => existsSync(ws.ledger));
  assert.ok(ms < 3000, `took ${ms} ms`);
  assert.ok(!existsSync(`${ws.ledger}.lock`), "the lock is released");
});

test("#7: howl status --follow ends at once on SIGTERM", async () => {
  const ledger = writeStory();
  const ms = await stopTime(["status", "--ledger", ledger, "--follow"], {}, (out) => out.includes("agent-1"));
  assert.ok(ms < 3000, `took ${ms} ms`);
});

test("#7: howl watch ends at once on SIGTERM", async () => {
  const ledger = writeStory();
  const ms = await stopTime(["watch", "--ledger", ledger, "--interval", "600"], {}, (out) => out.includes("change.merged"));
  assert.ok(ms < 3000, `took ${ms} ms`);
});
