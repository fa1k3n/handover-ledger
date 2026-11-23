// Signing in the binary: the tests of issue #142. What the Rust hook signs holds in the TypeScript's `verify`, and the
// other way round; a key that cannot be read gives an unsigned event; keyd is asked as the TypeScript asks it.
// The binary is started without HOWL_FALLBACK. keyd itself is still the TypeScript.
// @code_class tests
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { signatureHolds } from "../src/keys/keys.ts";
import { VERSIONS, binary, hookJson, leftIn, run, runAsync } from "./binary.ts";
import { folder, howl, PROJECT, startHowl, workspace, type Workspace } from "./helpers.ts";

const FIXTURES = new URL("./fixtures/signing/", import.meta.url).pathname;
const KEY = "a".repeat(64);
const TOKEN = "b".repeat(64);

const children: ChildProcess[] = [];
const servers: Server[] = [];
after(() => {
  for (const c of children) c.kill("SIGTERM");
  for (const s of servers) s.close();
});

function ws(): Workspace {
  const w = workspace();
  w.env.HOWL_CONFIG = folder();
  return w;
}

/** A key for one assignment of agent-1, by `howl key issue` (the TypeScript, until its piece): the file of the key, and its id. */
function issue(w: Workspace, ...args: string[]): { key: string; id: string } {
  const r = howl(["key", "issue", "--actor", "agent-1", ...args], { cwd: w.root, env: w.env });
  assert.equal(r.status, 0, r.stderr);
  return { key: /HOWL_KEY=(\S+)/.exec(r.stdout)![1]!, id: /key ([0-9a-f]{64})/.exec(r.stdout)![1]! };
}

const silent = (r: { status: number | null; stdout: string; stderr: string }, what: string) => assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 0, stdout: "", stderr: "" }, what);

test("#142: a signature made by either version holds in the other's verify, and both say the same", { skip: binary }, () => {
  const w = ws();
  const a = issue(w);
  for (const version of VERSIONS) silent(run(version, ["hook"], w.root, { ...w.env, HOWL_KEY: a.key }, hookJson(w)), version);
  const ingested = howl(["ingest"], { cwd: w.root, env: w.env });
  assert.equal(ingested.status, 0, ingested.stderr);
  const said = VERSIONS.map((version) => run(version, ["verify", "--project", PROJECT], w.root, w.env));
  for (const r of said) {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /signatures: 2 signed, 0 unsigned claimed/);
  }
  assert.equal(said[0]!.stdout, said[1]!.stdout, "the Rust verify and the TypeScript verify say the same");
  // Both signed with the key of the assignment, as its key.issued says.
  const signed = leftIn(w.home);
  assert.equal(signed.length, 0, "the inbox is taken in");
});

test("#142: what each version signs is the event's fixed form: a change after the signing is found by the other", { skip: binary }, () => {
  for (const version of VERSIONS) {
    const w = ws();
    const a = issue(w);
    silent(run(version, ["hook"], w.root, { ...w.env, HOWL_KEY: a.key }, hookJson(w)), version);
    const file = leftIn(w.home).find((f) => f.event.type === "session.started")!;
    assert.equal(file.event.sig?.key, a.id, version);
    assert.match(file.event.sig!.value, /^[A-Za-z0-9_-]{86}$/, "an Ed25519 signature in base64url, without padding");
    // The key.issued event says the public key: the signature holds against it, in the TypeScript's own check.
    const issued = leftIn(w.home).find((f) => f.event.type === "key.issued")!;
    const publicKey = (issued.event.data as { public: string }).public;
    assert.equal(signatureHolds(file.event, publicKey), true, version);
    assert.equal(signatureHolds({ ...file.event, session: "other" }, publicKey), false, version);
  }
});

