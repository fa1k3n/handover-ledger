// The hook never holds up a session when keyd hangs or is gone. The tests of issue #30.
// @code_class tests
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runHook } from "../src/hook/hook.ts";
import { folder, howl, inboxEvents, PROJECT, workspace, type Workspace } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli/howl.ts", import.meta.url));
const KEY = "a".repeat(64);
const TOKEN = "b".repeat(64);

const children: ChildProcess[] = [];
const servers: Server[] = [];
after(() => {
  for (const c of children) c.kill("SIGTERM");
  for (const s of servers) s.close();
});

const start = (w: Workspace) => JSON.stringify({ session_id: "s1", cwd: w.root, hook_event_name: "SessionStart", source: "startup" });
const downFile = (w: Workspace) => join(w.home, PROJECT, "keyd.down");

async function timed(fn: () => Promise<void>): Promise<number> {
  const t = Date.now();
  await fn();
  return Date.now() - t;
}

/** A socket that takes the connection and never answers. */
async function silent(): Promise<string> {
  const socket = join(folder(), "silent.sock");
  const server = createServer(() => {});
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return socket;
}

/** A socket that answers every request with the same refusal. */
async function refusing(error: string): Promise<string> {
  const socket = join(folder(), "refusing.sock");
  const server = createServer((conn) => {
    conn.on("data", () => conn.write(`${JSON.stringify({ ok: false, error })}\n`));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return socket;
}

test("#30: with HOWL_KEY naming a socket that does not exist, the hook ends within 1 s and writes the event unsigned", async () => {
  const w = workspace();
  const env = { ...w.env, HOWL_KEY: `keyd:${join(folder(), "gone.sock")}#${KEY}:${TOKEN}` };
  const ms = await timed(() => runHook(start(w), env, w.root));
  assert.ok(ms < 1000, `took ${ms} ms`);
  const [e] = inboxEvents(w.inbox);
  assert.equal(e?.type, "session.started");
  assert.equal(e?.sig, undefined);
  assert.ok(existsSync(downFile(w)), "keyd.down is written beside the ledger");
});

test("#30: a socket that never answers: the first call ends within 1 s, a second within 60 s ends at once without asking", async () => {
  const w = workspace();
  const socket = await silent();
  let asked = 0;
  servers.at(-1)!.on("connection", () => asked++);
  const env = { ...w.env, HOWL_KEY: `keyd:${socket}#${KEY}:${TOKEN}` };

  const first = await timed(() => runHook(start(w), env, w.root));
  assert.ok(first < 1000, `first took ${first} ms`);
  assert.equal(asked, 1);

  const second = await timed(() => runHook(start(w), env, w.root));
  assert.ok(second < 200, `second took ${second} ms`);
  assert.equal(asked, 1, "the second call does not ask keyd");

  const events = inboxEvents(w.inbox);
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.sig === undefined));
});

test("#30: a refusal about the claim is keyd answering: it is not marked as down", async () => {
  const w = workspace();
  const socket = await refusing("outside the key's window");
  const env = { ...w.env, HOWL_KEY: `keyd:${socket}#${KEY}:${TOKEN}` };
  await runHook(start(w), env, w.root);
  assert.equal(inboxEvents(w.inbox)[0]?.sig, undefined);
  assert.ok(!existsSync(downFile(w)));
});

test("#30: a keyd that answers signs as before, and a keyd.down older than 60 s does not stop it", async () => {
  const dir = folder();
  const socket = join(dir, "keyd.sock");
  const state = join(dir, "state");
  const child = spawn(process.execPath, [CLI, "keyd", "--project", PROJECT, "--socket", socket, "--state", state], { env: { PATH: process.env.PATH ?? "" } });
  children.push(child);
  const end = Date.now() + 10_000;
  while (!existsSync(socket)) {
    if (Date.now() > end) throw new Error("keyd did not start");
    await new Promise((r) => setTimeout(r, 50));
  }
  const w = workspace();
  w.env.HOWL_KEYD = socket;
  w.env.HOWL_KEYD_ADMIN = join(state, "admin.token");
  const r = howl(["key", "issue", "--actor", "agent-1"], { cwd: w.root, env: w.env });
  assert.equal(r.status, 0, r.stderr);
  const key = /HOWL_KEY=(\S+)/.exec(r.stdout)![1]!;

  writeFileSync(downFile(w), `${new Date(Date.now() - 120_000).toISOString()}\n`);
  await runHook(start(w), { ...w.env, HOWL_KEY: key }, w.root);
  const signed = inboxEvents(w.inbox).filter((e) => e.type === "session.started");
  assert.equal(signed.length, 1);
  assert.ok(signed[0]!.sig, "signed through keyd");
});
