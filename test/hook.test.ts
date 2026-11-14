// `howl hook`: the tests of issue #2.
// @code_class tests
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { eventFaults } from "../src/ledger/schema.ts";
import {
  folder,
  git,
  howl,
  howlAsync,
  inboxEvents,
  inboxFiles,
  PROJECT,
  workspace,
  type Workspace,
} from "./helpers.ts";

/** The JSON a hook of Claude Code gets on standard input. */
function input(ws: Workspace, name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "session-1",
    transcript_path: "/nowhere/transcript.jsonl",
    cwd: ws.root,
    hook_event_name: name,
    ...extra,
  });
}

/** Runs `howl hook` and expects it to print nothing and end with 0, whatever happens. */
function hook(ws: Workspace, stdin: string, env: Record<string, string> = ws.env, cwd = ws.root): void {
  const result = howl(["hook"], { cwd, env, input: stdin });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "a hook prints nothing: the stdout of SessionStart goes to the model");
  assert.equal(result.stderr, "");
}

const HOOKS: [string, Record<string, unknown>, string][] = [
  ["SessionStart", { source: "startup", model: "model-a" }, "session.started"],
  ["PostToolUse", { tool_name: "Read", tool_input: { file_path: "/x" }, tool_response: {}, tool_use_id: "t1" }, "tool.used"],
  ["Notification", { message: "Claude needs your permission", notification_type: "permission_prompt" }, "agent.waiting"],
  ["Stop", { stop_hook_active: false, last_assistant_message: "done" }, "session.stopped"],
  ["SessionEnd", { reason: "prompt_input_exit" }, "session.ended"],
];

test("outside a repository with .howl/howl.yml, howl hook writes nothing and ends with 0", () => {
  const ws = workspace();
  const outside = folder();
  for (const [name, extra] of HOOKS) {
    hook(ws, JSON.stringify({ session_id: "s", cwd: outside, hook_event_name: name, ...extra }), ws.env, outside);
  }
  assert.deepEqual(readdirSync(ws.home), []);
});

test("each of the five hooks gives one inbox file of its type, kind: claimed, with the session and the project", () => {
  const ws = workspace();
  for (const [name, extra, type] of HOOKS) {
    const before = inboxFiles(ws.inbox).length;
    hook(ws, input(ws, name, extra));
    const events = inboxEvents(ws.inbox);
    assert.equal(events.length, before + 1, name);
    const e = events.find((x) => x.type === type);
    assert.ok(e, `${name} gives ${type}`);
    assert.deepEqual(e.source, { adapter: "claude-code-hook", kind: "claimed" });
    assert.equal(e.session, "session-1");
    assert.equal(e.project, PROJECT);
    assert.deepEqual(e.actor, { kind: "agent", id: "agent-1" });
    assert.deepEqual(eventFaults(e), [], name);
  }
});

test("a failed tool call gives tool.used with the outcome failed, and no error text", () => {
  const ws = workspace();
  hook(ws, input(ws, "PostToolUseFailure", {
    tool_name: "Bash",
    tool_input: { command: "make secret-target" },
    tool_use_id: "t1",
    error: "Exit code 2\nmake: *** No rule to make target 'secret-target'",
  }));
  const [e] = inboxEvents(ws.inbox);
  assert.equal(e?.type, "tool.used");
  assert.equal(e?.data?.outcome, "failed");
  assert.ok(!JSON.stringify(e).includes("secret-target"));
});

