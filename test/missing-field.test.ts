// #200: a ledger line that parses but lacks a field the readers expect never makes a reader or the server
// fail. The line is named as a fault and left out of what is derived; everything else reads as before.
// @code_class tests
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkSignatures, issueKey, readKey, revokeKey, signEvent } from "../src/keys/keys.ts";
import { eventHash } from "../src/ledger/fixed.ts";
import { hashLine, openLedger, type LedgerEvent } from "../src/ledger/ledger.ts";
import { activityBeside, activityLines, ledgerLines, readAll, readWhole, Tail } from "../src/read/reader.ts";
import { startServer } from "../src/serve/server.ts";
import { event, folder, howl, PROJECT, rawLines, writeLines } from "./helpers.ts";
import { activityEvents, writeStory } from "./story.ts";

/** The line of the story that the tests damage: a claimed session.started with an actor and a branch. */
const DAMAGED = 5;

type Change = (e: Record<string, unknown>) => void;

/** A way to damage a line so that it still parses, and what the reader says of it. */
const REFUSED: [string, Change, RegExp][] = [
  ["lacking source", (e) => delete e.source, /source/],
  ["source null", (e) => (e.source = null), /source/],
  ["source not an object", (e) => (e.source = "claimed"), /source/],
  ["source lacking its kind", (e) => (e.source = { adapter: "claude-code-hook" }), /kind/],
  ["lacking id", (e) => delete e.id, /id/],
  ["actor not an object", (e) => (e.actor = "agent-1"), /actor/],
  ["actor lacking its id", (e) => (e.actor = { kind: "agent" }), /id/],
  ["data not an object", (e) => (e.data = "text"), /data/],
];

/**
 * A copy of the story's ledger (or of `base`) with line `n` changed by `change`; the chain is made again from that
 * line on, so that only the schema refuses it.
 */
function damaged(n: number, change: Change, base = writeStory()): string {
  const ledger = join(folder(), "ledger.jsonl");
  const raws = rawLines(base);
  let prev: string | null = n === 1 ? null : hashLine(Buffer.from(raws[n - 2]!));
  for (let i = n - 1; i < raws.length; i++) {
    const line = JSON.parse(raws[i]!);
    if (i === n - 1) change(line.event);
    line.prev = prev;
    line.hash = eventHash(line.event);
    raws[i] = JSON.stringify(line);
    prev = hashLine(Buffer.from(raws[i]!));
  }
  writeLines(ledger, raws);
  return ledger;
}

/** A built page of its own, so the tests need no build. */
function page(): string {
  const dir = folder();
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>dashboard</title>");
  return dir;
}

async function withServer(options: { ledger?: string; home?: string; project?: string }, run: (url: string) => Promise<void>) {
  const server = await startServer({ ...options, port: 0, root: page() });
  try {
    await run(server.url);
  } finally {
    await server.close();
  }
}

interface Faulty {
  line: number;
  reason: string;
  project?: string;
}

async function get<T = Record<string, unknown>>(url: string, path: string): Promise<{ status: number; body: T & { faulty?: Faulty[]; faultyMore?: number; error?: string } }> {
  const res = await fetch(`${url}${path}`);
  return { status: res.status, body: JSON.parse(await res.text()) };
}

interface Listed {
  n: number;
  event: LedgerEvent;
  signed?: unknown;
}

// --- the reader --------------------------------------------------------------------------------------------

for (const [name, change, reason] of REFUSED) {
  test(`#200: the reader names a line ${name}, leaves it out, and the lines after it keep their numbers`, () => {
    const ledger = damaged(DAMAGED, change);
    const whole = readWhole(ledger);
    assert.equal(whole.faulty.length, 1);
    assert.equal(whole.faulty[0]!.line, DAMAGED);
    assert.match(whole.faulty[0]!.reason, reason);
    assert.ok(!whole.lines.some((r) => r.n === DAMAGED), "left out of what is read");
    assert.equal(whole.bytes.length, rawLines(ledger).length, "still counted in the numbers");
    assert.equal(whole.lines.at(-1)!.n, rawLines(ledger).length);
    assert.ok(!ledgerLines(ledger).some((r) => r.n === DAMAGED));
    assert.ok(!readAll(ledger).some((r) => r.n === DAMAGED));
  });
}