test("#142: a key the hook cannot read leaves the event unsigned, silently, as the TypeScript does", { skip: binary }, () => {
  const w = ws();
  const dir = folder();
  const empty = join(dir, "empty.pem");
  writeFileSync(empty, "");
  const garbage = join(dir, "garbage.pem");
  writeFileSync(garbage, "not a key\n");
  const keys: [string, string][] = [
    ["a file that is not there", join(dir, "gone.pem")],
    ["an empty file", empty],
    ["garbage", garbage],
    ["a folder", dir],
    ["a key of another kind", `${FIXTURES}rsa.pem`],
    ["a keyd key that is cut short", `keyd:${join(dir, "k.sock")}#${KEY}`],
  ];
  for (const [label, key] of keys) {
    for (const version of VERSIONS) {
      const home = folder();
      silent(run(version, ["hook"], w.root, { ...w.env, HOWL_HOME: home, HOWL_KEY: key }, hookJson(w)), `${label}, ${version}`);
      const files = leftIn(home);
      assert.equal(files.length, 1, `${label}, ${version}`);
      assert.equal(files[0]!.event.sig, undefined, `${label}, ${version}`);
    }
  }
});

test("#142: with the key of the fixture, both versions give the signature of the fixture's key", { skip: binary }, () => {
  const w = ws();
  const expected = JSON.parse(readFileSync(`${FIXTURES}expected.json`, "utf8")) as { key: string };
  for (const key of ["key.pem", "key-v2.pem"]) {
    for (const version of VERSIONS) {
      const home = folder();
      silent(run(version, ["hook"], w.root, { ...w.env, HOWL_HOME: home, HOWL_KEY: `${FIXTURES}${key}` }, hookJson(w)), `${key}, ${version}`);
      assert.equal(leftIn(home)[0]!.event.sig?.key, expected.key, `${key}, ${version}`);
    }
  }
});

test("#142: a key named with white space round it is the key, and one of spaces is none", { skip: binary }, () => {
  const w = ws();
  const home = folder();
  silent(run("rust", ["hook"], w.root, { ...w.env, HOWL_HOME: home, HOWL_KEY: `  ${FIXTURES}key.pem \n` }, hookJson(w)), "padded");
  assert.ok(leftIn(home)[0]!.event.sig);
  const none = folder();
  silent(run("rust", ["hook"], w.root, { ...w.env, HOWL_HOME: none, HOWL_KEY: "   " }, hookJson(w)), "spaces");
  assert.equal(leftIn(none)[0]!.event.sig, undefined);
});

// ----- keyd

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

