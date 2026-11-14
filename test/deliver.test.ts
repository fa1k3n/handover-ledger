// #64: the hook and `howl emit` hand an event to the writer's server, and keep the inbox file when they cannot.
// @code_class tests
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTcp } from "node:net";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { SERVER_PAUSE_MS, SERVER_TIMEOUT_MS } from "../src/inbox/deliver.ts";
import { howlAsync, inboxEvents, inboxFiles, lines, workspace, type Workspace } from "./helpers.ts";
import { serverFile, until, up, type Up } from "./up-helpers.ts";

const TOKEN = "a".repeat(64);

function hookInput(ws: Workspace, name = "SessionStart", extra: Record<string, unknown> = { source: "startup" }): string {
  return JSON.stringify({ session_id: "session-1", transcript_path: "/nowhere/t.jsonl", cwd: ws.root, hook_event_name: name, ...extra });
}

/** Runs `howl hook` without blocking this process, so a server in it can answer. It must print nothing and end with 0. */
async function hook(ws: Workspace, stdin = hookInput(ws)): Promise<number> {
  const started = Date.now();
  const result = await howlAsync(["hook"], { cwd: ws.root, env: ws.env, input: stdin });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  return Date.now() - started;
}

/** A server file as `howl up` writes one, for a server of this test's process unless `pid` says otherwise. */
function pointAt(ws: Workspace, url: string, pid = process.pid): void {
  mkdirSync(dirname(ws.ledger), { recursive: true });
  writeFileSync(serverFile(ws), JSON.stringify({ url, token: TOKEN, pid }), { mode: 0o600 });
}

const down = (ws: Workspace) => join(dirname(ws.ledger), "server.down");

