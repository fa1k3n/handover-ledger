// Issue #41: the task comes from the branch when the hook writes the event, and the readers take it from the events.
// @code_class tests
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openLedger, type LedgerEvent } from "../src/ledger/ledger.ts";
import { agentStates, renderStatus } from "../src/read/state.ts";
import { startServer } from "../src/serve/server.ts";
import { event, folder, git, howl, inboxEvents, PROJECT, workspace, type Workspace } from "./helpers.ts";
import { at, LocalHost, SHA } from "./local-host.ts";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const PATTERN = "^task-([0-9]+)";

/** A repository on the branch `task-12-x`, with `.howl/howl.yml` holding `extra`. */
function onBranch(extra: string, actor: string | null = "agent-1"): Workspace {
  const ws = workspace({ yml: `project: ${PROJECT}\n${extra}`, actor });
  git(ws.root, "init");
  git(ws.root, "checkout", "-b", "task-12-x");
  git(ws.root, "commit", "--allow-empty", "-m", "first");
  return ws;
}

function hookInput(ws: Workspace, name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: "session-1", transcript_path: "/nowhere/t.jsonl", cwd: ws.root, hook_event_name: name, ...extra });
}

const HOOKS: [string, Record<string, unknown>][] = [
  ["SessionStart", { source: "startup", model: "model-a" }],
  ["PostToolUse", { tool_name: "Read", tool_input: { file_path: "/x" }, tool_response: {}, tool_use_id: "t1" }],
  ["Stop", { stop_hook_active: false, last_assistant_message: "done" }],
];

/** Runs the hooks in `ws` and returns the events they left. Each must print nothing and end with 0. */
function hooked(ws: Workspace, env: Record<string, string> = ws.env): LedgerEvent[] {
  for (const [name, extra] of HOOKS) {
    const run = howl(["hook"], { cwd: ws.root, env, input: hookInput(ws, name, extra) });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "");
    assert.equal(run.stderr, "");
  }
  return inboxEvents(ws.inbox);
}

test("R41.1: howl hook writes the task from the branch by the project's task_from_branch", () => {
  const ws = onBranch(`task_from_branch: '${PATTERN}'\n`);
  const events = hooked(ws);
  assert.equal(events.length, HOOKS.length);
  for (const e of events) {
    assert.equal(e.branch, "task-12-x");
    assert.equal(e.task, "12", e.type);
  }
});

test("R41.2: HOWL_TASK wins over the branch", () => {
  const ws = onBranch(`task_from_branch: '${PATTERN}'\n`);
  const events = hooked(ws, { ...ws.env, HOWL_TASK: "7" });
  assert.equal(events.length, HOOKS.length);
  for (const e of events) assert.equal(e.task, "7", e.type);
});

test("R41.3: with no task_from_branch, a hook event on task-12-x has no task", () => {
  const ws = onBranch("");
  const events = hooked(ws);
  assert.equal(events.length, HOOKS.length);
  for (const e of events) {
    assert.equal(e.branch, "task-12-x");
    assert.equal(e.task, undefined, e.type);
  }
});

test("R41.15: the task comes from the branch when HOWL_CHANGE is set and HOWL_TASK is not", () => {
  const ws = onBranch(`task_from_branch: '${PATTERN}'\n`);
  const events = hooked(ws, { ...ws.env, HOWL_CHANGE: "30" });
  assert.equal(events.length, HOOKS.length);
  for (const e of events) {
    assert.equal(e.change, "30");
    assert.equal(e.task, "12", e.type);
  }
});

test("R41.12: with a task_from_branch that is not a regular expression, howl hook writes no event, prints nothing and ends with 0", () => {
  const ws = onBranch("task_from_branch: '('\n");
  for (const [name, extra] of HOOKS) {
    const run = howl(["hook"], { cwd: ws.root, env: ws.env, input: hookInput(ws, name, extra) });
    assert.equal(run.status, 0, name);
    assert.equal(run.stdout, "", name);
    assert.equal(run.stderr, "", name);
  }
  assert.deepEqual(inboxEvents(ws.inbox), [], "no event is written");
});

// 41.4, 41.13: the state takes the task from the events.

function agentEvent(over: Partial<LedgerEvent> = {}): LedgerEvent {
  return event({
    type: "session.started",
    source: { adapter: "claude-code-hook", kind: "claimed" },
    actor: { kind: "agent", id: "agent-a" },
    session: "s-a",
    time: new Date(NOW - 60_000).toISOString(),
    branch: "task-12-x",
    task: undefined,
    ...over,
  });
}

test("R41.4: agentStates takes the task from the events and never works it out from the branch", () => {
  const [row] = agentStates([agentEvent()], NOW, { taskFromBranch: PATTERN } as never);
  assert.equal(row!.task, undefined, "an event with no task gives no task, whatever is passed");
  assert.equal(row!.branch, "task-12-x");
  const [withTask] = agentStates([agentEvent({ task: "7" })], NOW);
  assert.equal(withTask!.task, "7", "the task of the event, not the branch's 12");
  const [later] = agentStates([agentEvent({ task: "7" }), agentEvent({ type: "tool.used", data: { tool: "Read", target: "x", outcome: "succeeded" }, time: new Date(NOW - 30_000).toISOString() })], NOW);
  assert.equal(later!.task, "7", "a later event with no task does not take the task from the branch");
});