test("#200: a line that is no JSON, or holds no event, is named too, and an empty one", () => {
  const ledger = writeStory();
  const count = rawLines(ledger).length;
  appendFileSync(ledger, 'not json\n\n{"prev":null}\n');
  const read = readWhole(ledger);
  assert.deepEqual(
    read.faulty.map((f) => f.line),
    [count + 1, count + 2, count + 3],
  );
  assert.match(read.faulty[0]!.reason, /not JSON/);
  assert.match(read.faulty[1]!.reason, /empty/);
  assert.match(read.faulty[2]!.reason, /event/);
});

test("#200: a line lacking its actor is not refused by the schema: it is read, and named nowhere", () => {
  const ledger = damaged(DAMAGED, (e) => delete e.actor);
  const whole = readWhole(ledger);
  assert.deepEqual(whole.faulty, []);
  assert.ok(whole.lines.some((r) => r.n === DAMAGED));
});

test("#200: a line whose prev and hash are no hashes is read as before: only its event is held to the event schema", () => {
  const ledger = writeStory();
  const raws = rawLines(ledger);
  const line = JSON.parse(raws[6]!);
  line.prev = "x";
  line.hash = "y";
  raws[6] = JSON.stringify(line);
  writeLines(ledger, raws);
  const whole = readWhole(ledger);
  assert.deepEqual(whole.faulty, []);
  assert.ok(whole.lines.some((r) => r.n === 7));
});

test("#200: the tail that follows a ledger leaves a refused line out and names it", () => {
  const ledger = damaged(DAMAGED, (e) => delete e.source);
  const tail = new Tail(ledger, "ledger");
  const read = tail.read();
  assert.ok(!read.some((r) => r.n === DAMAGED));
  assert.deepEqual(
    tail.faulty.map((f) => f.line),
    [DAMAGED],
  );
});

test("#200: a tool call lacking its source is left out of the activity file's lines", () => {
  const ledger = writeStory();
  const bad = { ...activityEvents()[0]!, id: "tool-without-source" } as Partial<LedgerEvent>;
  delete bad.source;
  appendFileSync(activityBeside(ledger), `${JSON.stringify(bad)}\n`);
  const found = activityLines(ledger);
  assert.equal(found.length, activityEvents().length);
  assert.ok(!found.some((r) => r.event.id === "tool-without-source"));
  readAll(ledger);
});

// --- the check of signatures -------------------------------------------------------------------------------

/** An issued key (line 2), a signed event that holds, and a copy of it under the same id that lacks its source: the copy after the event, or before it. */
function signed(faultyAt: "before" | "after") {
  const dir = folder();
  const issued = issueKey(PROJECT, { actor: "agent-1", hours: 24 }, { configDir: join(dir, "config"), keysDir: join(dir, "keys") }, new Date("2026-01-02T00:00:00Z"));
  const key = readKey(issued.file);
  const good = signEvent(event({ type: "session.started", source: { adapter: "test", kind: "claimed" }, actor: { kind: "agent", id: "agent-1" } }), key);
  const copy = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
  delete copy.source;
  const faulty = copy as unknown as LedgerEvent;
  const lines: { n: number; event: LedgerEvent }[] = [
    { n: 2, event: issued.event },
    ...(faultyAt === "before" ? [{ n: 3, event: faulty }, { n: 4, event: good }] : [{ n: 3, event: good }, { n: 4, event: faulty }]),
  ];
  return { lines, good, goodN: faultyAt === "before" ? 4 : 3, faultyN: faultyAt === "before" ? 3 : 4 };
}

for (const where of ["before", "after"] as const) {
  test(`#200: a signed line lacking its source, ${where} the line it copies, is a fault of its own and never makes a signature read as valid`, () => {
    const { lines, goodN, faultyN, good } = signed(where);
    const check = checkSignatures(lines);
    const fault = check.faults.find((f) => f.line === faultyN);
    assert.ok(fault, "the faulty line is named");
    assert.match(fault!.reason, /source/);
    assert.equal(check.byLine.get(faultyN), undefined, "no verdict for it, valid or not");
    assert.equal(check.byLine.get(goodN)?.ok, true, "the good line reads as it did");
    assert.equal(check.byEvent.get(good.id)?.ok, true, "and by its id too");
    assert.deepEqual(
      check.faults.filter((f) => f.line !== faultyN),
      [],
    );
    assert.equal(check.signed, 1);
  });
}