/** A server that answers every POST with `status` and counts them. */
async function answering(status: number): Promise<{ url: string; calls: { auth?: string; type?: string; body: string }[]; close(): Promise<void> }> {
  const calls: { auth?: string; type?: string; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      calls.push({ auth: req.headers.authorization, type: req.headers["content-type"], body });
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(status === 200 ? { ok: true } : { error: "no" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let running: Up;
before(async () => {
  running = await up();
});
after(async () => {
  await running.stop();
});

// The rounds of this `howl up` are an hour apart. So an event that is in the ledger within seconds went
// through the server: a file the hook had left in the inbox would still lie there. It takes well under a
// second; the limit leaves room for a slow machine.
test("with howl up running, howl hook leaves nothing in the inbox and the event is in the ledger", async () => {
  await hook(running.ws);
  await until(() => lines(running.ws.ledger).some((l) => l.event.type === "session.started" && l.event.session === "session-1"), 3000, "the event in the ledger");
  // The writer removes the file a moment after it wrote the line: waited for, not looked at once.
  await until(() => inboxFiles(running.ws.inbox).length === 0, 2000, "the inbox taken in");
  assert.ok(!existsSync(down(running.ws)));
});

test("with howl up running, howl emit goes the same way", async () => {
  const result = await howlAsync(["emit", "checks.passed", "--change", "123"], { cwd: running.ws.root, env: running.ws.env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  await until(() => lines(running.ws.ledger).some((l) => l.event.type === "checks.passed" && l.event.change === "123"), 3000, "the event in the ledger");
  // The writer removes the file a moment after it wrote the line: waited for, not looked at once.
  await until(() => inboxFiles(running.ws.inbox).length === 0, 2000, "the inbox taken in");
});

test("the hook sends the event in its fixed form, with the token and as JSON", async () => {
  const ws = workspace();
  const server = await answering(200);
  try {
    pointAt(ws, server.url);
    await hook(ws);
    assert.equal(server.calls.length, 1);
    assert.equal(server.calls[0]!.auth, `Bearer ${TOKEN}`);
    assert.equal(server.calls[0]!.type, "application/json");
    const sent = JSON.parse(server.calls[0]!.body);
    assert.equal(sent.type, "session.started");
    assert.deepEqual(sent.source, { adapter: "claude-code-hook", kind: "claimed" });
    assert.deepEqual(inboxFiles(ws.inbox), []);
    assert.ok(!existsSync(down(ws)));
  } finally {
    await server.close();
  }
});

test("with a server file whose server is gone, the event is in the inbox, and the server is not asked again within the pause", async () => {
  const ws = workspace();
  // A port nothing listens on: taken, then given back.
  const gone = await answering(200);
  await gone.close();
  pointAt(ws, gone.url);
  await hook(ws);
  assert.equal(inboxFiles(ws.inbox).length, 1);
  assert.ok(existsSync(down(ws)), "server.down is written");

  // A server on a file again, yet within the pause: no call is made.
  const back = await answering(200);
  try {
    pointAt(ws, back.url);
    await hook(ws);
    assert.equal(back.calls.length, 0);
    assert.equal(inboxFiles(ws.inbox).length, 2);
    // After the pause it is asked again.
    writeFileSync(down(ws), `${new Date(Date.now() - SERVER_PAUSE_MS - 1000).toISOString()}\n`);
    await hook(ws);
    assert.equal(back.calls.length, 1);
    assert.equal(inboxFiles(ws.inbox).length, 2);
  } finally {
    await back.close();
  }
});

test("with a server that takes the connection and never answers, the hook ends in time and the event is in the inbox", async () => {
  const ws = workspace();
  const held: import("node:net").Socket[] = [];
  const silent = createTcp((socket) => held.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  try {
    pointAt(ws, `http://127.0.0.1:${(silent.address() as AddressInfo).port}`);
    const plain = await hook(workspace());
    const took = await hook(ws);
    // Within a second on top of what a hook takes anyway on this machine: the limit, and room for a slow start.
    assert.ok(took - plain < SERVER_TIMEOUT_MS + 500, `${took} ms against ${plain} ms without a server`);
    assert.equal(inboxFiles(ws.inbox).length, 1);
    assert.ok(existsSync(down(ws)));
  } finally {
    for (const socket of held) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});

for (const status of [401, 400, 500]) {
  test(`with a server that answers ${status}, the event is in the inbox and the server is still asked the next time`, async () => {
    const ws = workspace();
    const server = await answering(status);
    try {
      pointAt(ws, server.url);
      await hook(ws);
      await hook(ws);
      assert.equal(server.calls.length, 2);
      assert.equal(inboxFiles(ws.inbox).length, 2);
      assert.ok(!existsSync(down(ws)), "a server that answers is not down");
    } finally {
      await server.close();
    }
  });
}

test("a server file that names another machine, has no token, or cannot be read, is passed over: the inbox, and no call", async () => {
  const ws = workspace();
  mkdirSync(dirname(ws.ledger), { recursive: true });
  const pid = process.pid;
  for (const text of [JSON.stringify({ url: "http://example.invalid:4317", token: TOKEN, pid }), "{not json", JSON.stringify({ url: "http://127.0.0.1:1", pid })]) {
    writeFileSync(serverFile(ws), text);
    const took = await hook(ws);
    assert.ok(took < 5000);
  }
  assert.equal(inboxFiles(ws.inbox).length, 3);
  assert.ok(!existsSync(down(ws)));
});

test("a server file whose token cannot go into a header loses nothing: the inbox, silently", async () => {
  const server = await answering(200);
  try {
    for (const token of ["line\nbreak", "snow\u2603man", ""]) {
      const ws = workspace();
      mkdirSync(dirname(ws.ledger), { recursive: true });
      writeFileSync(serverFile(ws), JSON.stringify({ url: server.url, token, pid: process.pid }));
      await hook(ws);
      assert.equal(inboxFiles(ws.inbox).length, 1, JSON.stringify(token));
      const emitted = await howlAsync(["emit", "checks.passed"], { cwd: ws.root, env: ws.env });
      assert.equal(emitted.status, 0, emitted.stderr);
      assert.equal(emitted.stderr, "");
      assert.equal(inboxFiles(ws.inbox).length, 2);
    }
    assert.equal(server.calls.length, 0);
  } finally {
    await server.close();
  }
});

test("a server file that is a pipe or a folder does not hold the hook up", async () => {
  for (const make of [(path: string) => spawnSync("mkfifo", [path]), (path: string) => mkdirSync(path)]) {
    const ws = workspace();
    mkdirSync(dirname(ws.ledger), { recursive: true });
    make(serverFile(ws));
    const result = await Promise.race([hook(ws), new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))]);
    assert.notEqual(result, null, "the hook ended");
    assert.equal(inboxFiles(ws.inbox).length, 1);
  }
});

test("a server that answers 200 with anything but ok has not taken the event", async () => {
  const ws = workspace();
  const calls: number[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls.push(1);
      res.writeHead(200, { "content-type": "text/html" }).end("<p>hello</p>");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    pointAt(ws, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await hook(ws);
    assert.equal(calls.length, 1);
    assert.equal(inboxFiles(ws.inbox).length, 1);
    assert.ok(!existsSync(down(ws)), "it answered: it is not down");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a server.down from a time to come does not keep the server from being asked", async () => {
  const ws = workspace();
  const server = await answering(200);
  try {
    pointAt(ws, server.url);
    writeFileSync(down(ws), `${new Date(Date.now() + 365 * 86_400_000).toISOString()}\n`);
    await hook(ws);
    assert.equal(server.calls.length, 1);
    assert.deepEqual(inboxFiles(ws.inbox), []);
  } finally {
    await server.close();
  }
});

test("a server file left by a process that is gone sends nothing to whatever has its port now", async () => {
  const ws = workspace();
  // A process that has ended: its id names no one.
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const server = await answering(200);
  try {
    pointAt(ws, server.url, Number(gone.stdout));
    await hook(ws);
    assert.equal(server.calls.length, 0);
    assert.equal(inboxFiles(ws.inbox).length, 1);
    assert.ok(!existsSync(down(ws)));
    // The same file with a process that runs is used.
    pointAt(ws, server.url);
    await hook(ws);
    assert.equal(server.calls.length, 1);
  } finally {
    await server.close();
  }
});

test("without a server file the event is left in the inbox, as before", async () => {
  const ws = workspace();
  await hook(ws);
  assert.equal(inboxEvents(ws.inbox).length, 1);
  assert.equal(inboxEvents(ws.inbox)[0]!.type, "session.started");
});
