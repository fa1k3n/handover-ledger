// #138: an event time is a real time. The pattern lets in `2026-02-30`, which `Date.parse` rolls into March.
// @code_class tests
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { eventHash, fixedForm } from "../src/ledger/fixed.ts";
import { eventFaults } from "../src/ledger/schema.ts";
import { event, howl, ledgerWith, lines, rawLines, workspace, writeLines, type Line } from "./helpers.ts";

const NOT_REAL = [
  "2026-02-30T00:00:00Z",
  "2026-02-29T00:00:00Z",
  "2100-02-29T00:00:00Z",
  "2026-04-31T12:00:00Z",
  "2026-13-01T00:00:00Z",
  "2026-00-10T00:00:00Z",
  "2026-01-00T00:00:00Z",
  "2026-01-32T00:00:00Z",
  "2026-01-01T24:00:00Z",
  "2026-01-01T23:60:00Z",
  "2026-01-01T23:59:60Z",
  "2026-01-01T23:59:60.5Z",
];
const REAL = ["2024-02-29T00:00:00Z", "2000-02-29T00:00:00Z", "2026-12-31T23:59:59Z", "2026-01-01T00:00:00.123456789Z", "0001-01-01T00:00:00Z"];

test("#138: the check that howl emit makes refuses a time that is no date, and says so", () => {
  for (const time of NOT_REAL) {
    const faults = eventFaults({ ...event(), time });
    assert.deepEqual(faults, ["time: not a real time"], time);
  }
});

test("#138: a real time is let in, a leap day too", () => {
  for (const time of REAL) assert.deepEqual(eventFaults({ ...event(), time }), [], time);
});

test("#138: a time that does not match the pattern is still said as before, and not also as no real time", () => {
  const faults = eventFaults({ ...event(), time: "2026-02-30" });
  assert.equal(faults.length, 1);
  assert.match(faults[0]!, /^time: must match pattern/);
});

test("#138: howl ingest refuses an inbox file with a time that is no date, and writes nothing", () => {
  const ws = workspace();
  mkdirSync(ws.inbox, { recursive: true });
  writeFileSync(join(ws.inbox, "0001.json"), fixedForm(event({ id: "rolled", type: "session.started", time: "2026-02-30T00:00:00Z" })));
  const result = howl(["ingest"], { cwd: ws.root, env: ws.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(ws.inbox, "rejected", "0001.json.reason"), "utf8"), /time: not a real time/);
  assert.equal(lines(ws.ledger).length, 1, "only ledger.created");
});

test("#138: howl verify names the line whose time is no date", () => {
  const path = ledgerWith(2);
  const raw = rawLines(path);
  const line = JSON.parse(raw[2]!) as Line;
  line.event.time = "2026-02-30T00:00:00Z";
  line.hash = eventHash(line.event as never);
  raw[2] = `{"prev":${JSON.stringify(line.prev)},"hash":${JSON.stringify(line.hash)},"event":${fixedForm(line.event).toString("utf8")}}`;
  writeLines(path, raw);
  const result = howl(["verify", "--ledger", path]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(result.stdout.match(/^line \d+/gm), ["line 3"], result.stdout);
  assert.match(result.stdout, /event: time: not a real time/);
});
