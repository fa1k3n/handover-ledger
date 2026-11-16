// A change that is asked for is shown alone, and the other changes of its task are named: the tests of issue #117.
// The case is one task with one branch and two changes: the first is reviewed and merged, the second is opened
// after that, has no review and is merged.
// @code_class tests
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { hashFor, otherChangeLinks, sessionText } from "../src/dashboard/format.ts";
import { readTar } from "../src/export/tar.ts";
import { openLedger } from "../src/ledger/ledger.ts";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { parseAsked, render, show, type Shown } from "../src/read/show.ts";
import { startServer } from "../src/serve/server.ts";
import { folder, howl, PROJECT, rawLines } from "./helpers.ts";

const T0 = Date.UTC(2026, 10, 14, 9, 0, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const BRANCH = "issue-40-one-reader";
const SHA = { a: "a".repeat(40), b: "b".repeat(40), c: "c".repeat(40), d: "d".repeat(40) };
const person = { kind: "person" as const, id: "person-0a0a0a0a" };
const agent = { kind: "agent" as const, id: "agent-1" };

let n = 0;
function observed(type: LedgerEvent["type"], minute: number, extra: Partial<LedgerEvent> = {}): LedgerEvent {
  return { v: 0, id: `ev-${++n}`, time: at(minute), type, source: { adapter: "github", kind: "observed" }, project: PROJECT, ...extra };
}
/** A session's own event: claimed, with the branch of its checkout and no change. */
function hook(type: LedgerEvent["type"], minute: number, session: string, extra: Partial<LedgerEvent> = {}): LedgerEvent {
  return { v: 0, id: `ev-${++n}`, time: at(minute), type, source: { adapter: "claude-code-hook", kind: "claimed" }, project: PROJECT, actor: agent, session, branch: BRANCH, ...extra };
}
const of = (change: string, sha: string) => ({ task: "40", change, branch: BRANCH, sha });
const byTime = (events: LedgerEvent[]) => [...events].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

/** Task 40 on one branch: change 63 is reviewed and merged at 30; change 65 is opened at 60 and merged at 90. */
function base(): LedgerEvent[] {
  return [
    observed("task.opened", 0, { task: "40", actor: person }),
    observed("task.assigned", 1, { task: "40", actor: agent }),
    observed("change.opened", 10, { ...of("63", SHA.a), actor: agent }),
    observed("checks.passed", 12, of("63", SHA.a)),
    observed("review.approved", 20, { ...of("63", SHA.a), actor: person }),
    observed("change.merged", 30, { ...of("63", SHA.a), actor: person }),
    observed("change.opened", 60, { ...of("65", SHA.b), actor: agent }),
    observed("checks.passed", 62, of("65", SHA.b)),
    observed("change.merged", 90, { ...of("65", SHA.b), actor: person }),
    observed("task.closed", 95, { task: "40", actor: person }),
  ];
}

const ask = (events: LedgerEvent[], what: string): Shown => show(byTime(events), parseAsked(what), null)!;
const sessionIds = (shown: Shown) => shown.sessions.map((s) => s.session);
const idsOf = (shown: Shown) => new Set(shown.events.map((e) => e.id));
const names = (shown: Shown, change: string) => shown.events.filter((e) => e.change === change);

function ledgerOf(events: LedgerEvent[]): string {
  const path = join(folder(), "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  for (const e of byTime(events)) writer.append(e);
  writer.close();
  return path;
}

test("asked for the second change: its part alone, no review round, its own merge, the first is named, the task's opening is the hand-over", () => {
  const shown = ask(base(), "change:65");
  assert.equal(shown.asked, "change");
  assert.equal(shown.task, "40");
  assert.deepEqual(shown.changes.map((c) => c.change), ["65"]);
  assert.deepEqual(shown.reviews, []);
  assert.deepEqual(shown.end, { state: "merged", time: at(90), actor: person });
  assert.deepEqual(shown.changes[0]!.end, shown.end);
  assert.deepEqual(shown.otherChanges, ["63"]);
  assert.deepEqual(names(shown, "63"), [], "no event that names the first change");
  assert.ok(shown.events.some((e) => e.type === "task.opened"), "the task's opening");
  assert.deepEqual(shown.handover, [{ time: at(1), actor: agent, kind: "observed" }]);
  // Nothing of the first change under another name either: its checks sit on its own head.
  assert.ok(!shown.events.some((e) => e.sha === SHA.a));
});

test("asked for the first change: its review and its merge, nothing of the second", () => {
  const shown = ask(base(), "change:63");
  assert.deepEqual(shown.changes.map((c) => c.change), ["63"]);
  assert.equal(shown.reviews.length, 1);
  assert.equal(shown.reviews[0]!.change, "63");
  assert.equal(shown.reviews[0]!.followedBy, "change.merged");
  assert.deepEqual(shown.end, { state: "merged", time: at(30), actor: person });
  assert.deepEqual(shown.otherChanges, ["65"]);
  assert.deepEqual(names(shown, "65"), []);
  assert.ok(!shown.events.some((e) => e.sha === SHA.b));
});

test("a bare number that names no task gives what change:N gives", () => {
  const events = base();
  assert.deepEqual(ask(events, "65"), ask(events, "change:65"));
  assert.equal(ask(events, "65").asked, "change");
  // A number that names a task is the task, as before.
  assert.equal(ask(events, "40").asked, "task");
});

test("asked for the task: both changes, each with its own end; each round names its change", () => {
  const shown = ask(base(), "task:40");
  assert.equal(shown.asked, "task");
  assert.deepEqual(shown.otherChanges, []);
  assert.deepEqual(shown.changes.map((c) => [c.change, c.end.state]), [["63", "merged"], ["65", "merged"]]);
  assert.deepEqual(shown.changes.map((c) => (c.end.state === "merged" ? c.end.time : null)), [at(30), at(90)]);

  const reviewed = [...base(), observed("review.commented", 70, { ...of("65", SHA.b), actor: person })];
  const rounds = ask(reviewed, "task:40").reviews;
  assert.deepEqual(rounds.map((r) => r.change), ["63", "65"]);
  const text = render(ask(reviewed, "task:40"), { utc: true });
  assert.match(text, /round 1 of change 63: /);
  assert.match(text, /round 1 of change 65: /);
});

test("reviews on two changes of one task: the rounds are counted per change, and a head of one ends no round of the other", () => {
  const two = (change: string, branch: string, sha: string) => ({ task: "40", change, branch, sha });
  const events = [
    observed("change.opened", 0, two("63", "one", SHA.a)),
    observed("change.opened", 1, two("65", "two", SHA.b)),
    observed("review.commented", 2, { ...two("63", "one", SHA.a), actor: person }),
    observed("change.updated", 3, two("65", "two", SHA.c)),
    observed("review.approved", 4, { ...two("63", "one", SHA.a), actor: person }),
    observed("review.changes_requested", 5, { ...two("65", "two", SHA.c), actor: person }),
    observed("change.updated", 6, two("65", "two", SHA.d)),
    observed("review.approved", 7, { ...two("65", "two", SHA.d), actor: person }),
  ];
  const shown = ask(events, "task:40");
  assert.deepEqual(
    shown.reviews.map((r) => [r.change, r.reviews.map((x) => x.outcome), r.followedBy]),
    [
      ["63", ["commented", "approved"], null],
      ["65", ["changes_requested"], "change.updated"],
      ["65", ["approved"], null],
    ],
  );
  assert.equal(shown.summary.reviewRounds, 3);
  const text = render(shown, { utc: true });
  assert.match(text, /round 1 of change 63: .*commented, .*approved/);
  assert.match(text, /round 1 of change 65: .*changes requested; followed by a new head/);
  assert.match(text, /round 2 of change 65: .*approved/);
});

test("a view with one change reads as today, apart from the heading of a change that was asked for", () => {
  const events = base().filter((e) => e.change !== "65");
  const task = render(ask(events, "task:40"), { utc: true }).split("\n");
  const change = render(ask(events, "change:63"), { utc: true }).split("\n");
  assert.equal(task[0], "Task 40: merged");
  assert.equal(change[0], "Change 63 of task 40: merged");
  assert.ok(!change.some((l) => /has (another|other) change/.test(l)), "no line of other changes when there are none");
  // The task's closing is not under End for a change; the rest is the same.
  const rest = (lines: string[]) => lines.slice(1).filter((l) => !/task closed/.test(l));
  assert.deepEqual(rest(change), rest(task));
  assert.ok(!task.join("\n").includes("round 1 of change"), "a single change names no change in its rounds");
  assert.match(task.join("\n"), /round 1: /);
});

test("the heading of a change with no task is Change N", () => {
  const lone = [observed("change.opened", 0, { change: "70", branch: "solo", sha: SHA.a }), observed("change.merged", 5, { change: "70", branch: "solo", sha: SHA.a, actor: person })];
  const shown = ask(lone, "change:70");
  assert.equal(shown.task, undefined);
  assert.deepEqual(shown.otherChanges, []);
  assert.equal(render(shown, { utc: true }).split("\n")[0], "Change 70: merged");
});

test("the text names the other change in one line", () => {
  const text = render(ask(base(), "change:65"), { utc: true });
  assert.equal(text.split("\n").filter((l) => /^Task 40 has another change: 63$/.test(l)).length, 1, text);
  const three = [...base(), observed("change.opened", 100, { ...of("66", SHA.c), actor: agent })];
  assert.match(render(ask(three, "change:65"), { utc: true }), /^Task 40 has other changes: 63, 66$/m);
});

test("a session that names the second change is in its view and not in the first's", () => {
  // At minute 20 the first change is alive; the name decides, not the time.
  const events = [...base(), hook("session.started", 20, "named", { change: "65" }), hook("session.ended", 25, "named", { change: "65" })];
  assert.deepEqual(sessionIds(ask(events, "change:65")), ["named"]);
  assert.deepEqual(sessionIds(ask(events, "change:63")), []);
  assert.ok(!ask(events, "change:63").events.some((e) => e.session === "named"));
});

test("a session that names only the branch is placed by time: before the first end, between the ends, after both", () => {
  const run = (session: string, from: number, to: number) => [
    hook("session.started", from, session),
    hook("tool.used", from + 1, session, { data: { tool: "Edit", target: "a.ts", outcome: "succeeded" } }),
    hook("session.ended", to, session),
  ];
  const events = [...base(), ...run("early", 12, 25), ...run("between", 35, 50), ...run("late", 92, 94)];
  const first = ask(events, "change:63");
  const second = ask(events, "change:65");
  const task = ask(events, "task:40");
  assert.deepEqual(sessionIds(first), ["early"]);
  assert.deepEqual(sessionIds(second), ["between"]);
  assert.deepEqual(sessionIds(task).sort(), ["between", "early", "late"]);
  assert.ok(!first.events.some((e) => e.session === "between" || e.session === "late"));
  assert.ok(!second.events.some((e) => e.session === "early" || e.session === "late"));
  // A session wholly inside one change's life does not name the other.
  assert.equal(first.sessions[0]!.also, undefined);
  assert.equal(second.sessions[0]!.also, undefined);
});

test("a session that works on across the end of the first change is in both views, each with its own start, end and also", () => {
  const events = [
    ...base(),
    hook("session.started", 25, "across"),
    hook("tool.used", 28, "across", { data: { tool: "Edit", target: "a.ts", outcome: "succeeded" } }),
    hook("agent.waiting", 29, "across", { data: { notification_type: "idle_prompt" } }),
    hook("tool.used", 40, "across", { data: { tool: "Edit", target: "b.ts", outcome: "succeeded" } }),
    hook("tool.used", 80, "across", { data: { tool: "Read", target: "c.ts", outcome: "succeeded" } }),
    hook("session.ended", 85, "across"),
  ];
  const first = ask(events, "change:63");
  const second = ask(events, "change:65");
  const [a] = first.sessions;
  const [b] = second.sessions;
  assert.equal(first.sessions.length, 1);
  assert.equal(second.sessions.length, 1);
  assert.equal(a!.start, at(25));
  assert.equal(a!.end, at(29), "its last event there");
  assert.deepEqual(a!.files, ["a.ts"]);
  assert.deepEqual(a!.also, ["65"]);
  assert.equal(b!.start, at(40), "its first event there");
  assert.equal(b!.end, at(85));
  assert.deepEqual(b!.files, ["b.ts", "c.ts"]);
  assert.deepEqual(b!.also, ["63"]);
  // The wait is the first part's, and it lasts until the session's next event, in the second part.
  assert.deepEqual(a!.waits.map((w) => [w.time, w.seconds]), [[at(29), 11 * 60]]);
  assert.deepEqual(b!.waits, []);
  // The text says it, and the dashboard line too.
  assert.match(render(first, { utc: true }), /also under change 65/);
  assert.match(render(second, { utc: true }), /also under change 63/);
  assert.match(sessionText(a!), /also under change 65/);
  // The task has the whole session once, with no also.
  const whole = ask(events, "task:40").sessions;
  assert.equal(whole.length, 1);
  assert.equal(whole[0]!.start, at(25));
  assert.equal(whole[0]!.end, at(85));
  assert.equal(whole[0]!.also, undefined);
});

test("a task that was given to someone, with two changes: the first is measured from the hand-over, the second from its own first event", () => {
  const events = base();
  const first = ask(events, "change:63").summary;
  const second = ask(events, "change:65").summary;
  assert.equal(first.from, at(1));
  assert.equal(first.to, at(30));
  assert.equal(second.from, at(60), "its own first event, not the hand-over");
  assert.equal(second.to, at(90));
  assert.equal(second.seconds, 30 * 60);
  const sum = (s: Shown["summary"]) => Object.values(s.parts).reduce((a, b) => a + b, 0);
  assert.equal(sum(second), second.seconds);
  assert.equal(sum(first), first.seconds);
  assert.equal(second.reviewRounds, 0);
  assert.equal(first.reviewRounds, 1);
  assert.match(render(ask(events, "change:63"), { utc: true }), /hand-over to the end: /);
  assert.match(render(ask(events, "change:65"), { utc: true }), /first event to the end: /);
  // A session that worked between the two ends is the second's own first event.
  const worked = [...events, hook("session.started", 40, "between"), hook("session.ended", 50, "between")];
  assert.equal(ask(worked, "change:65").summary.from, at(40));
  // The task as a whole is from the hand-over, as before.
  assert.equal(ask(events, "task:40").summary.from, at(1));
});

test("in the view of a change, the task's closing is not under End; for the task it is, as before", () => {
  const lines = render(ask(base(), "change:65"), { utc: true }).split("\n");
  const end = lines.indexOf("End");
  const summary = lines.indexOf("Summary");
  const under = lines.slice(end + 1, summary).filter(Boolean);
  assert.equal(under.length, 1, under.join("\n"));
  assert.match(under[0]!, /observed {2}merged by person-0a0a0a0a/);
  const closing = lines.findIndex((l) => /task closed by/.test(l));
  assert.ok(closing > lines.indexOf("Hand-over") && closing < lines.indexOf("Sessions"), "with the task's opening and giving");
  const task = render(ask(base(), "task:40"), { utc: true }).split("\n");
  const closingOfTask = task.findIndex((l) => /task closed by/.test(l));
  assert.ok(closingOfTask > task.indexOf("End"), "the task's own view keeps it under End");
});

test("a claim of a change or a review adds nothing to otherChanges", () => {
  const claim = (type: LedgerEvent["type"], change: string) => ({
    ...hook(type, 5, "someone", { task: "40", change }),
    source: { adapter: "emit", kind: "claimed" as const },
  });
  const events = [...base(), claim("review.commented", "99"), claim("change.opened", "98")];
  assert.deepEqual(ask(events, "change:65").otherChanges, ["63"]);
  assert.deepEqual(ask(events, "change:63").otherChanges, ["65"]);
  assert.deepEqual(ask(events, "task:40").changes.map((c) => c.change), ["63", "65"]);
  // The claim names another change: it is not shown in this one.
  assert.deepEqual(ask(events, "change:65").claimed, []);
});

test("howl export --change of the second change selects no line that names the first, and the bundle passes its own check", () => {
  const events = [...base(), hook("session.started", 40, "between"), hook("session.ended", 50, "between"), hook("session.started", 12, "early"), hook("session.ended", 14, "early")];
  const ledger = ledgerOf(events);
  const out = join(folder(), "bundle.tar.gz");
  const run = howl(["export", "--ledger", ledger, "--change", "65", "--out", out]);
  assert.equal(run.status, 0, run.stderr);
  const files = readTar(readFileSync(out));
  const selection = JSON.parse(files.get("selection.json")!.toString()) as { asked: string; lines: number[] };
  assert.equal(selection.asked, "change:65");
  const lines = rawLines(ledger).map((l) => (JSON.parse(l) as { event: LedgerEvent }).event);
  const selected = selection.lines.map((i) => lines[i - 1]!);
  assert.ok(selected.length > 0);
  for (const e of selected) {
    assert.notEqual(e.change, "63", `${e.type} names the first change`);
    assert.notEqual(e.sha, SHA.a, `${e.type} sits on the first change's head`);
    assert.notEqual(e.session, "early");
  }
  assert.ok(selected.some((e) => e.change === "65"));
  assert.ok(selected.some((e) => e.session === "between"));
  const timeline = JSON.parse(files.get("timeline.json")!.toString()) as Shown;
  assert.deepEqual(timeline.changes.map((c) => c.change), ["65"]);
  assert.deepEqual(timeline.otherChanges, ["63"]);
  const verified = howl(["verify", "--bundle", out]);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  // The task is as before: both changes.
  const taskOut = join(folder(), "task.tar.gz");
  assert.equal(howl(["export", "--ledger", ledger, "--task", "40", "--out", taskOut]).status, 0);
  const whole = JSON.parse(readTar(readFileSync(taskOut)).get("selection.json")!.toString()) as { lines: number[] };
  assert.ok(whole.lines.length > selection.lines.length);
});

test("/api/show gives what howl show --json gives, for the second change", async () => {
  const ledger = ledgerOf(base());
  const server = await startServer({ ledger, port: 0, root: folder() });
  try {
    const body = await (await fetch(`${server.url}/api/show?what=change:65`)).json();
    const run = howl(["show", "change:65", "--ledger", ledger, "--json"]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(body, JSON.parse(run.stdout));
    assert.equal(body.asked, "change");
    assert.deepEqual(body.otherChanges, ["63"]);
  } finally {
    await server.close();
  }
});

test("the Change tab's line for the other changes: a link to each, and to the task, from the function that makes it", () => {
  const line = otherChangeLinks("40", ["63", "66"], "example");
  assert.deepEqual(line.task, { label: "Task 40", href: hashFor("change", "example", "task:40") });
  assert.deepEqual(line.changes, [
    { label: "63", href: hashFor("change", "example", "change:63") },
    { label: "66", href: hashFor("change", "example", "change:66") },
  ]);
  assert.deepEqual(otherChangeLinks("40", ["63"], null).changes, [{ label: "63", href: hashFor("change", null, "change:63") }]);
});

test("a session event that holds the first change's head after its merge is of the second change, by its time", () => {
  const tool = (minute: number, session: string, sha: string) => hook("tool.used", minute, session, { sha, data: { tool: "Edit", target: `${minute}.ts`, outcome: "succeeded" } });
  const events = [
    ...base(),
    hook("session.started", 25, "head", { sha: SHA.a }),
    tool(28, "head", SHA.a), // inside the first change's life: its commit and its time agree
    tool(40, "head", SHA.a), // after the first merge, the checkout still holds the first head
    tool(50, "head", SHA.a),
    tool(70, "head", SHA.b),
    hook("session.ended", 75, "head", { sha: SHA.b }),
  ];
  const first = ask(events, "change:63");
  const second = ask(events, "change:65");
  assert.deepEqual(first.sessions[0]!.files, ["28.ts"]);
  assert.equal(first.sessions[0]!.end, at(28));
  assert.deepEqual(second.sessions[0]!.files, ["40.ts", "50.ts", "70.ts"]);
  assert.equal(second.sessions[0]!.start, at(40));
  assert.ok(!first.events.some((e) => e.sha === SHA.a && Date.parse(e.time) > Date.parse(at(30)) && e.session !== undefined));
  assert.deepEqual(first.sessions[0]!.also, ["65"]);
  assert.deepEqual(second.sessions[0]!.also, ["63"]);
  // A branch with one change is as today: its commit places the event whatever the time.
  const alone = base().filter((e) => e.change !== "65");
  const late = [...alone, hook("session.started", 40, "late", { sha: SHA.a }), hook("session.ended", 45, "late", { sha: SHA.a })];
  assert.deepEqual(sessionIds(ask(late, "change:63")), ["late"]);
});

test("two changes open at once on one branch: the earlier one's life for placing ends where the later one's starts", () => {
  // A guess the view makes: 63 is still open, and under review, at minute 25, but the session's events there are 65's.
  const events = [
    observed("change.opened", 10, { ...of("63", SHA.a), actor: agent }),
    observed("change.opened", 20, { ...of("65", SHA.b), actor: agent }),
    observed("review.commented", 27, { ...of("63", SHA.a), actor: person }),
    observed("change.merged", 30, { ...of("63", SHA.a), actor: person }),
    observed("change.merged", 50, { ...of("65", SHA.b), actor: person }),
    hook("session.started", 15, "before"),
    hook("session.ended", 18, "before"),
    hook("session.started", 22, "overlap"),
    hook("session.ended", 25, "overlap"),
  ];
  assert.deepEqual(sessionIds(ask(events, "change:63")), ["before"]);
  assert.deepEqual(sessionIds(ask(events, "change:65")), ["overlap"]);
});

test("the same events in another order give the same views", () => {
  const tool = (minute: number, session: string, extra: Partial<LedgerEvent> = {}) => hook("tool.used", minute, session, { data: { tool: "Edit", target: `${minute}.ts`, outcome: "succeeded" }, ...extra });
  const events = byTime([
    ...base(),
    hook("session.started", 25, "across"),
    tool(28, "across", { sha: SHA.a }),
    hook("agent.waiting", 29, "across", { data: { notification_type: "idle_prompt" } }),
    tool(40, "across", { sha: SHA.a }),
    tool(80, "across", { sha: SHA.b }),
    hook("session.ended", 85, "across"),
    hook("session.started", 13, "early"),
    hook("session.ended", 14, "early"),
    hook("session.started", 35, "between"),
    hook("session.ended", 50, "between"),
    hook("session.started", 92, "late"),
    // An event with no branch rides with the branch its session was last on.
    hook("agent.waiting", 93, "late", { branch: undefined, data: { notification_type: "idle_prompt" } }),
  ]);
  const shuffled = events.map((e, i) => ({ e, k: (i * 7919) % 31 })).sort((a, b) => a.k - b.k).map((x) => x.e);
  for (const order of [[...events].reverse(), shuffled]) {
    assert.notDeepEqual(order, events);
    for (const what of ["change:63", "change:65"]) {
      assert.deepEqual(show(order, parseAsked(what), null), show(events, parseAsked(what), null), what);
    }
  }
});
