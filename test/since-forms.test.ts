// #138: --since and --until take named forms only: a date; a date with T or a space and HH:MM or HH:MM:SS (local time);
// the same ending in Z (UTC); and now where it is taken today. Anything else is a usage error.
// @code_class tests
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { parseWhen } from "../src/ledger/time.ts";
import { howl, workspace } from "./helpers.ts";
import { writeStory } from "./story.ts";

const STOCKHOLM = { TZ: "Europe/Stockholm" };
const watch = (ledger: string, since: string) => howl(["watch", "--ledger", ledger, "--no-follow", "--since", since], { env: STOCKHOLM });
const types = (stdout: string) =>
  stdout
    .split("\n")
    .filter((l) => /^\d{4}-/.test(l))
    .map((l) => l.match(/ (\w+\.\w+) /)?.[1]);

const NAMED = ["2026-01-01", "2026-01-01T09:55", "2026-01-01 09:55", "2026-01-01T09:55:30", "2026-01-01 09:55:30", "2026-01-01T08:55Z", "2026-01-01T08:55:30Z", "2026-01-01 08:55Z", "2026-01-01T08:55:00.000Z", "2026-01-01T08:55:00.123456789Z", "2026-01-01T09:55:00.5"];
const UNNAMED = [
  "12",
  "2001",
  "",
  "last tuesday",
  "Jan 1 2026",
  "2026-01",
  "2026-1-1",
  "2026/01/01",
  "20260101",
  "2026-01-01T09",
  "2026-01-01T09:55+01:00",
  "2026-01-01T08:55:00-05:00",
  "2026-01-01T08:55:00 Z",
  "2026-01-01t09:55",
  "2026-01-01  09:55",
  "2026-02-30",
  "2026-02-30T00:00",
  "2026-01-01T24:00",
  "2026-01-01T23:60",
  "2026-01-01T23:59:60Z",
  "2026-13-01",
  "2026-01-01T09:55.5",
  "2026-01-01T09:55:00.",
  "2026-01-01T08:55:00.1234567890Z",
  "now",
  "NOW",
  "+2026-01-01",
];

test("#138: the named forms are read, and anything else is not", () => {
  for (const text of NAMED) assert.ok(Number.isFinite(parseWhen(text, { date: "utc" })), text);
  for (const text of UNNAMED) assert.ok(Number.isNaN(parseWhen(text, { date: "utc" })), JSON.stringify(text));
});

/** What `parseWhen` reads in the zone of Stockholm, whatever the zone of the machine. */
function stockholm(text: string, date: "local" | "utc"): number {
  const old = process.env.TZ;
  process.env.TZ = "Europe/Stockholm";
  try {
    return parseWhen(text, { date });
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
}

test("#138: a time with a Z is UTC, one without is local, a date alone is as the command says", () => {
  assert.equal(stockholm("2026-01-01T09:55", "utc"), Date.UTC(2026, 0, 1, 8, 55));
  assert.equal(stockholm("2026-01-01 09:55:30", "utc"), Date.UTC(2026, 0, 1, 8, 55, 30));
  assert.equal(stockholm("2026-01-01T08:55Z", "utc"), Date.UTC(2026, 0, 1, 8, 55));
  assert.equal(stockholm("2026-01-01", "utc"), Date.UTC(2026, 0, 1));
  assert.equal(stockholm("2026-01-01", "local"), Date.UTC(2025, 11, 31, 23));
});

test("#138: a local time that does not exist, in the hour the clocks go forward, is refused", () => {
  // 2026-03-29: 02:00 became 03:00 in Stockholm.
  for (const text of ["2026-03-29 02:30", "2026-03-29T02:00", "2026-03-29T02:59:59", "2026-03-29 02:30:00.5"]) assert.ok(Number.isNaN(stockholm(text, "utc")), text);
  assert.equal(stockholm("2026-03-29 01:59", "utc"), Date.UTC(2026, 2, 29, 0, 59));
  assert.equal(stockholm("2026-03-29 03:00", "utc"), Date.UTC(2026, 2, 29, 1, 0));
  // The same hour in UTC, and a date alone, exist.
  assert.equal(stockholm("2026-03-29T02:30Z", "utc"), Date.UTC(2026, 2, 29, 2, 30));
  assert.equal(stockholm("2026-03-29", "local"), Date.UTC(2026, 2, 28, 23));
});

test("#138: a local time that occurs twice, when the clocks go back, takes the earlier one", () => {
  // 2026-10-25: 03:00 became 02:00 in Stockholm; 02:30 was at 00:30Z and again at 01:30Z.
  assert.equal(stockholm("2026-10-25 02:30", "utc"), Date.UTC(2026, 9, 25, 0, 30));
  assert.equal(stockholm("2026-10-25T02:00:00", "utc"), Date.UTC(2026, 9, 25, 0, 0));
  assert.equal(stockholm("2026-10-25 03:00", "utc"), Date.UTC(2026, 9, 25, 2, 0));
});

test("#138: howl watch refuses a local time in the hour that does not exist, with status 2", () => {
  const result = watch(writeStory(), "2026-03-29 02:30");
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /^howl: --since 2026-03-29 02:30/);
  assert.equal(result.stdout, "");
});

