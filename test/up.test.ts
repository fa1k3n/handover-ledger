// #64: `howl up`, one process that writes and serves, and takes events over HTTP.
// @code_class tests
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { after, before, test } from "node:test";
import { leave } from "../src/inbox/inbox.ts";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { startServer } from "../src/serve/server.ts";
import { folder, howl, inboxFiles, lines, PROJECT, rawLines } from "./helpers.ts";
import { at } from "./local-host.ts";
import { ledgerWith } from "./helpers.ts";
import { claim, observed, send, until, up, type Up } from "./up-helpers.ts";

let running: Up;
before(async () => {
  const setup = observed();
  setup.host.task({ number: 1, openedAt: at(0), openedBy: { login: "alice" }, assignments: [], updatedAt: at(0) });
  running = await up(setup);
});
after(async () => {
  await running.stop();
});

const types = (u: Up) => lines(u.ws.ledger).map((l) => l.event.type);
const activity = (u: Up) => (existsSync(u.ws.activity) ? rawLines(u.ws.activity) : []);
/** The ledger, the activity file and the inbox as they stand. */
const state = (u: Up) => JSON.stringify([rawLines(u.ws.ledger), activity(u), inboxFiles(u.ws.inbox)]);

test("howl up writes server.json for its owner only, records what the code host shows, and answers the page's calls", async () => {
  const stat = statSync(running.file);
  assert.equal(stat.mode & 0o777, 0o600);
  const file = JSON.parse(readFileSync(running.file, "utf8"));
  assert.match(file.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(file.token, /^[0-9a-f]{64}$/);
  assert.equal(file.pid, running.child.pid);
  await until(() => types(running).includes("task.opened"), 10_000, "the first round");
  const agents = await fetch(`${running.url}/api/agents`);
  assert.equal(agents.status, 200);
  const projects = (await (await fetch(`${running.url}/api/projects`)).json()) as { default: string };
  assert.equal(projects.default, PROJECT);
});

test("while it runs, a second howl up and howl observe for the same project are refused", () => {
  const second = howl(["up", "--port", "0"], { cwd: running.ws.root, env: running.ws.env });
  assert.equal(second.status, 2, second.stderr);
  assert.match(second.stderr, /^howl: /);
  assert.equal(JSON.parse(readFileSync(running.file, "utf8")).token, running.token, "the file of the first is left alone");
  const observe = howl(["observe", "--once"], { cwd: running.ws.root, env: running.ws.env });
  assert.equal(observe.status, 2, observe.stderr);
});

test("an event sent with the token is a line of the ledger within a second, a tool call a line of the activity file", async () => {
  const started = claim("session.started");
  const tool = claim("tool.used", { data: { tool: "Read", target: "src/a.ts", outcome: "succeeded" } });
  const a = await send(running.url, running.token, started);
  assert.equal(a.status, 200);
  assert.deepEqual(await a.json(), { ok: true });
  assert.equal((await send(running.url, running.token, tool)).status, 200);
  await until(() => lines(running.ws.ledger).some((l) => l.event.id === started.id), 1000, "the event in the ledger");
  await until(() => activity(running).some((raw) => JSON.parse(raw).id === tool.id), 1000, "the tool call in the activity file");
  assert.deepEqual(inboxFiles(running.ws.inbox), []);
  assert.ok(!lines(running.ws.ledger).some((l) => l.event.id === tool.id), "a tool call is not in the chain");
  const verified = howl(["verify", "--ledger", running.ws.ledger]);
  assert.equal(verified.status, 0, verified.stdout);
});

/** A POST with headers `fetch` will not send: a Host of another name. */
function rawPost(url: string, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${url}/api/events`, { method: "POST", headers: { "content-length": Buffer.byteLength(body), ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("each refusal gives its status and writes nothing", async () => {
  await until(() => inboxFiles(running.ws.inbox).length === 0, 2000, "an empty inbox");
  const before = state(running);
  const good = () => claim("session.started");
  const { url, token } = running;
  const cases: [string, number, () => Promise<number>][] = [
    ["no token", 401, async () => (await send(url, null, good())).status],
    ["a wrong token", 401, async () => (await send(url, "0".repeat(64), good())).status],
    ["the token with no Bearer", 401, async () => (await send(url, null, good(), { authorization: token })).status],
    ["an Origin, as a page in a browser sends", 403, async () => (await send(url, token, good(), { origin: "http://example.invalid" })).status],
    ["the server's own page as Origin", 403, async () => (await send(url, token, good(), { origin: url })).status],
    [
      "a Host that is not the server's",
      403,
      () => rawPost(url, { host: "example.invalid", "content-type": "application/json", authorization: `Bearer ${token}` }, JSON.stringify(good())),
    ],
    ["text/plain", 415, async () => (await send(url, token, good(), { "content-type": "text/plain" })).status],
    ["no content type", 415, () => rawPost(url, { authorization: `Bearer ${token}` }, JSON.stringify(good()))],
    ["more than 256 KiB", 413, async () => (await send(url, token, { ...good(), data: { filler: "x".repeat(300 * 1024) } })).status],
    ["not JSON", 400, async () => (await send(url, token, "{not json")).status],
    ["no event", 400, async () => (await send(url, token, { hello: "there" })).status],
    ["an event of a type that is not in the schema", 400, async () => (await send(url, token, claim("made.up"))).status],
    ["another project", 400, async () => (await send(url, token, { ...good(), project: "another" })).status],
    ["ledger.created", 400, async () => (await send(url, token, claim("ledger.created"))).status],
    ["an event that says observed", 400, async () => (await send(url, token, { ...good(), source: { adapter: "github", kind: "observed" } })).status],
  ];
  for (const [name, status, run] of cases) assert.equal(await run(), status, name);
  // Long enough for a pass over the inbox, had one been asked for.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(state(running), before);
  assert.ok(!existsSync(`${running.ws.inbox}/rejected`), "nothing was rejected: nothing was left");
});

test("a refusal says why, and a GET of /api/events still reads", async () => {
  const refused = await send(running.url, running.token, { ...claim("session.started"), source: { adapter: "x", kind: "observed" } });
  assert.match(((await refused.json()) as { error: string }).error, /claim/);
  const read = await fetch(`${running.url}/api/events`);
  assert.equal(read.status, 200);
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    assert.equal((await fetch(`${running.url}/api/events`, { method })).status, 405, method);
  }
  assert.equal((await fetch(`${running.url}/api/agents`, { method: "POST", headers: { authorization: `Bearer ${running.token}` } })).status, 405);
});

test("the same event sent and also left as a file is in the ledger once", async () => {
  const event = claim("session.started");
  assert.equal((await send(running.url, running.token, event)).status, 200);
  leave(running.ws.inbox, event as unknown as LedgerEvent);
  assert.equal((await send(running.url, running.token, claim("session.stopped"))).status, 200);
  await until(() => inboxFiles(running.ws.inbox).length === 0, 2000, "the inbox taken in");
  assert.equal(lines(running.ws.ledger).filter((l) => l.event.id === event.id).length, 1);
});

test("howl serve answers 405 to the same POST and writes nothing", async () => {
  const ledger = ledgerWith(1);
  const server = await startServer({ ledger, port: 0, root: folder() });
  try {
    const before = rawLines(ledger);
    assert.equal((await send(server.url, "0".repeat(64), claim("session.started"))).status, 405);
    assert.deepEqual(rawLines(ledger), before);
  } finally {
    await server.close();
  }
});

test("SIGTERM ends it with 0: the server file is gone, the lock is free, and what was in the inbox is taken in", async () => {
  const mine = await up();
  const left = claim("session.started");
  leave(mine.ws.inbox, left as unknown as LedgerEvent);
  assert.equal(await mine.stop(), 0, mine.output());
  assert.ok(!existsSync(mine.file));
  assert.ok(!existsSync(`${mine.ws.ledger}.lock`));
  await assert.rejects(fetch(`${mine.url}/api/agents`));
  const round = howl(["observe", "--once"], { cwd: mine.ws.root, env: mine.ws.env });
  assert.equal(round.status, 0, round.stderr);
  assert.ok(lines(mine.ws.ledger).some((l) => l.event.id === left.id));
});
