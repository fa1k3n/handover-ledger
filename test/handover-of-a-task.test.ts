// #120: the giving of a task is a handover, a row of the overview from the one who gave it to the one who got it.
// The care: rows of events written before #45, a giving taken back, and the key figures left alone.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { handoverKey, handoverLink, takenBackText } from "../src/dashboard/format.ts";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { handovers, keyFigures } from "../src/read/overview.ts";
import { PROJECT } from "./helpers.ts";

const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const person = { kind: "person" as const, id: "person-0a0a0a0a" };
const other = { kind: "person" as const, id: "person-0b0b0b0b" };
const agent = { kind: "agent" as const, id: "agent-1" };
const second = { kind: "agent" as const, id: "agent-2" };

let n = 0;
function event(type: string, minute: number, extra: Record<string, unknown> = {}, kind: "observed" | "claimed" = "observed"): LedgerEvent {
  return { v: 0, id: `ev-${++n}`, time: at(minute), type, source: { adapter: kind === "observed" ? "github" : "claude-code-hook", kind }, project: PROJECT, ...extra } as LedgerEvent;
}
const items = (events: LedgerEvent[]) => events.map((e, i) => ({ event: e, hash: `h${i}` }));
const given = (minute: number, by: unknown, to: unknown, extra: Record<string, unknown> = {}) => event("task.assigned", minute, { task: "40", actor: by, to, ...extra });

test("#120: a task opened by a person and given to an agent is one row, from the person to the agent, with the task and no change", () => {
  const rows = handovers(items([event("task.opened", 0, { task: "40", actor: person }), given(1, person, agent)]));
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.step, "Task → implementation");
  assert.equal(row.from, person.id);
  assert.equal(row.to, agent.id);
  assert.equal(row.task, "40");
  assert.equal(row.change, undefined);
  assert.equal(row.hash, "h1");
  assert.equal(row.time, at(1));
});

test("#120: then a change that is reviewed and merged: the row of the task is the oldest", () => {
  const of = { task: "40", change: "7" };
  const rows = handovers(
    items([
      given(1, person, agent),
      event("change.opened", 5, { ...of, actor: agent }),
      event("review.approved", 8, { ...of, actor: second }),
      event("change.merged", 9, { ...of, actor: other }),
    ]),
  );
  assert.deepEqual(
    rows.map((r) => r.step),
    ["Review → merge", "Implementation → review", "Task → implementation"],
  );
  assert.equal(rows.at(-1)!.change, undefined);
  assert.equal(rows[0]!.change, "7");
});

test("#120: a claimed task.assigned gives no row (#51)", () => {
  assert.deepEqual(handovers(items([event("task.assigned", 1, { task: "40", actor: person, to: agent }, "claimed")])), []);
});

test("#120: a task that someone gives to themself gives no row", () => {
  assert.deepEqual(handovers(items([given(1, agent, agent)])), []);
  // The same id of another kind is another member.
  assert.equal(handovers(items([given(1, { kind: "person", id: "x" }, { kind: "agent", id: "x" })])).length, 1);
});

