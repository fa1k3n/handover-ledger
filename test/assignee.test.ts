// #45: `assignee(event)`, the one reader of who a task was given to, and the schema's `to` and four new types.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { eventFaults } from "../src/ledger/schema.ts";
import { assignee } from "../src/read/assignee.ts";
import { event } from "./helpers.ts";

const agent = { kind: "agent" as const, id: "agent-1" };
const person = { kind: "person" as const, id: "person-0a0a0a0a" };
const some = (over: Record<string, unknown>) => event(over as any);

test("assignee: `to`, else for an event written before this one, `actor`", () => {
  assert.deepEqual(assignee(some({ type: "task.assigned", actor: person, to: agent })), agent);
  assert.deepEqual(assignee(some({ type: "task.assigned", actor: agent })), agent, "an old event: the actor is the receiver");
  assert.equal(assignee(some({ type: "task.assigned" })), undefined);
});

test("assignee: a giving to an account that is gone has no receiver, and the giver is not it", () => {
  assert.equal(assignee(some({ type: "task.assigned", actor: person, data: { account_removed: true } })), undefined);
  // Before this step the same case had no actor at all.
  assert.equal(assignee(some({ type: "task.assigned", data: { account_removed: true } })), undefined);
});

test("assignee: on a taking back it is the one it was taken from, never the one who took it", () => {
  assert.deepEqual(assignee(some({ type: "task.unassigned", actor: person, to: agent })), agent);
  assert.equal(assignee(some({ type: "task.unassigned", actor: person, data: { account_removed: true } })), undefined);
  assert.equal(assignee(some({ type: "task.unassigned", actor: person })), undefined);
});

test("assignee: an event that is no giving has none, whatever its actor", () => {
  assert.equal(assignee(some({ type: "change.opened", actor: agent })), undefined);
  assert.equal(assignee(some({ type: "task.opened", actor: person })), undefined);
});

test("the schema takes `to`, as a team member as `actor` is, and the four new types", () => {
  for (const type of ["task.assigned", "task.unassigned"]) assert.deepEqual(eventFaults(some({ type, actor: person, to: agent })), [], type);
  for (const type of ["task.reopened", "change.reopened", "review.dismissed"]) assert.deepEqual(eventFaults(some({ type, actor: person })), [], type);
});

test("the schema refuses a `to` that is not a team member, and a type that is not in the list", () => {
  assert.notDeepEqual(eventFaults(some({ to: "agent-1" })), []);
  assert.notDeepEqual(eventFaults(some({ to: { kind: "robot", id: "x" } })), []);
  assert.notDeepEqual(eventFaults(some({ to: { kind: "agent" } })), []);
  assert.notDeepEqual(eventFaults(some({ to: { kind: "agent", id: "x", more: 1 } })), []);
  assert.notDeepEqual(eventFaults(some({ type: "task.given" })), []);
});
