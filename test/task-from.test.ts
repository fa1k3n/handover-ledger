// Issue #175: the event says where its task came from (`task_from`), and the state ranks the task by it.
// @code_class tests
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { eventFaults } from "../src/ledger/schema.ts";
import { openLedger, type LedgerEvent } from "../src/ledger/ledger.ts";
import { agentStates, renderStatus } from "../src/read/state.ts";
import { startServer } from "../src/serve/server.ts";
import { event, folder, git, howl, inboxEvents, lines, PROJECT, rawLines, workspace, type Workspace } from "./helpers.ts";
import { at, LocalHost, SHA } from "./local-host.ts";
import { until, up, type Up } from "./up-helpers.ts";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const PATTERN = "^task-([0-9]+)";
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A repository on the branch `task-12-x`, with `.howl/howl.yml` holding `extra`. */
function onBranch(extra: string): Workspace {
  const ws = workspace({ yml: `project: ${PROJECT}\n${extra}` });
  git(ws.root, "init");
  git(ws.root, "checkout", "-b", "task-12-x");
  git(ws.root, "commit", "--allow-empty", "-m", "first");
  return ws;
}

const HOOKS: [string, Record<string, unknown>][] = [
  ["SessionStart", { source: "startup", model: "model-a" }],
  ["PostToolUse", { tool_name: "Read", tool_input: { file_path: "/x" }, tool_response: {}, tool_use_id: "t1" }],
  ["Notification", { message: "Claude needs your permission", notification_type: "permission_prompt" }],
  ["Stop", { stop_hook_active: false, last_assistant_message: "done" }],
  ["SessionEnd", { reason: "prompt_input_exit" }],
];

function hookJson(ws: Workspace, name: string, extra: Record<string, unknown> = {}, session = "session-1"): Record<string, unknown> {
  return { session_id: session, transcript_path: "/nowhere/t.jsonl", cwd: ws.root, hook_event_name: name, ...extra };
}

/** Runs the five hooks in `ws` and returns the events they left. */
function hooked(ws: Workspace, env: Record<string, string> = ws.env): Record<string, unknown>[] {
  for (const [name, extra] of HOOKS) {
    const run = howl(["hook"], { cwd: ws.root, env, input: JSON.stringify(hookJson(ws, name, extra)) });
    assert.equal(run.status, 0, run.stderr);
  }
  const events = inboxEvents(ws.inbox) as unknown as Record<string, unknown>[];
  assert.equal(events.length, HOOKS.length);
  return events;
}

// 175.1: the hook says where its task came from.

test("R175.1: a hook event whose task is HOWL_TASK says task_from env", () => {
  const ws = onBranch(`task_from_branch: '${PATTERN}'\n`);
  for (const e of hooked(ws, { ...ws.env, HOWL_TASK: "7" })) {
    assert.equal(e.task, "7", String(e.type));
    assert.equal(e.task_from, "env", String(e.type));
  }
});

test("R175.1: a hook event whose task is taken from the branch says task_from branch", () => {
  const ws = onBranch(`task_from_branch: '${PATTERN}'\n`);
  for (const e of hooked(ws)) {
    assert.equal(e.task, "12", String(e.type));
    assert.equal(e.task_from, "branch", String(e.type));
  }
});

test("R175.1: with HOWL_CHANGE set and no HOWL_TASK, the task from the branch says task_from branch", () => {
  const ws = onBranch(`task_from_branch: '${PATTERN}'\n`);
  for (const e of hooked(ws, { ...ws.env, HOWL_CHANGE: "30" })) {
    assert.equal(e.task, "12", String(e.type));
    assert.equal(e.task_from, "branch", String(e.type));
  }
});

test("R175.1: a hook event with no task has no task_from", () => {
  // Guard: holds before the change.
  const ws = onBranch("");
  for (const e of hooked(ws)) {
    assert.equal(e.task, undefined, String(e.type));
    assert.ok(!("task_from" in e), String(e.type));
  }
});

// 175.2: the schema holds the field and its values; the types are generated from it.

test("R175.2: the schema accepts task_from env and branch on an event with a task", () => {
  for (const value of ["env", "branch"]) {
    assert.deepEqual(eventFaults(event({ task: "12", task_from: value } as Partial<LedgerEvent>)), [], value);
  }
});

