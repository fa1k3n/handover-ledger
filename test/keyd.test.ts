// howl keyd: a signing service that holds the keys, so a session never sees one. The tests of issue #24.
// @code_class tests
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { request } from "../src/keys/keyd.ts";
import { folder, howl, inboxEvents, PROJECT, startHowl, workspace, type Workspace } from "./helpers.ts";

const children: ChildProcess[] = [];
after(() => {
  for (const c of children) c.kill("SIGTERM");
});

async function keyd(): Promise<{ socket: string; admin: string }> {
  const dir = folder();
  const socket = join(dir, "keyd.sock");
  const state = join(dir, "state");
  const child = startHowl(["keyd", "--project", PROJECT, "--socket", socket, "--state", state]);
  children.push(child);
  const end = Date.now() + 10_000;
  while (!existsSync(socket)) {
    if (Date.now() > end) throw new Error("keyd did not start");
    await new Promise((r) => setTimeout(r, 50));
  }
  return { socket, admin: join(state, "admin.token") };
}

function ws(d: { socket: string; admin: string }): Workspace {
  const w = workspace();
  w.env.HOWL_KEYD = d.socket;
  w.env.HOWL_KEYD_ADMIN = d.admin;
  return w;
}
const issue = (w: Workspace, ...args: string[]) => {
  const r = howl(["key", "issue", "--actor", "agent-1", ...args], { cwd: w.root, env: w.env });
  assert.equal(r.status, 0, r.stderr);
  return { key: /HOWL_KEY=(\S+)/.exec(r.stdout)![1]!, id: /key ([0-9a-f]{64})/.exec(r.stdout)![1]! };
};
const hook = (w: Workspace, env: Record<string, string>) => {
  const stdin = JSON.stringify({ session_id: "s1", cwd: w.root, hook_event_name: "SessionStart", source: "startup" });
  assert.equal(howl(["hook"], { cwd: w.root, env: { ...w.env, ...env }, input: stdin }).status, 0);
};

test("#24: with keyd, key issue gives a socket and a token, and no private key is written where the session can read it", async () => {
  const d = await keyd();
  const w = ws(d);
  const a = issue(w, "--change", "30");
  assert.match(a.key, /^keyd:.+#[0-9a-f]{64}:[0-9a-f]{64}$/);
  const keysDir = join(w.home, PROJECT, "keys");
  assert.ok(!existsSync(keysDir) || readdirSync(keysDir).every((f) => !f.endsWith(".pem")));
  assert.equal(inboxEvents(w.inbox).filter((e) => e.type === "key.issued").length, 1);
});

test("#24: a session signs through keyd, and howl verify accepts it", async () => {
  const d = await keyd();
  const w = ws(d);
  const a = issue(w);
  hook(w, { HOWL_KEY: a.key });
  const signed = inboxEvents(w.inbox).filter((e) => e.type === "session.started" && e.sig?.key === a.id);
  assert.equal(signed.length, 1);
  assert.equal(howl(["ingest"], { cwd: w.root, env: w.env }).status, 0);
  const v = howl(["verify", "--project", PROJECT], { env: w.env });
  assert.equal(v.status, 0, v.stdout);
  assert.match(v.stdout, /1 signed/);
});

test("#24: keyd refuses another actor, a wrong token, a revoked key and one whose window has passed", async () => {
  const d = await keyd();
  const w = ws(d);
  const a = issue(w);
  const [, rest] = a.key.split("#");
  const [id, token] = rest!.split(":");
  const event = { v: 0, id: "x", time: new Date().toISOString(), type: "session.started", source: { adapter: "claude-code-hook", kind: "claimed" }, project: PROJECT, actor: { kind: "agent", id: "agent-1" } };
  assert.equal((await request(d.socket, { op: "sign", key: id, token, event })).ok, true);
  assert.match(String((await request(d.socket, { op: "sign", key: id, token, event: { ...event, actor: { kind: "agent", id: "agent-2" } } })).error), /not the key's agent/);
  assert.match(String((await request(d.socket, { op: "sign", key: id, token: "0".repeat(64), event })).error), /token/);
  const short = issue(w, "--hours", "0.0002");
  await new Promise((r) => setTimeout(r, 1200));
  const [, rest2] = short.key.split("#");
  const [id2, token2] = rest2!.split(":");
  assert.match(String((await request(d.socket, { op: "sign", key: id2, token: token2, event })).error), /window/);
  assert.equal(howl(["key", "revoke", id!], { cwd: w.root, env: w.env }).status, 0);
  assert.match(String((await request(d.socket, { op: "sign", key: id, token, event })).error), /revoked/);
});

test("#24: issuing needs keyd's admin token", async () => {
  const d = await keyd();
  const r = await request(d.socket, { op: "issue", admin: "0".repeat(64), actor: "agent-1", hours: 1 });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /admin/);
});
