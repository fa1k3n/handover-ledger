// `howl ingest`: the tests of issue #2.
// @code_class tests
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { eventHash, fixedForm } from "../src/ledger/fixed.ts";
import { openLedger, type LedgerEvent } from "../src/ledger/ledger.ts";
import { ACTIVITY_TYPES } from "../src/ledger/schema.ts";
import { event, howl, inboxFiles, lines, PROJECT, rawLines, startHowl, workspace, type Workspace } from "./helpers.ts";

/** Leaves an event in the inbox under `name`, as a hook would. */
function leave(ws: Workspace, name: string, content: unknown): void {
  mkdirSync(ws.inbox, { recursive: true });
  writeFileSync(join(ws.inbox, name), typeof content === "string" ? content : fixedForm(content));
}

function ingest(ws: Workspace, ...args: string[]) {
  return howl(["ingest", ...args], { cwd: ws.root, env: ws.env });
}

test("howl ingest brings the inbox in, in the order of the names: tool.used to the activity file, the others to the ledger", () => {
  const ws = workspace();
  // Activity older than the days it is kept would be removed at once: give it the time of now.
  const now = new Date().toISOString();
  leave(ws, "0003-c.json", event({ id: "c", type: "session.stopped", session: "s" }));
  leave(ws, "0001-a.json", event({ id: "a", type: "session.started", session: "s" }));
  leave(ws, "0002-b.json", event({ id: "b", type: "tool.used", session: "s", time: now, data: { tool: "Read" } }));
  leave(ws, "0004-d.json", event({ id: "d", type: "session.ended", session: "s" }));

  const result = ingest(ws);
  assert.equal(result.status, 0, result.stderr);

  const ledger = lines(ws.ledger).map((l) => l.event.id);
  assert.equal(ledger.length, 4);
  assert.deepEqual(ledger.slice(1), ["a", "c", "d"]);
  const activity = rawLines(ws.activity).map((l) => JSON.parse(l).id);
  assert.deepEqual(activity, ["b"]);

  assert.deepEqual(inboxFiles(ws.inbox), []);
  assert.equal(howl(["verify", "--ledger", ws.ledger]).status, 0);
});

test("an activity line holds the event in its fixed form, with no chain", () => {
  const ws = workspace();
  const e = event({ type: "tool.used", time: new Date().toISOString(), data: { tool: "Read" } });
  leave(ws, "0001.json", e);
  assert.equal(ingest(ws).status, 0);
  assert.deepEqual(rawLines(ws.activity), [fixedForm(e).toString("utf8")]);
});

test("the activity types are in the list of types", async () => {
  const { default: schema } = await import("../schema/event.v0.schema.json", { with: { type: "json" } });
  assert.deepEqual([...ACTIVITY_TYPES], ["tool.used"]);
  for (const type of ACTIVITY_TYPES) assert.ok(schema.properties.type.enum.includes(type), type);
});

test("a second pass over an empty inbox appends nothing", () => {
  const ws = workspace();
  leave(ws, "0001.json", event({ type: "session.started" }));
  assert.equal(ingest(ws).status, 0);
  const before = readFileSync(ws.ledger);
  assert.equal(ingest(ws).status, 0);
  assert.deepEqual(readFileSync(ws.ledger), before);
});

test("an activity line older than activity_days is removed by the next pass, and the ledger is untouched by that", () => {
  const ws = workspace({ yml: `project: ${PROJECT}\nactivity_days: 2\n` });
  const now = Date.now();
  const days = (n: number) => new Date(now - n * 86_400_000).toISOString();
  const old = event({ type: "tool.used", time: days(3) });
  const young = event({ type: "tool.used", time: days(1) });
  leave(ws, "0001.json", old);
  leave(ws, "0002.json", young);
  leave(ws, "0003.json", event({ type: "session.started", time: days(10) }));
  assert.equal(ingest(ws).status, 0);
  // The first pass writes, and also removes what is already too old.
  assert.deepEqual(rawLines(ws.activity), [fixedForm(young).toString("utf8")]);

  const ledger = readFileSync(ws.ledger);
  writeFileSync(ws.activity, `${fixedForm(old)}\n${fixedForm(young)}\n`);
  assert.equal(ingest(ws).status, 0);
  assert.deepEqual(rawLines(ws.activity), [fixedForm(young).toString("utf8")]);
  assert.deepEqual(readFileSync(ws.ledger), ledger);
});