test("#138: now is read only where the command takes it", () => {
  assert.ok(Number.isNaN(parseWhen("now", { date: "utc" })));
  assert.equal(parseWhen("now", { date: "utc", now: 1234 }), 1234);
});

test("#138: howl watch --since 12 is a usage error; it printed no line", () => {
  const result = watch(writeStory(), "12");
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /^howl: --since 12/);
  assert.equal(result.stdout, "");
});

test("#138: howl watch --since still reads a local time with a space or a T, and a time with Z", () => {
  const ledger = writeStory();
  assert.deepEqual(types(watch(ledger, "2026-01-01 09:55").stdout), ["review.approved", "change.merged"]);
  assert.deepEqual(types(watch(ledger, "2026-01-01T09:55:00").stdout), ["review.approved", "change.merged"]);
  assert.deepEqual(types(watch(ledger, "2026-01-01T08:55:00Z").stdout), ["review.approved", "change.merged"]);
});

test("#138: howl watch refuses every form that is not named, with status 2", () => {
  const ledger = writeStory();
  for (const text of ["2001", "2026-02-30", "2026-01-01T09", "2026-01-01T09:55+01:00", "now", "last tuesday"]) {
    const result = watch(ledger, text);
    assert.equal(result.status, 2, `${text}: ${result.stderr}`);
    assert.equal(result.stdout, "", text);
  }
});

test("#138: howl export refuses --since and --until that are not named forms, with status 2", () => {
  const ledger = writeStory();
  for (const [since, until] of [
    ["12", "2026-01-02"],
    ["2026-01-01", "tomorrow"],
    ["2026-01-01", "now"],
    ["2026-02-30", "2026-03-01"],
    ["2026-01-01T00:00:00+01:00", "2026-01-02"],
  ]) {
    const result = howl(["export", "--ledger", ledger, "--since", since!, "--until", until!, "--out", "/nonexistent/never-written.tar.gz"]);
    assert.equal(result.status, 2, `${since}..${until}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /--since|--until/);
  }
});

test("#138: howl observe and howl up refuse a --since that is not named, with status 2, and write nothing", () => {
  for (const since of ["12", "2026-02-30", "2026-01-01T09:55+01:00", "NOW"]) {
    const ws = workspace();
    const result = howl(["observe", "--once", "--since", since], { cwd: ws.root, env: ws.env });
    assert.equal(result.status, 2, `${since}: ${result.stderr}`);
    assert.match(result.stderr, /^howl: --since /, since);
    assert.ok(!existsSync(ws.ledger), "nothing is written");
  }
});
