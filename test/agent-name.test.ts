// #46: one name for an agent, by its session and by its account at the code host.
// @code_class tests
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { agentAccounts, agentFaults, agentNames } from "../src/howl/project.ts";
import { agentStates } from "../src/read/state.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { folder, howl, lines, PROJECT, workspace } from "./helpers.ts";
import { at, LocalHost, SHA } from "./local-host.ts";

function setup(agents: string, login = "agent-1-bot") {
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
    reviews: [{ id: "r-1", by: { login }, state: "approved", at: at(5), sha: SHA.a }],
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
  const shown = howl(["show", "change:30", "--json"], { cwd: ws.root, env: ws.env });
  assert.equal(shown.status, 0, shown.stderr);
  const parsed = JSON.parse(shown.stdout);
  assert.deepEqual(parsed.changes.length > 0 && parsed.reviews[0].reviews.map((r: { actor: unknown }) => r.actor), [{ id: "agent-1", kind: "agent" }], "the review is the agent's, not a person's");
  assert.deepEqual(parsed.summary.actors.map((a: { id: string }) => a.id).filter((id: string) => id !== "agent-1" && !id.startsWith("person-")), []);
  const plain = howl(["show", "change:30"], { cwd: ws.root, env: ws.env }).stdout;
  assert.match(plain, /agent-1 approved/);
  assert.doesNotMatch(plain, /person-\S* approved/, "the reviewer is no person");
  assert.equal(existsSync(join(ws.home, PROJECT, "people.json")) && /agent-1-bot/.test(readFileSync(join(ws.home, PROJECT, "people.json"), "utf8")), false, "no pseudonym is made for the account");
  const review = events.find((x) => x.type === "review.approved")!;
  assert.deepEqual(review.actor, { kind: "agent", id: "agent-1" });
});

test("#46: agentAccounts and agentNames read both forms; one name may have two accounts; accounts are in lower case", () => {
  const entries = ["agent-1=Agent-1-Bot", "plain", "agent-1=agent-1-other"];
  assert.deepEqual([...agentAccounts(entries)], [
    ["agent-1-bot", "agent-1"],
    ["plain", "plain"],
    ["agent-1-other", "agent-1"],
  ]);
  assert.deepEqual([...agentNames(entries)].sort(), ["agent-1", "plain"]);
  assert.deepEqual(agentFaults(entries), []);
});

test("#46: agentFaults names an entry with an empty side or two =, and an account given twice in any case, also by a plain entry", () => {
  assert.equal(agentFaults(["agent-1=agent-1-bot=x"]).length, 1);
  assert.equal(agentFaults(["=agent-1-bot"]).length, 1);
  assert.equal(agentFaults(["agent-1="]).length, 1);
  assert.equal(agentFaults(["agent-1=a-bot", "agent-2=A-Bot"]).length, 1);
  assert.ok(agentFaults(["agent-1=agent-2", "agent-2"]).length >= 1);
  assert.equal(agentFaults(["agent-1=agent-1-bot", "agent-2=agent-1"]).length, 1);
  assert.match(agentFaults(["agent-1=agent-2", "agent-2"])[0]!, /agent-2/);
});

for (const bad of [
  "[agent-1=agent-1-bot=x]",
  "[=agent-1-bot]",
  "[agent-1=]",
  "[agent-1=a-bot, agent-2=a-bot]",
  "[agent-1=agent-2, agent-2]",
  "[agent-1=agent-1-bot agent-2]",
  "[agent-1=agent-1-bot, agent-2",
  "['agent-1=agent-1-bot, agent-2']",
  "[agent-1=agent-1-bot, agent-2=agent-1]",
]) {
  test(`#46: agents ${bad} is refused: howl observe --once names the entry, ends not with 0 and writes nothing`, () => {
    const { ws } = setup(bad);
    const r = howl(["observe", "--once"], { cwd: ws.root, env: ws.env });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /agents: the (entry|account)/);
    assert.equal(existsSync(ws.ledger) ? lines(ws.ledger).length : 0, 0);
    assert.equal(existsSync(join(ws.home, PROJECT, "people.json")), false);
  });
}

