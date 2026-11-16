// The fold of what an agent is doing, alone: events in, a list of (time, state) out (#39).
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { agentTimeline, stateAt } from "../src/read/agent.ts";
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
