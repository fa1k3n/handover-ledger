// #40: one reader of the ledger and the activity file.
// @code_class tests
import assert from "node:assert/strict";
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildBundle } from "../src/export/export.ts";
import { checkpointOf } from "../src/anchor/anchor.ts";
import { LedgerError } from "../src/ledger/errors.ts";
import { hashLine } from "../src/ledger/ledger.ts";
import { activityBeside, activityFrom, byTime, ledgerLines, lineCount, readAll, readWhole, Tail } from "../src/read/reader.ts";
import { startServer } from "../src/serve/server.ts";
import { howl } from "./helpers.ts";
import { activityEvents, ledgerEvents, writeStory } from "./story.ts";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The files that may know how the ledger and the activity file are kept. */
const keeps = (file: string) => file === "read/reader.ts" || file.startsWith("ledger/") || file.startsWith("inbox/");

test("outside the reader, src/ledger and src/inbox, no source names the two files or parses a line of the ledger", () => {
  const faults: string[] = [];
  for (const path of sources()) {
    const file = relative(SRC, path).split("\\").join("/");
    if (keeps(file)) continue;
    const text = readFileSync(path, "utf8");
    text.split("\n").forEach((line, i) => {
      if (/ledger\.jsonl|activity\.jsonl/.test(line)) faults.push(`${file}:${i + 1} names a file`);
    });
    faults.push(...parsesLine(text).map((what) => `${file} ${what}`));
  }
  assert.deepEqual(faults, []);
});

/** What in a source reads or parses the ledger or the activity file itself. Statement by statement, so a wrapped line counts. */
function parsesLine(text: string): string[] {
  const found: string[] = [];
  for (const statement of text.split(";")) {
    const one = statement.replace(/\s+/g, " ").trim();
    // A line of the ledger is `{prev, hash, event}`: a parse that is read as one, with or without a cast.
    if (/JSON\.parse\(/.test(one) && (/\bas \{[^}]*\b(prev|event)\b/.test(one) || /JSON\.parse\([^;]*\)\)?\.(event|prev)\b/.test(one))) {
      found.push(`parses a line: ${one.slice(0, 80)}`);
    }
    // One of the two files opened by its path.
    if (/\b(readFileSync|openSync|createReadStream)\(\s*(ledger|activity)\w*\(?/i.test(one)) found.push(`opens a file: ${one.slice(0, 80)}`);
  }
  return found;
}

test("the source test finds a parse with no cast, a wrapped cast and a file opened by its path", () => {
  assert.equal(parsesLine("const e = JSON.parse(raw).event;").length, 1);
  assert.equal(parsesLine("const e = (JSON.parse(raw) as\n  {\n    event: X }).event;").length, 1);
  assert.equal(parsesLine("const l = JSON.parse(raw) as { prev: string | null };").length, 1);
  assert.equal(parsesLine("const t = readFileSync(ledgerPath(project), \"utf8\");").length, 1);
  assert.equal(parsesLine("const fd = openSync(ledger, \"r\");").length, 1);
  assert.equal(parsesLine("const t = readFileSync(activityBeside(ledger));").length, 1);
  assert.deepEqual(parsesLine("const c = JSON.parse(kept.text) as Checkpoint; const s = readFileSync(file, \"utf8\"); statSync(ledger);"), []);
});

test("one byTime: no other source sorts events by time", () => {
  const faults: string[] = [];
  for (const path of sources()) {
    const file = relative(SRC, path).split("\\").join("/");
    if (file === "read/order.ts") continue;
    const text = readFileSync(path, "utf8");
    if (/function byTime\b/.test(text)) faults.push(`${file} has a byTime of its own`);
    if (/Date\.parse\([^)]*\.time\)[^;]*\}\)\)\s*\.sort\(|\.sort\(\(a, b\) => a\.t - b\.t/.test(text)) faults.push(`${file} sorts by time by hand`);
  }
  assert.deepEqual(faults, []);
});

test("byTime sorts by time and keeps the order read for events of the same time", () => {
  const at = (time: string, id: string) => ({ event: { time }, id });
  const sorted = byTime([at("2026-01-01T08:00:02Z", "c"), at("2026-01-01T08:00:01Z", "a"), at("2026-01-01T08:00:01Z", "b")]);
  assert.deepEqual(
    sorted.map((x) => x.id),
    ["a", "b", "c"],
  );
});

test("the lines of the ledger come with their number, hash, prev and raw line, as they stand in the file", () => {
  const ledger = writeStory();
  const text = readFileSync(ledger, "utf8").split("\n").slice(0, -1);
  const lines = ledgerLines(ledger, { first: true });
  assert.equal(lines.length, text.length);
  for (const [i, line] of lines.entries()) {
    const stored = JSON.parse(text[i]!);
    assert.equal(line.n, i + 1);
    assert.equal(line.from, "ledger");
    assert.equal(line.raw, text[i]);
    assert.equal(line.hash, stored.hash);
    assert.equal(line.prev, stored.prev);
    assert.deepEqual(line.event, stored.event);
  }
  assert.equal(lines[0]!.event.type, "ledger.created");
  assert.equal(lines[0]!.prev, null);
  // Without the first line when not asked for; the numbers stay.
  const rest = ledgerLines(ledger);
  assert.deepEqual(
    rest.map((l) => l.n),
    lines.slice(1).map((l) => l.n),
  );
});