test("#200: the check of signatures gives the same for the good lines with a faulty line among them as without it", () => {
  const { lines, goodN, faultyN } = signed("after");
  const without = checkSignatures(lines.filter((l) => l.n !== faultyN));
  const among = checkSignatures(lines);
  assert.deepEqual(among.byLine.get(goodN), without.byLine.get(goodN));
  assert.equal(among.issuer, without.issuer);
  assert.equal(among.signed, without.signed);
  assert.equal(among.unsigned, without.unsigned);
});

test("#200: no field of a line, left out or of the wrong kind, makes the check of signatures throw", () => {
  const dir = folder();
  const places = { configDir: join(dir, "config"), keysDir: join(dir, "keys") };
  const issued = issueKey(PROJECT, { actor: "agent-1", hours: 24 }, places, new Date("2026-01-02T00:00:00Z"));
  const key = readKey(issued.file);
  const revoked = revokeKey(PROJECT, issued.keyId, places, new Date("2026-01-02T05:00:00Z"));
  const claim = signEvent(event({ type: "session.started", source: { adapter: "test", kind: "claimed" }, actor: { kind: "agent", id: "agent-1" }, time: "2026-01-02T01:00:00Z" }), key);
  const unsigned = event({ type: "session.started", source: { adapter: "test", kind: "claimed" }, time: "2026-01-02T01:30:00Z" });
  const events = [issued.event, claim, unsigned, revoked];
  const wrong: unknown[] = [undefined, null, 5, "x", [], {}, true];
  let tried = 0;
  const run = (i: number, copy: unknown, what: string) => {
    const lines = events.map((e, j) => ({ n: j + 2, event: (j === i ? copy : e) as LedgerEvent }));
    assert.doesNotThrow(() => checkSignatures(lines), what);
    tried++;
  };
  for (const [i, target] of events.entries()) {
    const fields = [...new Set([...Object.keys(target), "source", "actor", "sig", "data", "id", "time", "type"])];
    for (const field of fields) {
      for (const value of wrong) {
        const copy = JSON.parse(JSON.stringify(target)) as Record<string, unknown>;
        if (value === undefined) delete copy[field];
        else copy[field] = value;
        run(i, copy, `line ${i + 2}, ${field} = ${JSON.stringify(value)}`);
      }
    }
    // The fields of the key's own data, too.
    for (const field of Object.keys(target.data ?? {})) {
      for (const value of wrong) {
        const copy = JSON.parse(JSON.stringify(target)) as { data: Record<string, unknown> };
        if (value === undefined) delete copy.data[field];
        else copy.data[field] = value;
        run(i, copy, `line ${i + 2}, data.${field} = ${JSON.stringify(value)}`);
      }
    }
  }
  assert.ok(tried > 200);
});

test("#200: the reader gives the check of signatures every line that parses to an object with an event, also one it leaves out", () => {
  const ledger = damaged(DAMAGED, (e) => delete e.source);
  const whole = readWhole(ledger);
  assert.ok(whole.parsed.some((p) => p.n === DAMAGED), "the refused line is given to the check of signatures");
  assert.ok(!whole.lines.some((r) => r.n === DAMAGED), "and left out of the lines");
  assert.equal(whole.parsed.length, rawLines(ledger).length);
});

test("#200: a line that lacks a field the check reads and is no key's issue or revocation gives its reason, and an empty id is said to be empty", () => {
  const { lines } = signed("after");
  const bad = lines.map((l) => (l.n === 4 ? { n: 4, event: { ...l.event, id: "" } as LedgerEvent } : l));
  const check = checkSignatures(bad);
  assert.match(check.faults.find((f) => f.line === 4)?.reason ?? "", /id: empty/);
});

// --- a line left out never changes what a key's issue or revocation did -------------------------------------------

