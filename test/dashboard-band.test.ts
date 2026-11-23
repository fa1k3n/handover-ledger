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

test("#190: how long and the order follow the start of the wait, not the last event", () => {
  const items = needsPersonItems(
    [row("a", "needs-input", "2026-11-23T09:59:00Z", { since: "2026-11-23T09:00:00Z" }), row("b", "needs-input", "2026-11-23T09:30:00Z", { since: "2026-11-23T09:30:00Z" })],
    NOW,
  );
  assert.deepEqual(items.map((i) => i.agent), ["a", "b"]);
  assert.equal(items[0]!.since, "1 h 00 min");
});

import { waitFilter, waitRowKeys, itemKey } from "../src/dashboard/format.ts";
import type { Item } from "../src/serve/server.ts";

const wait = (n: number, agent: string, waitsFor: string, project?: string): Item =>
  ({ n, from: "ledger", raw: "{}", ...(project ? { project } : {}), event: { v: 0, id: `w${n}`, time: "2026-11-23T09:00:00Z", type: "agent.waiting", actor: { kind: "agent", id: agent }, source: { adapter: "hook", kind: "claimed" }, data: { waits_for: waitsFor } } }) as unknown as Item;

test("#190: the bar goes on the latest wait for a person of an agent that needs input, and on no other", () => {
  const list = [wait(5, "a", "person"), wait(4, "b", "instructions"), wait(3, "a", "person"), wait(2, "c", "person")];
  const keys = waitRowKeys(list, [row("a", "needs-input", "2026-11-23T09:00:00Z"), row("b", "needs-input", "2026-11-23T09:00:00Z"), row("c", "working", "2026-11-23T09:00:00Z")], null);
  assert.deepEqual([...keys], [itemKey(list[0]!)]);
});

test("#190: with several projects, only the project of the band", () => {
  const list = [wait(5, "a", "person", "other"), wait(4, "a", "person", "mine")];
  const keys = waitRowKeys(list, [row("a", "needs-input", "2026-11-23T09:00:00Z")], "mine");
  assert.deepEqual([...keys], [itemKey(list[1]!)]);
});

test("#190: the filter quotes an agent id with a quote and a backslash, with and without a project", () => {
  const id = 'a"b\\c';
  assert.equal(waitFilter(id, null), `event.type == "agent.waiting" && has(event.actor) && event.actor.id == "a\\"b\\\\c"`);
  assert.equal(waitFilter(id, 'p"q'), `event.type == "agent.waiting" && has(event.actor) && event.actor.id == "a\\"b\\\\c" && event.project == "p\\"q"`);
});