test("R41.13: an event with no task shows the branch in the state", () => {
  const rows = agentStates([agentEvent()], NOW);
  assert.equal(rows[0]!.task, undefined);
  const shown = renderStatus(rows, NOW);
  assert.ok(shown.includes("task-12-x"), shown);
  assert.ok(!/task 12/.test(shown), shown);
});

test("R41.13: howl status shows the branch of events with no task, though the project has a task_from_branch", () => {
  const ws = onBranch(`task_from_branch: '${PATTERN}'\n`);
  mkdirSync(join(ws.home, PROJECT), { recursive: true });
  const w = openLedger(ws.ledger, { project: PROJECT });
  w.append(agentEvent());
  w.close();
  const run = howl(["status"], { cwd: ws.root, env: ws.env });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes("task-12-x"), run.stdout);
  assert.ok(!/task 12/.test(run.stdout), run.stdout);
});

// 41.5: the type-check shows that the option is gone. `npm run check` fails on an unused directive.

test("R41.5: taskFromBranch is no option of StateOptions or ServeOptions", () => {
  // @ts-expect-error StateOptions has no taskFromBranch after #41.
  const state: Parameters<typeof agentStates>[2] = { taskFromBranch: new RegExp(PATTERN) };
  // @ts-expect-error ServeOptions has no taskFromBranch after #41.
  const serve: Parameters<typeof startServer>[0] = { port: 0, root: "x", taskFromBranch: new RegExp(PATTERN) };
  assert.ok(state && serve);
});

// 41.6, 41.7: other projects' tasks come from their events.

/** A howl home with a project `a` and a project `b`, whose event has task 5 on the branch task-9-x. */
function twoProjects(): string {
  const home = folder();
  for (const name of ["a", "b"]) {
    mkdirSync(join(home, name));
    const w = openLedger(join(home, name, "ledger.jsonl"), { project: name });
    w.append(agentEvent({ project: name, actor: { kind: "agent", id: `agent-${name}` }, branch: "task-9-x", task: name === "b" ? "5" : "1" }));
    w.close();
  }
  return home;
}

test("R41.6: howl status --project b, started in the repository of project a, shows the tasks of b's events", () => {
  const ws = workspace({ yml: `project: a\ntask_from_branch: '${PATTERN}'\n` });
  const home = twoProjects();
  const run = howl(["status", "--project", "b", "--json"], { cwd: ws.root, env: { HOWL_HOME: home } });
  assert.equal(run.status, 0, run.stderr);
  const rows = JSON.parse(run.stdout) as { agent: string; task?: string }[];
  assert.deepEqual(rows.map((r) => [r.agent, r.task]), [["agent-b", "5"]]);
  const plain = howl(["status", "--project", "b"], { cwd: ws.root, env: { HOWL_HOME: home } });
  assert.match(plain.stdout, /task 5/);
  assert.ok(!/task 9/.test(plain.stdout), plain.stdout);
});

test("R41.7: howl serve shows the tasks of every project it serves from that project's events", async () => {
  const server = await startServer({ home: twoProjects(), port: 0, root: folder() });
  try {
    for (const [name, task] of [["a", "1"], ["b", "5"]] as const) {
      const body = (await (await fetch(`${server.url}/api/agents?project=${name}`)).json()) as { rows: { agent: string; task?: string }[] };
      assert.deepEqual(body.rows.map((r) => [r.agent, r.task]), [[`agent-${name}`, task]], name);
    }
  } finally {
    await server.close();
  }
});

// 41.10, 41.11: howl observe says a setting it cannot read.

/** A repository observed through a local host with one change, and `extra` in its howl.yml. */
function observed(extra: string): Workspace {
  const dir = folder();
  const ws = workspace({ yml: `project: ${PROJECT}\nhost: local\nlocal: ${dir}\nrepository: team/product\n${extra}` });
  new LocalHost(dir).change({
    number: 10,
    branch: "task-1-feature",
    openedAt: at(2),
    openedBy: { login: "alice" },
    head: { sha: SHA.a, at: at(2) },
    tasks: [],
    reviews: [{ id: "r-1", by: { login: "bob" }, state: "commented", at: at(10), sha: SHA.a, comments: [{ id: "c-1", by: { login: "bob" }, at: at(10), body: "[review] note" }] }] as never,
    updatedAt: at(10),
  });
  return ws;
}

const observe = (ws: Workspace) => howl(["observe", "--once"], { cwd: ws.root, env: ws.env });

test("R41.10: howl observe with an invalid task_from_branch ends with a message that names the setting", () => {
  const good = observe(observed(`task_from_branch: '${PATTERN}'\n`));
  assert.equal(good.status, 0, `the setup itself is sound: ${good.stderr}`);
  const run = observe(observed("task_from_branch: '('\n"));
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /task_from_branch/);
});

test("R41.11: howl observe with an invalid review_comment_pattern stops with a message that names the setting", () => {
  const good = observe(observed("review_comment_pattern: '^\\[review\\]'\n"));
  assert.equal(good.status, 0, `the setup itself is sound: ${good.stderr}`);
  const run = observe(observed("review_comment_pattern: '('\n"));
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /review_comment_pattern/);
});
