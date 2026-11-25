// #216: the branch howl/log of the observed repository, a file per event named by its hash; its reader, which reads
// the union of the branch and the ledger file, ordered by time, then hash; and `howl verify` of its files.
// @code_class tests
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { eventHash, fixedForm } from "../src/ledger/fixed.ts";
import { openLedger, type LedgerEvent } from "../src/ledger/ledger.ts";
import { readEverything } from "../src/read/reader.ts";
import { startServer } from "../src/serve/server.ts";
import { event, folder, git, howl, ledgerWith, logPath, PROJECT, workspace, writeLog } from "./helpers.ts";
import { ledgerEvents, m } from "./story.ts";

/** A workspace whose root is a git repository. */
function repository() {
  const ws = workspace();
  git(ws.root, "init", "-q");
  return ws;
}

/** The ids of the events `howl watch --json` prints, in its order. */
function watched(ws: { root: string; env: Record<string, string> }): string[] {
  const r = howl(["watch", "--no-follow", "--json"], { cwd: ws.root, env: ws.env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const value = JSON.parse(l) as { id?: string; event?: { id: string } };
      return value.event?.id ?? value.id!;
    });
}

function ledgerOf(path: string, events: LedgerEvent[]): void {
  const writer = openLedger(path, { project: PROJECT });
  for (const e of events) writer.append(e);
  writer.close();
}

test("#216: three events on howl/log and no ledger file: howl watch gives them by time, two of one time by hash", () => {
  const ws = repository();
  const late = event({ time: "2026-01-02T03:04:06Z" });
  const a = event({ time: "2026-01-02T03:04:05Z" });
  const b = event({ time: "2026-01-02T03:04:05Z" });
  writeLog(ws.root, [late, a, b]);
  const [first, second] = eventHash(a) < eventHash(b) ? [a, b] : [b, a];
  assert.deepEqual(watched(ws), [first.id, second.id, late.id]);
  // The branch is never checked out: the working tree holds nothing of it.
  assert.equal(git(ws.root, "status", "--porcelain", "--untracked-files=no"), "");
});

test("#216: the same event in the ledger file and on the branch is read once", () => {
  const ws = repository();
  const both = event({ time: "2026-01-02T03:04:05Z" });
  const ledgerOnly = event({ time: "2026-01-02T03:04:06Z" });
  const logOnly = event({ time: "2026-01-02T03:04:07Z" });
  ledgerOf(ws.ledger, [both, ledgerOnly]);
  writeLog(ws.root, [both, logOnly]);
  assert.deepEqual(watched(ws), [both.id, ledgerOnly.id, logOnly.id]);
  const read = readEverything(ws.ledger, ws.root);
  assert.deepEqual(
    read.reads.map((r) => [r.event.id, r.from]),
    [
      [both.id, "ledger"],
      [ledgerOnly.id, "ledger"],
      [logOnly.id, "log"],
    ],
  );
  assert.equal(read.reads[2]!.hash, eventHash(logOnly), "an event of the log carries its hash");
});

test("#216: howl watch, show and status say the same of events on the branch as of the same events in a ledger file", () => {
  // One time each, so that the order of the file and the order of the hashes cannot differ.
  const events = ledgerEvents().map((e, i) => ({ ...e, time: new Date(Date.parse(e.time) + i * 1000).toISOString() }));
  const inFile = workspace();
  git(inFile.root, "init", "-q");
  ledgerOf(inFile.ledger, events);
  const onLog = repository();
  writeLog(onLog.root, events);
  const env = { HOWL_NOW: m(70), TZ: "UTC" };
  for (const args of [
    ["watch", "--no-follow", "--utc"],
    ["watch", "--no-follow"],
    ["show", "12", "--utc"],
    ["show", "change:31", "--json"],
    ["status"],
    ["status", "--json"],
  ]) {
    const a = howl(args, { cwd: inFile.root, env: { ...inFile.env, ...env } });
    const b = howl(args, { cwd: onLog.root, env: { ...onLog.env, ...env } });
    assert.equal(a.status, 0, `${args.join(" ")}: ${a.stderr}`);
    assert.deepEqual(b, a, `howl ${args.join(" ")}`);
  }
});