test("R175.2: the schema refuses any other task_from, and the ledger writes nothing", () => {
  // The field exists: the same event with `env` is valid and is written.
  assert.deepEqual(eventFaults(event({ task: "12", task_from: "env" } as Partial<LedgerEvent>)), [], "control: env is accepted");
  for (const value of ["host", "ENV", "", "branch ", 1, null, ["env"]]) {
    const bad = event({ task: "12", task_from: value } as unknown as Partial<LedgerEvent>);
    assert.notEqual(eventFaults(bad).length, 0, JSON.stringify(value));
  }
  const dir = folder();
  const path = join(dir, "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  writer.append(event({ task: "12", task_from: "env" } as Partial<LedgerEvent>));
  const before = rawLines(path);
  assert.equal(before.length, 2, "control: the event with env is written");
  assert.throws(() => writer.append(event({ task: "12", task_from: "host" } as unknown as Partial<LedgerEvent>)));
  writer.close();
  assert.deepEqual(rawLines(path), before, "nothing was written");
});

test("R175.2: the generated types hold task_from as env or branch", () => {
  const gen = readFileSync(join(ROOT, "src/ledger/event.gen.ts"), "utf8");
  const at = gen.indexOf("task_from?");
  assert.ok(at >= 0, "task_from is a field of LedgerEvent");
  const declared = gen.slice(at, gen.indexOf(";", at) + 1);
  assert.match(declared, /"env"/);
  assert.match(declared, /"branch"/);
  assert.ok(!/string\s*;/.test(declared), "not a free string");
});

test("R175.2: the schema file names the two values", () => {
  const schema = JSON.parse(readFileSync(join(ROOT, "schema/event.v0.schema.json"), "utf8"));
  const field = schema.properties?.task_from;
  assert.ok(field, "properties.task_from");
  assert.deepEqual([...(field.enum ?? [])].sort(), ["branch", "env"]);
});

// 175.3: a source with no task is refused.

test("R175.3: the schema refuses task_from on an event with no task, and the ledger writes nothing", () => {
  // The field exists: with a task it is valid.
  assert.deepEqual(eventFaults(event({ task: "12", task_from: "branch" } as Partial<LedgerEvent>)), [], "control: with a task it is accepted");
  for (const value of ["env", "branch"]) {
    assert.deepEqual(eventFaults(event({ task: "12", task_from: value } as Partial<LedgerEvent>)), [], `control: ${value} with a task`);
    const bare = event({ task: undefined, task_from: value } as unknown as Partial<LedgerEvent>);
    assert.notEqual(eventFaults(bare).length, 0, value);
  }
  const dir = folder();
  const path = join(dir, "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  writer.append(event({ task: "12", task_from: "env" } as Partial<LedgerEvent>));
  const before = rawLines(path);
  assert.equal(before.length, 2, "control: the event with a task is written");
  assert.throws(() => writer.append(event({ task: undefined, task_from: "env" } as unknown as Partial<LedgerEvent>)));
  writer.close();
  assert.deepEqual(rawLines(path), before, "nothing was written");
});

test("R175.3: an event with a task and no task_from, and one with neither, stay valid", () => {
  // Guard: holds before the change.
  assert.deepEqual(eventFaults(event({ task: "12" })), []);
  assert.deepEqual(eventFaults(event({ task: undefined })), []);
});

// 175.4: /api/hook gives the task_from howl hook gives.

let running: Up | undefined;
after(async () => {
  await running?.stop();
});

test("R175.4: a hook sent to /api/hook gives the same task_from as howl hook, for HOWL_TASK and for the branch", async () => {
  const dir = folder();
  const ws = workspace({ yml: `project: ${PROJECT}\nhost: local\nlocal: ${dir}\nrepository: team/product\ntask_from_branch: '${PATTERN}'\n` });
  git(ws.root, "init");
  git(ws.root, "checkout", "-b", "task-12-x");
  git(ws.root, "commit", "--allow-empty", "-m", "first");
  running = await up({ ws, host: new LocalHost(dir) });
  const u = running;
  const cases: [string, Record<string, string>, Record<string, string>, string][] = [
    ["env", { HOWL_TASK: "7" }, { "x-howl-task": "7" }, "env"],
    ["branch", {}, {}, "branch"],
  ];
  for (const [label, envNames, headers, expected] of cases) {
    const session = `same-${label}`;
    const json = JSON.stringify(hookJson(ws, "PostToolUse", HOOKS[1]![1], session));
    const home = folder();
    const built = howl(["hook"], { cwd: ws.root, env: { HOWL_HOME: home, HOWL_ACTOR: "agent-7", ...envNames }, input: json });
    assert.equal(built.status, 0, built.stderr);
    const [byHook] = inboxEvents(join(home, PROJECT, "inbox")) as unknown as Record<string, unknown>[];
    assert.equal(byHook?.task_from, expected, `howl hook, ${label}`);
    const answer = await fetch(`${u.url}/api/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${u.token}`, "x-howl-actor": "agent-7", ...headers },
      body: json,
    });
    assert.equal(answer.status, 200);
    const all = (): Record<string, any>[] => [
      ...(existsSync(ws.ledger) ? lines(ws.ledger).map((l) => l.event) : []),
      ...(existsSync(ws.activity) ? rawLines(ws.activity).map((raw) => JSON.parse(raw)) : []),
    ];
    const byServer = await until(() => all().find((e) => e.session === session), 3000, `${label} at the server`);
    assert.equal(byServer.task_from, byHook!.task_from, label);
    assert.equal(byServer.task_from, expected, label);
  }
});

