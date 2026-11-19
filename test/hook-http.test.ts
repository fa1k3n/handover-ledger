// #67: the hook line is curl, and `howl up` builds the event from the hook's own JSON.
// @code_class tests
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { curlHookLine, tokenOfLine } from "../src/hook/line.ts";
import { folder, git, howl, inboxEvents, inboxFiles, lines, PROJECT, rawLines, workspace, type Workspace } from "./helpers.ts";
import { LocalHost } from "./local-host.ts";
import { claim, send, until, up, type Up } from "./up-helpers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

let running: Up;
before(async () => {
  running = await up();
});
after(async () => {
  await running.stop();
});

const tokenFile = (ws: Workspace) => join(dirname(ws.ledger), "token");
const activity = (u: Up) => (existsSync(u.ws.activity) ? rawLines(u.ws.activity) : []);
const state = (u: Up) => JSON.stringify([rawLines(u.ws.ledger), activity(u), inboxFiles(u.ws.inbox)]);
/** Every event the server holds, of the ledger and of the activity file. */
const events = (u: Up): Record<string, any>[] => [...lines(u.ws.ledger).map((l) => l.event), ...activity(u).map((raw) => JSON.parse(raw))];

function hookJson(ws: Workspace, name: string, extra: Record<string, unknown> = {}, session = "session-1"): Record<string, unknown> {
  return { session_id: session, transcript_path: "/nowhere/t.jsonl", cwd: ws.root, hook_event_name: name, ...extra };
}

/** A hook's JSON sent to /api/hook as the hook line sends it. */
function sendHook(u: Up, body: unknown, headers: Record<string, string> = { "x-howl-actor": "agent-1" }, token: string | null = u.token): Promise<Response> {
  return fetch(`${u.url}/api/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const HOOKS: [string, Record<string, unknown>, string][] = [
  ["SessionStart", { source: "startup", model: "model-a", effort: { level: "high" } }, "session.started"],
  ["PostToolUse", { tool_name: "Read", tool_input: { file_path: "/x" }, tool_response: {}, tool_use_id: "t1" }, "tool.used"],
  ["Notification", { message: "Claude needs your permission", notification_type: "permission_prompt" }, "agent.waiting"],
  ["Stop", { stop_hook_active: false, last_assistant_message: "done" }, "session.stopped"],
  ["SessionEnd", { reason: "prompt_input_exit" }, "session.ended"],
];

test("each of the five hooks sent to /api/hook gives the event howl hook gives, but for id, time and the adapter", async () => {
  const names = { HOWL_ACTOR: "agent-7", HOWL_TASK: "12", HOWL_CHANGE: "30", HOWL_ROLE: "review" };
  const headers = { "x-howl-actor": "agent-7", "x-howl-task": "12", "x-howl-change": "30", "x-howl-role": "review" };
  for (const [name, extra, type] of HOOKS) {
    const session = `same-${name}`;
    const json = JSON.stringify(hookJson(running.ws, name, extra, session));
    // `howl hook` with a howl home of its own: no server there, so its event lies in that inbox.
    const home = folder();
    const built = howl(["hook"], { cwd: running.ws.root, env: { HOWL_HOME: home, ...names }, input: json });
    assert.equal(built.status, 0, built.stderr);
    const [byHook] = inboxEvents(join(home, "example", "inbox"));
    assert.equal(byHook?.type, type);

    const answer = await sendHook(running, json, headers);
    assert.equal(answer.status, 200);
    assert.equal(await answer.text(), "", "an empty body: Claude Code reads a JSON object as a decision");
    const byServer = await until(() => events(running).find((e) => e.session === session), 3000, `${name} at the server`);
    assert.deepEqual(byServer.source, { adapter: "claude-code-http", kind: "claimed" });
    const strip = (e: Record<string, any>) => {
      const { id: _id, time: _time, source: _source, ...rest } = e;
      return rest;
    };
    assert.deepEqual(strip(byServer), strip(byHook as Record<string, any>), name);
  }
});

test("a tool call's input and answer reach no file and no output of the server", async () => {
  const secrets = { input: "SECRET-IN-THE-INPUT-91c7", answer: "SECRET-IN-THE-ANSWER-4be2", message: "SECRET-IN-THE-MESSAGE-07aa" };
  const calls = [
    hookJson(running.ws, "PostToolUse", { tool_name: "Bash", tool_input: { command: `curl -H 'X: ${secrets.input}' https://example.invalid` }, tool_response: { stdout: secrets.answer } }, "secret"),
    hookJson(running.ws, "PostToolUseFailure", { tool_name: "Edit", tool_input: { file_path: join(running.ws.root, "a.ts"), new_string: secrets.input }, error: secrets.answer }, "secret"),
    hookJson(running.ws, "Stop", { last_assistant_message: secrets.message }, "secret"),
  ];
  for (const call of calls) assert.equal((await sendHook(running, call)).status, 200);
  await until(() => events(running).filter((e) => e.session === "secret").length === 3, 3000, "the three events");
  const tool = events(running).find((e) => e.session === "secret" && e.data?.tool === "Bash")!;
  assert.deepEqual(tool.data, { tool: "Bash", target: "curl", outcome: "succeeded" });
  const kept = [readFileSync(running.ws.ledger, "utf8"), activity(running).join("\n"), running.output()];
  for (const name of inboxFiles(running.ws.inbox)) kept.push(readFileSync(join(running.ws.inbox, name), "utf8"));
  for (const secret of Object.values(secrets)) assert.ok(!kept.some((text) => text.includes(secret)), secret);
  // And not in what the folder of the project holds besides.
  const found = spawnSync("grep", ["-rl", "SECRET-IN-THE", dirname(running.ws.ledger)], { encoding: "utf8" });
  assert.equal(found.status, 1, "grep ran and found no file");
  assert.equal(found.stdout, "");
});