/** A key issued (line 2), a claim signed in time (3), the key revoked (4), a claim signed after the revocation (5). */
function revoked(): string {
  const dir = folder();
  const places = { configDir: join(dir, "config"), keysDir: join(dir, "keys") };
  const issued = issueKey(PROJECT, { actor: "agent-1", hours: 24 }, places, new Date("2026-01-02T00:00:00Z"));
  const key = readKey(issued.file);
  const claim = (time: string) => signEvent(event({ type: "session.started", source: { adapter: "test", kind: "claimed" }, actor: { kind: "agent", id: "agent-1" }, time }), key);
  const ledger = join(dir, "ledger.jsonl");
  const w = openLedger(ledger, { project: PROJECT });
  w.append(issued.event);
  w.append(claim("2026-01-02T01:00:00Z"));
  w.append(revokeKey(PROJECT, issued.keyId, places, new Date("2026-01-02T02:00:00Z")));
  w.append(claim("2026-01-02T03:00:00Z"));
  w.close();
  return ledger;
}

/** Issuer A's issue of a key (line 2), issuer B's issue of another key for the same agent (3), a claim signed with B's key (4). */
function swapped(): string {
  const dir = folder();
  const a = issueKey(PROJECT, { actor: "agent-1", hours: 24 }, { configDir: join(dir, "config-a"), keysDir: join(dir, "keys-a") }, new Date("2026-01-02T00:00:00Z"));
  const b = issueKey(PROJECT, { actor: "agent-1", hours: 24 }, { configDir: join(dir, "config-b"), keysDir: join(dir, "keys-b") }, new Date("2026-01-02T00:00:00Z"));
  const claim = signEvent(event({ type: "session.started", source: { adapter: "test", kind: "claimed" }, actor: { kind: "agent", id: "agent-1" }, time: "2026-01-02T01:00:00Z" }), readKey(b.file));
  const ledger = join(dir, "ledger.jsonl");
  const w = openLedger(ledger, { project: PROJECT });
  w.append(a.event);
  w.append(b.event);
  w.append(claim);
  w.close();
  return ledger;
}

const sigOf = (e: Record<string, unknown>) => e.sig as Record<string, unknown>;

for (const [name, change] of [
  ["a field the schema does not know added to its sig", (e: Record<string, unknown>) => (e.sig = { ...sigOf(e), x: 1 })],
  ["its sig key in capitals", (e: Record<string, unknown>) => (e.sig = { ...sigOf(e), key: String(sigOf(e).key).toUpperCase() })],
] as const) {
  test(`#200: a revocation with ${name} still revokes: the claim after it is not valid, as without the change`, async () => {
    const base = revoked();
    const ledger = damaged(4, change, base);
    await withServer({ ledger }, async (url) => {
      const events = await get<{ events: (Listed & { signed?: { ok: boolean; reason?: string } })[] }>(url, "/api/events");
      assert.equal(events.status, 200, events.body.error);
      const later = events.body.events.find((i) => i.n === 5)!;
      assert.equal(later.signed?.ok, false, "signed after the key was revoked");
      assert.match(later.signed?.reason ?? "", /revoked/);
      assert.equal(events.body.events.find((i) => i.n === 3)!.signed?.ok, true, "the claim before it still holds");
      assert.ok(!events.body.events.some((i) => i.n === 4), "the line itself is left out of the list");
      assert.deepEqual(
        events.body.faulty?.map((f) => f.line),
        [4],
      );
      const one = await get<{ signature: { ok: boolean; reason?: string } }>(url, "/api/line?line=5");
      assert.equal(one.status, 200, one.body.error);
      assert.equal(one.body.signature.ok, false);
      assert.match(one.body.signature.reason ?? "", /revoked/);
    });
  });
}

test("#200: an issue with a field added to its sig is not left out of the issuer: a key another issuer made has no valid issue", async () => {
  const ledger = damaged(2, (e) => (e.sig = { ...sigOf(e), x: 1 }), swapped());
  await withServer({ ledger }, async (url) => {
    const events = await get<{ events: (Listed & { signed?: { ok: boolean; reason?: string } })[] }>(url, "/api/events");
    assert.equal(events.status, 200, events.body.error);
    const claim = events.body.events.find((i) => i.n === 4)!;
    assert.equal(claim.signed?.ok ?? false, false, "not valid");
    const one = await get<{ signature: { ok: boolean; reason?: string } }>(url, "/api/line?line=4");
    assert.equal(one.body.signature.ok, false);
    assert.match(one.body.signature.reason ?? "", /no valid issue/);
  });
});

