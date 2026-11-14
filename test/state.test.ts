// The state of each agent, folded from the events: the tests of issue #11.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { agentStates, renderStatus, WORKING_WITHIN_MS } from "../src/read/state.ts";
import { PROJECT } from "./helpers.ts";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

let n = 0;
function agentEvent(actor: string, type: LedgerEvent["type"], secondsAgo: number, extra: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    v: 0,
    id: `e-${++n}`,
    time: ago(secondsAgo),
    type,
    source: { adapter: "claude-code-hook", kind: "claimed" },
    project: PROJECT,
    actor: { kind: "agent", id: actor },
    session: `${actor}-s`,
    branch: "task-12-x",
    ...extra,
  };
}
const tool = (actor: string, secondsAgo: number, name: string, target: string, extra: Partial<LedgerEvent> = {}) =>
  agentEvent(actor, "tool.used", secondsAgo, { data: { tool: name, target, outcome: "succeeded" }, ...extra });

test("#11: a session with tool calls a minute ago is working, with the last tool", () => {
  const rows = agentStates(
    [
      agentEvent("agent-1", "session.started", 300, { model: "claude-opus-5-5", effort: "high" }),
      tool("agent-1", 120, "Read", "src/a.ts"),
      tool("agent-1", 60, "Bash", "make"),
    ],
    NOW,
  );
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row!.agent, "agent-1");
  assert.equal(row!.state, "working");
  assert.equal(row!.tool, "Bash");
  assert.equal(row!.target, "make");
  assert.equal(row!.model, "claude-opus-5-5");
  assert.equal(row!.effort, "high");
  assert.equal(row!.last, ago(60));
});

test("#11, #16: an idle wait after the tool calls is waiting, and a later tool call makes it working again", () => {
  const events = [
    tool("agent-1", 200, "Bash", "make"),
    agentEvent("agent-1", "agent.waiting", 100, { data: { notification_type: "idle_prompt" } }),
  ];
  assert.equal(agentStates(events, NOW)[0]!.state, "waiting");
  assert.equal(agentStates([...events, tool("agent-1", 30, "Edit", "src/a.ts")], NOW)[0]!.state, "working");
});

test("#11: a stopped turn waits for its next prompt; session.ended with nothing after is ended", () => {
  assert.equal(agentStates([tool("agent-1", 30, "Bash", "make"), agentEvent("agent-1", "session.stopped", 20)], NOW)[0]!.state, "waiting");
  assert.equal(agentStates([tool("agent-1", 30, "Bash", "make"), agentEvent("agent-1", "session.ended", 20)], NOW)[0]!.state, "ended");
});

test("#11: an agent whose last tool call is older than the working window is idle", () => {
  const old = WORKING_WITHIN_MS / 1000 + 60;
  assert.equal(agentStates([tool("agent-1", old, "Bash", "make")], NOW)[0]!.state, "idle");
});

test("#11: an event that names change gives the row its change, over the branch", () => {
  const opened: LedgerEvent = {
    v: 0,
    id: "obs-1",
    time: ago(900),
    type: "change.opened",
    source: { adapter: "github", kind: "observed" },
    project: PROJECT,
    change: "30",
    task: "12",
    branch: "task-12-x",
  };
  // From the branch: the change opened on it, and its task.
  const fromBranch = agentStates([opened, tool("agent-1", 30, "Bash", "make")], NOW)[0]!;
  assert.equal(fromBranch.change, "30");
  assert.equal(fromBranch.task, "12");
  // Named on the event: it wins, even on a branch with a change of its own.
  const named = agentStates([opened, tool("agent-1", 30, "Bash", "gh", { branch: "main", change: "31", task: "13" })], NOW)[0]!;
  assert.equal(named.change, "31");
  assert.equal(named.task, "13");
});

test("#11: the task comes from the branch name when the project says how", () => {
  const row = agentStates([tool("agent-1", 30, "Bash", "make", { branch: "task-14-x" })], NOW, { taskFromBranch: /^task-([0-9]+)/ })[0]!;
  assert.equal(row.task, "14");
  assert.equal(row.change, undefined);
});

test("#11: a person's events give no row", () => {
  const person: LedgerEvent = {
    v: 0,
    id: "p-1",
    time: ago(10),
    type: "review.approved",
    source: { adapter: "github", kind: "observed" },
    project: PROJECT,
    actor: { kind: "person", id: "person-0a0a0a0a" },
    change: "30",
  };
  assert.deepEqual(agentStates([person], NOW), []);
});