/** A socket that answers every request with `reply`, and counts the connections. */
async function socketAnswering(reply: string | null): Promise<{ socket: string; asked: () => number; lines: string[] }> {
  const socket = join(folder(), "fake.sock");
  const lines: string[] = [];
  let asked = 0;
  const server = createServer((conn) => {
    asked++;
    let buf = "";
    conn.on("data", (d) => {
      buf += d;
      const at = buf.indexOf("\n");
      if (at >= 0) {
        lines.push(buf.slice(0, at));
        buf = buf.slice(at + 1);
        if (reply !== null) conn.write(`${reply}\n`);
      }
    });
    conn.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return { socket, asked: () => asked, lines };
}

const downFile = (w: Workspace) => join(w.home, PROJECT, "keyd.down");

test("#142: the hook signs through keyd, and both versions of verify accept it", { skip: binary }, async () => {
  const d = await keyd();
  const w = workspace();
  w.env.HOWL_KEYD = d.socket;
  w.env.HOWL_KEYD_ADMIN = d.admin;
  const a = issue(w, "--change", "30");
  assert.match(a.key, /^keyd:.+#[0-9a-f]{64}:[0-9a-f]{64}$/);
  const done = await runAsync("rust", ["hook"], w.root, { ...w.env, HOWL_KEY: a.key, HOWL_CHANGE: "30" }, hookJson(w));
  silent(done, "the hook");
  const signed = leftIn(w.home).filter((f) => f.event.type === "session.started" && f.event.sig?.key === a.id);
  assert.equal(signed.length, 1, "signed through keyd");
  assert.ok(!existsSync(downFile(w)));
  assert.equal(howl(["ingest"], { cwd: w.root, env: w.env }).status, 0);
  for (const version of VERSIONS) {
    const v = run(version, ["verify", "--project", PROJECT], w.root, w.env);
    assert.equal(v.status, 0, `${version}: ${v.stdout}${v.stderr}`);
    assert.match(v.stdout, /1 signed/);
  }
});

test("#142: keyd's refusal leaves the event unsigned and is not marked as down; keyd.down older than 60 s or from a time to come does not stop it", { skip: binary }, async () => {
  const refusing = await socketAnswering('{"ok":false,"error":"outside the key\'s window"}');
  const w = workspace();
  const key = `keyd:${refusing.socket}#${KEY}:${TOKEN}`;
  silent(await runAsync("rust", ["hook"], w.root, { ...w.env, HOWL_KEY: key }, hookJson(w)), "refused");
  assert.equal(leftIn(w.home)[0]!.event.sig, undefined);
  assert.ok(!existsSync(downFile(w)), "a refusal is keyd answering: it is not down");
  // The request is one line with what keyd needs and the event as it stands.
  const asked = JSON.parse(refusing.lines[0]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(asked).sort(), ["event", "key", "op", "token"]);
  assert.equal(asked.op, "sign");
  assert.equal(asked.key, KEY);
  assert.equal(asked.token, TOKEN);
  assert.equal((asked.event as { type: string }).type, "session.started");
  assert.equal((asked.event as { sig?: unknown }).sig, undefined);
  for (const at of [Date.now() - 120_000, Date.now() + 365 * 86_400_000]) {
    writeFileSync(downFile(w), `${new Date(at).toISOString()}\n`);
    const before = refusing.asked();
    silent(await runAsync("rust", ["hook"], w.root, { ...w.env, HOWL_KEY: key }, hookJson(w)), "old or future down");
    assert.equal(refusing.asked(), before + 1, "keyd is asked");
  }
});

test("#142: a keyd that is gone is marked down, the event is unsigned, and the hook ends within a second", { skip: binary }, async () => {
  const w = workspace();
  const key = `keyd:${join(folder(), "gone.sock")}#${KEY}:${TOKEN}`;
  const done = await runAsync("rust", ["hook"], w.root, { ...w.env, HOWL_KEY: key }, hookJson(w));
  silent(done, "gone");
  assert.ok(done.ms < 1000, `${done.ms} ms`);
  assert.equal(leftIn(w.home)[0]!.event.sig, undefined);
  assert.match(readFileSync(downFile(w), "utf8"), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\n$/);
});

test("#142: a keyd that never answers: the first call ends within 1 s, a second within 60 s ends at once without asking", { skip: binary }, async () => {
  const hold = await socketAnswering(null);
  const w = workspace();
  const env = { ...w.env, HOWL_KEY: `keyd:${hold.socket}#${KEY}:${TOKEN}` };
  const first = await runAsync("rust", ["hook"], w.root, env, hookJson(w));
  silent(first, "first");
  assert.ok(first.ms < 1000, `first took ${first.ms} ms`);
  assert.ok(first.ms >= 450, `the whole 500 ms was given: ${first.ms} ms`);
  assert.equal(hold.asked(), 1);
  const second = await runAsync("rust", ["hook"], w.root, env, hookJson(w));
  silent(second, "second");
  assert.equal(hold.asked(), 1, "the second call does not ask keyd");
  assert.ok(second.ms < first.ms - 300, `second took ${second.ms} ms, the first ${first.ms} ms`);
  const events = leftIn(w.home);
  assert.equal(events.length, 2);
  assert.ok(events.every((f) => f.event.sig === undefined));
  assert.ok(existsSync(downFile(w)));
});

test("#142: an answer from keyd that is not a signature never makes a signature", { skip: binary }, async () => {
  for (const answer of ['{"ok":true}', '{"ok":true,"sig":"x"}', '{"ok":true,"sig":{"key":1,"value":"v"}}', '{"ok":true,"sig":{"key":"k"}}', "null", "[]", '"yes"', "hello"]) {
    const fake = await socketAnswering(answer);
    const w = workspace();
    silent(await runAsync("rust", ["hook"], w.root, { ...w.env, HOWL_KEY: `keyd:${fake.socket}#${KEY}:${TOKEN}` }, hookJson(w)), answer);
    const files = leftIn(w.home);
    assert.equal(files.length, 1, answer);
    assert.equal(files[0]!.event.sig, undefined, answer);
  }
  // And one that is a signature in form is passed on as keyd made it.
  const fake = await socketAnswering('{"ok":true,"sig":{"key":"k","value":"v"}}');
  const w = workspace();
  silent(await runAsync("rust", ["hook"], w.root, { ...w.env, HOWL_KEY: `keyd:${fake.socket}#${KEY}:${TOKEN}` }, hookJson(w)), "a signature");
  assert.deepEqual(leftIn(w.home)[0]!.event.sig, { key: "k", value: "v" });
});
