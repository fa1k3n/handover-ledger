// What needs a person is shown above the event list: the band's items from the agents' rows (#190).
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { needsPersonItems } from "../src/dashboard/format.ts";
import type { AgentRow, AgentState } from "../src/read/state.ts";

const NOW = Date.parse("2026-11-23T10:00:00Z");
const row = (agent: string, state: AgentState, last: string, more: Partial<AgentRow> = {}): AgentRow => ({ agent, state, last, gaps: [], ...more });

test("#190: a row in needs input makes an item, with its mark, agent, subject, how long and its session", () => {
  const items = needsPersonItems([row("agent-1", "needs-input", "2026-11-23T09:50:00Z", { task: "12", change: "30", session: "s-1" })], NOW);
  assert.equal(items.length, 1);
  const [it] = items;
  assert.equal(it!.mark, "◷");
  assert.equal(it!.agent, "agent-1");
  assert.equal(it!.subject, "task 12 · change 30");
  assert.equal(it!.since, "10 min");
  assert.equal(it!.session, "s-1");
});

test("#190: working, idle, ended and waiting for instructions make no item", () => {
  const states: AgentState[] = ["working", "idle", "ended", "waiting"];
  const rows = states.map((s) => row(`a-${s}`, s, "2026-11-23T09:59:00Z"));
  assert.deepEqual(needsPersonItems(rows, NOW), []);
});

test("#190: the longest wait comes first", () => {
  const items = needsPersonItems(
    [row("late", "needs-input", "2026-11-23T09:58:00Z"), row("early", "needs-input", "2026-11-23T09:10:00Z"), row("mid", "needs-input", "2026-11-23T09:40:00Z"), row("busy", "working", "2026-11-23T09:00:00Z")],
    NOW,
  );
  assert.deepEqual(items.map((i) => i.agent), ["early", "mid", "late"]);
});

test("#190: established by is a claim, never observed", () => {
  const [it] = needsPersonItems([row("agent-1", "needs-input", "2026-11-23T09:50:00Z")], NOW);
  assert.equal(it!.established.code, "CLAIM");
  assert.equal(it!.established.claimed, true);
});

test("#190: no row, or none that needs a person, gives an empty band", () => {
  assert.deepEqual(needsPersonItems([], NOW), []);
});