test("a line howl cannot read is passed over and still counts in the numbers", () => {
  const ledger = writeStory();
  const whole = ledgerLines(ledger, { first: true }).length;
  appendFileSync(ledger, "not json\n\n{\"prev\":null}\n");
  const extra = ledgerEvents()[0]!;
  appendFileSync(ledger, `${JSON.stringify({ prev: "x", hash: "y", event: { ...extra, id: "after-the-broken-lines" } })}\n`);
  const lines = ledgerLines(ledger, { first: true });
  assert.equal(lines.length, whole + 1);
  assert.equal(lines.at(-1)!.n, whole + 4);
  assert.equal(lines.at(-1)!.event.id, "after-the-broken-lines");
  assert.equal(lineCount(ledger), whole + 4);
  assert.equal(readWhole(ledger).bytes.length, whole + 4);
});

test("a half-written last line is passed over by every reader, and read when it is whole", () => {
  const ledger = writeStory();
  const before = { lines: ledgerLines(ledger).length, all: readAll(ledger).length, count: lineCount(ledger) };
  const tail = new Tail(ledger, "ledger");
  const first = tail.read();
  const extra = { ...ledgerEvents()[0]!, id: "half-written" };
  const line = JSON.stringify({ prev: "x", hash: "y", event: extra });
  appendFileSync(ledger, line.slice(0, 40));
  assert.equal(ledgerLines(ledger).length, before.lines);
  assert.equal(readAll(ledger).length, before.all);
  assert.equal(lineCount(ledger), before.count);
  assert.equal(readWhole(ledger).bytes.length, before.count);
  assert.deepEqual(tail.read(), []);
  // The same for the activity file.
  const activity = activityBeside(ledger);
  appendFileSync(activity, JSON.stringify({ ...activityEvents()[0]!, id: "half-activity" }).slice(0, 30));
  assert.equal(readAll(ledger).length, before.all);

  appendFileSync(ledger, `${line.slice(40)}\n`);
  const now = tail.read();
  assert.equal(now.length, 1);
  assert.equal(now[0]!.event.id, "half-written");
  assert.equal(now[0]!.n, first.at(-1)!.n! + 1, "a followed line has its number too");
  assert.equal(ledgerLines(ledger).length, before.lines + 1);
});

test("readAll gives the ledger and the activity beside it in the order of time, without the first line", () => {
  const ledger = writeStory();
  const reads = readAll(ledger);
  assert.ok(!reads.some((r) => r.event.type === "ledger.created"));
  assert.equal(reads.filter((r) => r.from === "activity").length, activityEvents().length);
  assert.equal(reads.filter((r) => r.from === "ledger").length, ledgerEvents().length);
  const times = reads.map((r) => Date.parse(r.event.time));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.ok(reads.filter((r) => r.from === "activity").every((r) => r.n === undefined && r.hash === undefined));
  assert.equal(activityFrom(reads), activityEvents().map((e) => e.time).sort()[0]);
  assert.equal(activityFrom(readAll(writeStory({ activity: false }))), null);
  assert.throws(() => readAll(join(ledger, "..", "none.jsonl")), /ENOENT/);
});

test("the whole ledger, read once: the bytes of every whole line, and the head they give", () => {
  const ledger = writeStory();
  const { bytes, lines } = readWhole(ledger);
  assert.equal(Buffer.concat(bytes.flatMap((b) => [b, Buffer.from("\n")])).toString("utf8"), readFileSync(ledger, "utf8"));
  assert.equal(lines.length, bytes.length);
  const verified = howl(["verify", "--ledger", ledger]);
  assert.match(verified.stdout, new RegExp(`head ${hashLine(bytes.at(-1)!)}`));
  assert.equal(checkpointOf(ledger, "0").head, hashLine(bytes.at(-1)!));
  assert.equal(checkpointOf(ledger, "0").lines, bytes.length);
});

test("the export and the checkpoint refuse a ledger with a line that cannot be read, and say which", () => {
  const ledger = writeStory();
  const n = lineCount(ledger);
  appendFileSync(ledger, "not json\n");
  assert.throws(
    () => buildBundle(ledger, { kind: "change", id: "30" }, { version: "0" }),
    (e) => e instanceof LedgerError && e.message.includes(`line ${n + 1}`),
  );
  const broken = join(ledger, "..", "broken.jsonl");
  writeFileSync(broken, "not json\n");
  assert.throws(() => checkpointOf(broken, "0"), (e) => e instanceof LedgerError && /line 1/.test(e.message));
});

test("the server's lines are the reader's: the same numbers and hashes", async () => {
  const ledger = writeStory();
  const server = await startServer({ ledger, port: 0, root: join(ledger, "..") });
  try {
    const body = (await (await fetch(`${server.url}/api/events?limit=5000`)).json()) as { events: { n: number; hash: string; prev: string; raw: string }[] };
    const lines = ledgerLines(ledger);
    assert.deepEqual(
      body.events.map((e) => [e.n, e.hash, e.prev, e.raw]),
      byTime(lines).map((l) => [l.n, l.hash, l.prev, l.raw]),
    );
    // The keys in the order the server sent them before this step: its answers are the same byte for byte.
    const withTools = (await (await fetch(`${server.url}/api/events?limit=5000&activity=1`)).json()) as { events: { from: string }[] };
    assert.deepEqual(Object.keys(withTools.events.find((e) => e.from === "ledger")!), ["n", "from", "hash", "prev", "event", "raw"]);
    assert.deepEqual(Object.keys(withTools.events.find((e) => e.from === "activity")!), ["from", "event", "raw"]);
  } finally {
    await server.close();
  }
});
