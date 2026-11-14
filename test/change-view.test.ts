// One change or task in the dashboard, its whole timeline: the tests of issue #22.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { readAll } from "../src/read/reader.ts";
import { show } from "../src/read/show.ts";
import { startServer } from "../src/serve/server.ts";
import { headText, sessionText } from "../src/dashboard/format.ts";
import { folder, PROJECT } from "./helpers.ts";
import { ledgerEvents, m, writeStory } from "./story.ts";

const DAY = 24 * 3600_000;

test("#22: /api/show gives what show() gives, 404 for a number nothing names, 400 for nonsense", async () => {
  const ledger = writeStory();
  const server = await startServer({ ledger, port: 0, root: folder() });
  try {
    const body = await (await fetch(`${server.url}/api/show?what=change:30`)).json();
    const reads = readAll(ledger);
    const activity = reads.filter((r) => r.from === "activity");
    const expected = show(
      reads.map((r) => r.event),
      { kind: "change", id: "30" },
      activity.length > 0 ? activity[0]!.event.time : null,
    );
    assert.deepEqual(body, JSON.parse(JSON.stringify(expected)));
    assert.equal((await fetch(`${server.url}/api/show?what=999`)).status, 404);
    assert.equal((await fetch(`${server.url}/api/show?what=`)).status, 400);
  } finally {
    await server.close();
  }
});

test("#22: a task opened a week before its work counts from its first change or session, not from its opening", () => {
  const opened: LedgerEvent = {
    v: 0,
    id: "old-open",
    time: new Date(Date.parse(m(0)) - 7 * DAY).toISOString(),
    type: "task.opened",
    source: { adapter: "local", kind: "observed" },
    project: PROJECT,
    task: "13",
  };
  // Task 13 of the story has no assignment in the ledger once that line is left out.
  const events = [opened, ...ledgerEvents().filter((e) => !(e.type === "task.assigned" && e.task === "13"))];
  const shown = show(events, { kind: "task", id: "13" }, null)!;
  assert.ok(Date.parse(shown.summary.from) > Date.parse(opened.time), shown.summary.from);
  assert.ok(shown.summary.seconds < DAY / 1000, `${shown.summary.seconds} s`);
});

test("#22: a head line and a session line for the view", () => {
  assert.equal(
    headText({ sha: "399a7cb1234", time: m(30), by: "agent-1", checks: "failed", checksTime: m(33) }, false),
    "new head 399a7cb by agent-1 (matched) · checks failed",
  );
  assert.equal(headText({ sha: "425d572aaaa", time: m(0), checks: "passed", checksTime: m(2) }, true), "head 425d572 · checks passed");
  assert.equal(
    sessionText({ session: "6affad97-8cdf", actor: { kind: "agent", id: "agent-1" }, role: "fix", start: m(0), end: m(33), tools: { Bash: 54, Read: 1 }, files: [], waits: [], activity: "kept" }),
    "agent-1 · fix · 33 min · Bash 54, Read 1",
  );
});