test("no actor, a folder outside the project, and a hook howl does not record: 200, an empty body, and nothing written", async () => {
  await until(() => inboxFiles(running.ws.inbox).length === 0, 2000, "an empty inbox");
  const before = state(running);
  const started = (ws: Workspace | { root: string }) => hookJson(ws as Workspace, "SessionStart", { source: "startup" }, "nothing");
  const cases: [string, Promise<Response>][] = [
    ["no actor", sendHook(running, started(running.ws), {})],
    ["an empty actor", sendHook(running, started(running.ws), { "x-howl-actor": "" })],
    ["a folder with no .howl", sendHook(running, started({ root: folder() }))],
    ["another project's folder", sendHook(running, started({ root: elsewhere("another") }))],
    ["no cwd", sendHook(running, { session_id: "nothing", hook_event_name: "SessionStart" })],
    ["a hook howl does not record", sendHook(running, hookJson(running.ws, "PreToolUse", { tool_name: "Read" }, "nothing"))],
    ["a notification that is no wait", sendHook(running, hookJson(running.ws, "Notification", { notification_type: "auth_success" }, "nothing"))],
    ["an array", sendHook(running, [1, 2])],
  ];
  for (const [name, call] of cases) {
    const answer = await call;
    assert.equal(answer.status, 200, name);
    assert.equal(await answer.text(), "", name);
  }
  await settled(running);
  assert.ok(!events(running).some((e) => e.session === "nothing"));
  assert.equal(lines(running.ws.ledger).length, JSON.parse(before)[0].length + 1, "only the event that marks the end");
});

/**
 * Waits until the server has taken in everything sent so far: an event sent now is in the ledger,
 * and the inbox is taken in in the order it was left.
 */
async function settled(u: Up): Promise<void> {
  const mark = claim("session.stopped", { session: `settled-${Date.now()}` });
  assert.equal((await send(u.url, u.token, mark)).status, 200);
  await until(() => lines(u.ws.ledger).some((l) => l.event.id === mark.id), 3000, "the mark in the ledger");
  // The writer removes a file a moment after it wrote its line: waited for, not looked at once.
  await until(() => inboxFiles(u.ws.inbox).length === 0, 2000, "the inbox taken in");
}

/** A folder whose `.howl/howl.yml` names `project`. */
function elsewhere(project: string): string {
  const root = folder();
  mkdirSync(join(root, ".howl"));
  writeFileSync(join(root, ".howl", "howl.yml"), `project: ${project}\n`);
  return root;
}