test("#11: two agents give two rows, the most recent first", () => {
  const rows = agentStates([tool("agent-1", 100, "Bash", "make"), tool("agent-2", 10, "Read", "x"), tool("agent-1", 200, "Read", "y")], NOW);
  assert.deepEqual(
    rows.map((r) => r.agent),
    ["agent-2", "agent-1"],
  );
});

test("#16: a permission prompt needs input; an idle prompt only waits; a later tool call is working", () => {
  const ask = (kind: string) => [tool("agent-1", 200, "Bash", "make"), agentEvent("agent-1", "agent.waiting", 100, { data: { notification_type: kind } })];
  assert.equal(agentStates(ask("permission_prompt"), NOW)[0]!.state, "needs-input");
  assert.equal(agentStates(ask("elicitation_dialog"), NOW)[0]!.state, "needs-input");
  assert.equal(agentStates(ask("idle_prompt"), NOW)[0]!.state, "waiting");
  assert.equal(agentStates([...ask("permission_prompt"), tool("agent-1", 10, "Bash", "make")], NOW)[0]!.state, "working");
});

test("#16: rows that need input come first, before more recent ones", () => {
  const rows = agentStates(
    [
      tool("agent-1", 300, "Bash", "make"),
      agentEvent("agent-1", "agent.waiting", 250, { data: { notification_type: "permission_prompt" } }),
      tool("agent-2", 5, "Read", "x"),
    ],
    NOW,
  );
  assert.deepEqual(
    rows.map((r) => `${r.agent} ${r.state}`),
    ["agent-1 needs-input", "agent-2 working"],
  );
});

test("#16: howl status prints NEEDS INPUT first and counts it", () => {
  const rows = agentStates(
    [tool("agent-2", 5, "Read", "x"), agentEvent("agent-1", "agent.waiting", 60, { data: { notification_type: "permission_prompt" } })],
    NOW,
  );
  const lines = renderStatus(rows, NOW).split("\n");
  assert.match(lines[0]!, /^agent-1\s+NEEDS INPUT/);
  assert.match(lines.at(-1)!, /1 needs? input/);
});

test("#17: the role is that of the current session, not an earlier one", () => {
  const rows = agentStates(
    [
      agentEvent("agent-1", "session.started", 600, { session: "old", role: "build" }),
      agentEvent("agent-1", "session.ended", 500, { session: "old", role: "build" }),
      agentEvent("agent-1", "session.started", 100, { session: "new", role: "review" }),
      tool("agent-1", 30, "Bash", "gh", { session: "new", role: "review" }),
    ],
    NOW,
  );
  assert.equal(rows[0]!.role, "review");
  const none = agentStates([agentEvent("agent-1", "session.started", 600, { session: "old", role: "build" }), tool("agent-1", 30, "Bash", "gh", { session: "new" })], NOW);
  assert.equal(none[0]!.role, undefined, "a session that names no role has none");
});

test("#17: howl status shows the role after the state", () => {
  const rows = agentStates([tool("agent-1", 30, "Bash", "gh", { role: "review" })], NOW);
  assert.match(renderStatus(rows, NOW).split("\n")[0]!, /^agent-1\s+working\s+review\s/);
});

test("#26: a session that names no change or task has the gap; one with HOWL_CHANGE has none", () => {
  const bare = agentStates([tool("agent-1", 30, "Bash", "gh", { branch: "main" })], NOW)[0]!;
  assert.ok(bare.gaps.includes("no change or task named"), JSON.stringify(bare.gaps));
  const named = agentStates([tool("agent-1", 30, "Bash", "gh", { branch: "main", change: "30", role: "review" })], NOW)[0]!;
  assert.deepEqual(named.gaps, []);
});

test("#26: a session without a role has the gap", () => {
  const row = agentStates([tool("agent-1", 30, "Bash", "gh", { change: "30" })], NOW)[0]!;
  assert.deepEqual(row.gaps, ["no role"]);
});

test("#26: an agent whose earlier session was signed and whose current one is not has the gap 'unsigned'", () => {
  const sig = { key: "c".repeat(64), value: "x" };
  const row = agentStates(
    [
      agentEvent("agent-1", "session.started", 3600, { session: "old", change: "30", role: "review", sig }),
      agentEvent("agent-1", "session.started", 60, { session: "new", change: "31", role: "review" }),
    ],
    NOW,
  )[0]!;
  assert.deepEqual(row.gaps, ["unsigned"]);
});

test("#26: howl status shows a row's gaps", () => {
  const rows = agentStates([tool("agent-1", 30, "Bash", "gh", { branch: "main" })], NOW);
  assert.match(renderStatus(rows, NOW), /missing: no change or task named, no role/);
});
