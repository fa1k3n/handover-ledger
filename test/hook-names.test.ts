// A session names the change and the task it works on: the tests of issue #9.
import assert from "node:assert/strict";
import { test } from "node:test";
import { git, howl, inboxEvents, workspace, type Workspace } from "./helpers.ts";

function run(ws: Workspace, env: Record<string, string>) {
  const stdin = JSON.stringify({ session_id: "s1", cwd: ws.root, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gh pr view" } });
  const result = howl(["hook"], { cwd: ws.root, env: { ...ws.env, ...env }, input: stdin });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  return inboxEvents(ws.inbox).at(-1)!;
}

test("#9: with HOWL_CHANGE and HOWL_TASK set, the event carries change and task", () => {
  const e = run(workspace(), { HOWL_CHANGE: "327", HOWL_TASK: "295" });
  assert.equal(e.change, "327");
  assert.equal(e.task, "295");
});

test("#9: without them the event is as before: no change, no task", () => {
  const e = run(workspace(), {});
  assert.equal(e.change, undefined);
  assert.equal(e.task, undefined);
});

test("#9: they name the work even on the default branch of a separate folder; the branch stays as the folder has it", () => {
  const ws = workspace();
  git(ws.root, "init", "-q");
  git(ws.root, "commit", "-q", "--allow-empty", "-m", "x");
  const e = run(ws, { HOWL_CHANGE: "12" });
  assert.equal(e.branch, "main");
  assert.equal(e.change, "12");
  assert.equal(e.task, undefined);
});

test("#9: an empty or blank value is left out", () => {
  const e = run(workspace(), { HOWL_CHANGE: "", HOWL_TASK: "  " });
  assert.equal(e.change, undefined);
  assert.equal(e.task, undefined);
});

test("#9: howl show <change> takes in a review session that names the change, and nothing else on its branch", async () => {
  const { show } = await import("../src/read/show.ts");
  const { ledgerEvents, m, SHA } = await import("./story.ts");
  const review = (minute: number, type: "session.started" | "tool.used", session: string, change?: string) => ({
    v: 0 as const,
    id: `r-${session}-${minute}`,
    time: m(minute),
    type,
    source: { adapter: "claude-code-hook", kind: "claimed" as const },
    project: "example",
    actor: { kind: "agent" as const, id: "agent-2" },
    session,
    branch: "main",
    sha: SHA.x,
    ...(change ? { change } : {}),
  });
  const events = [
    ...ledgerEvents(),
    review(50, "session.started", "rev", "30"),
    review(51, "tool.used", "rev", "30"),
    // Another session on main that names no change: not part of change 30.
    review(52, "session.started", "other"),
  ];
  const shown = show(events, { kind: "change", id: "30" }, null)!;
  const sessions = new Set(shown.events.map((e) => e.session).filter(Boolean));
  assert.ok(sessions.has("rev"), "the review session is in the timeline");
  assert.ok(!sessions.has("other"), "another session on main is not");
});
