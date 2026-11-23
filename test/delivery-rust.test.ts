// Delivery in the binary: the tests of issue #142. The hook and `howl emit` of the binary send what those of the
// TypeScript send, ask no longer than they do, and lose nothing. The binary is started without HOWL_FALLBACK.
// @code_class tests
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer as createHttp, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createTcp, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { VERSIONS, binary, hookJson, leftIn, runAsync, sameButForIdAndTime, type Version } from "./binary.ts";
import { inboxFiles, lines, workspace, type Workspace } from "./helpers.ts";
import { serverFile, until, up, type Up } from "./up-helpers.ts";

const TOKEN = "t".repeat(48) + "-._~!#$%&'()*+,/:;=?@[]";

interface Call {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  body: string;
}

/** A server that answers every POST with `answer` and keeps what it was sent. */
async function answering(status = 200, reply = '{"ok":true}'): Promise<{ url: string; calls: Call[]; close(): Promise<void> }> {
  const calls: Call[] = [];
  const server: Server = createHttp((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body });
      res.writeHead(status, { "content-type": "application/json" }).end(reply);
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

function pointAt(ws: Workspace, url: string, pid = process.pid, token = TOKEN): void {
  mkdirSync(dirname(ws.ledger), { recursive: true });
  writeFileSync(serverFile(ws), JSON.stringify({ url, token, pid }), { mode: 0o600 });
}

const down = (ws: Workspace) => join(dirname(ws.ledger), "server.down");

const quiet = (r: { status: number | null; stdout: string; stderr: string }, what: string) => assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 0, stdout: "", stderr: "" }, what);

async function hook(version: Version, ws: Workspace, input = hookJson(ws)) {
  const done = await runAsync(version, ["hook"], ws.root, ws.env, input);
  quiet(done, `${version}: the hook`);
  return done;
}

