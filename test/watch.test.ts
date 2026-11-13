// `howl watch`: the tests of issue #4.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openLedger } from "../src/ledger/ledger.ts";
import { event, howl, PROJECT, rawLines } from "./helpers.ts";
import { m, writeStory } from "./story.ts";

const CLI = fileURLToPath(new URL("../src/cli/howl.ts", import.meta.url));
const ESC = "\u001b[";

/** `howl watch` without following: what is there, then it ends. */
function once(ledger: string, args: string[] = [], env: Record<string, string> = {}) {
  return howl(["watch", "--ledger", ledger, "--no-follow", ...args], { env });
}

function eventLines(stdout: string): string[] {
  return stdout.split("\n").filter((l) => /^\d{4}-/.test(l));
}

test("howl watch prints one line per event with time, actor, type and what it concerns", () => {
  const ledger = writeStory();
  const result = once(ledger);
  assert.equal(result.status, 0, result.stderr);
  const lines = eventLines(result.stdout);
  // The ledger without its first line, and the activity file.
  assert.equal(lines.length, rawLines(ledger).length - 1 + 6);
  const assigned = lines.find((l) => l.includes("task.assigned") && l.includes("task 12"));
  assert.ok(assigned, result.stdout);
  assert.match(assigned, /^2026-01-01T08:00:00Z/);
  assert.match(assigned, /agent-1/);
  const tool = lines.find((l) => l.includes("tool.used") && l.includes("src/b.ts"));
  assert.ok(tool, "a tool call shows its file");
  assert.match(lines.find((l) => l.includes("tool.used") && l.includes("make"))!, /Bash/);
  assert.match(lines.find((l) => l.includes("checks.failed"))!, /change 30/);
});

test("the lines come in the order of time, and say whether an event is claimed or observed", () => {
  const lines = eventLines(once(writeStory()).stdout);
  const times = lines.map((l) => l.slice(0, 20));
  assert.deepEqual(times, [...times].sort());
  assert.ok(lines.some((l) => / claimed /.test(l)));
  assert.ok(lines.some((l) => / observed /.test(l)));
});

test("--since passes over what happened before it", () => {
  const lines = eventLines(once(writeStory(), ["--since", m(55)]).stdout);
  assert.deepEqual(
    lines.map((l) => l.match(/ (\w+\.\w+) /)?.[1]),
    ["review.approved", "change.merged"],
  );
});

test("--filter with one pair, with two pairs, and with a type ending in *", () => {
  const ledger = writeStory();
  const count = (...pairs: string[]) => eventLines(once(ledger, pairs.flatMap((p) => ["--filter", p])).stdout).length;
  assert.equal(count("type=tool.used"), 6);
  assert.equal(count("type=tool.used", "session=s2"), 1);
  assert.equal(count("type=review.*"), 2);
  assert.equal(count("kind=claimed", "type=session.*"), 6);
  assert.equal(count("change=30", "type=checks.*"), 3);
  assert.equal(count("actor=agent-1", "type=task.assigned"), 2);
  assert.equal(count("type=nothing.here"), 0);
});

test("a wrong filter is refused", () => {
  const result = once(writeStory(), ["--filter", "no-equals-sign"]);
  assert.equal(result.status, 2);
});

test("--json gives the lines of the ledger and the activity file unchanged", () => {
  const ledger = writeStory();
  const out = once(ledger, ["--json"]).stdout.split("\n").filter(Boolean);
  const activity = readFileSync(ledger.replace(/ledger\.jsonl$/, "activity.jsonl"), "utf8").split("\n").filter(Boolean);
  const ledgerLines = rawLines(ledger).slice(1);
  assert.deepEqual([...out].sort(), [...ledgerLines, ...activity].sort());
});

test("no colour codes when the output is not a terminal, and none with NO_COLOR", () => {
  const ledger = writeStory();
  assert.ok(!once(ledger).stdout.includes(ESC), "not a terminal");
  const forced = once(ledger, [], { FORCE_COLOR: "1" }).stdout;
  assert.ok(forced.includes(ESC), "FORCE_COLOR gives colour, so the test can see it");
  assert.ok(!once(ledger, [], { FORCE_COLOR: "1", NO_COLOR: "1" }).stdout.includes(ESC));
});

test("a wait for a person, failed checks and a review asking for changes stand out; an idle wait does not", () => {
  // A coloured line starts with its colour code, so the lines are not picked by their date.
  const lines = once(writeStory(), [], { FORCE_COLOR: "1" }).stdout.split("\n");
  const marked = (needle: string) => lines.find((l) => l.includes(needle))!.includes(ESC);
  assert.ok(marked("permission_prompt"));
  assert.ok(marked("checks.failed"));
  assert.ok(marked("review.changes_requested"));
  assert.ok(!marked("idle_prompt"));
  assert.ok(!marked("checks.passed"));
});

test("an event appended while it follows is printed; a half-written last line is not, and is printed when it is whole", async () => {
  const ledger = writeStory();
  const child = spawn(process.execPath, [CLI, "watch", "--ledger", ledger, "--interval", "0.05"], {
    env: { PATH: process.env.PATH ?? "" },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const closed = new Promise((resolve) => child.on("close", resolve));
  try {
    await until(() => out.includes("change.merged"));

    const writer = openLedger(ledger, { project: PROJECT });
    writer.append(event({ id: "late-1", type: "session.started", time: m(70), session: "late" }));
    writer.close();
    await until(() => /session late\b/.test(out));

    // Half a line: the writer of a ledger never leaves one for long, but a reader can meet one.
    const line = JSON.stringify({ prev: null, hash: "0".repeat(64), event: event({ id: "late-2", type: "session.ended", time: m(71), session: "half" }) });
    appendFileSync(ledger, line.slice(0, 40));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!/session half\b/.test(out), "half a line is not printed");
    appendFileSync(ledger, `${line.slice(40)}\n`);
    await until(() => /session half\b/.test(out));
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
});

test("howl watch does not change the ledger or take its lock", () => {
  const ledger = writeStory();
  const before = readFileSync(ledger);
  const mtime = statSync(ledger).mtimeMs;
  const entries = readdirSync(dirname(ledger)).sort();
  const writer = openLedger(ledger, { project: PROJECT });
  try {
    assert.equal(once(ledger).status, 0);
  } finally {
    writer.close();
  }
  assert.deepEqual(readFileSync(ledger), before);
  assert.equal(statSync(ledger).mtimeMs, mtime);
  assert.deepEqual(readdirSync(dirname(ledger)).sort(), entries);
});

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
