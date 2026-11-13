// `howl status`: the tests of issue #11.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { howl } from "./helpers.ts";
import { writeStory } from "./story.ts";

test("#11: howl status prints one line per agent with its state and what it works on", () => {
  const ledger = writeStory();
  const result = howl(["status", "--ledger", ledger]);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n").filter((l) => l.startsWith("agent-1"));
  assert.equal(lines.length, 1, result.stdout);
  // The story is long over, so the agent is idle; its last session ended on task 12.
  assert.match(lines[0]!, /ended|idle/);
  assert.match(lines[0]!, /task 12/);
  assert.ok(!result.stdout.includes("person-"), "no person is a row");
});

test("#11: howl status --json gives the rows", () => {
  const ledger = writeStory();
  const rows = JSON.parse(howl(["status", "--ledger", ledger, "--json"]).stdout) as { agent: string; state: string }[];
  assert.deepEqual(
    rows.map((r) => r.agent),
    ["agent-1"],
  );
  assert.ok(["working", "waiting", "idle", "ended"].includes(rows[0]!.state));
});

test("#11: howl status does not change the ledger", () => {
  const ledger = writeStory();
  const before = readFileSync(ledger);
  assert.equal(howl(["status", "--ledger", ledger]).status, 0);
  assert.deepEqual(readFileSync(ledger), before);
});
