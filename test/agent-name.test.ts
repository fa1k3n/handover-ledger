// #46: one name for an agent, by its session and by its account at the code host.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentAccounts, agentNames } from "../src/howl/project.ts";
import { agentStates } from "../src/read/state.ts";
import { folder, howl, lines, PROJECT, workspace } from "./helpers.ts";
import { at, LocalHost, SHA } from "./local-host.ts";

function setup(agents: string) {
  const dir = folder();
  const ws = workspace({
    yml: `project: ${PROJECT}
host: local
local: ${dir}
repository: team/product
agents: ${agents}
`,
  });
  const host = new LocalHost(dir);
  host.change({
    number: 30,
    branch: "task-1-x",
    openedAt: at(1),
    openedBy: { login: "alice" },
    head: { sha: SHA.a, at: at(1) },
    tasks: [],
    reviews: [{ id: "r-1", by: { login: "agent-1-bot" }, state: "approved", at: at(5), sha: SHA.a }],
    updatedAt: at(5),
  });
  return { ws };
}

function observe(ws: ReturnType<typeof workspace>) {
  const r = howl(["observe", "--once"], { cwd: ws.root, env: ws.env });
  assert.equal(r.status, 0, r.stderr);
  return lines(ws.ledger).map((l) => l.event);
}

const review = (events: Record<string, any>[]) => events.find((e) => e.type === "review.approved")!;

test("#46: an entry name=account gives the name for the account, and the account is kept in data.account", () => {
  const { ws } = setup("[agent-1=agent-1-bot]");
  const e = review(observe(ws));
  assert.deepEqual(e.actor, { kind: "agent", id: "agent-1" });
  assert.equal(e.data.account, "agent-1-bot");
});

test("#46: a plain entry is both name and account, and data.account is left out, as the name is the account", () => {
  const { ws } = setup("[agent-1-bot]");
  const e = review(observe(ws));
  assert.deepEqual(e.actor, { kind: "agent", id: "agent-1-bot" });
  assert.equal("account" in e.data, false);
});

test("#46: a session of agent-1 and a review by agent-1-bot are one row in the state and one name in howl show", () => {
  const { ws } = setup("[agent-1=agent-1-bot]");
  const r = howl(["emit", "session.started", "--change", "30"], { cwd: ws.root, env: ws.env });
  assert.equal(r.status, 0, r.stderr);
  const events = observe(ws);
  assert.deepEqual(agentStates(events as never, Date.now()).map((x) => x.agent), ["agent-1"]);
  const shown = howl(["show", "change:30"], { cwd: ws.root, env: ws.env });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /agent-1\b/);
  assert.doesNotMatch(shown.stdout, /agent-1-bot/);
});

test("#46: agentAccounts and agentNames read both forms; a doubled account keeps its first name, a doubled name may have two accounts", () => {
  const entries = ["agent-1=agent-1-bot", "plain", "agent-2=agent-1-bot", "agent-1=agent-1-other", "=x", "y=", "a=b=c"];
  assert.deepEqual([...agentAccounts(entries)], [
    ["agent-1-bot", "agent-1"],
    ["plain", "plain"],
    ["agent-1-other", "agent-1"],
  ]);
  assert.deepEqual([...agentNames(entries)].sort(), ["agent-1", "agent-2", "plain"]);
});

test("#46: a session whose actor is no name in agents has the gap 'not a known agent'; with no agents listed, none", () => {
  const now = Date.now();
  const e = (actor: string) =>
    ({
      v: 0,
      id: `x-${actor}`,
      time: new Date(now - 30_000).toISOString(),
      type: "tool.used",
      source: { adapter: "claude-code-hook", kind: "claimed" },
      project: PROJECT,
      actor: { kind: "agent", id: actor },
      session: "s",
      change: "30",
      role: "review",
      data: { tool: "Bash", target: "gh", outcome: "succeeded" },
    }) as never;
  const known = new Set(["agent-1"]);
  const rows = agentStates([e("agent-1"), e("agent-9")], now, { agents: known });
  const gaps = Object.fromEntries(rows.map((r) => [r.agent, r.gaps]));
  assert.deepEqual(gaps, { "agent-1": [], "agent-9": ["not a known agent"] });
  assert.deepEqual(agentStates([e("agent-9")], now)[0]!.gaps, []);
  assert.deepEqual(agentStates([e("agent-9")], now, { agents: new Set() })[0]!.gaps, []);
});

test("#46: howl status marks a session whose actor is not listed", () => {
  const { ws } = setup("[agent-1=agent-1-bot]");
  howl(["emit", "session.started", "--change", "30"], { cwd: ws.root, env: { ...ws.env, HOWL_ACTOR: "agent-9" } });
  observe(ws);
  const s = howl(["status"], { cwd: ws.root, env: ws.env });
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /agent-9.*not a known agent/);
});
