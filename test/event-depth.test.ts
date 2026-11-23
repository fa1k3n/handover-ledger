// #138, from the review: an event is at most 127 deep, so that its line is at most 128 and `howl verify` reads it.
// Whatever takes an event in refuses a deeper one, and nothing that was taken in is refused by `howl verify`.
// @code_class tests
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fixedForm } from "../src/ledger/fixed.ts";
import { openLedger } from "../src/ledger/ledger.ts";
import { event, folder, howl, inboxEvents, inboxFiles, lines, PROJECT, rawLines, workspace } from "./helpers.ts";
import { claim, send, until, up, type Up } from "./up-helpers.ts";

/** `n` objects inside each other: `n` deep. */
function nest(n: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let i = 1; i < n; i++) value = { a: value };
  return value;
}

/** The data that makes an event `depth` deep: the event is 1, its data 2 and what is inside goes on from there. */
const dataFor = (depth: number) => nest(depth - 1);

const REFUSED = "not JSON: nested more than 128 deep";

test("#138: the writer takes an event 127 deep, and howl verify passes the ledger", () => {
  const path = join(folder(), "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  writer.append(event({ id: "deep", type: "change.opened", data: dataFor(127) }));
  writer.close();
  const verified = howl(["verify", "--ledger", path]);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
});

test("#138: the writer refuses an event 128 deep, says why and writes nothing", () => {
  const path = join(folder(), "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  const before = rawLines(path);
  assert.throws(() => writer.append(event({ id: "too-deep", type: "change.opened", data: dataFor(128) })), { message: REFUSED });
  writer.close();
  assert.deepEqual(rawLines(path), before);
});

test("#138: howl ingest takes an event 127 deep and the ledger verifies; one 128 deep is rejected with the reason and nothing is written", () => {
  const ws = workspace();
  mkdirSync(ws.inbox, { recursive: true });
  writeFileSync(join(ws.inbox, "0001.json"), fixedForm(event({ id: "at-limit", type: "session.started", data: dataFor(127) })));
  writeFileSync(join(ws.inbox, "0002.json"), fixedForm(event({ id: "too-deep", type: "session.started", data: dataFor(128) })));
  const result = howl(["ingest"], { cwd: ws.root, env: ws.env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(ws.ledger).slice(1).map((l) => l.event.id), ["at-limit"]);
  assert.match(readFileSync(join(ws.inbox, "rejected", "0002.json.reason"), "utf8"), /not JSON: nested more than 128 deep/);
  const verified = howl(["verify", "--ledger", ws.ledger]);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
});

test("#138: howl emit --data makes an event 127 deep, and refuses one 128 deep, leaving nothing in the inbox", () => {
  const ws = workspace();
  // The event is 1, its data 2: a data object nested `n` deep makes an event `n + 1` deep.
  const bad = howl(["emit", "session.started", "--data", JSON.stringify(nest(127))], { cwd: ws.root, env: ws.env });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /not JSON: nested more than 128 deep/);
  assert.deepEqual(inboxFiles(ws.inbox), []);
  const ok = howl(["emit", "session.started", "--data", JSON.stringify(nest(126))], { cwd: ws.root, env: ws.env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(inboxEvents(ws.inbox).length, 1);
  assert.equal(howl(["ingest"], { cwd: ws.root, env: ws.env }).status, 0);
  const verified = howl(["verify", "--ledger", ws.ledger]);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
});

let running: Up;
before(async () => {
  running = await up();
});
after(async () => {
  await running.stop();
});

test("#138: the request body takes an event 127 deep, which verifies, and refuses one 128 deep with 400 and the reason, leaving no file", async () => {
  const good = claim("session.started", { id: "body-at-limit", data: dataFor(127) });
  assert.equal((await send(running.url, running.token, good)).status, 200);
  await until(() => lines(running.ws.ledger).some((l) => l.event.id === "body-at-limit"), 5000, "the event in the ledger");
  const bad = await send(running.url, running.token, claim("session.started", { id: "body-too-deep", data: dataFor(128) }));
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /not JSON: nested more than 128 deep/);
  await until(() => inboxFiles(running.ws.inbox).length === 0, 2000, "an empty inbox");
  assert.ok(!lines(running.ws.ledger).some((l) => l.event.id === "body-too-deep"));
  const verified = howl(["verify", "--ledger", running.ws.ledger]);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
});
