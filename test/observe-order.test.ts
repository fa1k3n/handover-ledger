// #112: events of one moment are written in the order they can happen in.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { happensBefore } from "../src/observe/order.ts";
import { folder, howl, lines, PROJECT, workspace, type Workspace } from "./helpers.ts";
import { at, LocalHost, SHA } from "./local-host.ts";

function setup(): { ws: Workspace; host: LocalHost } {
  const dir = folder();
  const ws = workspace({ yml: `project: ${PROJECT}\nhost: local\nlocal: ${dir}\nrepository: team/product\nagents: [agent-bot]\n` });
  return { ws, host: new LocalHost(dir) };
}
const lead = { login: "lead" };
const agent = { login: "agent-bot" };
const reviewer = { login: "reviewer" };

/** Runs one round and gives the types of the lines it wrote, in the order of the ledger, with what each concerns. */
function round(s: { ws: Workspace }): string[] {
  const run = howl(["observe", "--once"], { cwd: s.ws.root, env: s.ws.env });
  assert.equal(run.status, 0, run.stderr);
  return lines(s.ws.ledger)
    .slice(1)
    .map((l) => `${l.event.type} ${l.event.task ?? ""}/${l.event.change ?? ""}`.trim());
}

test("#112: a task opened and given in the same second is opened first, and closed last", () => {
  const s = setup();
  s.host.task({ number: 21, openedAt: at(10), openedBy: lead, assignments: [{ id: "a1", assignee: agent, at: at(10) }], updatedAt: at(10) });
  assert.deepEqual(round(s), ["task.opened 21/", "task.assigned 21/"]);

  const all = setup();
  all.host.task({ number: 7, openedAt: at(10), openedBy: lead, assignments: [{ id: "a1", assignee: agent, at: at(10) }], closedAt: at(10), closedBy: lead, updatedAt: at(10) });
  assert.deepEqual(round(all), ["task.opened 7/", "task.assigned 7/", "task.closed 7/"]);
});

test("#112: a change opened, checked, reviewed and merged in the same second is written in that order", () => {
  const s = setup();
  s.host
    .change({
      number: 40,
      branch: "work",
      openedAt: at(20),
      openedBy: agent,
      head: { sha: SHA.a, at: at(20) },
      tasks: [],
      reviews: [
        { id: "r2", by: reviewer, state: "approved", at: at(20), sha: SHA.a },
        { id: "r1", by: reviewer, state: "changes_requested", at: at(20), sha: SHA.a },
      ],
      mergedAt: at(20),
      mergedBy: lead,
      updatedAt: at(20),
    })
    .checks(SHA.a, "passed", at(20));
  assert.deepEqual(round(s), ["change.opened /40", "checks.passed /40", "review.changes_requested /40", "review.approved /40", "change.merged /40"]);
});

test("#112: events of different times keep the order of their times, whatever their types", () => {
  const s = setup();
  s.host.task({ number: 3, openedAt: at(30), openedBy: lead, assignments: [{ id: "a1", assignee: agent, at: at(5) }], closedAt: at(1), closedBy: lead, updatedAt: at(30) });
  assert.deepEqual(round(s), ["task.closed 3/", "task.assigned 3/", "task.opened 3/"], "the host's times are the record, also when they read oddly");
});

test("#112: the order is one function: by time, then by what can happen first, then by the id", () => {
  const e = (type: string, time: string, id: string) => ({ type, time, id });
  const sorted = (events: { type: string; time: string; id: string }[]) => [...events].sort(happensBefore).map((x) => x.id);
  assert.deepEqual(sorted([e("task.assigned", at(1), "a"), e("task.opened", at(1), "z")]), ["z", "a"]);
  assert.deepEqual(sorted([e("task.opened", at(2), "a"), e("task.assigned", at(1), "z")]), ["z", "a"], "the time comes first");
  assert.deepEqual(sorted([e("task.assigned", at(1), "b"), e("task.assigned", at(1), "a")]), ["a", "b"], "two of one type at one time come by their id");
  assert.deepEqual(sorted([e("observe.started", at(1), "a"), e("task.closed", at(1), "z")]), ["z", "a"], "a type with no place of its own comes last");
  const story = ["task.opened", "task.assigned", "change.opened", "change.updated", "config.changed", "checks.passed", "change.commented", "review.approved", "change.merged", "change.closed", "task.closed"];
  assert.deepEqual(
    sorted([...story].reverse().map((type, i) => e(type, at(1), `id-${String(i).padStart(2, "0")}`))).map((id) => story[story.length - 1 - Number(id.slice(3))]),
    story,
  );
});

test("#112: a second round over the same state appends nothing", () => {
  const s = setup();
  s.host.task({ number: 21, openedAt: at(10), openedBy: lead, assignments: [{ id: "a1", assignee: agent, at: at(10) }], updatedAt: at(10) });
  const first = round(s);
  assert.deepEqual(round(s), first);
});

test("#112: times are compared by the instant they mean, not as texts", () => {
  const e = (type: string, time: string, id: string) => ({ type, time, id });
  const first = (a: ReturnType<typeof e>, b: ReturnType<typeof e>) => [a, b].sort(happensBefore)[0]!.id;
  assert.equal(first(e("task.assigned", "2026-01-01T10:00:10.000Z", "a"), e("task.opened", "2026-01-01T10:00:10Z", "z")), "z", "with and without milliseconds is one moment: opened first");
  assert.equal(first(e("task.opened", "2026-01-01T10:00:10.5Z", "late"), e("task.closed", "2026-01-01T10:00:10Z", "early")), "early", "half a second later is later");
  assert.equal(first(e("task.opened", "2026-01-01T11:00:10+01:00", "early"), e("task.closed", "2026-01-01T10:00:11Z", "late")), "early", "another offset, the same clock");
});

test("#112: the reviews of one moment come by the host's ids, a number read as a number, whatever their outcome", () => {
  const e = (type: string, id: string) => ({ type, time: at(1), id });
  const sorted = (events: { type: string; time: string; id: string }[]) => [...events].sort(happensBefore).map((x) => x.id);
  assert.deepEqual(sorted([e("review.approved", "h:review:10"), e("review.changes_requested", "h:review:9")]), ["h:review:9", "h:review:10"], "9 before 10");
  assert.deepEqual(sorted([e("review.changes_requested", "h:review:12"), e("review.approved", "h:review:11")]), ["h:review:11", "h:review:12"], "an approval that came first stays first");
  assert.deepEqual(sorted([e("change.merged", "h:change:40:merged"), e("config.changed", "h:config:40:abc"), e("change.updated", "h:change:40:head:abc")]), ["h:change:40:head:abc", "h:config:40:abc", "h:change:40:merged"], "what a head holds is told with the head");
  // No two different events are equal, and the order does not depend on where the sort starts.
  const many = ["a:7", "a:07", "a:10", "a:9", "a:9:x", "b:1", "a"].map((id) => e("review.commented", id));
  const one = sorted(many);
  assert.deepEqual(sorted([...many].reverse()), one);
  assert.deepEqual(one, ["a", "a:07", "a:7", "a:9", "a:9:x", "a:10", "b:1"]);
});