test("activity is kept for 30 days when howl.yml does not say", () => {
  const ws = workspace();
  const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const kept = event({ type: "tool.used", time: days(29) });
  leave(ws, "0001.json", event({ type: "tool.used", time: days(31) }));
  leave(ws, "0002.json", kept);
  assert.equal(ingest(ws).status, 0);
  assert.deepEqual(rawLines(ws.activity), [fixedForm(kept).toString("utf8")]);
});

test("an invalid file is moved to rejected/ with the reason, and the pass goes on", () => {
  const ws = workspace();
  leave(ws, "0001.json", "not json");
  leave(ws, "0002.json", { ...event(), colour: "red" });
  leave(ws, "0003.json", event({ type: "tool.used", colour: "blue" } as never));
  leave(ws, "0004.json", event({ project: "another" }));
  leave(ws, "0005.json", event({ id: "good", type: "session.started" }));

  const result = ingest(ws);
  assert.equal(result.status, 0, result.stderr);

  assert.deepEqual(inboxFiles(ws.inbox), []);
  const rejected = join(ws.inbox, "rejected");
  assert.deepEqual(readdirSync(rejected).sort(), [
    "0001.json",
    "0001.json.reason",
    "0002.json",
    "0002.json.reason",
    "0003.json",
    "0003.json.reason",
    "0004.json",
    "0004.json.reason",
  ]);
  assert.match(readFileSync(join(rejected, "0001.json.reason"), "utf8"), /JSON/);
  assert.match(readFileSync(join(rejected, "0002.json.reason"), "utf8"), /colour/);
  assert.match(readFileSync(join(rejected, "0003.json.reason"), "utf8"), /colour/);
  assert.match(readFileSync(join(rejected, "0004.json.reason"), "utf8"), /project/);
  assert.match(result.stderr, /4 rejected/);

  assert.deepEqual(lines(ws.ledger).map((l) => l.event.id).slice(1), ["good"]);
  assert.ok(!existsSync(ws.activity));
});

/** A ledger in which a line holding `planted` has been written first, as someone who can append would. */
function plant(ws: Workspace, planted: LedgerEvent): void {
  const writer = openLedger(ws.ledger, { project: PROJECT });
  writer.append(planted);
  writer.close();
}

test("#203: an event whose id a planted line holds first is refused with the reason and kept in rejected/, never dropped as a duplicate", () => {
  const ws = workspace();
  const real = event({ id: "predicted", type: "session.started", session: "s" });
  plant(ws, event({ id: "predicted", type: "session.stopped", session: "other" }));
  const before = readFileSync(ws.ledger);
  leave(ws, "0001-real.json", real);
  leave(ws, "0002-next.json", event({ id: "next", type: "session.started", session: "t" }));

  const result = ingest(ws);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /1 rejected/);
  assert.doesNotMatch(result.stdout, /already in the ledger/);

  assert.deepEqual(inboxFiles(ws.inbox), []);
  const rejected = join(ws.inbox, "rejected");
  assert.deepEqual(readdirSync(rejected).sort(), ["0001-real.json", "0001-real.json.reason"]);
  assert.deepEqual(readFileSync(join(rejected, "0001-real.json")), fixedForm(real));
  const reason = readFileSync(join(rejected, "0001-real.json.reason"), "utf8");
  assert.match(reason, /predicted/);
  assert.match(reason, /another event/);

  // The pass went on, and the planted line is untouched.
  assert.deepEqual(readFileSync(ws.ledger).subarray(0, before.length), before);
  assert.deepEqual(lines(ws.ledger).map((l) => l.event.id).slice(1), ["predicted", "next"]);
  assert.equal(lines(ws.ledger)[1]?.event.type, "session.stopped");
});