/** A POST with headers `fetch` will not send. */
function rawPost(url: string, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${url}/api/hook`, { method: "POST", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("the refusals of /api/events hold for /api/hook, and nothing is written", async () => {
  await until(() => inboxFiles(running.ws.inbox).length === 0, 2000, "an empty inbox");
  const before = state(running);
  const good = () => hookJson(running.ws, "SessionStart", { source: "startup" }, "refused");
  const auth = { authorization: `Bearer ${running.token}`, "content-type": "application/json", "x-howl-actor": "agent-1" };
  const body = JSON.stringify(good());
  const length = { "content-length": String(Buffer.byteLength(body)) };
  assert.equal((await sendHook(running, good(), undefined, null)).status, 401, "no token");
  assert.equal((await sendHook(running, good(), undefined, "0".repeat(64))).status, 401, "a wrong token");
  assert.equal((await sendHook(running, good(), { origin: "http://example.invalid", "x-howl-actor": "agent-1" })).status, 403, "an Origin");
  assert.equal(await rawPost(running.url, { ...auth, ...length, host: "example.invalid" }, body), 403, "another Host");
  assert.equal((await sendHook(running, good(), { "content-type": "text/plain", "x-howl-actor": "agent-1" })).status, 415, "text/plain");
  assert.equal((await sendHook(running, "{not json")).status, 400, "not JSON");
  // Larger than a hook's JSON may be: said in the length, so nothing that large has to be sent here.
  assert.equal(await rawPost(running.url, { ...auth, "content-length": String(1024 * 1024 * 1024) }, body), 413, "too large");
  // An event larger than an event may be: a session id of 300 KB.
  assert.equal((await sendHook(running, hookJson(running.ws, "SessionStart", {}, "x".repeat(300 * 1024)))).status, 400, "an event too large");
  for (const method of ["GET", "PUT", "DELETE"]) assert.equal((await fetch(`${running.url}/api/hook`, { method })).status, 405, method);
  // No refusal is a JSON object.
  const refused = await sendHook(running, "{not json");
  assert.match(refused.headers.get("content-type") ?? "", /^text\/plain/);
  assert.throws(() => JSON.parse("{not json"));
  assert.ok(!(await refused.text()).trim().startsWith("{"));
  await settled(running);
  assert.ok(!events(running).some((e) => e.session === "refused"));
  assert.equal(lines(running.ws.ledger).length, JSON.parse(before)[0].length + 1, "only the event that marks the end");
});

/** What a server answers to the headers of a POST whose body never comes: the status, or null when it waits for the body. */
function statusBeforeBody(url: string, headers: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const { hostname, port } = new URL(url);
    const socket = connect(Number(port), hostname, () => {
      socket.write(`POST /api/hook HTTP/1.1\r\nHost: ${hostname}:${port}\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\n${headers.map((h) => `${h}\r\n`).join("")}\r\n{"cut":`);
    });
    const done = (status: number | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(status);
    };
    const timer = setTimeout(() => done(null), 1500);
    socket.on("data", (d) => done(Number(/^HTTP\/1\.1 (\d+)/.exec(String(d))?.[1] ?? 0)));
    socket.on("error", () => done(0));
  });
}

test("a sender without the token is answered before its body is read; one with it is heard", async () => {
  assert.equal(await statusBeforeBody(running.url, []), 401);
  assert.equal(await statusBeforeBody(running.url, [`Authorization: Bearer ${"0".repeat(64)}`]), 401);
  assert.equal(await statusBeforeBody(running.url, [`Authorization: Bearer ${running.token}`, "Origin: http://example.invalid"]), 403);
  assert.equal(await statusBeforeBody(running.url, [`Authorization: Bearer ${running.token}`]), null, "the server waits for the rest of the body");
});

test("a folder too long to be one, and a role prompt that is a pipe, do not hold the server up", async () => {
  const long = `/${Array.from({ length: 16_000 }, () => "a").join("/")}`;
  const started = Date.now();
  const answer = await sendHook(running, { session_id: "long", cwd: long, hook_event_name: "SessionStart" });
  assert.equal(answer.status, 200);
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms for a folder of 16000 parts`);
  assert.equal(spawnSync("mkfifo", [join(running.ws.root, "pipe.md")]).status, 0);
  const piped = await Promise.race([
    sendHook(running, hookJson(running.ws, "SessionStart", {}, "piped"), { "x-howl-actor": "agent-1", "x-howl-role-prompt": "pipe.md" }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
  assert.notEqual(piped, null, "the server answered");
  const event = await until(() => events(running).find((e) => e.session === "piped"), 3000, "the event");
  assert.equal(event.prompt, undefined, "a pipe is no role prompt");
  assert.ok(!events(running).some((e) => e.session === "long"));
});

test("the lasting token: a file for its owner only, the same after a new start, and taken by both POSTs", async () => {
  const mine = await up();
  const file = tokenFile(mine.ws);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // The file holds the header line itself, for `curl -H @file`: the token stands on no command line.
  assert.match(readFileSync(file, "utf8"), /^Authorization: Bearer [0-9a-f]{64}\n$/);
  const token = tokenOfLine(readFileSync(file, "utf8"))!;
  assert.notEqual(token, mine.token, "not the token of server.json, which is new at every start");
  assert.equal((await sendHook(mine, hookJson(mine.ws, "SessionStart", {}, "lasting"), undefined, token)).status, 200);
  assert.equal((await send(mine.url, token, claim("session.stopped"))).status, 200);
  assert.equal(await mine.stop(), 0);
  assert.ok(existsSync(file), "it stays when the server stops");
  const again = await up({ ws: mine.ws, host: mine.host });
  try {
    assert.equal(tokenOfLine(readFileSync(file, "utf8")), token);
    assert.notEqual(again.token, mine.token);
    assert.equal((await sendHook(again, hookJson(again.ws, "Stop", {}, "lasting"), undefined, token)).status, 200);
    await until(() => events(again).some((e) => e.session === "lasting" && e.type === "session.stopped"), 3000, "the event");
  } finally {
    await again.stop();
  }
});

const hasCurl = spawnSync("curl", ["--version"]).status === 0;

/** Runs the hook line with `sh`, the hook's JSON on its standard input. */
function runLine(line: string, json: string, env: Record<string, string>): Promise<{ status: number | null; output: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn("sh", ["-c", line], { env: { PATH: process.env.PATH ?? "", ...env } });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, output, ms: Date.now() - started }));
    child.stdin.end(json);
  });
}

