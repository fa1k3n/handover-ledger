// Issue 43: one place for the words of a duration, of what an event concerns and of its short detail.
// @code_class tests
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sessionText } from "../src/dashboard/format.ts";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { keyFigures } from "../src/read/overview.ts";
import { parseAsked, render, show, type Session } from "../src/read/show.ts";
import { agentStates, renderStatus } from "../src/read/state.ts";
import { formatLine } from "../src/read/watch.ts";
import { concerns, detail, duration } from "../src/read/words.ts";
import { writingLine } from "../src/read/writing-text.ts";
import { PROJECT } from "./helpers.ts";
import { ledgerEvents, T0 as STORY_T0 } from "./story.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = (path: string) => readFileSync(join(ROOT, path), "utf8");
// A failed check of a source says where, never prints the file.
const srcMatch = (text: string, re: RegExp, label = re.source) => assert.ok(re.test(text), `expected: ${label}`);
const srcDoesNotMatch = (text: string, re: RegExp, label = re.source) => assert.ok(!re.test(text), `not expected: ${label}`);

const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const SHA = { a: "a".repeat(40), b: "b".repeat(40) };
const person = { kind: "person" as const, id: "person-0a0a0a0a" };
const agent = { kind: "agent" as const, id: "agent-1" };

let n = 0;
function ev(type: string, extra: Record<string, unknown> = {}, kind: "observed" | "claimed" = "observed", minute = 1): LedgerEvent {
  return {
    v: 0,
    id: `w-${++n}`,
    time: at(minute),
    type,
    source: { adapter: kind === "observed" ? "github" : "claude-code-hook", kind },
    project: PROJECT,
    ...extra,
  } as LedgerEvent;
}

// ---- R43.1: the file, with no Node ----

test("R43.1: words.ts holds duration, concerns and detail, as functions", () => {
  assert.equal(typeof duration, "function");
  assert.equal(typeof concerns, "function");
  assert.equal(typeof detail, "function");
});

