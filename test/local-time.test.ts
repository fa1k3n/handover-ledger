// howl watch and howl show print local time: the tests of issue #8.
import assert from "node:assert/strict";
import { test } from "node:test";
import { howl } from "./helpers.ts";
import { writeStory } from "./story.ts";

const STOCKHOLM = { TZ: "Europe/Stockholm" };
const watch = (ledger: string, args: string[] = [], env: Record<string, string> = STOCKHOLM) =>
  howl(["watch", "--ledger", ledger, "--no-follow", ...args], { env });
const eventLines = (stdout: string) => stdout.split("\n").filter((l) => /^\d{4}-/.test(l));

test("#8: howl watch prints local time, and says once which zone", () => {
  const result = watch(writeStory());
  assert.equal(result.status, 0, result.stderr);
  const lines = eventLines(result.stdout);
  // The hand-over is at 08:00 UTC: 09:00 in Stockholm in January.
  assert.ok(lines.some((l) => l.startsWith("2026-01-01 09:00:00 ") && l.includes("task.assigned")), result.stdout);
  assert.ok(!lines.some((l) => /\d{2}Z /.test(l)), "no UTC times");
  const header = result.stdout.split("\n").filter((l) => /^times in /.test(l));
  assert.equal(header.length, 1);
  assert.match(header[0]!, /Europe\/Stockholm/);
  assert.match(header[0]!, /UTC\+01:00/);
});

test("#8: --utc prints UTC, as before", () => {
  const lines = eventLines(watch(writeStory(), ["--utc"]).stdout);
  assert.ok(lines.some((l) => l.startsWith("2026-01-01T08:00:00Z") && l.includes("task.assigned")));
});

test("#8: --json keeps the stored UTC times and prints no header", () => {
  const out = watch(writeStory(), ["--json"]).stdout;
  assert.ok(!/^times in /m.test(out));
  assert.ok(out.split("\n").filter(Boolean).every((l) => /"time":"[^"]+Z"/.test(l)));
});

test("#8: --since without an offset is read as local time; with one, as given", () => {
  const ledger = writeStory();
  const types = (since: string) => eventLines(watch(ledger, ["--since", since]).stdout).map((l) => l.match(/ (\w+\.\w+) /)?.[1]);
  // 09:55 in Stockholm is 08:55 UTC: the approval and the merge.
  assert.deepEqual(types("2026-01-01 09:55"), ["review.approved", "change.merged"]);
  assert.deepEqual(types("2026-01-01T09:55"), ["review.approved", "change.merged"]);
  assert.deepEqual(types("2026-01-01T08:55:00Z"), ["review.approved", "change.merged"]);
});

test("#8: howl show prints local time, and UTC with --utc", () => {
  const ledger = writeStory();
  const local = howl(["show", "12", "--ledger", ledger], { env: STOCKHOLM }).stdout;
  assert.match(local, /2026-01-01 09:00:00/);
  assert.ok(!/T08:00:00Z/.test(local));
  assert.match(local, /times in Europe\/Stockholm/);
  const utc = howl(["show", "12", "--ledger", ledger, "--utc"], { env: STOCKHOLM }).stdout;
  assert.match(utc, /2026-01-01T08:00:00Z/);
});
