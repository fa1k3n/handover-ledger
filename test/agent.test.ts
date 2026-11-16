// The fold of what an agent is doing, alone: events in, a list of (time, state) out (#39).
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { agentTimeline, stateAt } from "../src/read/agent.ts";
import { agentStates } from "../src/read/state.ts";
import { PROJECT } from "./helpers.ts";

const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const SHA = { a: "a".repeat(40) };
const agent = { kind: "agent" as const, id: "agent-1" };

let n = 0;
function observed(type: string, minute: number, extra: Record<string, unknown> = {}): LedgerEvent {
  return { v: 0, id: `ev-${++n}`, time: at(minute), type, source: { adapter: "github", kind: "observed" }, project: PROJECT, ...extra } as LedgerEvent;
}
function hook(type: string, minute: number, branch: string, extra: Record<string, unknown> = {}): LedgerEvent {
  return { v: 0, id: `ev-${++n}`, time: at(minute), type, source: { adapter: "claude-code-hook", kind: "claimed" }, project: PROJECT, actor: agent, session: "s1", branch, ...extra } as LedgerEvent;
}
const of = (change: string, branch: string, sha: string) => ({ task: "40", change, branch, sha });

test("the fold: the events of a session in, a list of (time, state) out; work ends five minutes after its last sign", () => {
  const events = [
    hook("session.started", 0, "b1"),
    hook("tool.used", 1, "b1", { data: { tool: "Read", target: "src/a.ts", outcome: "succeeded" } }),
    // Not an event of what the agent does: it moves nothing.
    observed("change.opened", 2, { ...of("63", "b1", SHA.a), actor: agent }),
    hook("agent.waiting", 20, "b1", { data: { waits_for: "person" } }),
    hook("tool.used", 21, "b1", { data: { tool: "Edit", target: "src/a.ts", outcome: "succeeded" } }),
    hook("session.stopped", 24, "b1"),
    hook("agent.waiting", 25, "b1", { data: { waits_for: "instructions" } }),
    hook("session.ended", 30, "b1"),
  ];
  const points = agentTimeline(events);
  assert.deepEqual(points, [
    { time: at(0), state: "working" },
    { time: at(6), state: "idle" },
    { time: at(20), state: "needs-input" },
    { time: at(21), state: "working" },
    { time: at(24), state: "waiting" },
    { time: at(30), state: "ended" },
  ]);
  const minute = (m: number) => T0 + m * 60_000;
  assert.equal(stateAt(points, minute(-1)), undefined, "before its first event the agent has no state");
  assert.equal(stateAt(points, minute(5)), "working");
  assert.equal(stateAt(points, minute(6)), "working", "at five minutes it is still working, as the overview had it");
  assert.equal(stateAt(points, minute(6) + 1), "idle");
  assert.equal(stateAt(points, minute(99)), "ended");
});

test("an agent that only sends claims (a change, a review), with no event of a session, is idle in the overview", () => {
  // Before #39 any claimed event of an agent made it working for five minutes; now only the five types of a session move it.
  const now = T0 + 10 * 60_000;
  const claims = [
    hook("change.opened", 9, "b1", { change: "63", source: { adapter: "emit", kind: "claimed" } }),
    hook("review.commented", 9.5, "b1", { change: "63", source: { adapter: "emit", kind: "claimed" } }),
  ];
  const [row] = agentStates(claims, now);
  assert.equal(row!.state, "idle");
  assert.equal(row!.lastType, "review.commented");
  // A session event among them still says what the agent does.
  assert.equal(agentStates([hook("session.started", 8, "b1"), ...claims], now)[0]!.state, "working");
});

test("an event stamped a little ahead of the clock is read as now", () => {
  const now = T0 + 10 * 60_000;
  const ahead = (type: string, extra: Record<string, unknown> = {}) => agentStates([hook(type, 10.5, "b1", extra)], now)[0]!.state;
  assert.equal(ahead("tool.used", { data: { tool: "Edit", target: "src/a.ts", outcome: "succeeded" } }), "working");
  assert.equal(ahead("agent.waiting", { data: { waits_for: "person" } }), "needs-input");
  assert.equal(ahead("session.ended"), "ended");
});