test("the hook line, run with sh against howl up: the event is in the ledger, and it prints nothing", { skip: !hasCurl && "curl is not installed" }, async () => {
  const line = curlHookLine({ url: running.url, tokenFile: tokenFile(running.ws) });
  const json = JSON.stringify(hookJson(running.ws, "SessionStart", { source: "startup" }, "by-curl"));
  const run = await runLine(line, json, { HOWL_ACTOR: "agent-9", HOWL_TASK: "44" });
  assert.equal(run.status, 0);
  assert.equal(run.output, "");
  const event = await until(() => events(running).find((e) => e.session === "by-curl"), 3000, "the event of the hook line");
  assert.deepEqual(event.actor, { kind: "agent", id: "agent-9" });
  assert.equal(event.task, "44");
  assert.equal(event.change, undefined, "a name the session does not set is not sent");
  // With no actor in the session's environment nothing is recorded: a person's session.
  const person = await runLine(line, JSON.stringify(hookJson(running.ws, "SessionStart", {}, "a-person")), {});
  assert.equal(person.status, 0);
  assert.equal(person.output, "");
  await settled(running);
  assert.ok(!events(running).some((e) => e.session === "a-person"));
});

test("the hook line and howl hook give the same event for names beyond ASCII and a role prompt", { skip: !hasCurl && "curl is not installed" }, async () => {
  mkdirSync(join(running.ws.root, "prompts"), { recursive: true });
  writeFileSync(join(running.ws.root, "prompts", "granskare-å.md"), "Review as the team's rules say.\n");
  const names = { HOWL_ACTOR: "agent-å", HOWL_ROLE: "granskare", HOWL_ROLE_PROMPT: "prompts/granskare-å.md" };
  const json = JSON.stringify(hookJson(running.ws, "SessionStart", { source: "startup" }, "beyond-ascii"));
  const home = folder();
  assert.equal(howl(["hook"], { cwd: running.ws.root, env: { HOWL_HOME: home, ...names }, input: json }).status, 0);
  const [byHook] = inboxEvents(join(home, "example", "inbox")) as Record<string, any>[];
  assert.equal(byHook?.actor?.id, "agent-å");
  assert.equal(byHook?.prompt?.file, "prompts/granskare-å.md");
  const run = await runLine(curlHookLine({ url: running.url, tokenFile: tokenFile(running.ws) }), json, names);
  assert.equal(run.status, 0);
  const byServer = await until(() => events(running).find((e) => e.session === "beyond-ascii"), 3000, "the event of the hook line");
  for (const key of ["actor", "role", "prompt", "data", "type", "project"]) assert.deepEqual(byServer[key], byHook![key], key);
});