// 175.5 to 175.10: the state ranks the task, and shows the change on the branch only when it should.

let n = 0;
const agentEvent = (secondsAgo: number, extra: Partial<LedgerEvent> = {}): LedgerEvent => ({
  v: 0,
  id: `a-${++n}`,
  time: ago(secondsAgo),
  type: "tool.used",
  source: { adapter: "claude-code-hook", kind: "claimed" },
  project: PROJECT,
  actor: { kind: "agent", id: "agent-1" },
  session: "agent-1-s",
  branch: "task-12-x",
  data: { tool: "Bash", target: "make", outcome: "succeeded" },
  ...extra,
});
/** The change the code host shows opened on the branch, linked to `task` (to none when it is left out). */
const opened = (task?: string): LedgerEvent => ({
  v: 0,
  id: `obs-${++n}`,
  time: ago(900),
  type: "change.opened",
  source: { adapter: "github", kind: "observed" },
  project: PROJECT,
  change: "30",
  branch: "task-12-x",
  ...(task !== undefined ? { task } : {}),
});
const from = (task: string, task_from?: "env" | "branch"): Partial<LedgerEvent> => ({ task, ...(task_from ? { task_from } : {}) } as Partial<LedgerEvent>);
const row = (events: LedgerEvent[]) => agentStates(events, NOW)[0]!;

test("R175.5: HOWL_TASK wins over the task the host links to the change", () => {
  const r = row([opened("13"), agentEvent(30, from("7", "env"))]);
  assert.equal(r.task, "7");
});

test("R175.5: the task the host links to the change wins over the branch's", () => {
  const r = row([opened("13"), agentEvent(30, from("12", "branch"))]);
  assert.equal(r.task, "13");
});

test("R175.5: with no change on the branch, the branch's task stands", () => {
  const r = row([agentEvent(30, from("12", "branch"))]);
  assert.equal(r.task, "12");
});

test("R175.5: a change on the branch that the host links to no task leaves the branch's task", () => {
  const r = row([opened(), agentEvent(30, from("12", "branch"))]);
  assert.equal(r.task, "12");
});

test("R175.5: howl status ranks the same way, and shows the change only as the rules say", () => {
  const ws = onBranch("");
  mkdirSync(join(ws.home, PROJECT), { recursive: true });
  const cases: [string, LedgerEvent[], string, string | undefined][] = [
    ["env over host", [opened("13"), agentEvent(30, from("7", "env"))], "7", undefined],
    ["host over branch", [opened("13"), agentEvent(30, from("12", "branch"))], "13", "30"],
  ];
  for (const [label, events, task, change] of cases) {
    const home = folder();
    mkdirSync(join(home, PROJECT));
    const w = openLedger(join(home, PROJECT, "ledger.jsonl"), { project: PROJECT });
    for (const e of events) w.append(e);
    w.close();
    const run = howl(["status", "--json"], { cwd: ws.root, env: { HOWL_HOME: home } });
    assert.equal(run.status, 0, run.stderr);
    const [r] = JSON.parse(run.stdout) as { task?: string; change?: string }[];
    assert.equal(r!.task, task, label);
    assert.equal(r!.change, change, label);
  }
});

test("R175.5: the dashboard's agents rank the same way", async () => {
  const home = folder();
  mkdirSync(join(home, PROJECT));
  const w = openLedger(join(home, PROJECT, "ledger.jsonl"), { project: PROJECT });
  for (const e of [opened("13"), agentEvent(30, from("12", "branch"))]) w.append(e);
  w.close();
  const server = await startServer({ home, port: 0, root: folder() });
  try {
    const body = (await (await fetch(`${server.url}/api/agents?project=${PROJECT}`)).json()) as { rows: { task?: string; change?: string }[] };
    assert.deepEqual(body.rows.map((r) => [r.task, r.change]), [["13", "30"]]);
  } finally {
    await server.close();
  }
});

test("R175.6: an event with a task and no task_from is read as named by the session", () => {
  // Read as `branch`, the host's 13 would win and the change would show.
  const r = row([opened("13"), agentEvent(30, from("12"))]);
  assert.equal(r.task, "12");
  assert.equal(r.change, undefined);
});