test("R43.1: words.ts uses no Node: no node: import, no process, no Buffer", () => {
  const code = source("src/read/words.ts");
  srcDoesNotMatch(code, /from\s+["']node:/);
  srcDoesNotMatch(code, /require\(/);
  srcDoesNotMatch(code, /\bprocess\./);
  srcDoesNotMatch(code, /\bBuffer\b/);
});

// ---- R43.2: duration ----

test("R43.2: below a minute, whole seconds", () => {
  assert.equal(duration(0), "0 s");
  assert.equal(duration(12_000), "12 s");
  assert.equal(duration(59_000), "59 s");
});

test("R43.2: from a minute, whole minutes, rounded down, and no seconds", () => {
  assert.equal(duration(60_000), "1 min");
  assert.equal(duration(110_000), "1 min");
  assert.equal(duration(50 * MIN), "50 min");
  assert.equal(duration(59 * MIN + 59_000), "59 min");
});

test("R43.2: from an hour, hours and minutes, the minutes in two digits", () => {
  assert.equal(duration(HOUR), "1 h 00 min");
  assert.equal(duration(HOUR + 5 * MIN), "1 h 05 min");
  assert.equal(duration(5 * HOUR + 40 * MIN), "5 h 40 min");
  assert.equal(duration(5 * HOUR + 40 * MIN + 59_000), "5 h 40 min");
});

test("R43.2: hours and minutes go up to 47 h 59 min", () => {
  assert.equal(duration(47 * HOUR + 59 * MIN), "47 h 59 min");
  assert.equal(duration(47 * HOUR + 59 * MIN + 30_000), "47 h 59 min");
});

test("R43.2: from 48 hours, days with one decimal", () => {
  assert.equal(duration(48 * HOUR), "2.0 d");
  assert.equal(duration(60 * HOUR), "2.5 d");
  assert.equal(duration(72 * HOUR), "3.0 d");
});

test("R43.2: a span below 0 is 0 s", () => {
  assert.equal(duration(-1_000), "0 s");
  assert.equal(duration(-5 * MIN), "0 s");
  assert.equal(duration(-100 * HOUR), "0 s");
});

// ---- R43.3: what an event concerns ----

test("R43.3: the parts are joined by ' · '", () => {
  assert.equal(concerns(ev("change.opened", { task: "12", change: "30" })), "task 12 · change 30");
  assert.equal(concerns(ev("task.opened", { task: "12" })), "task 12");
  assert.equal(concerns(ev("change.opened", { change: "30" })), "change 30");
});

test("R43.3: who a task was given to, and who it was taken from", () => {
  assert.equal(concerns(ev("task.assigned", { task: "40", actor: person, to: agent })), "task 40 · to agent-1");
  assert.equal(concerns(ev("task.unassigned", { task: "40", actor: person, to: agent })), "task 40 · taken from agent-1");
});

test("R43.3: it does not name the session", () => {
  const e = ev("change.opened", { task: "12", change: "30", session: "6affad97e1d24c0b" }, "claimed");
  assert.equal(concerns(e), "task 12 · change 30");
  const withBranch = ev("tool.used", { task: "12", change: "30", branch: "task-12-x", session: "6affad97e1d24c0b" }, "claimed");
  assert.doesNotMatch(concerns(withBranch), /session|6affad97/);
});

// ---- R43.4: the short detail ----

test("R43.4: a tool call: its tool, target and outcome, joined by a space", () => {
  const e = ev("tool.used", { data: { tool: "Bash", target: "make", outcome: "failed" } }, "claimed");
  assert.equal(detail(e), "Bash make failed");
});

test("R43.4: a wait: its kind of notification", () => {
  assert.equal(detail(ev("agent.waiting", { data: { notification_type: "permission_prompt" } }, "claimed")), "permission_prompt");
});

test("R43.4: a started session: model, effort and where it came from, joined by ' · '", () => {
  const started = ev("session.started", { model: "claude-opus-5-5", effort: "high", data: { source: "startup" } }, "claimed");
  assert.equal(detail(started), "claude-opus-5-5 · high · startup");
  const resumed = ev("session.started", { model: "claude-opus-5-5", effort: "high", data: { source: "resume" } }, "claimed");
  assert.equal(detail(resumed), "claude-opus-5-5 · high · resume");
});

test("R43.4: an ended session: its reason", () => {
  assert.equal(detail(ev("session.ended", { data: { reason: "other" } }, "claimed")), "other");
});

test("R43.4: a change: its branch and its commit, and `forced` on a forced push", () => {
  const plain = ev("change.updated", { task: "12", change: "30", branch: "task-12-x", sha: SHA.b });
  assert.equal(detail(plain), "task-12-x bbbbbbb");
  const forced = ev("change.updated", { task: "12", change: "30", branch: "task-12-x", sha: SHA.b, data: { forced: true } });
  assert.equal(detail(forced), "task-12-x bbbbbbb forced");
  assert.equal(detail(ev("change.opened", { change: "30", branch: "task-12-x", sha: SHA.a })), "task-12-x aaaaaaa");
});

test("R43.4: checks: their commit and the names that failed", () => {
  assert.equal(detail(ev("checks.failed", { change: "40", branch: "b", sha: SHA.a, data: { failed: ["lint", "unit"] } })), "aaaaaaa lint, unit");
  assert.equal(detail(ev("checks.passed", { change: "40", branch: "b", sha: SHA.a })), "aaaaaaa");
});

test("R43.4: a review: its branch and its commit", () => {
  assert.equal(detail(ev("review.approved", { task: "12", change: "30", branch: "task-12-x", sha: SHA.a, actor: person })), "task-12-x aaaaaaa");
});

test("R43.4: any other type: the fields of its data as key=value, without `seen`", () => {
  const e = ev("task.opened", { task: "12", data: { seen: at(1), reason: "new", count: 3 } });
  assert.equal(detail(e), "reason=new count=3");
});

// ---- R43.5: since goes; the span of the last event is written with duration ----

// The story's task 12 with change 30: the agent's last event is the end of its first session, at minute 10 after T0 of the story.
const ledger = ledgerEvents().filter((e) => Date.parse(e.time) <= STORY_T0 + 12 * MIN);
/** `howl status` for that agent, `minutes` after its last event. */
const working = (minutes: number) => {
  const now = STORY_T0 + (10 + minutes) * MIN;
  return renderStatus(agentStates(ledger, now), now);
};

test("R43.5: guard: howl status writes a span of up to a day as hours and minutes, as it does now", () => {
  assert.match(working(340), /5 h 40 min/);
  assert.match(working(65), /1 h 05 min/);
  assert.match(working(50), /50 min/);
});

test("R43.5: howl status writes a span of a day or more in the one form of duration", () => {
  assert.match(working(30 * 60), /30 h 00 min/);
  assert.match(working(60 * 60), /2\.5 d/);
  assert.match(working(72 * 60), /3\.0 d/);
});

test("R43.5: guard: an event stamped a moment ahead of the clock reads as 0 s", () => {
  const now = STORY_T0 + 9 * MIN;
  assert.match(renderStatus(agentStates(ledger, now), now), /\b0 s\b/);
});

test("R43.5: state.ts and App.tsx no longer hold or import `since`", () => {
  srcDoesNotMatch(source("src/read/state.ts"), /(function|const|let)\s+since\b/);
  srcDoesNotMatch(source("src/dashboard/App.tsx"), /import\s*(type\s*)?\{[^}]*\bsince\b[^}]*\}/);
  srcDoesNotMatch(source("src/dashboard/App.tsx"), /\bsince\(/);
});

test("R43.5: state.ts writes the span with duration of words.ts", () => {
  srcMatch(source("src/read/state.ts"), /import\s*\{[^}]*\bduration\b[^}]*\}\s*from\s*["'][^"']*words\.ts["']/);
});