test("#46: howl hook with a refused list is as it was: silent, status 0", () => {
  const { ws } = setup("[agent-1=agent-1-bot=x]");
  const r = howl(["hook"], { cwd: ws.root, env: ws.env, input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "s" }) });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, "");
});

test("#46: agent-1=Agent-1-Bot with the host showing agent-1-bot: the review has the actor agent-1 and no pseudonym is made", () => {
  const { ws } = setup("[agent-1=Agent-1-Bot]");
  const e = review(observe(ws));
  assert.deepEqual(e.actor, { kind: "agent", id: "agent-1" });
  assert.equal(e.data.account, "agent-1-bot");
  assert.equal(existsSync(join(ws.home, PROJECT, "people.json")) && /agent-1-bot/i.test(readFileSync(join(ws.home, PROJECT, "people.json"), "utf8")), false);
});

test("#46: a reader of a refused list reads the ledger, says it was refused and shows no gap", () => {
  const { ws } = setup("[agent-1=agent-1-bot]");
  howl(["emit", "session.started", "--change", "30"], { cwd: ws.root, env: { ...ws.env, HOWL_ACTOR: "agent-9" } });
  observe(ws);
  const yml = join(ws.root, ".howl", "howl.yml");
  writeFileSync(yml, readFileSync(yml, "utf8").replace("[agent-1=agent-1-bot]", "[agent-1=agent-1-bot=x]"));
  const s = howl(["status"], { cwd: ws.root, env: ws.env });
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stderr, /refused/);
  assert.doesNotMatch(s.stdout, /not a known agent/);
});

test("#46: howl status --project <another> from a project's folder shows no gap for the other project's agents; from a folder with no project, none", () => {
  const { ws } = setup("[x-bot]");
  const other = workspace({ yml: `project: other\n`, actor: "agent-1" });
  const mine = join(ws.home, "other");
  mkdirSync(mine, { recursive: true });
  const emit = howl(["emit", "session.started", "--change", "30"], { cwd: other.root, env: { ...ws.env, HOWL_ACTOR: "agent-1" } });
  assert.equal(emit.status, 0, emit.stderr);
  const ingest = howl(["ingest", "--project", "other"], { cwd: other.root, env: { ...ws.env } });
  assert.equal(ingest.status, 0, ingest.stderr);
  const here = howl(["status"], { cwd: other.root, env: { ...ws.env } });
  assert.doesNotMatch(here.stdout, /not a known agent/);
  const across = howl(["status", "--project", "other"], { cwd: ws.root, env: ws.env });
  assert.equal(across.status, 0, across.stderr);
  assert.match(across.stdout, /agent-1/);
  assert.doesNotMatch(across.stdout, /not a known agent/);
  const none = howl(["status", "--project", "other"], { cwd: folder(), env: ws.env });
  assert.doesNotMatch(none.stdout, /not a known agent/);
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

test("#46: lists that must pass pass: one name with two accounts, a=a, spaces round =, names that differ only by case, [bot]", () => {
  for (const ok of [["agent-1=a-bot", "agent-1=a-other"], ["a=a"], ["agent-1 = agent-1-bot"], ["Agent-1=a-bot", "agent-1=b-bot"], ["agent-1=reviewer[bot]"], ["agent-1=a-bot", "agent-1"]]) {
    assert.deepEqual(agentFaults(ok), [], ok.join(","));
  }
});

test("#46: agent-1=reviewer[bot], as a file holds it, is read: a review by the app reviewer[bot] has the actor agent-1", () => {
  for (const form of ["[agent-1=reviewer[bot]]", "[other, agent-1=reviewer[bot]]", "\n  - agent-1=reviewer[bot]\n"]) {
    const { ws } = setup(form, "reviewer[bot]");
    const e = review(observe(ws));
    assert.deepEqual(e.actor, { kind: "agent", id: "agent-1" }, form);
    assert.equal(e.data.account, "reviewer[bot]");
  }
});