test("#216: /api/line?hash= gives an event that is only on the branch, with no line and no prev", async () => {
  const ws = repository();
  ledgerOf(ws.ledger, [event({ time: "2026-01-02T03:04:05Z" })]);
  const only = event({ time: "2026-01-02T03:04:06Z" });
  writeLog(ws.root, [only]);
  const root = folder();
  writeFileSync(join(root, "index.html"), "<!doctype html><title>dashboard</title>");
  const server = await startServer({ home: ws.home, project: PROJECT, log: ws.root, port: 0, root });
  try {
    const hash = eventHash(only);
    const res = await fetch(`${server.url}/api/line?hash=${hash}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { item: { from: string; hash: string; n?: number; prev?: string | null; raw: string; event: LedgerEvent } };
    assert.equal(body.item.from, "log");
    assert.equal(body.item.hash, hash);
    assert.equal(body.item.n, undefined);
    assert.equal(body.item.prev, undefined);
    assert.equal(body.item.raw, fixedForm(only).toString("utf8"));
    assert.deepEqual(body.item.event, only);
    // The event log gives it with its hash too.
    const list = (await (await fetch(`${server.url}/api/events`)).json()) as { events: { from: string; hash?: string }[] };
    assert.deepEqual(
      list.events.map((i) => i.from),
      ["ledger", "log"],
    );
    assert.equal(list.events[1]!.hash, hash);
    // A hash that is not there, and one that is not a hash.
    assert.equal((await fetch(`${server.url}/api/line?hash=${"0".repeat(64)}`)).status, 404);
    assert.equal((await fetch(`${server.url}/api/line?hash=../x`)).status, 400);
  } finally {
    await server.close();
  }
});

test("#216: a file not named by its hash, a file outside events/ and a file not in the fixed form: verify ends with 1, naming each and its commit", () => {
  const ws = repository();
  ledgerOf(ws.ledger, []);
  const good = event();
  const renamed = event();
  const loose = event();
  const spaced = event();
  const wrongName = `events/00/${"0".repeat(64)}.json`;
  const first = writeLog(ws.root, [good, { path: wrongName, content: fixedForm(renamed) }]);
  const spacedText = JSON.stringify(spaced, null, 1);
  const spacedPath = logPath(Buffer.from(spacedText));
  const second = writeLog(ws.root, [good, { path: wrongName, content: fixedForm(renamed) }, { path: "notes/x.json", content: fixedForm(loose) }, { path: spacedPath, content: spacedText }]);
  const r = howl(["verify", "--project", PROJECT], { cwd: ws.root, env: ws.env });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = r.stdout.split("\n");
  assert.ok(out.includes(`howl/log: ${wrongName}, commit ${first}: the name is not the hash of the content`), r.stdout);
  assert.ok(out.includes(`howl/log: notes/x.json, commit ${second}: only events/<aa>/<hash>.json belongs on the log`), r.stdout);
  assert.ok(out.includes(`howl/log: ${spacedPath}, commit ${second}: the content is not the fixed form of its event`), r.stdout);
  assert.ok(out.includes(`howl/log: failed: 3 faults in 4 files, head ${second}`), r.stdout);
  assert.ok(!r.stdout.includes(logPath(fixedForm(good))), "the file that holds is not named");
});

test("#216: a file that is no event the schema accepts is a fault of verify, and left out by the reader", () => {
  const ws = repository();
  ledgerOf(ws.ledger, []);
  const notJson = Buffer.from("not json");
  const noEvent = fixedForm({ v: 0, id: "x" });
  const head = writeLog(ws.root, [{ path: logPath(notJson), content: notJson }, { path: logPath(noEvent), content: noEvent }]);
  const r = howl(["verify", "--project", PROJECT], { cwd: ws.root, env: ws.env });
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes(`howl/log: ${logPath(notJson)}, commit ${head}: the content is not JSON\n`), r.stdout);
  assert.match(r.stdout, new RegExp(`howl/log: ${logPath(noEvent)}, commit ${head}: event: `));
  assert.deepEqual(readEverything(ws.ledger, ws.root).reads, []);
});

test("#216: two files with one id and different content are both read, and verify ends with 1 naming the id", () => {
  const ws = repository();
  ledgerOf(ws.ledger, []);
  const one = event({ id: "twice", time: "2026-01-02T03:04:05Z" });
  const other = { ...one, task: "other" };
  writeLog(ws.root, [one, other]);
  assert.deepEqual(
    watched(ws).filter((id) => id === "twice"),
    ["twice", "twice"],
  );
  const r = howl(["verify", "--project", PROJECT], { cwd: ws.root, env: ws.env });
  assert.equal(r.status, 1, r.stdout);
  const paths = [logPath(fixedForm(one)), logPath(fixedForm(other))].sort();
  assert.ok(r.stdout.includes(`howl/log: id twice is in more than one file, with different content: ${paths.join(", ")}\n`), r.stdout);
});

test("#216: an event both on the branch and in the ledger file is no fault, and verify says the branch holds", () => {
  const ws = repository();
  const both = event();
  ledgerOf(ws.ledger, [both]);
  const head = writeLog(ws.root, [both, event()]);
  const r = howl(["verify", "--project", PROJECT], { cwd: ws.root, env: ws.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.endsWith(`howl/log: ok: 2 files checked, head ${head}\n`), r.stdout);
});

test("#216: with no howl/log, or a ledger named by its path, verify says nothing of a branch", () => {
  const ws = repository();
  ledgerOf(ws.ledger, [event()]);
  const before = howl(["verify", "--project", PROJECT], { cwd: ws.root, env: ws.env });
  assert.equal(before.status, 0);
  assert.ok(!before.stdout.includes("howl/log"));
  writeLog(ws.root, [{ path: "x", content: "x" }]);
  const byPath = howl(["verify", "--ledger", ws.ledger], { cwd: ws.root, env: ws.env });
  assert.equal(byPath.status, 0, byPath.stdout);
  assert.equal(byPath.stdout, before.stdout);
  // A ledger of another project than the repository's is read alone.
  const other = howl(["verify", "--ledger", ledgerWith(1)], { cwd: ws.root, env: ws.env });
  assert.ok(!other.stdout.includes("howl/log"));
});