// ---- R43.6: what a row works on is said with concerns ----

test("R43.6: guard: howl status says what a row works on as `task 12 · change 30`", () => {
  assert.match(working(5), /task 12 · change 30/);
});

test("R43.6: worksOn goes from state.ts and the dashboard, which use concerns of words.ts", () => {
  const state = source("src/read/state.ts");
  srcDoesNotMatch(state, /\bworksOn\b/);
  srcMatch(state, /import\s*\{[^}]*\bconcerns\b[^}]*\}\s*from\s*["'][^"']*words\.ts["']/);
  srcDoesNotMatch(source("src/dashboard/App.tsx"), /\bworksOn\b/);
});

// ---- R43.7: the overview ----

test("R43.7: overview.ts has no duration of its own", () => {
  srcDoesNotMatch(source("src/read/overview.ts"), /(export\s+)?(function|const)\s+duration\b/);
});

test("R43.7: guard: the lead time of the dashboard is written with duration(...leadTimeMedianMs)", () => {
  srcMatch(source("src/dashboard/App.tsx"), /\bduration\(\s*[\w.?!]*leadTimeMedianMs/);
});

// ---- R43.8: howl show ----

test("R43.8: show.ts has no duration or seconds of its own", () => {
  const code = source("src/read/show.ts");
  srcDoesNotMatch(code, /(function|const)\s+duration\b/);
  srcDoesNotMatch(code, /(function|const)\s+seconds\b/);
});

test("R43.8: howl show writes the summary, a session and a wait in the one form", () => {
  const of = { task: "40", change: "63", branch: "issue-40-x", sha: SHA.a };
  const text = render(
    show(
      [
        ev("task.opened", { task: "40", actor: person }, "observed", 0),
        ev("task.assigned", { task: "40", actor: person, to: agent }, "observed", 1),
        ev("session.started", { session: "s1", actor: agent, branch: "issue-40-x", data: { source: "startup" } }, "claimed", 2),
        ev("agent.waiting", { session: "s1", actor: agent, branch: "issue-40-x", data: { notification_type: "permission_prompt" } }, "claimed", 5),
        ev("session.ended", { session: "s1", actor: agent, branch: "issue-40-x", data: { reason: "other" } }, "claimed", 70),
        ev("change.opened", { ...of, actor: agent }, "observed", 3),
        ev("change.merged", { ...of, actor: person }, "observed", 66),
      ],
      parseAsked("task:40"),
      null,
    )!,
    { utc: true },
  );
  assert.match(text, /hand-over to the end: 1 h 05 min/);
  assert.match(text, /session s1.*1 h 08 min/);
  assert.match(text, /permission_prompt\): 1 h 05 min/);
  assert.doesNotMatch(text, /\b\d+h \d+m\b|\b\d+m \d+s\b|\b\d+[ms]\b/);
});

// ---- R43.9: howl watch ----

test("R43.9: watch.ts has no `short`", () => {
  const code = source("src/read/watch.ts");
  srcDoesNotMatch(code, /(function|const)\s+short\b/);
  srcMatch(code, /import\s*\{[^}]*\bconcerns\b[^}]*\}\s*from\s*["'][^"']*words\.ts["']/);
  srcMatch(code, /import\s*\{[^}]*\bdetail\b[^}]*\}\s*from\s*["'][^"']*words\.ts["']/);
});

