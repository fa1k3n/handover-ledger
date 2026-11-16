// `howl show`: the tests of issue #4.
// @code_class tests
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { openLedger } from "../src/ledger/ledger.ts";
import { howl, PROJECT } from "./helpers.ts";
import { m, MERGER, REVIEWER, SHA, writeStory } from "./story.ts";

function show(ledger: string, what: string, ...args: string[]) {
  return howl(["show", what, "--ledger", ledger, ...args]);
}

function json(ledger: string, what: string): any {
  const result = show(ledger, what, "--json");
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("howl show for a task gathers the events that name it, of its change, of hook events on its branch, and of those sessions; none of another task", () => {
  const ledger = writeStory();
  const shown = json(ledger, "12");
  const ids = new Set<string>(shown.events.map((e: { id: string }) => e.id));
  const all = shown.events as { type: string; task?: string; change?: string; session?: string }[];
  assert.ok(all.some((e) => e.type === "task.assigned" && e.task === "12"));
  assert.ok(all.some((e) => e.type === "change.merged" && e.change === "30"));
  assert.ok(all.some((e) => e.session === "s1" && e.type === "session.started"), "a hook event on the branch");
  assert.ok(all.some((e) => e.session === "s2"), "the second session");
  assert.ok(all.some((e) => e.type === "tool.used"), "the tool calls of those sessions, from the activity file");
  assert.ok(!all.some((e) => e.task === "13" || e.change === "31" || e.session === "s3"), "nothing of the other task");
  assert.equal(ids.size, all.length);
  // In the order they happened.
  const times = shown.events.map((e: { time: string }) => e.time);
  assert.deepEqual(times, [...times].sort());
});

test("a change gives the same assignment as its task", () => {
  const ledger = writeStory();
  assert.deepEqual(
    json(ledger, "change:30").events.map((e: { id: string }) => e.id),
    json(ledger, "task:12").events.map((e: { id: string }) => e.id),
  );
});

test("the hand-over: the task, who got it and when", () => {
  const shown = json(writeStory(), "12");
  assert.deepEqual(shown.handover, [{ time: m(0), actor: { kind: "agent", id: "agent-1" }, kind: "observed" }]);
});

test("the sessions show the number of tool calls per tool, the files touched, and each wait with its length", () => {
  const shown = json(writeStory(), "12");
  const [s1, s2] = shown.sessions;
  assert.equal(s1.session, "s1");
  assert.deepEqual(s1.actor, { kind: "agent", id: "agent-1" });
  assert.equal(s1.start, m(2));
  assert.equal(s1.end, m(10));
  assert.deepEqual(s1.tools, { Bash: 2, Edit: 1, Read: 1 });
  assert.deepEqual(s1.files, ["src/a.ts"]);
  assert.deepEqual(s1.waits, [
    { time: m(5), kind: "person", notification_type: "permission_prompt", seconds: 60 },
    { time: m(9), kind: "instructions", notification_type: "idle_prompt", seconds: 60 },
  ]);
  assert.equal(s1.activity, "kept");
  assert.deepEqual(s2.tools, { Edit: 1 });
  assert.deepEqual(s2.files, ["src/b.ts"]);
});

test("with the activity lines gone, the sessions are still shown and say that the activity is no longer kept", () => {
  const ledger = writeStory({ activity: false });
  const shown = json(ledger, "12");
  assert.equal(shown.sessions.length, 2);
  assert.equal(shown.sessions[0].activity, "no longer kept");
  assert.deepEqual(shown.sessions[0].tools, {});
  const text = show(ledger, "12").stdout;
  assert.match(text, /activity is no longer kept/);
});

test("the change: opened, each new head commit, the checks of each", () => {
  const [change] = json(writeStory(), "12").changes;
  assert.equal(change.change, "30");
  assert.equal(change.branch, "task-12-x");
  assert.deepEqual(
    change.heads.map((h: { sha: string; time: string; checks?: string }) => [h.sha, h.time, h.checks]),
    [
      [SHA.a, m(10), "passed"],
      [SHA.b, m(30), "failed"],
      [SHA.c, m(40), "passed"],
    ],
  );
});

test("two reviews with a new head commit between them are two rounds", () => {
  const shown = json(writeStory(), "12");
  assert.equal(shown.reviews.length, 2);
  assert.deepEqual(
    shown.reviews.map((r: { reviews: { outcome: string; actor: { id: string } }[]; followedBy: string }) => [
      r.reviews.map((x) => [x.actor.id, x.outcome]),
      r.followedBy,
    ]),
    [
      [[[REVIEWER, "changes_requested"]], "change.updated"],
      [[[REVIEWER, "approved"]], "change.merged"],
    ],
  );
  assert.equal(shown.summary.reviewRounds, 2);
});

test("the end: merged, by whom", () => {
  const shown = json(writeStory(), "12");
  assert.deepEqual(shown.end, { state: "merged", time: m(60), actor: { kind: "person", id: MERGER } });
});

test("the summary's parts add up to the time from hand-over to merge", () => {
  const { summary } = json(writeStory(), "12");
  assert.equal(summary.from, m(0));
  assert.equal(summary.to, m(60));
  assert.equal(summary.seconds, 3600);
  const parts = summary.parts as Record<string, number>;
  assert.deepEqual(Object.keys(parts).sort(), ["checks", "instructions", "person", "review", "unknown", "work"]);
  assert.equal(Object.values(parts).reduce((a, b) => a + b, 0), 3600);
  // Some of the story, minute by minute:
  assert.equal(parts.person, 60 + 5 * 60, "the permission wait, and from approval to merge");
  assert.equal(parts.checks, 2 * 60 + 3 * 60 + 5 * 60, "from each new head to its checks");
  assert.deepEqual(summary.actors.map((a: { id: string }) => a.id).sort(), ["agent-1", MERGER, REVIEWER].sort());
});

test("with no session of an agent, the time a change waits for its checks and its review is not work", async () => {
  const { openLedger } = await import("../src/ledger/ledger.ts");
  const { folder } = await import("./helpers.ts");
  const path = join(folder(), "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  const observed = (id: string, type: any, minute: number, extra: object = {}) =>
    writer.append({ v: 0, id, time: m(minute), type, source: { adapter: "local", kind: "observed" }, project: PROJECT, ...extra });
  const of = { change: "40", branch: "b", sha: SHA.a, task: "20" };
  observed("1", "task.opened", 0, { task: "20" });
  observed("2", "change.opened", 10, of);
  observed("3", "checks.passed", 25, of);
  observed("4", "change.merged", 40, of);
  writer.close();
  const { summary } = json(path, "20");
  // #22: the summary starts at the first change; the ten minutes after the task was opened are not counted.
  assert.deepEqual(summary.parts, { work: 0, person: 0, instructions: 0, checks: 900, review: 900, unknown: 0 });
});

test("no output names a person's account, and no figure is given per person", () => {
  const ledger = writeStory();
  const text = show(ledger, "12").stdout;
  const shown = json(ledger, "12");
  for (const line of text.split("\n")) {
    if (line.includes(REVIEWER) || line.includes(MERGER)) {
      assert.doesNotMatch(line, /\b\d+\s?[hms]\b|\d+%/, `a person's line holds no figure: ${line}`);
    }
  }
  for (const session of shown.sessions) for (const wait of session.waits) assert.equal(wait.actor, undefined);
  assert.deepEqual(Object.keys(shown.summary).sort(), ["actors", "from", "open", "parts", "reviewRounds", "seconds", "to"]);
});

test("claimed and observed events are marked apart", () => {
  const text = show(writeStory(), "12").stdout;
  assert.match(text, /claimed/);
  assert.match(text, /observed/);
  const shown = json(writeStory(), "12");
  assert.ok(shown.events.every((e: { source: { kind: string } }) => ["claimed", "observed"].includes(e.source.kind)));
});

test("an assignment that is not finished shows what there is and says it is open", () => {
  const ledger = writeStory({ until: 35 });
  const shown = json(ledger, "12");
  assert.equal(shown.end.state, "open");
  assert.equal(shown.summary.open, true);
  assert.equal(shown.summary.to, m(33));
  assert.equal(Object.values(shown.summary.parts as Record<string, number>).reduce((a, b) => a + b, 0), shown.summary.seconds);
  assert.match(show(ledger, "12").stdout, /\bopen\b/);
});

test("a task that is not in the ledger gives a message and status 1", () => {
  const result = show(writeStory(), "99");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /99/);
});

test("the text names the parts", () => {
  const text = show(writeStory(), "12").stdout;
  for (const part of ["Hand-over", "Sessions", "Change 30", "Reviews", "End", "Summary"]) assert.match(text, new RegExp(part));
  assert.match(text, /Bash 2/);
  assert.match(text, /round 1/);
});

test("howl show does not change the ledger or take its lock, and runs while a writer holds it", () => {
  const ledger = writeStory();
  const dir = dirname(ledger);
  const before = readFileSync(ledger);
  const mtime = statSync(ledger).mtimeMs;
  const entries = readdirSync(dir).sort();
  const writer = openLedger(ledger, { project: PROJECT });
  try {
    assert.equal(show(ledger, "12").status, 0);
  } finally {
    writer.close();
  }
  assert.deepEqual(readFileSync(ledger), before);
  assert.equal(statSync(ledger).mtimeMs, mtime);
  assert.deepEqual(readdirSync(dir).sort(), entries);
  rmSync(join(dir, "activity.jsonl"));
});
