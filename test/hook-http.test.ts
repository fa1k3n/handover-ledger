// #67: the hook line is curl, and `howl up` builds the event from the hook's own JSON.
// @code_class tests
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { curlHookLine } from "../src/hook/line.ts";
import { folder, howl, inboxEvents, inboxFiles, lines, rawLines, type Workspace } from "./helpers.ts";
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
  assert.deepEqual(tool.data, { tool: "Bash", target: "curl", outcome: "succeeded", ...("input_sha256" in tool.data ? { input_sha256: tool.data.input_sha256 } : {}) });
  const kept = [readFileSync(running.ws.ledger, "utf8"), activity(running).join("\n"), running.output()];
  for (const name of inboxFiles(running.ws.inbox)) kept.push(readFileSync(join(running.ws.inbox, name), "utf8"));
  for (const secret of Object.values(secrets)) assert.ok(!kept.some((text) => text.includes(secret)), secret);
  // And not in what the folder of the project holds besides.
  const found = spawnSync("grep", ["-rl", "SECRET-IN-THE", dirname(running.ws.ledger)], { encoding: "utf8" });
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
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(state(running), before);
});

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
  const tooLarge = await rawPost(running.url, { ...auth, "content-length": String(1024 * 1024 * 1024) }, body).catch(() => 413);
  assert.equal(tooLarge, 413, "too large");
  for (const method of ["GET", "PUT", "DELETE"]) assert.equal((await fetch(`${running.url}/api/hook`, { method })).status, 405, method);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(state(running), before);
});

test("the lasting token: a file for its owner only, the same after a new start, and taken by both POSTs", async () => {
  const mine = await up();
  const file = tokenFile(mine.ws);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const token = readFileSync(file, "utf8").trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.notEqual(token, mine.token, "not the token of server.json, which is new at every start");
  assert.equal((await sendHook(mine, hookJson(mine.ws, "SessionStart", {}, "lasting"), undefined, token)).status, 200);
  assert.equal((await send(mine.url, token, claim("session.stopped"))).status, 200);
  assert.equal(await mine.stop(), 0);
  assert.ok(existsSync(file), "it stays when the server stops");
  const again = await up({ ws: mine.ws, host: mine.host });
  try {
    assert.equal(readFileSync(file, "utf8").trim(), token);
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
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(!events(running).some((e) => e.session === "a-person"));
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