test("#203: a planted line that names the hash of the real event beside its own event does not make the real event a duplicate", () => {
  const ws = workspace();
  const real = event({ id: "predicted", type: "session.started", session: "s" });
  const planted = event({ id: "predicted", type: "session.stopped", session: "other" });
  plant(ws, planted);
  writeFileSync(ws.ledger, readFileSync(ws.ledger, "utf8").replace(`"hash":"${eventHash(planted)}"`, `"hash":"${eventHash(real)}"`));
  leave(ws, "0001.json", real);

  const result = ingest(ws);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /1 rejected/);
  assert.deepEqual(readdirSync(join(ws.inbox, "rejected")).sort(), ["0001.json", "0001.json.reason"]);
});

test("#203: an activity event whose id a line of the ledger holds for another event is refused too", () => {
  const ws = workspace();
  plant(ws, event({ id: "predicted", type: "session.started" }));
  leave(ws, "0001.json", event({ id: "predicted", type: "tool.used", time: new Date().toISOString(), data: { tool: "Read" } }));

  const result = ingest(ws);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /1 rejected/);
  assert.deepEqual(readdirSync(join(ws.inbox, "rejected")).sort(), ["0001.json", "0001.json.reason"]);
  assert.ok(!existsSync(ws.activity));
});

test("#203: the same event ingested twice is dropped as a duplicate, also when its keys come in another order, and nothing is refused", () => {
  const ws = workspace();
  const e = event({ id: "once", type: "session.started", session: "s" });
  leave(ws, "0001.json", e);
  assert.equal(ingest(ws).status, 0);
  const before = readFileSync(ws.ledger);

  leave(ws, "0002.json", e);
  leave(ws, "0003.json", JSON.stringify(Object.fromEntries(Object.entries(e).reverse())));
  const result = ingest(ws);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 already in the ledger/);
  assert.match(result.stdout, /0 rejected/);
  assert.deepEqual(inboxFiles(ws.inbox), []);
  assert.ok(!existsSync(join(ws.inbox, "rejected")));
  assert.deepEqual(readFileSync(ws.ledger), before);
});

test("files under a temporary name are left for the next pass", () => {
  const ws = workspace();
  leave(ws, ".0001.json.tmp", event());
  assert.equal(ingest(ws).status, 0);
  assert.deepEqual(readdirSync(ws.inbox), [".0001.json.tmp"]);
});

test("a second howl ingest is refused while the first holds the lock", () => {
  const ws = workspace();
  leave(ws, "0001.json", event({ type: "session.started" }));
  const writer = openLedger(ws.ledger, { project: PROJECT });
  try {
    const result = ingest(ws);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /ledger\.jsonl\.lock/);
    assert.deepEqual(inboxFiles(ws.inbox), ["0001.json"]);
  } finally {
    writer.close();
  }
  assert.equal(ingest(ws).status, 0);
  assert.deepEqual(inboxFiles(ws.inbox), []);
});

test("howl ingest outside a repository with .howl/howl.yml needs --project", () => {
  const ws = workspace();
  leave(ws, "0001.json", event({ type: "session.started" }));
  const outside = howl(["ingest"], { cwd: ws.home, env: ws.env });
  assert.equal(outside.status, 2);
  const named = howl(["ingest", "--project", PROJECT], { cwd: ws.home, env: ws.env });
  assert.equal(named.status, 0, named.stderr);
  assert.deepEqual(inboxFiles(ws.inbox), []);
});

test("howl ingest --watch brings in what arrives while it runs, and lets go of the lock when it is stopped", async () => {
  const ws = workspace();
  const child = startHowl(["ingest", "--watch", "--interval", "0.1"], { cwd: ws.root, env: ws.env, stdio: "ignore" });
  const closed = new Promise((resolve) => child.on("close", resolve));
  try {
    await until(() => existsSync(ws.ledger));
    leave(ws, "0001.json", event({ id: "late", type: "session.started" }));
    await until(() => inboxFiles(ws.inbox).length === 0);
    assert.deepEqual(lines(ws.ledger).map((l) => l.event.id).slice(1), ["late"]);
    assert.ok(existsSync(`${ws.ledger}.lock`));
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
  assert.ok(!existsSync(`${ws.ledger}.lock`));
});

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
