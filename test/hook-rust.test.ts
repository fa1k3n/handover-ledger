// `howl hook` in Rust, to the inbox: the tests of issue #141. They start the binary named by HOWL_BIN with no
// HOWL_FALLBACK, so what they see is the Rust side's own work, and set it beside what the TypeScript leaves.
// @code_class tests
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { folder, git, PROJECT, workspace, type Workspace } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli/howl.ts", import.meta.url));
const bin = process.env.HOWL_BIN;
const compare = bin && process.env.HOWL_COMPARE ? false : "HOWL_BIN and HOWL_COMPARE are not both set";
const binary = bin ? false : "HOWL_BIN is not set";

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** `howl hook` from the binary alone, or from the TypeScript, with no environment but PATH and `env`. */
function hook(version: "rust" | "typescript", input: string, cwd: string, env: Record<string, string>): Run {
  const base = { PATH: process.env.PATH ?? "", ...env };
  const [file, argv] = version === "rust" ? [resolve(bin!), ["hook"]] : [process.execPath, [CLI, "hook"]];
  const run = spawnSync(file, argv, { cwd, env: base, input, encoding: "utf8" });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** The one file each version leaves for `input`, or null when it leaves none. */
function leftBy(version: "rust" | "typescript", ws: Workspace, input: string, env: Record<string, string>): { name: string; text: string; mode: number } | null {
  const home = folder();
  const run = hook(version, input, ws.root, { ...ws.env, ...env, HOWL_HOME: home });
  assert.deepEqual(run, { status: 0, stdout: "", stderr: "" }, `${version}: silent, status 0`);
  const inbox = join(home, PROJECT, "inbox");
  if (!existsSync(inbox)) return null;
  const names = readdirSync(inbox);
  assert.equal(names.length, 1, `${version}: one file, none under a temporary name: ${names.join(" ")}`);
  const name = names[0]!;
  return { name, text: readFileSync(join(inbox, name), "utf8"), mode: statSync(join(inbox, name)).mode & 0o777 };
}

const NAME = /^\d{15}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

/** The text of a file with its `id` and `time` taken out: what must be the same in both versions. */
function without(text: string): string {
  const event = JSON.parse(text) as Record<string, unknown>;
  assert.match(String(event.id), UUID);
  assert.match(String(event.time), TIME);
  return text.replace(`"id":"${event.id}"`, '"id":"…"').replace(`"time":"${event.time}"`, '"time":"…"');
}

/** A repository on the branch `task-12-x` with a remote, a role prompt and a task_from_branch. */
function repository(): Workspace {
  const ws = workspace({ yml: `project: ${PROJECT}   # the project\ntask_from_branch: '^task-([0-9]+)'\nagents: [agent-1]\n` });
  git(ws.root, "init", "-q");
  git(ws.root, "checkout", "-q", "-b", "task-12-x");
  git(ws.root, "remote", "add", "origin", "https://example.invalid/team/product.git");
  git(ws.root, "commit", "-q", "--allow-empty", "-m", "first");
  mkdirSync(join(ws.root, "roles"));
  writeFileSync(join(ws.root, "roles", "review-å.md"), "Review the change.\n");
  mkdirSync(join(ws.root, "src", "deep"), { recursive: true });
  return ws;
}

const json = (ws: Workspace, name: string, extra: Record<string, unknown> = {}, cwd: string = ws.root) =>
  JSON.stringify({ session_id: "session-1", transcript_path: "/nowhere/t.jsonl", cwd, hook_event_name: name, ...extra });

test("#141: an inbox file from each version for the same input differs only in id, time and the file's name", { skip: compare }, () => {
  const ws = repository();
  const cases: [string, string, Record<string, string>][] = [
    ["a start", json(ws, "SessionStart", { source: "startup", model: "model-a", effort: { level: "high" } }), {}],
    ["a start with a plain effort", json(ws, "SessionStart", { source: "resume", effort: "low" }), {}],
    ["a shell command", json(ws, "PostToolUse", { tool_name: "Bash", tool_input: { command: 'TOKEN="a b" ./scripts/run.sh --x' }, tool_response: { stdout: "x" } }), {}],
    ["a file", json(ws, "PostToolUse", { tool_name: "Write", tool_input: { file_path: join(ws.root, "src", "main.c"), content: "secret" } }), {}],
    ["the root itself", json(ws, "PostToolUse", { tool_name: "Glob", tool_input: { path: ws.root } }), {}],
    ["a notebook", json(ws, "PostToolUse", { tool_name: "NotebookEdit", tool_input: { notebook_path: join(ws.root, "n.ipynb") } }), {}],
    ["a file outside", json(ws, "PostToolUseFailure", { tool_name: "Read", tool_input: { file_path: "/etc/hosts" }, error: "no" }), {}],
    ["no tool name", json(ws, "PostToolUse", { tool_input: [1, 2] }), {}],
    ["a wait", json(ws, "Notification", { message: "m", notification_type: "idle_prompt" }), {}],
    ["a stop", json(ws, "Stop", { stop_hook_active: false }), {}],
    ["an end", json(ws, "SessionEnd", { reason: "clear" }), {}],
    ["an end with no reason", json(ws, "SessionEnd", { reason: "" }), {}],
    ["a folder below the root", json(ws, "Stop", {}, join(ws.root, "src", "deep")), {}],
    ["a relative cwd", json(ws, "Stop", {}, "src"), {}],
    ["what the session names", json(ws, "Stop"), { HOWL_CHANGE: " 30 ", HOWL_ROLE: "review", HOWL_ROLE_PROMPT: "roles/review-å.md", HOWL_HARNESS: "h", HOWL_HARNESS_REVISION: "1 2" }],
    ["the task from the session", json(ws, "Stop"), { HOWL_TASK: "7" }],
    ["an actor beyond ASCII", json(ws, "Stop"), { HOWL_ACTOR: "  agent-å  " }],
    ["a prompt outside", json(ws, "Stop"), { HOWL_ROLE_PROMPT: "../x.md" }],
    ["a key given twice", '{"hook_event_name":"Stop","session_id":"a","session_id":"b\\u00e5\\ud83d\\ude00"}', {}],
    // A lone surrogate in a part of the path that is not kept: the target is what follows it.
    ["a lone surrogate before a `..` in a path", json(ws, "PostToolUse", { tool_name: "Read", tool_input: { file_path: `${ws.root}/\ud800/../x` } }), {}],
    ["deeply nested in what is dropped", `{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls","x":${"[".repeat(5000)}${"]".repeat(5000)}}}`, {}],
  ];
  for (const [label, input, env] of cases) {
    const rust = leftBy("rust", ws, input, env);
    const typescript = leftBy("typescript", ws, input, env);
    assert.ok(rust && typescript, `${label}: both leave a file`);
    assert.match(rust.name, NAME, label);
    assert.equal(rust.mode, 0o600, label);
    assert.equal(without(rust.text), without(typescript.text), label);
  }
});

test("#141: what the TypeScript records nothing for, the binary records nothing for", { skip: compare }, () => {
  const ws = repository();
  const cases: [string, string, Record<string, string>][] = [
    ["empty", "", {}],
    ["not JSON", "{", {}],
    ["an array", "[1]", {}],
    ["a byte order mark", `\ufeff${json(ws, "Stop")}`, {}],
    ["a hook not recorded", json(ws, "PreToolUse", { tool_name: "Bash" }), {}],
    ["a notification that is no wait", json(ws, "Notification", { notification_type: "auth_success" }), {}],
    ["no actor", json(ws, "Stop"), { HOWL_ACTOR: " " }],
    ["a lone surrogate in what is kept", '{"hook_event_name":"Stop","session_id":"\\ud800"}', {}],
  ];
  for (const [label, input, env] of cases) {
    assert.equal(leftBy("typescript", ws, input, env), null, `${label}: the TypeScript`);
    assert.equal(leftBy("rust", ws, input, env), null, `${label}: the binary`);
  }
  // A task_from_branch that is no regular expression with the u flag.
  const bad = workspace({ yml: `project: ${PROJECT}\ntask_from_branch: '^task\\_([0-9]+)'\n` });
  assert.equal(leftBy("typescript", bad, json(bad, "Stop"), {}), null);
  assert.equal(leftBy("rust", bad, json(bad, "Stop"), {}), null);
});

test("#141: a hook input that makes the binary panic still gives no output, status 0, and nothing written", { skip: binary }, () => {
  const ws = workspace();
  const run = hook("rust", json(ws, "Stop"), ws.root, { ...ws.env, HOWL_TEST_PANIC: "1" });
  assert.deepEqual(run, { status: 0, stdout: "", stderr: "" });
  assert.deepEqual(readdirSync(ws.home), []);
  // Without the switch the same input is recorded.
  assert.deepEqual(hook("rust", json(ws, "Stop"), ws.root, ws.env), { status: 0, stdout: "", stderr: "" });
  assert.equal(readdirSync(join(ws.home, PROJECT, "inbox")).length, 1);
});

/** A stand-in for node that keeps its arguments and what it finds on standard input. */
function standIn(): { node: string; out: string } {
  const dir = folder();
  const node = join(dir, "node");
  const out = join(dir, "out");
  writeFileSync(node, `#!/bin/sh\necho "args $*" > '${out}'\ncat >> '${out}'\n`);
  chmodSync(node, 0o755);
  return { node, out };
}

test("#141: with HOWL_KEY set, or a server.json in the project folder, the hook becomes node before it reads standard input", { skip: binary }, () => {
  for (const which of ["key", "server"]) {
    const ws = workspace();
    const env: Record<string, string> = { ...ws.env };
    if (which === "key") env.HOWL_KEY = "/nowhere/key.json";
    else {
      mkdirSync(join(ws.home, PROJECT), { recursive: true });
      writeFileSync(join(ws.home, PROJECT, "server.json"), "{}");
    }
    const { node, out } = standIn();
    const input = json(ws, "Stop");
    const run = hook("rust", input, ws.root, { ...env, HOWL_FALLBACK: CLI, HOWL_NODE: node });
    assert.deepEqual(run, { status: 0, stdout: "", stderr: "" }, which);
    assert.equal(readFileSync(out, "utf8"), `args ${CLI} hook\n${input}`, `${which}: node gets the arguments and the whole input`);
    assert.ok(!existsSync(join(ws.home, PROJECT, "inbox")), `${which}: the binary leaves nothing itself`);
  }
});

test("#141: without HOWL_FALLBACK, a hook with HOWL_KEY set or a server.json is left in the inbox, unsigned, silently", { skip: binary }, () => {
  for (const which of ["key", "server"]) {
    const ws = workspace();
    const env: Record<string, string> = { ...ws.env };
    if (which === "key") env.HOWL_KEY = "/nowhere/key.json";
    else {
      mkdirSync(join(ws.home, PROJECT), { recursive: true });
      writeFileSync(join(ws.home, PROJECT, "server.json"), "{}");
    }
    assert.deepEqual(hook("rust", json(ws, "Stop"), ws.root, env), { status: 0, stdout: "", stderr: "" }, which);
    const inbox = join(ws.home, PROJECT, "inbox");
    const files = readdirSync(inbox);
    assert.equal(files.length, 1, which);
    const event = JSON.parse(readFileSync(join(inbox, files[0]!), "utf8")) as Record<string, unknown>;
    assert.equal(event.type, "session.stopped", which);
    assert.equal(event.sig, undefined, which);
  }
});

test("#141: panic = \"unwind\" is kept for the binary, so that a panic in the hook can be caught", () => {
  const toml = readFileSync(new URL("../rust/Cargo.toml", import.meta.url), "utf8");
  assert.match(toml, /^\[profile\.release\][^[]*^panic = "unwind"$/m);
  assert.doesNotMatch(toml, /panic = "abort"/);
});
