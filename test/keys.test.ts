// Signed claims with a key per assignment: the tests of issue #23.
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { eventFaults } from "../src/ledger/schema.ts";
import { folder, howl, inboxEvents, inboxFiles, PROJECT, workspace, type Workspace } from "./helpers.ts";

function ws(): Workspace {
  const w = workspace();
  w.env.HOWL_CONFIG = folder();
  return w;
}
const run = (w: Workspace, args: string[], env: Record<string, string> = {}) => howl(args, { cwd: w.root, env: { ...w.env, ...env } });
const issue = (w: Workspace, ...args: string[]) => {
  const r = run(w, ["key", "issue", "--actor", "agent-1", ...args]);
  assert.equal(r.status, 0, r.stderr);
  const file = /HOWL_KEY=(\S+)/.exec(r.stdout)?.[1];
  const key = /key ([0-9a-f]{64})/.exec(r.stdout)?.[1];
  assert.ok(file && key, r.stdout);
  return { file: file!, key: key!, out: r.stdout };
};
const hook = (w: Workspace, env: Record<string, string> = {}) => {
  const stdin = JSON.stringify({ session_id: "s1", cwd: w.root, hook_event_name: "SessionStart", source: "startup" });
  const r = howl(["hook"], { cwd: w.root, env: { ...w.env, ...env }, input: stdin });
  assert.equal(r.status, 0);
};
const ingest = (w: Workspace) => assert.equal(run(w, ["ingest"]).status, 0);
const verify = (w: Workspace, ...extra: string[]) => run(w, ["verify", "--project", PROJECT, ...extra]);

test("#23: key issue makes the issuer key once and the assignment key, both 0600, and a key.issued the schema accepts", () => {
  const w = ws();
  const a = issue(w, "--change", "30", "--role", "review");
  const issuer = join(w.env.HOWL_CONFIG!, PROJECT, "issuer.key");
  assert.equal(statSync(issuer).mode & 0o777, 0o600);
  assert.equal(statSync(a.file).mode & 0o777, 0o600);
  const before = readFileSync(issuer);
  issue(w);
  assert.deepEqual(readFileSync(issuer), before, "the issuer key is made once");
  const issued = inboxEvents(w.inbox).filter((e) => e.type === "key.issued");
  assert.equal(issued.length, 2);
  assert.deepEqual(eventFaults(issued[0]!), []);
  assert.equal(issued[0]!.data?.key, a.key);
  assert.equal(issued[0]!.data?.actor, "agent-1");
  assert.equal(issued[0]!.data?.change, "30");
  assert.ok(issued[0]!.sig, "signed by the issuer");
});

test("#23: with HOWL_KEY the hook signs its event; without it, it does not", () => {
  const w = ws();
  const a = issue(w);
  hook(w, { HOWL_KEY: a.file });
  hook(w);
  const sessions = inboxEvents(w.inbox).filter((e) => e.type === "session.started");
  assert.equal(sessions.filter((e) => e.sig?.key === a.key).length, 1);
  assert.equal(sessions.filter((e) => e.sig === undefined).length, 1);
});

test("#23: a ledger of an issued key and signed events verifies, and counts what is signed and what is not", () => {
  const w = ws();
  const a = issue(w);
  hook(w, { HOWL_KEY: a.file });
  hook(w, { HOWL_KEY: a.file });
  hook(w);
  ingest(w);
  const r = verify(w);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /signatures: 2 signed, 1 unsigned/);
});

test("#23: a signed claim changed before it reached the ledger fails, naming the line", async () => {
  const w = ws();
  const a = issue(w);
  hook(w, { HOWL_KEY: a.file });
  // Change what the session claimed, keeping its signature.
  const name = inboxFiles(w.inbox).find((f) => readFileSync(join(w.inbox, f), "utf8").includes("session.started"))!;
  const path = join(w.inbox, name);
  const e = JSON.parse(readFileSync(path, "utf8"));
  e.actor.id = "agent-9";
  (await import("node:fs")).writeFileSync(path, JSON.stringify(e));
  ingest(w);
  const r = verify(w);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /line \d+: .*signature does not hold/);
});

test("#23: an actor, a change or a time outside the key's assignment fails", async () => {
  const w = ws();
  const a = issue(w, "--change", "30");
  hook(w, { HOWL_KEY: a.file, HOWL_ACTOR: "agent-2" });
  hook(w, { HOWL_KEY: a.file, HOWL_CHANGE: "31" });
  const short = issue(w, "--hours", "0.0002");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  hook(w, { HOWL_KEY: short.file });
  ingest(w);
  const r = verify(w);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not the key's agent/);
  assert.match(r.stdout, /not the key's change/);
  assert.match(r.stdout, /outside the key's window/);
});

test("#23: a claim signed after its key was revoked fails", () => {
  const w = ws();
  const a = issue(w);
  const kept = join(folder(), "kept.pem");
  copyFileSync(a.file, kept);
  const r1 = run(w, ["key", "revoke", a.key]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.throws(() => statSync(a.file), "the private key is removed");
  hook(w, { HOWL_KEY: kept });
  ingest(w);
  const r = verify(w);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /after the key was revoked/);
});

test("#23: a key from another issuer fails; with --issuer pinned to another, every key fails", () => {
  const w = ws();
  const a = issue(w);
  hook(w, { HOWL_KEY: a.file });
  // A second issuer: the same ledger, another config folder.
  const other = { ...w, env: { ...w.env, HOWL_CONFIG: folder() } };
  const b = issue(other);
  hook(other, { HOWL_KEY: b.file });
  ingest(w);
  const r = verify(w);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not issued by the ledger's issuer/);
  const pinned = verify(w, "--issuer", "f".repeat(64));
  assert.equal(pinned.status, 1);
  assert.equal((pinned.stdout.match(/not issued by the ledger's issuer/g) ?? []).length, 2);
});
