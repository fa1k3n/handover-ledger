// The readers speak howl's words for a wait, not one agent tool's. The tests of issue #29.
import assert from "node:assert/strict";
import { test } from "node:test";
import { standsOut } from "../src/dashboard/format.ts";
import { runHook } from "../src/hook/hook.ts";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { parseAsked, show } from "../src/read/show.ts";
import { agentStates } from "../src/read/state.ts";
import { waitsFor } from "../src/read/wait.ts";
import { formatLine } from "../src/read/watch.ts";
import { inboxEvents, PROJECT, workspace } from "./helpers.ts";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const YELLOW = "\u001b[33m";

let n = 0;
function claimed(type: LedgerEvent["type"], secondsAgo: number, data?: Record<string, unknown>): LedgerEvent {
  return {
    v: 0,
    id: `w-${++n}`,
    time: ago(secondsAgo),
    type,
    source: { adapter: "other-tool-hook", kind: "claimed" },
    project: PROJECT,
    actor: { kind: "agent", id: "agent-9" },
    session: "s9",
    task: "12",
    ...(data ? { data } : {}),
  };
}
const waiting = (data: Record<string, unknown>) => [claimed("session.started", 120), claimed("agent.waiting", 60, data)];

async function hookWait(kind: string): Promise<LedgerEvent | undefined> {
  const w = workspace();
  const input = { session_id: "s1", cwd: w.root, hook_event_name: "Notification", message: "never kept", notification_type: kind };
  await runHook(JSON.stringify(input), w.env, w.root);
  return inboxEvents(w.inbox)[0];
}

test("#29: the hook writes waits_for: person for a permission prompt and instructions for an idle prompt, beside the tool's own kind", async () => {
  assert.deepEqual((await hookWait("permission_prompt"))?.data, { notification_type: "permission_prompt", waits_for: "person" });
  assert.deepEqual((await hookWait("idle_prompt"))?.data, { notification_type: "idle_prompt", waits_for: "instructions" });
});

test("#29: a wait from another tool with waits_for: person and an unknown kind needs input everywhere", () => {
  const events = waiting({ notification_type: "asks_the_human", waits_for: "person" });
  const wait = events[1]!;
  assert.equal(waitsFor(wait), "person");
  assert.equal(agentStates(events, NOW)[0]!.state, "needs-input");
  const shown = show(events, parseAsked("12"), null);
  assert.equal(shown!.sessions[0]!.waits[0]!.kind, "person");
  assert.ok(formatLine(wait, true).startsWith(YELLOW), "stands out in howl watch");
  assert.equal(standsOut({ from: "ledger", event: wait, raw: "" } as never), "warn");
});

test("#29: a wait from another tool with waits_for: instructions and an unknown kind is waiting, and does not stand out", () => {
  const events = waiting({ notification_type: "done_for_now", waits_for: "instructions" });
  const wait = events[1]!;
  assert.equal(waitsFor(wait), "instructions");
  assert.equal(agentStates(events, NOW)[0]!.state, "waiting");
  assert.equal(show(events, parseAsked("12"), null)!.sessions[0]!.waits[0]!.kind, "instructions");
  assert.ok(!formatLine(wait, true).startsWith(YELLOW));
  assert.equal(standsOut({ from: "ledger", event: wait, raw: "" } as never), null);
});

test("#29: an old event with only notification_type reads as before", () => {
  assert.equal(waitsFor(claimed("agent.waiting", 1, { notification_type: "idle_prompt" })), "instructions");
  assert.equal(waitsFor(claimed("agent.waiting", 1, { notification_type: "permission_prompt" })), "person");
  assert.equal(waitsFor(claimed("agent.waiting", 1)), "person");
  assert.equal(agentStates(waiting({ notification_type: "idle_prompt" }), NOW)[0]!.state, "waiting");
  assert.equal(agentStates(waiting({ notification_type: "permission_prompt" }), NOW)[0]!.state, "needs-input");
});

test("#29: no reader names a tool's notification any more", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["read/state.ts", "read/show.ts", "read/watch.ts", "dashboard/format.ts", "dashboard/App.tsx"]) {
    const text = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.ok(!/idle_prompt|permission_prompt/.test(text), `${file} names a tool's notification`);
  }
});
