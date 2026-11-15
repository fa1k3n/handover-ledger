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
  const story = ["task.opened", "task.assigned", "change.opened", "change.updated", "checks.passed", "change.commented", "review.commented", "review.changes_requested", "review.approved", "change.merged", "change.closed", "task.closed"];
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