test("the token stands on no command line, and a machine without curl stays silent", async () => {
  const line = curlHookLine({ url: running.url, tokenFile: tokenFile(running.ws) });
  assert.ok(!line.includes("$("), "nothing is read into the command line");
  assert.match(line, /-H @"/);
  assert.ok(!line.includes(tokenOfLine(readFileSync(tokenFile(running.ws), "utf8"))!));
  // No curl on the PATH: nothing printed, and 0.
  const run = await new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", line], { env: { PATH: "/nonexistent" } });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, output }));
    child.stdin.on("error", () => {});
    child.stdin.end("{}");
  });
  assert.equal(run.status, 0);
  assert.equal(run.output, "");
});

test("the hook line against no server ends with 0 within two seconds and prints nothing", { skip: !hasCurl && "curl is not installed" }, async () => {
  const line = curlHookLine({ url: "http://127.0.0.1:1", tokenFile: join(folder(), "no-token") });
  const run = await runLine(line, JSON.stringify({ hook_event_name: "SessionStart" }), { HOWL_ACTOR: "agent-9" });
  assert.equal(run.status, 0);
  assert.equal(run.output, "");
  assert.ok(run.ms < 2000, `${run.ms} ms`);
});

test("the README shows the hook line as howl gives it", () => {
  const line = curlHookLine({ url: "http://127.0.0.1:4317", tokenFile: "$HOME/.local/state/howl/example/token" });
  assert.ok(readFileSync(join(ROOT, "README.md"), "utf8").includes(line), line);
});

test("R41.16: a hook sent to /api/hook gets the task from the branch, as howl hook gives it", async () => {
  const dir = folder();
  const ws = workspace({ yml: `project: ${PROJECT}\nhost: local\nlocal: ${dir}\nrepository: team/product\ntask_from_branch: '^task-([0-9]+)'\n` });
  git(ws.root, "init");
  git(ws.root, "checkout", "-b", "task-12-x");
  git(ws.root, "commit", "--allow-empty", "-m", "first");
  const mine = await up({ ws, host: new LocalHost(dir) });
  try {
    const json = JSON.stringify(hookJson(ws, "SessionStart", { source: "startup" }, "by-branch"));
    const home = folder();
    assert.equal(howl(["hook"], { cwd: ws.root, env: { HOWL_HOME: home, HOWL_ACTOR: "agent-1" }, input: json }).status, 0);
    const [byHook] = inboxEvents(join(home, "example", "inbox")) as Record<string, any>[];
    assert.equal(byHook?.task, "12", "howl hook gives the task");
    assert.equal(byHook?.branch, "task-12-x");
    assert.equal((await sendHook(mine, json)).status, 200);
    const byServer = await until(() => events(mine).find((e) => e.session === "by-branch"), 3000, "the event at the server");
    assert.deepEqual(byServer.source, { adapter: "claude-code-http", kind: "claimed" });
    assert.equal(byServer.task, "12");
    assert.equal(byServer.branch, "task-12-x");
  } finally {
    await mine.stop();
  }
});