test("R43.9: a line of howl watch joins what the event concerns by ' · '", () => {
  const line = formatLine(ev("change.opened", { task: "12", change: "30", branch: "task-12-x", sha: SHA.a, actor: agent }), false, true);
  assert.match(line, /task 12 · change 30/);
  assert.doesNotMatch(line, /task 12 +change 30/);
});

test("R43.9: the session follows what the event concerns, on its own, as a part of the line", () => {
  const e = ev("checks.failed", { task: "12", change: "30", branch: "task-12-x", sha: SHA.a, session: "6affad97e1d24c0b", actor: agent, data: { failed: ["lint", "unit"] } }, "claimed");
  const line = formatLine(e, false, true);
  assert.match(line, /task 12 · change 30\s+session 6affad97\s+aaaaaaa lint, unit/);
  assert.doesNotMatch(line, /change 30 · session/);
});

test("R43.9: a line has the time, claimed or observed, the actor, the type, what it concerns, and the short of its data", () => {
  const e = ev("checks.failed", { task: "12", change: "30", branch: "b", sha: SHA.a, actor: agent, data: { failed: ["lint", "unit"] } }, "observed");
  assert.match(formatLine(e, false, true), /^2026-11-16T09:01:00Z\s+observed\s+agent-1\s+checks\.failed\s+task 12 · change 30\s+aaaaaaa lint, unit$/);
  const c = ev("tool.used", { task: "12", actor: agent, data: { tool: "Bash", target: "make", outcome: "failed" } }, "claimed");
  assert.match(formatLine(c, false, true), /^2026-11-16T09:01:00Z\s+claimed\s+agent-1\s+tool\.used\s+task 12\s+Bash make failed$/);
});

// ---- R43.10: the dashboard's stream ----

test("R43.10: format.ts has no concerns or detail of its own, and the stream uses those of words.ts with the row's event", () => {
  const format = source("src/dashboard/format.ts");
  srcDoesNotMatch(format, /export\s+(function|const)\s+concerns\b/);
  srcDoesNotMatch(format, /export\s+(function|const)\s+detail\b/);
  const app = source("src/dashboard/App.tsx");
  srcMatch(app, /import\s*\{[^}]*\bconcerns\b[^}]*\}\s*from\s*["'][^"']*read\/words\.ts["']/);
  srcMatch(app, /import\s*\{[^}]*\bdetail\b[^}]*\}\s*from\s*["'][^"']*read\/words\.ts["']/);
  srcMatch(app, /\bconcerns\(\s*(\w+\.)?event\s*\)/);
  srcMatch(app, /\bdetail\(\s*(\w+\.)?event\s*\)/);
  srcDoesNotMatch(app, /\b(concerns|detail)\(\s*item\s*\)/);
  srcDoesNotMatch(app, /import\s*\{[^}]*\b(concerns|detail)\b[^}]*\}\s*from\s*["'][^"']*format\.ts["']/);
});

// ---- R43.11: the dashboard's durations ----

const session = (minutes: number): Session => ({
  session: "s1",
  actor: agent,
  role: "fix",
  start: at(0),
  end: at(minutes),
  tools: { Bash: 54, Read: 1 },
  files: [],
  waits: [],
  activity: "kept",
});

test("R43.11: sessionText writes the span of a session with duration", () => {
  assert.equal(sessionText(session(65)), "agent-1 · fix · 1 h 05 min · Bash 54, Read 1");
  assert.equal(sessionText(session(0)).includes("0 s"), true);
});

test("R43.11: guard: sessionText of 33 minutes is as before", () => {
  assert.equal(sessionText(session(33)), "agent-1 · fix · 33 min · Bash 54, Read 1");
});

test("R43.11: format.ts, App.tsx and ChangeView.tsx import duration from words.ts, not from overview.ts", () => {
  for (const file of ["format.ts", "App.tsx", "ChangeView.tsx"]) {
    const code = source(`src/dashboard/${file}`);
    srcMatch(code, /import\s*\{[^}]*\bduration\b[^}]*\}\s*from\s*["'][^"']*read\/words\.ts["']/, file);
    srcDoesNotMatch(code, /import\s*\{[^}]*\bduration\b[^}]*\}\s*from\s*["'][^"']*overview\.ts["']/, file);
  }
});