test("#142: the request of the binary is the request of the TypeScript, but for id and time", { skip: binary }, async () => {
  const server = await answering();
  try {
    for (const version of VERSIONS) {
      const ws = workspace();
      pointAt(ws, server.url);
      await hook(version, ws);
      assert.deepEqual(inboxFiles(ws.inbox), [], `${version}: taken, nothing left`);
    }
    assert.equal(server.calls.length, 2);
    const [rust, ts] = server.calls as [Call, Call];
    assert.equal(rust.method, "POST");
    assert.equal(rust.url, "/api/events");
    assert.equal(rust.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(rust.headers["content-type"], "application/json");
    assert.equal(rust.headers["content-length"], String(Buffer.byteLength(rust.body)));
    assert.equal(rust.headers.connection, "close");
    assert.equal(rust.headers.host, new URL(server.url).host);
    // The same headers, and no others.
    const names = (call: Call) => Object.keys(call.headers).sort();
    assert.deepEqual(names(rust), names(ts));
    assert.deepEqual(sameButForIdAndTime(JSON.parse(rust.body)), sameButForIdAndTime(JSON.parse(ts.body)));
    // In the fixed form: sorted keys, no white space.
    assert.match(rust.body, /^\{"actor":\{"id":"agent-1","kind":"agent"\},/);
  } finally {
    await server.close();
  }
});

test("#142: howl emit sends as the hook does, to the same address, and says nothing", { skip: binary }, async () => {
  const server = await answering();
  try {
    for (const version of VERSIONS) {
      const ws = workspace();
      pointAt(ws, server.url);
      const done = await runAsync(version, ["emit", "checks.passed", "--change", "123", "--data", '{"check":"static-analysis"}'], ws.root, ws.env);
      quiet(done, version);
      assert.deepEqual(inboxFiles(ws.inbox), [], `${version}: taken`);
    }
    const [rust, ts] = server.calls as [Call, Call];
    assert.equal(rust.url, "/api/events");
    assert.equal(rust.headers.authorization, ts.headers.authorization);
    assert.deepEqual(sameButForIdAndTime(JSON.parse(rust.body)), sameButForIdAndTime(JSON.parse(ts.body)));
  } finally {
    await server.close();
  }
});

test("#142: a server that is gone: the event is in the inbox, server.down is written, and the server is not asked again within the pause", { skip: binary }, async () => {
  const ws = workspace();
  const gone = await answering();
  await gone.close();
  pointAt(ws, gone.url);
  quiet(await hook("rust", ws), "gone");
  assert.equal(inboxFiles(ws.inbox).length, 1);
  assert.ok(existsSync(down(ws)), "server.down is written");
  const back = await answering();
  try {
    pointAt(ws, back.url);
    quiet(await hook("rust", ws), "within the pause");
    assert.equal(back.calls.length, 0);
    assert.equal(inboxFiles(ws.inbox).length, 2);
    // After the pause it is asked again; and taking the event, it leaves no third file.
    writeFileSync(down(ws), `${new Date(Date.now() - 61_000).toISOString()}\n`);
    quiet(await hook("rust", ws), "after");
    assert.equal(back.calls.length, 1);
    assert.equal(inboxFiles(ws.inbox).length, 2);
  } finally {
    await back.close();
  }
});

test("#142: a server that takes the connection and never answers costs the hook half a second, and the event is in the inbox", { skip: binary }, async () => {
  const ws = workspace();
  const held: Socket[] = [];
  const silent: TcpServer = createTcp((socket) => held.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  try {
    pointAt(ws, `http://127.0.0.1:${(silent.address() as AddressInfo).port}`);
    const plain = await hook("rust", workspace());
    const took = await hook("rust", ws);
    assert.ok(took.ms - plain.ms < 500 + 300, `${took.ms} ms against ${plain.ms} ms without a server`);
    assert.ok(took.ms >= 450, `the half second was given: ${took.ms} ms`);
    assert.equal(inboxFiles(ws.inbox).length, 1);
    assert.ok(existsSync(down(ws)));
  } finally {
    for (const socket of held) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});

for (const status of [401, 400, 500]) {
  test(`#142: a server that answers ${status}: the event is in the inbox and the server is still asked the next time`, { skip: binary }, async () => {
    const ws = workspace();
    const server = await answering(status, '{"error":"no"}');
    try {
      pointAt(ws, server.url);
      await hook("rust", ws);
      await hook("rust", ws);
      assert.equal(server.calls.length, 2);
      assert.equal(inboxFiles(ws.inbox).length, 2);
      assert.ok(!existsSync(down(ws)), "a server that answers is not down");
    } finally {
      await server.close();
    }
  });
}

test("#142: a 200 that is not howl's answer has not taken the event, and the server is not down", { skip: binary }, async () => {
  for (const reply of ["<p>hello</p>", '{"ok":false}', "[]", "", "x".repeat(2000)]) {
    const ws = workspace();
    const server = await answering(200, reply);
    try {
      pointAt(ws, server.url);
      await hook("rust", ws);
      assert.equal(server.calls.length, 1, reply.slice(0, 20));
      assert.equal(inboxFiles(ws.inbox).length, 1, reply.slice(0, 20));
      assert.ok(!existsSync(down(ws)), "it answered");
    } finally {
      await server.close();
    }
  }
});

test("#142: something on the port that is no server of howl's loses nothing and ends in time", { skip: binary }, async () => {
  const behaviours: [string, (socket: Socket) => void][] = [
    ["closes at once", (socket) => socket.destroy()],
    ["says something else", (socket) => socket.end("SSH-2.0-OpenSSH_9.9\r\n")],
    ["answers half", (socket) => socket.write("HTTP/1.1 200 OK\r\ncontent-le")],
  ];
  for (const [label, behave] of behaviours) {
    const ws = workspace();
    const odd: TcpServer = createTcp((socket) => {
      socket.on("error", () => {});
      // Read, so that the end of the other side is seen and the connection closes.
      socket.resume();
      behave(socket);
    });
    await new Promise<void>((resolve) => odd.listen(0, "127.0.0.1", resolve));
    try {
      pointAt(ws, `http://127.0.0.1:${(odd.address() as AddressInfo).port}`);
      const done = await hook("rust", ws);
      assert.ok(done.ms < 2000, `${label}: ${done.ms} ms`);
      assert.equal(inboxFiles(ws.inbox).length, 1, label);
    } finally {
      await new Promise<void>((resolve) => odd.close(() => resolve()));
    }
  }
});

test("#142: a server file that holds nothing up sends nothing: another machine, no token, a token that cannot be a header, a process that is gone", { skip: binary }, async () => {
  const server = await answering();
  try {
    const ws = workspace();
    mkdirSync(dirname(ws.ledger), { recursive: true });
    const pid = process.pid;
    const files = [
      JSON.stringify({ url: "http://example.invalid:4317", token: TOKEN, pid }),
      "{not json",
      JSON.stringify({ url: server.url, pid }),
      JSON.stringify({ url: server.url, token: "line\nbreak", pid }),
      JSON.stringify({ url: server.url, token: "snow☃man", pid }),
      JSON.stringify({ url: server.url, token: "", pid }),
      JSON.stringify({ url: server.url, token: TOKEN, pid: 2 ** 31 }),
    ];
    for (const text of files) {
      writeFileSync(serverFile(ws), text);
      const done = await hook("rust", ws);
      assert.ok(done.ms < 5000);
    }
    assert.equal(server.calls.length, 0);
    assert.equal(inboxFiles(ws.inbox).length, files.length);
    assert.ok(!existsSync(down(ws)));
  } finally {
    await server.close();
  }
});

// ----- with howl up running

let running: Up;
before(async () => {
  if (!binary) running = await up();
});
after(async () => {
  if (!binary) await running.stop();
});

test("#142: with howl up running, the binary's hook and emit leave nothing in the inbox and the events are in the ledger", { skip: binary }, async () => {
  const ws = running.ws;
  const hooked = await hook("rust", ws, hookJson(ws, "SessionStart", { source: "startup" }));
  await until(() => lines(ws.ledger).some((l) => l.event.type === "session.started" && l.event.session === "session-1"), 3000, "the hook's event in the ledger");
  const emitted = await runAsync("rust", ["emit", "checks.passed", "--change", "77"], ws.root, ws.env);
  quiet(emitted, "emit");
  await until(() => lines(ws.ledger).some((l) => l.event.type === "checks.passed" && l.event.change === "77"), 3000, "the emitted event in the ledger");
  await until(() => inboxFiles(ws.inbox).length === 0, 2000, "the inbox taken in");
  assert.ok(!existsSync(down(ws)));
  assert.ok(hooked.ms < 1000, `${hooked.ms} ms`);
  assert.deepEqual(leftIn(ws.home), []);
});