test("#120: an event from before #45, with no `to`: a row to its actor, the giver not recorded", () => {
  const rows = handovers(items([event("task.assigned", 1, { task: "40", actor: agent })]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.from, "not recorded");
  assert.equal(rows[0]!.to, agent.id);
  assert.equal(rows[0]!.step, "Task → implementation");
});

test("#120: a giving whose giver the host did not name (`to` and no actor): a row to the receiver, the giver not recorded", () => {
  const rows = handovers(items([event("task.assigned", 1, { task: "40", to: agent })]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.from, "not recorded");
  assert.equal(rows[0]!.to, agent.id);
});

test("#120: a task given to one, taken back and given to another: two rows, in the order of time, newest first", () => {
  const rows = handovers(items([given(1, person, agent), event("task.unassigned", 2, { task: "40", actor: person, to: agent }), given(3, person, second)]));
  assert.deepEqual(
    rows.map((r) => `${r.from} → ${r.to}`),
    [`${person.id} → ${second.id}`, `${person.id} → ${agent.id}`],
  );
  // The taking back is no row of its own.
  assert.equal(rows.length, 2);
});

test("#120: a giving that was taken back is marked, with when; the later giving is not", () => {
  const rows = handovers(items([given(1, person, agent), event("task.unassigned", 2, { task: "40", actor: person, to: agent }), given(3, person, second)]));
  assert.equal(rows[0]!.takenBack, undefined);
  assert.equal(rows[1]!.takenBack, at(2));
  assert.equal(takenBackText(rows[0]!, T0), null);
  assert.match(takenBackText(rows[1]!, T0 + 3 * 60_000)!, /taken back/);
});

test("#120: a task given to the same one again after a taking back is two rows, each taking back marks one giving", () => {
  const rows = handovers(items([given(1, person, agent), event("task.unassigned", 2, { task: "40", actor: person, to: agent }), given(3, person, agent)]));
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.takenBack, at(2));
  assert.equal(rows[0]!.takenBack, undefined);
});

test("#120: a claim of a taking back marks nothing", () => {
  const rows = handovers(items([given(1, person, agent), event("task.unassigned", 2, { task: "40", actor: person, to: agent }, "claimed")]));
  assert.equal(rows[0]!.takenBack, undefined);
});

test("#120: a giving to an account that no longer exists, and one by such an account: a row each, with no pseudonym made", () => {
  const toGone = event("task.assigned", 1, { task: "40", actor: person, data: { to_account_removed: true } });
  const byGone = event("task.assigned", 2, { task: "41", to: agent, data: { account_removed: true } });
  const byGone2 = event("task.assigned", 3, { task: "42", to: agent, data: { account_removed: true } });
  const rows = handovers(items([toGone, byGone, byGone2]));
  assert.equal(rows.length, 3);
  const [c, b, a] = rows;
  assert.equal(a!.from, person.id);
  assert.equal(a!.to, "someone");
  assert.equal(b!.from, "someone");
  assert.equal(b!.to, agent.id);
  assert.equal(c!.from, "someone");
  assert.ok(!JSON.stringify(rows).includes("person-0") || JSON.stringify(rows).split("person-0").length === 2);
  // Two of them are never one row, whatever the key.
  assert.notEqual(handoverKey(b!), handoverKey(c!));
});

test("#120: the key figures are what they were: a row of a task counts in none of them", () => {
  const of = { task: "40", change: "7" };
  const base = [event("change.opened", 5, { ...of, actor: agent }), event("review.approved", 8, { ...of, actor: second }), event("change.merged", 9, { ...of, actor: other })];
  const withTask = [given(1, person, agent), event("task.unassigned", 2, { task: "40", actor: person, to: agent }), given(3, person, second), ...base];
  assert.deepEqual(keyFigures(withTask, T0 + 3600_000), keyFigures(base, T0 + 3600_000));
  // A task given and no change: nothing is open.
  assert.equal(keyFigures([given(1, person, agent)], T0 + 3600_000).open, 0);
});

test("#120: the repeats of a reviewer are still folded with a row of a task between", () => {
  const of = { task: "40", change: "7" };
  const rows = handovers(
    items([event("change.opened", 5, { ...of, actor: agent }), event("review.commented", 6, { ...of, actor: second }), given(7, person, agent, { task: "41" }), event("review.commented", 8, { ...of, actor: second })]),
  );
  const review = rows.filter((r) => r.step === "Implementation → review");
  assert.equal(review.length, 1);
  assert.equal(review[0]!.n, 2);
  assert.equal(rows.length, 2);
});

test("#120: the model and the effort are those of the agent who hands over; a person has none", () => {
  const session = event("session.started", 0, { actor: agent, model: "sonnet", effort: "medium" }, "claimed");
  const rows = handovers(items([session, given(1, agent, second), given(2, person, agent, { task: "41" })]));
  const byAgent = rows.find((r) => r.from === agent.id)!;
  assert.equal(byAgent.model, "sonnet");
  assert.equal(byAgent.effort, "medium");
  const byPerson = rows.find((r) => r.from === person.id)!;
  assert.equal(byPerson.model, undefined);
  assert.equal(byPerson.effort, undefined);
});

test("#120: the dashboard's link of a row is the task's view for a row of a task and the change's for the others", () => {
  const [task] = handovers(items([given(1, person, agent)]));
  assert.equal(handoverLink(task!, "p"), "#change?project=p&what=task%3A40");
  const [review] = handovers(items([event("change.opened", 0, { change: "7", task: "40", actor: agent }), event("review.approved", 1, { change: "7", task: "40", actor: second })]));
  assert.equal(handoverLink(review!, "p"), "#change?project=p&what=change%3A7");
  assert.equal(handoverLink(review!, null), "#change?what=change%3A7");
});

test("#120: the key of a row differs between a task row and a change row at the same time and hash", () => {
  const a = { time: "t", from: "a", to: "b", step: "Task → implementation" as const, task: "1" };
  const b = { time: "t", from: "a", to: "b", step: "Implementation → review" as const, change: "1" };
  assert.notEqual(handoverKey(a), handoverKey(b));
});

test("#120: no figure is given per person: a row holds no count, whoever the person is", () => {
  const rows = handovers(items([given(1, person, agent), given(2, person, second, { task: "41" })]));
  for (const row of rows) assert.equal(row.n, undefined);
  assert.deepEqual(Object.keys(keyFigures([given(1, person, agent)], T0)).sort(), Object.keys(keyFigures([], T0)).sort());
});
