// The start of a wait for a person, given by the reader (#190).
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { agentStates } from "../src/read/state.ts";
import { PROJECT } from "./helpers.ts";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
let n = 0;
const ev = (type: LedgerEvent["type"], secondsAgo: number, extra: Partial<LedgerEvent> = {}): LedgerEvent => ({
  v: 0,
  id: `s-${++n}`,
  time: ago(secondsAgo),
  type,
  source: { adapter: "claude-code-hook", kind: "claimed" },
  project: PROJECT,
  actor: { kind: "agent", id: "agent-1" },
  session: "s-1",
  ...extra,
});

test("#190: a row needing input has `since`, the time its wait began", () => {
  const [row] = agentStates([ev("session.started", 900), ev("agent.waiting", 600, { data: { waits_for: "person" } })], NOW);
  assert.equal(row!.state, "needs-input");
  assert.equal(row!.since, ago(600));
});

test("#190: a second wait for a person does not move `since`", () => {
  const [row] = agentStates([ev("agent.waiting", 600, { data: { waits_for: "person" } }), ev("agent.waiting", 300, { data: { waits_for: "person" } })], NOW);
  assert.equal(row!.since, ago(600));
});

test("#190: a later observed event or a task given to the agent does not move `since`", () => {
  const rows = agentStates(
    [
      ev("agent.waiting", 600, { data: { waits_for: "person" } }),
      ev("review.requested", 120, { source: { adapter: "github", kind: "observed" } }),
      ev("task.assigned", 60, { actor: { kind: "person", id: "p-1" }, to: { kind: "agent", id: "agent-1" } }),
    ],
    NOW,
  );
  const row = rows.find((r) => r.agent === "agent-1")!;
  assert.equal(row.state, "needs-input");
  assert.equal(row.since, ago(600));
  assert.equal(row.last, ago(60));
});

test("#190: a row not needing input has no `since`", () => {
  const [row] = agentStates([ev("agent.waiting", 600, { data: { waits_for: "instructions" } })], NOW);
  assert.equal(row!.since, undefined);
});
