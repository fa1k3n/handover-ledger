// Who acted behind a person's account at the code host: the tests of issue #14.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { actingAgents } from "../src/read/acting.ts";
import { handovers, keyFigures } from "../src/read/overview.ts";
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

// #21: who pushed a new head the code host names no one for.
const pushed = (minute: number, extra: Partial<LedgerEvent> = {}) => host("change.updated", minute, { actor: undefined, sha: "f".repeat(40), ...extra });

test("#21: a new head with no actor while one agent's session was on the branch: that agent, matched", () => {
  const head = pushed(30);
  const acting = actingAgents([session("agent-a", 29), head]);
  assert.equal(acting.get(head.id)?.agent, "agent-a");
  assert.equal(acting.get(head.id)?.via, undefined, "no account was named");
});

test("#21: two agents on the branch, or none: no actor; nothing invented", () => {
  const head = pushed(30);
  assert.equal(actingAgents([session("agent-a", 29), session("agent-b", 29.5), head]).get(head.id), undefined);
  assert.equal(actingAgents([session("agent-a", 1), head]).get(head.id), undefined);
});

test("#21: howl show says who pushed each new head", () => {
  const events = [session("agent-a", 9), host("change.opened", 10, { sha: "e".repeat(40) }), session("agent-a", 29), pushed(30)];
  const text = render(show(events, { kind: "change", id: "30" }, null)!, { utc: true });
  assert.match(text, /new head fffffff by agent-a \(matched\)/);
});

// #44: a head the code host named a pusher for.
test("#44: a head pushed through a person's account while one agent's session was on the branch: that agent, via the person", () => {
  const head = pushed(30, { actor: { kind: "person", id: OWNER } });
  assert.deepEqual(actingAgents([session("agent-a", 29), head]).get(head.id), { agent: "agent-a", via: OWNER });
});

test("#44: a head pushed by an agent's account, or by an account that no longer exists, is matched to no one", () => {
  const own = pushed(30, { actor: { kind: "agent", id: "agent-b" } });
  const gone = pushed(31, { actor: undefined, data: { account_removed: true } });
  const acting = actingAgents([session("agent-a", 29), own, gone]);
  assert.equal(acting.get(own.id), undefined);
  assert.equal(acting.get(gone.id), undefined);
});

test("#44: a head the host gave no push for, marked as inferred, is matched as before", () => {
  const head = pushed(30, { data: { inferred: true } });
  assert.equal(actingAgents([session("agent-a", 29), head]).get(head.id)?.agent, "agent-a");
});

test("#44: howl show says who pushed each head the host named a pusher for, and the agent behind a person's account", () => {
  const events = [
    session("agent-a", 9),
    host("change.opened", 10, { sha: "e".repeat(40) }),
    session("agent-a", 29),
    pushed(30, { actor: { kind: "person", id: OWNER } }),
    pushed(40, { actor: { kind: "agent", id: "agent-b" }, sha: "d".repeat(40) }),
    pushed(50, { actor: undefined, sha: "c".repeat(40), data: { account_removed: true } }),
  ];
  const shown = show(events, { kind: "change", id: "30" }, null)!;
  assert.deepEqual(shown.changes[0]!.heads.map((h) => [h.actor?.id, h.by]), [
    [undefined, undefined],
    [OWNER, "agent-a"],
    ["agent-b", undefined],
    [undefined, undefined],
  ]);
  const text = render(shown, { utc: true });
  assert.match(text, /new head fffffff pushed by agent-a via person-0c0c0c0c/);
  assert.match(text, /new head ddddddd pushed by agent-b/);
  assert.match(text, /new head ccccccc pushed by an account that no longer exists/);
});

test("#44: a head marked as inferred says so in howl show; one from a ledger before this is shown as before", () => {
  const events = [
    host("change.opened", 10, { sha: "e".repeat(40), data: { inferred: true } }),
    pushed(30, { data: { inferred: true } }),
    pushed(40, { sha: "d".repeat(40) }),
  ];
  const shown = show(events, { kind: "change", id: "30" }, null)!;
  assert.deepEqual(shown.changes[0]!.heads.map((h) => h.inferred), [true, true, undefined]);
  const text = render(shown, { utc: true });
  assert.match(text, /the host told no push for eeeeeee, fffffff: as a round of howl saw them/);
  assert.match(text, /new head ddddddd\n/, "a head from a ledger before this is shown as before");
});

test("#44: a head whose pusher's account no longer exists is not counted as a head no agent was matched to; one the host named no one for is", () => {
  const gone = pushed(30, { actor: undefined, data: { account_removed: true } });
  const nameless = pushed(31, { sha: "d".repeat(40) });
  const figures = keyFigures([host("change.opened", 10, { actor: { kind: "agent", id: "agent-a" } }), gone, nameless], T0 + 3600_000);
  assert.equal(figures.unattributed.count, 1);
});