// --- a field name from the ledger is quoted, escaped and cut ------------------------------------------------------

const ESCAPES = "\u001b[2J\u001b[31mFORGED\u001b[0m\nhowl: ok\u009b\u2028";
const LONG = "x".repeat(200_000);
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/;

test("#200: a field name with escape sequences and a line break comes into a reason quoted and escaped, in the reader, the answers, the commands and verify", async () => {
  const ledger = damaged(DAMAGED, (e) => ((e as Record<string, unknown>)[ESCAPES] = 1));
  const reason = readWhole(ledger).faulty[0]!.reason;
  assert.ok(!CONTROL.test(reason) && !reason.includes("\n"), JSON.stringify(reason));
  assert.match(reason, /^"\\u001b\[2J/);
  await withServer({ ledger }, async (url) => {
    const text = await (await fetch(`${url}/api/events`)).text();
    assert.ok(!CONTROL.test(text.replaceAll("\n", "")));
  });
  for (const args of [["status"], ["show", "12", "--utc"], ["watch", "--no-follow", "--utc"], ["verify"]]) {
    const run = howl([...args, "--ledger", ledger]);
    const said = args[0] === "verify" ? run.stdout : run.stderr;
    assert.ok(!CONTROL.test(said), `${args[0]}: a raw control character`);
    assert.ok(!said.split("\n").some((l) => l.startsWith("howl: ok")), `${args[0]}: a line of its own`);
    assert.match(said, /not a field of an event/);
  }
});

test("#200: a field name of 200,000 characters is cut in every answer and command", async () => {
  const ledger = damaged(DAMAGED, (e) => ((e as Record<string, unknown>)[LONG] = 1));
  const reason = readWhole(ledger).faulty[0]!.reason;
  assert.ok(reason.length < 120, `${reason.length} characters`);
  assert.ok(reason.includes("…"));
  await withServer({ ledger }, async (url) => {
    for (const path of ["/api/events", `/api/line?line=${DAMAGED}`, "/api/line?line=3", "/api/agents", "/api/overview"]) {
      const text = await (await fetch(`${url}${path}`)).text();
      assert.ok(text.length < 50_000, `${path}: ${text.length} characters`);
    }
  });
  for (const args of [["status"], ["watch", "--no-follow", "--utc"]]) {
    const run = howl([...args, "--ledger", ledger]);
    assert.ok(run.stderr.length < 500, `${args[0]}: ${run.stderr.length} characters`);
  }
  const verify = howl(["verify", "--ledger", ledger]);
  assert.ok(verify.stdout.length < 1000, `verify: ${verify.stdout.length} characters`);
});

// --- the line's own shape -----------------------------------------------------------------------------------------

for (const [name, change, reason] of [
  ["a hash that is a number", (l: Record<string, unknown>) => (l.hash = 5), /hash/],
  ["a prev that is an object", (l: Record<string, unknown>) => (l.prev = {}), /prev/],
  ["no hash", (l: Record<string, unknown>) => delete l.hash, /hash/],
] as const) {
  test(`#200: a line with ${name} is left out and named, and the answers are 200`, async () => {
    const ledger = writeStory();
    const raws = rawLines(ledger);
    const line = JSON.parse(raws[6]!);
    change(line);
    raws[6] = JSON.stringify(line);
    writeLines(ledger, raws);
    const whole = readWhole(ledger);
    assert.deepEqual(
      whole.faulty.map((f) => f.line),
      [7],
    );
    assert.match(whole.faulty[0]!.reason, reason);
    assert.ok(!whole.lines.some((r) => r.n === 7));
    await withServer({ ledger }, async (url) => {
      for (const path of ["/api/events", "/api/line?line=3", "/api/overview", "/api/agents"]) {
        const a = await get(url, path);
        assert.equal(a.status, 200, path);
        assert.deepEqual(
          a.body.faulty?.map((f) => f.line),
          [7],
          path,
        );
      }
    });
  });
}

// --- the server ----------------------------------------------------------------------------------------------

for (const [name, change, reason] of REFUSED) {
  test(`#200: a line ${name}: /api/events, /api/line, /api/agents and /api/overview answer 200, the good lines read as before, and the line is named`, async () => {
    const baseline = writeStory();
    const ledger = damaged(DAMAGED, change, baseline);
    await withServer({ ledger: baseline }, async (url) => {
      const before = (await get<{ events: Listed[] }>(url, "/api/events")).body.events;
      await withServer({ ledger }, async (url2) => {
        const events = await get<{ events: Listed[] }>(url2, "/api/events");
        assert.equal(events.status, 200, events.body.error);
        const read = events.body.events;
        assert.deepEqual(
          read.map((i) => i.n),
          before.map((i) => i.n).filter((n) => n !== DAMAGED),
        );
        for (const item of read) assert.deepEqual(item.event, before.find((b) => b.n === item.n)!.event, `line ${item.n}`);
        assert.equal(events.body.faulty?.length, 1);
        assert.equal(events.body.faulty![0]!.line, DAMAGED);
        assert.match(events.body.faulty![0]!.reason, reason);

        const good = await get<{ item: Listed }>(url2, "/api/line?line=3");
        assert.equal(good.status, 200, good.body.error);
        assert.deepEqual(good.body.item.event, before.find((b) => b.n === 3)!.event);
        assert.deepEqual(
          good.body.faulty?.map((f) => f.line),
          [DAMAGED],
          "the answer for a line names the faulty line",
        );
        const later = await get(url2, "/api/line?line=9");
        assert.equal(later.status, 200, later.body.error);

        // The faulty line itself is named, with what is wrong; it is not given as an event.
        const faulty = await get(url2, `/api/line?line=${DAMAGED}`);
        assert.equal(faulty.status, 404);
        assert.match(faulty.body.error ?? "", new RegExp(`line ${DAMAGED}`));
        assert.match(faulty.body.error ?? "", reason);

        const agents = await get<{ rows: unknown[] }>(url2, "/api/agents");
        assert.equal(agents.status, 200, agents.body.error);
        assert.ok(Array.isArray(agents.body.rows));
        assert.deepEqual(
          agents.body.faulty?.map((f) => f.line),
          [DAMAGED],
        );
        const overview = await get<{ figures: unknown; handovers: unknown[] }>(url2, "/api/overview");
        assert.equal(overview.status, 200, overview.body.error);
        assert.ok(Array.isArray(overview.body.handovers));
        assert.deepEqual(
          overview.body.faulty?.map((f) => f.line),
          [DAMAGED],
        );
        const shown = await get(url2, "/api/show?what=12");
        assert.equal(shown.status, 200, shown.body.error);
      });
    });
  });
}

test("#200: a line lacking its actor is read as it is, named nowhere, and no endpoint fails", async () => {
  const ledger = damaged(DAMAGED, (e) => delete e.actor);
  await withServer({ ledger }, async (url) => {
    const events = await get<{ events: Listed[] }>(url, "/api/events");
    assert.equal(events.status, 200);
    assert.ok(events.body.events.some((i) => i.n === DAMAGED && i.event.actor === undefined));
    assert.equal(events.body.faulty, undefined);
    for (const path of ["/api/line?line=5", "/api/agents", "/api/overview", "/api/show?what=12"]) {
      const a = await get(url, path);
      assert.equal(a.status, 200, path);
      assert.equal(a.body.faulty, undefined, path);
    }
  });
});

test("#200: a ledger with no faulty line answers as before: no faulty in any answer", async () => {
  const ledger = writeStory();
  await withServer({ ledger }, async (url) => {
    for (const path of ["/api/events", "/api/line?line=3", "/api/agents", "/api/overview"]) {
      const a = await get(url, path);
      assert.equal(a.status, 200, path);
      assert.equal("faulty" in a.body, false, path);
    }
  });
});

test("#200: a faulty line is named with its project in an answer over several projects", async () => {
  const dir = folder();
  for (const name of ["a", "b"]) {
    const ledger = damaged(DAMAGED, name === "a" ? (e) => delete e.source : () => {});
    mkdirSync(join(dir, name));
    copyFileSync(ledger, join(dir, name, "ledger.jsonl"));
  }
  await withServer({ home: dir }, async (url) => {
    const events = await get<{ events: Listed[] }>(url, "/api/events");
    assert.equal(events.status, 200, events.body.error);
    assert.equal(events.body.faulty?.length, 1);
    assert.equal(events.body.faulty![0]!.project, "a");
    assert.equal(events.body.faulty![0]!.line, DAMAGED);
    assert.match(events.body.faulty![0]!.reason, /source/);
    const overview = await get(url, "/api/overview?project=a");
    assert.equal(overview.status, 200);
    assert.deepEqual(
      overview.body.faulty?.map((f) => f.line),
      [DAMAGED],
    );
  });
});

test("#200: the faulty lines in an answer are at most a hundred, with how many more there are", async () => {
  const ledger = writeStory();
  const bad = JSON.stringify({ prev: null, hash: "0".repeat(64), event: { time: "2026-01-02T03:04:05Z", type: "task.assigned" } });
  appendFileSync(ledger, `${Array.from({ length: 150 }, () => bad).join("\n")}\n`);
  await withServer({ ledger }, async (url) => {
    const events = await get<{ events: Listed[] }>(url, "/api/events");
    assert.equal(events.status, 200, events.body.error);
    assert.equal(events.body.faulty?.length, 100);
    assert.equal(events.body.faultyMore, 50);
  });
});

test("#200: a tool call lacking its source in the activity file does not fail /api/events with the tools", async () => {
  const ledger = writeStory();
  const bad = { ...activityEvents()[0]!, id: "tool-without-source" } as Partial<LedgerEvent>;
  delete bad.source;
  appendFileSync(activityBeside(ledger), `${JSON.stringify(bad)}\n`);
  await withServer({ ledger }, async (url) => {
    const a = await get<{ events: Listed[] }>(url, "/api/events?activity=1");
    assert.equal(a.status, 200, a.body.error);
    assert.ok(!a.body.events.some((i) => i.event.id === "tool-without-source"));
  });
});

// --- the commands --------------------------------------------------------------------------------------------

for (const [name, change, reason] of REFUSED) {
  test(`#200: howl show and howl status on a ledger with a line ${name} end without a stack, and name the line`, () => {
    const ledger = damaged(DAMAGED, change);
    for (const args of [["show", "12", "--utc"], ["show", "change:30", "--json"], ["status"], ["status", "--json"]]) {
      const run = howl([...args, "--ledger", ledger]);
      assert.equal(run.status, 0, `${args.join(" ")}: ${run.stderr}`);
      assert.ok(!/\n\s+at /.test(run.stderr), `a stack: ${run.stderr}`);
      assert.ok(!/TypeError|Cannot read/.test(run.stderr), run.stderr);
      assert.match(run.stderr, new RegExp(`line ${DAMAGED}`), `${args.join(" ")} names the line`);
      assert.match(run.stderr, reason);
    }
  });
}

test("#200: howl show and howl status on a ledger with no faulty line say nothing more on standard error", () => {
  const ledger = writeStory();
  for (const args of [["show", "12", "--utc"], ["status"]]) {
    const run = howl([...args, "--ledger", ledger]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
  }
});

for (const [name, change, reason] of REFUSED.slice(0, 3)) {
  test(`#200: howl watch on a ledger with a line ${name} shows the other lines, names the line, and ends without a stack`, () => {
    const ledger = damaged(DAMAGED, change);
    const run = howl(["watch", "--no-follow", "--utc", "--ledger", ledger]);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(!/\n\s+at /.test(run.stderr) && !/TypeError|Cannot read/.test(run.stderr), run.stderr);
    assert.match(run.stderr, new RegExp(`line ${DAMAGED} is left out`));
    assert.match(run.stderr, reason);
    assert.equal(run.stdout.trim().split("\n").length, rawLines(ledger).length - 2, "every line but the first and the faulty one");
  });
}

test("#200: howl verify still names the line the schema refuses, and fails", () => {
  const ledger = damaged(DAMAGED, (e) => delete e.source);
  const run = howl(["verify", "--ledger", ledger]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, new RegExp(`line ${DAMAGED}: .*source`));
});
