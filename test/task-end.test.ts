// The end of a task with several changes: the tests of issue #118.
// The case is the one of #117: task 40 with a first change that is merged and a second that is opened after it.
// @code_class tests
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readTar } from "../src/export/tar.ts";
import { openLedger } from "../src/ledger/ledger.ts";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { parseAsked, render, show, type Shown } from "../src/read/show.ts";
import { startServer } from "../src/serve/server.ts";
import { folder, howl, PROJECT } from "./helpers.ts";

const T0 = Date.UTC(2026, 10, 14, 9, 0, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const BRANCH = "issue-40-one-reader";
const SHA = { a: "a".repeat(40), b: "b".repeat(40) };
const person = { kind: "person" as const, id: "person-0a0a0a0a" };
const agent = { kind: "agent" as const, id: "agent-1" };

let n = 0;
function observed(type: LedgerEvent["type"], minute: number, extra: Partial<LedgerEvent> = {}): LedgerEvent {
  return { v: 0, id: `ev-${++n}`, time: at(minute), type, source: { adapter: "github", kind: "observed" }, project: PROJECT, ...extra };
}
function claimed(type: LedgerEvent["type"], minute: number, extra: Partial<LedgerEvent> = {}): LedgerEvent {
  return { v: 0, id: `ev-${++n}`, time: at(minute), type, source: { adapter: "claude-code-hook", kind: "claimed" }, project: PROJECT, actor: agent, ...extra };
}
const of = (change: string, sha: string) => ({ task: "40", change, branch: BRANCH, sha });
const byTime = (events: LedgerEvent[]) => [...events].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
const ask = (events: LedgerEvent[], what = "task:40"): Shown => show(byTime(events), parseAsked(what), null)!;

/** Change 63 is merged at 30; change 65 is opened at 60. What happens to 65 is added by each test. */
function first(): LedgerEvent[] {
  return [
    observed("task.opened", 0, { task: "40", actor: person }),
    observed("task.assigned", 1, { task: "40", actor: agent }),
    observed("change.opened", 10, { ...of("63", SHA.a), actor: agent }),
    observed("review.approved", 20, { ...of("63", SHA.a), actor: person }),
    observed("change.merged", 30, { ...of("63", SHA.a), actor: person }),
    // The code host closes the task at the first merge that names it.
    observed("task.closed", 31, { task: "40", actor: person }),
    observed("change.opened", 60, { ...of("65", SHA.b), actor: agent }),
  ];
}

test("both merged: the task is merged at the second merge, with the second change; the summary measures to it", () => {
  const shown = ask([...first(), observed("change.merged", 90, { ...of("65", SHA.b), actor: person })]);
  assert.deepEqual(shown.end, { state: "merged", time: at(90), actor: person, change: "65" });
  assert.equal(shown.summary.to, at(90));
  assert.equal(shown.summary.open, false);
  assert.equal(shown.summary.seconds, 89 * 60);
  assert.equal(render(shown, { utc: true }).split("\n")[0], "Task 40: merged");
});

test("the second still open: the task is open, and the summary is to the last event", () => {
  const shown = ask([...first(), observed("checks.passed", 62, of("65", SHA.b))]);
  assert.deepEqual(shown.end, { state: "open" });
  assert.equal(shown.summary.open, true);
  assert.equal(shown.summary.to, at(62));
  const text = render(shown, { utc: true });
  assert.equal(text.split("\n")[0], "Task 40: open");
  // The tracker's closing is shown, and decides nothing.
  assert.match(text, /task closed by person-0a0a0a0a/);
});

test("the second closed without a merge after the first was merged: merged, at the closing, with the second change", () => {
  const shown = ask([...first(), observed("change.closed", 75, { ...of("65", SHA.b), actor: person })]);
  assert.deepEqual(shown.end, { state: "merged", time: at(75), actor: person, change: "65" });
  assert.equal(shown.summary.to, at(75));
});

test("both closed without a merge: closed, at the last closing", () => {
  const events = first().filter((e) => e.type !== "change.merged" && e.type !== "review.approved");
  const shown = ask([
    ...events,
    observed("change.closed", 40, { ...of("63", SHA.a), actor: person }),
    observed("change.closed", 75, { ...of("65", SHA.b), actor: person }),
  ]);
  assert.deepEqual(shown.end, { state: "closed", time: at(75), actor: person, change: "65" });
  assert.equal(shown.summary.to, at(75));
  assert.equal(render(shown, { utc: true }).split("\n")[0], "Task 40: closed");
});

test("a task with one change: the end, the summary and the lines are as before", () => {
  const events = first().filter((e) => e.change !== "65");
  const shown = ask(events);
  assert.deepEqual(shown.end, { state: "merged", time: at(30), actor: person }, "no `change` where there is one change");
  assert.equal(shown.summary.to, at(30));
  const text = render(shown, { utc: true }).split("\n");
  assert.equal(text[0], "Task 40: merged");
  const end = text.slice(text.indexOf("End") + 1, text.indexOf("Summary") - 1);
  assert.deepEqual(end, [`  ${at(30).slice(0, 19)}Z  observed  merged by person-0a0a0a0a`, `  ${at(31).slice(0, 19)}Z  observed  task closed by person-0a0a0a0a`]);
});

test("a task with no change is open", () => {
  const shown = ask([observed("task.opened", 0, { task: "40", actor: person })]);
  assert.deepEqual(shown.end, { state: "open" });
});

test("a claimed merge of the second change ends nothing (#51)", () => {
  const shown = ask([...first(), claimed("change.merged", 90, of("65", SHA.b))]);
  assert.deepEqual(shown.end, { state: "open" });
  assert.equal(render(shown, { utc: true }).split("\n")[0], "Task 40: open");
});

test("a change asked for keeps its own end, and the same task's end is not added to it", () => {
  const shown = ask([...first(), observed("change.merged", 90, { ...of("65", SHA.b), actor: person })], "change:63");
  assert.deepEqual(shown.end, { state: "merged", time: at(30), actor: person });
});

test("/api/show and timeline.json of an export carry the end of the task", async () => {
  const path = join(folder(), "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  for (const e of byTime([...first(), observed("change.merged", 90, { ...of("65", SHA.b), actor: person })])) writer.append(e);
  writer.close();
  const server = await startServer({ ledger: path, port: 0, root: folder() });
  try {
    const body = await (await fetch(`${server.url}/api/show?what=task:40`)).json();
    assert.deepEqual(body.end, { state: "merged", time: at(90), actor: person, change: "65" });
    const out = join(folder(), "task.tar.gz");
    assert.equal(howl(["export", "--ledger", path, "--task", "40", "--out", out]).status, 0);
    const timeline = JSON.parse(readTar(readFileSync(out)).get("timeline.json")!.toString()) as Shown;
    assert.deepEqual(timeline.end, body.end);
  } finally {
    await server.close();
  }
});