test("a successful tool call has the outcome succeeded", () => {
  const ws = workspace();
  hook(ws, input(ws, "PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: {} }));
  assert.equal(inboxEvents(ws.inbox)[0]?.data?.outcome, "succeeded");
});

test("a notification that is not a wait for a person gives no event", () => {
  const ws = workspace();
  hook(ws, input(ws, "Notification", { message: "signed in", notification_type: "auth_success" }));
  assert.deepEqual(inboxFiles(ws.inbox), []);
});

test("a wait keeps the kind of notification, never its message", () => {
  const ws = workspace();
  hook(ws, input(ws, "Notification", { message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" }));
  const [e] = inboxEvents(ws.inbox);
  assert.deepEqual(e?.data, { notification_type: "permission_prompt", waits_for: "person" });
});

test("the model and the effort are read where the hook gives them, and left out where it does not", () => {
  const ws = workspace();
  hook(ws, input(ws, "SessionStart", { source: "startup", model: "model-a", effort: { level: "high" } }));
  hook(ws, input(ws, "Stop", {}));
  const [started, stopped] = inboxEvents(ws.inbox);
  assert.equal(started?.model, "model-a");
  assert.equal(started?.effort, "high");
  assert.equal(stopped?.model, undefined);
  assert.equal(stopped?.effort, undefined);
});

test("a session's start keeps its source, and its end its reason", () => {
  const ws = workspace();
  hook(ws, input(ws, "SessionStart", { source: "resume" }));
  hook(ws, input(ws, "SessionEnd", { reason: "clear" }));
  const [started, ended] = inboxEvents(ws.inbox);
  assert.deepEqual(started?.data, { source: "resume" });
  assert.deepEqual(ended?.data, { reason: "clear" });
});

test("in a git checkout the event holds the branch and the head commit", () => {
  const ws = workspace();
  git(ws.root, "init", "-q");
  git(ws.root, "checkout", "-q", "-b", "feature/x");
  git(ws.root, "add", ".howl");
  git(ws.root, "commit", "-q", "-m", "first");
  const head = git(ws.root, "rev-parse", "HEAD");
  hook(ws, input(ws, "SessionStart", { source: "startup" }));
  const [e] = inboxEvents(ws.inbox);
  assert.equal(e?.branch, "feature/x");
  assert.equal(e?.sha, head);
});

test("outside a git checkout the event holds neither the branch nor the commit, and is still written", () => {
  const ws = workspace();
  hook(ws, input(ws, "SessionStart", { source: "startup" }));
  const [e] = inboxEvents(ws.inbox);
  assert.ok(e);
  assert.equal(e.branch, undefined);
  assert.equal(e.sha, undefined);
});

test("repo is the name of the repository, never a path on the machine", () => {
  const ws = workspace();
  git(ws.root, "init", "-q");
  git(ws.root, "remote", "add", "origin", "git@example.invalid:team/product.git");
  hook(ws, input(ws, "SessionStart", { source: "startup" }));
  const [e] = inboxEvents(ws.inbox);
  assert.equal(e?.repo, "team/product");
  assert.ok(!JSON.stringify(e).includes(ws.root));
});

test("the actor comes from $HOWL_ACTOR, else .howl/actor", () => {
  const ws = workspace({ actor: null });
  writeFileSync(join(ws.root, ".howl", "actor"), "\nagent-from-file\n");
  hook(ws, input(ws, "Stop"));
  hook(ws, input(ws, "Stop"), { ...ws.env, HOWL_ACTOR: "agent-from-env" });
  const actors = inboxEvents(ws.inbox).map((e) => e.actor?.id).sort();
  assert.deepEqual(actors, ["agent-from-env", "agent-from-file"]);
  for (const e of inboxEvents(ws.inbox)) assert.equal(e.actor?.kind, "agent");
});

test("with neither $HOWL_ACTOR nor .howl/actor the session is a person's: howl hook writes nothing and ends with 0", () => {
  const ws = workspace({ actor: null });
  for (const [name, extra] of HOOKS) hook(ws, input(ws, name, extra));
  assert.deepEqual(readdirSync(ws.home), []);
});

test("a tool call on a file keeps the path within the repository and no content", () => {
  const ws = workspace();
  const content = "the content of the file, never to be kept";
  hook(ws, input(ws, "PostToolUse", {
    tool_name: "Write",
    tool_input: { file_path: join(ws.root, "src", "main.c"), content },
    tool_response: { filePath: join(ws.root, "src", "main.c"), type: "create" },
  }));
  const [e] = inboxEvents(ws.inbox);
  assert.equal(e?.data?.tool, "Write");
  assert.equal(e?.data?.target, "src/main.c");
  const file = readFileSync(join(ws.inbox, inboxFiles(ws.inbox)[0]!), "utf8");
  assert.ok(!file.includes(content));
  assert.ok(!file.includes(ws.root));
});

test("a tool call on a file outside the repository keeps no path", () => {
  const ws = workspace();
  hook(ws, input(ws, "PostToolUse", { tool_name: "Read", tool_input: { file_path: "/etc/hosts" }, tool_response: {} }));
  const [e] = inboxEvents(ws.inbox);
  assert.equal(e?.data?.target, undefined);
  assert.ok(!JSON.stringify(e).includes("/etc/hosts"));
});

test("a shell command keeps the program's name, not the command and no hash of it", () => {
  const ws = workspace();
  const toolInput = { command: "TOKEN=abc123 curl -H 'Authorization: abc123' https://example.invalid", description: "x" };
  hook(ws, input(ws, "PostToolUse", { tool_name: "Bash", tool_input: toolInput, tool_response: {} }));
  const [e] = inboxEvents(ws.inbox);
  assert.equal(e?.data?.target, "curl");
  assert.equal(e?.data?.input_sha256, undefined);
  assert.ok(!JSON.stringify(e).includes("abc123"));
});

test("a shell command that first sets a variable on a line of its own keeps the program of the next line", () => {
  const ws = workspace();
  const commands: [string, string | undefined][] = [
    ['H=/tmp/x/y\nmkdir -p "$H"', "mkdir"],
    ["A=1; B=2 make check", "make"],
    ["X=1 && ./scripts/build.sh --fast", "build.sh"],
    ["A=1 B=2", undefined],
    ['"$H"/run.sh', "run.sh"],
    ["$(which make) check", undefined],
  ];
  for (const [command] of commands) {
    hook(ws, input(ws, "PostToolUse", { tool_name: "Bash", tool_input: { command }, tool_response: {} }));
  }
  assert.deepEqual(
    inboxEvents(ws.inbox).map((e) => e.data?.target),
    commands.map(([, target]) => target),
  );
});

test("input that is not JSON: nothing printed, status 0, nothing written", () => {
  const ws = workspace();
  for (const stdin of ["", "not json", "[1,2]", "null", '{"hook_event_name":"NoSuchHook","cwd":"/"}']) {
    hook(ws, stdin);
  }
  assert.deepEqual(inboxFiles(ws.inbox), []);
});

test("an inbox that cannot be written: nothing printed, status 0", () => {
  const ws = workspace();
  // HOWL_HOME is a file, so no folder can be made in it.
  const blocked = join(folder(), "file");
  writeFileSync(blocked, "");
  hook(ws, input(ws, "SessionStart", { source: "startup" }), { ...ws.env, HOWL_HOME: blocked });

  // A relative HOWL_HOME is refused by the place of the ledger; still silent.
  hook(ws, input(ws, "SessionStart", { source: "startup" }), { ...ws.env, HOWL_HOME: "relative" });

  // An inbox folder that may not be written to.
  mkdirSync(ws.inbox, { recursive: true });
  chmodSync(ws.inbox, 0o500);
  try {
    hook(ws, input(ws, "SessionStart", { source: "startup" }));
  } finally {
    chmodSync(ws.inbox, 0o700);
  }
});

test("twenty hooks started at once give twenty files, none half written", async () => {
  const ws = workspace();
  const runs = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      howlAsync(["hook"], {
        cwd: ws.root,
        env: ws.env,
        input: input(ws, "PostToolUse", { tool_name: "Bash", tool_input: { command: `echo ${i}` }, tool_response: {} }),
      }),
    ),
  );
  for (const run of runs) assert.deepEqual([run.status, run.stdout, run.stderr], [0, "", ""]);
  const names = readdirSync(ws.inbox);
  assert.equal(names.length, 20, names.join(" "));
  assert.equal(inboxFiles(ws.inbox).length, 20, "no file under a temporary name is left");
  const events = inboxEvents(ws.inbox);
  assert.equal(new Set(events.map((e) => e.id)).size, 20);
  for (const e of events) assert.deepEqual(eventFaults(e), []);
});

test(".howl/howl.yml is found from a folder below the root", () => {
  const ws = workspace();
  const below = join(ws.root, "src", "deep");
  mkdirSync(below, { recursive: true });
  hook(ws, JSON.stringify({ session_id: "s", cwd: below, hook_event_name: "Stop" }), ws.env, below);
  assert.equal(inboxFiles(ws.inbox).length, 1);
});

test("a howl.yml without a project gives no event", () => {
  const ws = workspace({ yml: "# no project here\nactivity_days: 3\n" });
  hook(ws, input(ws, "Stop"));
  assert.deepEqual(readdirSync(ws.home), []);
  assert.ok(!existsSync(ws.inbox));
});