test("R175.6: such an event is read as env also where the host links the same task", () => {
  const r = row([opened("12"), agentEvent(30, from("12"))]);
  assert.equal(r.task, "12");
  assert.equal(r.change, "30");
});

test("R175.7: the change on the branch is shown when the task came from the branch", () => {
  assert.equal(row([opened("13"), agentEvent(30, from("12", "branch"))]).change, "30");
  assert.equal(row([opened(), agentEvent(30, from("12", "branch"))]).change, "30");
});

test("R175.8: with no task, the change on the branch and the task the host links to it are shown", () => {
  const r = row([opened("13"), agentEvent(30)]);
  assert.equal(r.change, "30");
  assert.equal(r.task, "13");
});

test("R175.8: with no task and a change the host links to no task, the change is shown", () => {
  const r = row([opened(), agentEvent(30)]);
  assert.equal(r.change, "30");
  assert.equal(r.task, undefined);
});

test("R175.9: the change on the branch is shown when HOWL_TASK names the task the host links to it", () => {
  const r = row([opened("12"), agentEvent(30, from("12", "env"))]);
  assert.equal(r.change, "30");
  assert.equal(r.task, "12");
});

test("R175.10: a HOWL_TASK that is not the host's task for the change is shown no change", () => {
  const r = row([opened("13"), agentEvent(30, from("12", "env"))]);
  assert.equal(r.change, undefined);
  assert.equal(r.task, "12");
});

test("R175.10: a HOWL_TASK is shown no change that the host links to no task", () => {
  const r = row([opened(), agentEvent(30, from("12", "env"))]);
  assert.equal(r.change, undefined);
  assert.equal(r.task, "12");
});

test("R175.10: a task with no task_from is shown no change that the host links to another task or to none", () => {
  assert.equal(row([opened("13"), agentEvent(30, from("12"))]).change, undefined);
  assert.equal(row([opened(), agentEvent(30, from("12"))]).change, undefined);
});

test("R175.10: howl status shows no change on the branch for a HOWL_TASK that names another task", () => {
  const ws = onBranch("");
  const home = folder();
  mkdirSync(join(home, PROJECT));
  const w = openLedger(join(home, PROJECT, "ledger.jsonl"), { project: PROJECT });
  for (const e of [opened("13"), agentEvent(30, from("12", "env"))]) w.append(e);
  w.close();
  const run = howl(["status"], { cwd: ws.root, env: { HOWL_HOME: home } });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!/change 30|#30/.test(run.stdout), run.stdout);
  assert.ok(/task 12/.test(run.stdout), run.stdout);
  assert.ok(renderStatus(agentStates([opened("13"), agentEvent(30, from("12", "env"))], NOW), NOW).length > 0);
});

test("R175.10: a change named on the event is still shown, whatever the task came from", () => {
  // Guard: holds before the change.
  const r = row([opened("13"), agentEvent(30, { ...from("12", "env"), change: "31" })]);
  assert.equal(r.change, "31");
});

// 175.11: the observer's events carry no task_from.

test("R175.11: the observer's events carry no task_from, for a task from the host's link and one from the branch", () => {
  // Guard: holds before the change.
  const dir = folder();
  const ws = workspace({ yml: `project: ${PROJECT}\nhost: local\nlocal: ${dir}\nrepository: team/product\nagents: [agent-bot]\ntask_from_branch: '${PATTERN}'\n` });
  new LocalHost(dir)
    .task({ number: 1, openedAt: at(0), openedBy: { login: "alice" }, assignments: [], updatedAt: at(0) } as never)
    .change({ number: 10, branch: "task-1-feature", openedAt: at(2), openedBy: { login: "agent-bot" }, head: { sha: SHA.a, at: at(2) }, tasks: [1], reviews: [], updatedAt: at(2) } as never)
    .change({ number: 11, branch: "task-2-other", openedAt: at(3), openedBy: { login: "agent-bot" }, head: { sha: SHA.b, at: at(3) }, tasks: [], reviews: [], updatedAt: at(3) } as never);
  const run = howl(["observe", "--once"], { cwd: ws.root, env: ws.env });
  assert.equal(run.status, 0, run.stderr);
  const events = lines(ws.ledger).map((l) => l.event) as Record<string, unknown>[];
  const withTask = events.filter((e) => e.task !== undefined);
  assert.ok(withTask.some((e) => e.task === "1"), "a task from the host's link");
  assert.ok(withTask.some((e) => e.task === "2"), "a task from the branch");
  for (const e of events) assert.ok(!("task_from" in e), String(e.type));
});
