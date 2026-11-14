// A session names the change and the task it works on: the tests of issue #9.
// @code_class tests
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

// #17: the role of a session and its role prompt.
function runIn(ws: Workspace, env: Record<string, string>) {
  return run(ws, env);
}

test("#17: with HOWL_ROLE every event of the session has its role; without it, none", () => {
  assert.equal(runIn(workspace(), { HOWL_ROLE: "review" }).role, "review");
  assert.equal(runIn(workspace(), {}).role, undefined);
  assert.equal(runIn(workspace(), { HOWL_ROLE: "  " }).role, undefined);
});

test("#17: HOWL_ROLE_PROMPT gives the prompt's file and the SHA-256 of its content", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { join } = await import("node:path");
  const ws = workspace();
  mkdirSync(join(ws.root, "roles"));
  writeFileSync(join(ws.root, "roles", "review.md"), "Review the change.\n");
  const e = runIn(ws, { HOWL_ROLE: "review", HOWL_ROLE_PROMPT: "roles/review.md" });
  assert.deepEqual(e.prompt, { file: "roles/review.md", sha256: createHash("sha256").update("Review the change.\n").digest("hex") });
});

test("#17: a missing prompt file, or one outside the repository, gives no prompt and the event is still written", () => {
  const missing = runIn(workspace(), { HOWL_ROLE: "review", HOWL_ROLE_PROMPT: "roles/none.md" });
  assert.equal(missing.prompt, undefined);
  assert.equal(missing.role, "review");
  const outside = runIn(workspace(), { HOWL_ROLE_PROMPT: "../../etc/hostname" });
  assert.equal(outside.prompt, undefined);
  assert.equal(outside.type, "tool.used");
});

test("#17: howl show names the role of each session", async () => {
  const { show, render } = await import("../src/read/show.ts");
  const { ledgerEvents } = await import("./story.ts");
  const events = ledgerEvents().map((e) => (e.session === "s2" ? { ...e, role: "fix" } : e));
  const text = render(show(events, { kind: "task", id: "12" }, null)!, { utc: true });
  assert.match(text, /session s2 .*role fix/);
  assert.ok(!/session s1 .*role /.test(text), "a session without a role names none");
});