// ---- R43.12: a started session reads the same everywhere ----

test("R43.12: a started session has the same detail in howl watch and in detail of words.ts", () => {
  const e = ev("session.started", { session: "6affad97e1d24c0b", actor: agent, model: "claude-opus-5-5", effort: "high", data: { source: "startup" } }, "claimed");
  assert.equal(detail(e), "claude-opus-5-5 · high · startup");
  assert.ok(formatLine(e, false, true).endsWith("claude-opus-5-5 · high · startup"), formatLine(e, false, true));
});

// ---- R43.13: no other function formats a duration ----

// Left out, with the reason: warnings in code that records events, which this step does not class.
const LEFT_OUT: Record<string, string> = {
  "src/read/words.ts": "the one place of the words",
  "src/howl/trace-read.ts": "the time limit of reading the tests of a head (`took more than 10 s`): a warning in code that records events",
  "src/observe/github.ts": "the pause at GitHub's limit (`waiting 30 s`): a warning in code that records events",
};

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test("R43.13: no function under src/ but words.ts turns milliseconds or seconds into a duration of text", () => {
  // A division by the length of a minute, an hour or a day, or by a thousand, with a unit written within two lines of it.
  const divides = /\/\s*(60_?000|3_?600_?000|86_?400_?000|3_?600|86_?400|1_?000|60)\b/;
  const unit = /(\}|["'`])\s*(min|[smhd])\b/;
  const found: string[] = [];
  for (const path of sources("src")) {
    if (path in LEFT_OUT) continue;
    const lines = readFileSync(join(ROOT, path), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!divides.test(line)) return;
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (lines.slice(i, i + 3).some((l) => unit.test(l))) found.push(`${relative(ROOT, join(ROOT, path))}:${i + 1}`);
    });
  }
  assert.deepEqual(found, []);
});

// ---- R43.14: README ----

const block = (text: string, start: string): string => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, start);
  const to = text.indexOf("```", from);
  return text.slice(from, to);
};

test("R43.14: the example of howl show takes the one form of a duration", () => {
  const example = block(readFileSync(join(ROOT, "README.md"), "utf8"), "$ howl show 12 --utc");
  srcDoesNotMatch(example, /\b\d+[hms]\b/);
  srcMatch(example, /to 2026-01-01T08:10:00Z, 8 min/);
  srcMatch(example, /hand-over to the end: 1 h 00 min/);
  srcMatch(example, /work 13 min, waiting for a person 6 min/);
});

test("R43.14: the example of howl watch joins what an event concerns by ' · '", () => {
  const example = block(readFileSync(join(ROOT, "README.md"), "utf8"), "$ howl watch --filter type=review.*");
  srcMatch(example, /task 12 · change 30/);
  srcDoesNotMatch(example, /task 12 +change 30/);
});

// ---- R43.15: times of day are as they are ----

test("R43.15: guard: howl watch writes the time of day as stored with --utc", () => {
  const line = formatLine(ev("task.assigned", { task: "12", actor: person, to: agent }), false, true);
  assert.match(line, /^2026-11-16T09:01:00Z\s+observed\s/);
});

// ---- R43.17: the line about the writer ----

const writer = (oldest: number, now: number) => writingLine("example", { writer: true, waiting: 2, oldest } as any, now);

test("R43.17: the line about events that waited for the writer writes its span with duration", () => {
  const now = T0 + 10 * HOUR;
  assert.match(writer(now - (HOUR + 5 * MIN), now)!, /waited for the writer for 1 h 05 min\./);
  assert.match(writer(now - (5 * HOUR + 40 * MIN), now)!, /waited for the writer for 5 h 40 min\./);
});

test("R43.17: guard: a span of 7 minutes reads `for 7 min`, rounded down", () => {
  const now = T0 + HOUR;
  assert.match(writer(now - (7 * MIN + 50_000), now)!, /waited for the writer for 7 min\./);
});

test("R43.17: writing-text.ts keeps no division by a minute", () => {
  srcDoesNotMatch(source("src/read/writing-text.ts"), /\/\s*60_?000/);
});

// Kept as a reference for the type: the figure the overview's lead time comes from is still milliseconds.
test("R43.7: guard: the lead time of the figures is a number of milliseconds", () => {
  const figures = keyFigures([], T0);
  assert.ok(figures.leadTimeMedianMs === null || typeof figures.leadTimeMedianMs === "number");
});
