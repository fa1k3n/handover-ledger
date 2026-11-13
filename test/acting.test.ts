// Who acted behind a person's account at the code host: the tests of issue #14.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { actingAgents } from "../src/read/acting.ts";
import { handovers } from "../src/read/overview.ts";
import { show, render } from "../src/read/show.ts";
import { PROJECT } from "./helpers.ts";

const T0 = Date.UTC(2026, 0, 1, 8, 0, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const OWNER = "person-0c0c0c0c";

let n = 0;
function host(type: LedgerEvent["type"], minute: number, extra: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    v: 0,
    id: `h-${++n}`,
    time: at(minute),
    type,
    source: { adapter: "github", kind: "observed" },
    project: PROJECT,
    actor: { kind: "person", id: OWNER },
    change: "30",
    task: "12",
    branch: "task-12-x",
    ...extra,
  };
}
function session(agent: string, minute: number, extra: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    v: 0,
    id: `s-${++n}`,
    time: at(minute),
    type: "tool.used",
    source: { adapter: "claude-code-hook", kind: "claimed" },
    project: PROJECT,
    actor: { kind: "agent", id: agent },
    session: `${agent}-s`,
    branch: "task-12-x",
    data: { tool: "Bash", target: "gh", outcome: "succeeded" },
    ...extra,
  };
}

test("#14: a change opened through a person's account while one agent's session was on its branch: that agent, via the person", () => {
  const opened = host("change.opened", 10);
  const acting = actingAgents([session("agent-a", 9), opened, session("agent-a", 10.1)]);
  assert.deepEqual(acting.get(opened.id), { agent: "agent-a", via: OWNER });
});

test("#14: a review through the same account while another agent's session named the change: a handover from the first to the second", () => {
  const events = [
    session("agent-a", 9),
    host("change.opened", 10),
    session("agent-b", 19, { branch: "main", change: "30", task: "12" }),
    host("review.commented", 20),
  ];
  const rows = handovers(events.map((event) => ({ event })));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.from, "agent-a");
  assert.equal(rows[0]!.to, "agent-b");
  assert.equal(rows[0]!.via, OWNER);
});

test("#14: two agents on the same branch at the time: no match, the person stays", () => {
  const opened = host("change.opened", 10);
  const acting = actingAgents([session("agent-a", 9), session("agent-b", 9.5), opened]);
  assert.equal(acting.get(opened.id), undefined);
});

test("#14: no session at the time: the person stays, nothing is invented", () => {
  const opened = host("change.opened", 60);
  const acting = actingAgents([session("agent-a", 9), opened]);
  assert.equal(acting.get(opened.id), undefined);
  // An agent acting under its own name needs no match.
  const own = host("change.opened", 10, { actor: { kind: "agent", id: "agent-a" } });
  assert.equal(actingAgents([session("agent-a", 9), own]).get(own.id), undefined);
});

test("#14: the events are not changed: the observed actor is still the person", () => {
  const opened = host("change.opened", 10);
  const before = JSON.stringify(opened);
  actingAgents([session("agent-a", 9), opened]);
  handovers([{ event: opened }]);
  assert.equal(JSON.stringify(opened), before);
});

test("#14: howl show names the agent behind the account", () => {
  const events = [
    session("agent-a", 9),
    host("change.opened", 10),
    session("agent-b", 19, { branch: "main", change: "30", task: "12" }),
    host("review.commented", 20),
  ];
  const text = render(show(events, { kind: "change", id: "30" }, null)!, { utc: true });
  assert.match(text, /opened by agent-a via person-0c0c0c0c/);
  assert.match(text, /agent-b via person-0c0c0c0c/);
});

test("#14: the stream marks the agent behind the account; the observed actor stays", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openLedger } = await import("../src/ledger/ledger.ts");
  const { startServer } = await import("../src/serve/server.ts");
  const dir = mkdtempSync(join(tmpdir(), "howl-acting-"));
  try {
    const ledger = join(dir, "ledger.jsonl");
    const w = openLedger(ledger, { project: PROJECT });
    const opened = host("change.opened", 10);
    for (const e of [session("agent-a", 9, { type: "session.started" }), opened]) w.append(e);
    w.close();
    const server = await startServer({ ledger, port: 0, root: dir });
    try {
      const { events } = (await (await fetch(`${server.url}/api/events`)).json()) as { events: { by?: string; event: { id: string; actor: { id: string } } }[] };
      const item = events.find((i) => i.event.id === opened.id)!;
      assert.equal(item.by, "agent-a");
      assert.equal(item.event.actor.id, OWNER);
    } finally {
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
