// A session names its harness and the revision it runs under: the tests of issue #129 that hold whatever the field is called.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { howl, inboxEvents, ledgerWith, workspace, type Workspace } from "./helpers.ts";

const HARNESS = "example-harness";
const REVISION = "1.4.2 3f9a0c51d7e8";

function run(ws: Workspace, env: Record<string, string>): Record<string, unknown> {
  const stdin = JSON.stringify({ session_id: "s1", cwd: ws.root, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gh pr view" } });
  const result = howl(["hook"], { cwd: ws.root, env: { ...ws.env, ...env }, input: stdin });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  return inboxEvents(ws.inbox).at(-1) as unknown as Record<string, unknown>;
}

/** The event without what differs from run to run. */
function stable(e: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, time: _time, ...rest } = e;
  return rest;
}

test("R129.1: with both HOWL_HARNESS and HOWL_HARNESS_REVISION set, the event holds the harness and the revision, marked as claimed", () => {
  const e = run(workspace(), { HOWL_HARNESS: HARNESS, HOWL_HARNESS_REVISION: REVISION });
  const text = JSON.stringify(e);
  assert.ok(text.includes(HARNESS), `the harness is on the event: ${text}`);
  assert.ok(text.includes(REVISION), `the revision is on the event: ${text}`);
  assert.deepEqual((e.source as { kind: string }).kind, "claimed");
});

test("R129.1: with only one of the two set, no event holds either", () => {
  const baseline = stable(run(workspace(), {}));
  for (const env of [{ HOWL_HARNESS: HARNESS }, { HOWL_HARNESS_REVISION: REVISION }]) {
    const e = run(workspace(), env);
    const text = JSON.stringify(e);
    assert.ok(!text.includes(HARNESS) && !text.includes(REVISION), text);
    assert.deepEqual(stable(e), baseline, JSON.stringify(env));
  }
});

test("R129.7: a session with no harness named has an event with no new field, as before", () => {
  const e = stable(run(workspace(), { HOWL_ROLE: "review" }));
  assert.deepEqual(Object.keys(e).sort(), ["actor", "data", "project", "role", "session", "source", "type", "v"]);
});

test("R129.8: a ledger written before this step still verifies", () => {
  const result = howl(["verify", "--ledger", ledgerWith(4)]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\b5 lines\b/);
});
