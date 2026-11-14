// One assignment from hand-over to merge, written as a trial would write it:
// observed events from the code host in the ledger, claimed events of the
// agent's sessions in the ledger, and its tool calls in the activity file.
// Beside it, another task with a session and a change of its own.
// @code_class tests
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fixedForm } from "../src/ledger/fixed.ts";
import { openLedger, type LedgerEvent } from "../src/ledger/ledger.ts";
import { folder, PROJECT } from "./helpers.ts";

export const T0 = Date.UTC(2026, 0, 1, 8, 0, 0);
/** The time `minutes` after the hand-over. */
export const m = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

export const SHA = { a: "a".repeat(40), b: "b".repeat(40), c: "c".repeat(40), x: "e".repeat(40) };
export const REVIEWER = "person-0a0a0a0a";
export const MERGER = "person-0b0b0b0b";

let n = 0;
const observed = (type: LedgerEvent["type"], minute: number, extra: Partial<LedgerEvent> = {}): LedgerEvent => ({
  v: 0,
  id: `obs-${++n}`,
  time: m(minute),
  type,
  source: { adapter: "local", kind: "observed" },
  project: PROJECT,
  data: { seen: m(minute) },
  ...extra,
});
const claimed = (type: LedgerEvent["type"], minute: number, session: string, branch: string, extra: Partial<LedgerEvent> = {}): LedgerEvent => ({
  v: 0,
  id: `hook-${++n}`,
  time: m(minute),
  type,
  source: { adapter: "claude-code-hook", kind: "claimed" },
  project: PROJECT,
  actor: { kind: "agent", id: "agent-1" },
  session,
  branch,
  ...extra,
});
const tool = (minute: number, session: string, branch: string, name: string, target: string, outcome = "succeeded") =>
  claimed("tool.used", minute, session, branch, { data: { tool: name, target, outcome } });

const agent = { kind: "agent" as const, id: "agent-1" };
const reviewer = { kind: "person" as const, id: REVIEWER };
const merger = { kind: "person" as const, id: MERGER };
const branch = "task-12-x";
const other = "task-13-y";

/** The ledger events of the story, in the order they would be taken in. */
export function ledgerEvents(): LedgerEvent[] {
  const of = (sha: string) => ({ change: "30", branch, sha, task: "12" });
  return [
    observed("task.opened", -10, { task: "12", actor: reviewer }),
    observed("task.assigned", 0, { task: "12", actor: agent }),
    observed("task.assigned", 1, { task: "13", actor: agent }),
    claimed("session.started", 2, "s1", branch, { data: { source: "startup" } }),
    claimed("agent.waiting", 5, "s1", branch, { data: { notification_type: "permission_prompt" } }),
    claimed("session.stopped", 8, "s1", branch),
    claimed("agent.waiting", 9, "s1", branch, { data: { notification_type: "idle_prompt" } }),
    claimed("session.ended", 10, "s1", branch, { data: { reason: "other" } }),
    observed("change.opened", 10, { ...of(SHA.a), actor: agent }),
    observed("checks.passed", 12, of(SHA.a)),
    observed("review.changes_requested", 20, { ...of(SHA.a), actor: reviewer }),
    claimed("session.started", 22, "s2", branch, { data: { source: "startup" } }),
    claimed("session.ended", 30, "s2", branch, { data: { reason: "other" } }),
    observed("change.updated", 30, of(SHA.b)),
    observed("checks.failed", 33, of(SHA.b)),
    observed("change.updated", 40, of(SHA.c)),
    observed("checks.passed", 45, of(SHA.c)),
    observed("review.approved", 55, { ...of(SHA.c), actor: reviewer }),
    observed("change.merged", 60, { ...of(SHA.c), actor: merger }),
    // The other task: a session on its own branch and a change of its own.
    claimed("session.started", 3, "s3", other),
    observed("change.opened", 15, { change: "31", branch: other, sha: SHA.x, task: "13", actor: agent }),
  ];
}

export function activityEvents(): LedgerEvent[] {
  return [
    tool(3, "s1", branch, "Read", "src/a.ts"),
    tool(4, "s1", branch, "Bash", "make"),
    tool(6, "s1", branch, "Edit", "src/a.ts"),
    tool(7, "s1", branch, "Bash", "make", "failed"),
    tool(25, "s2", branch, "Edit", "src/b.ts"),
    tool(4, "s3", other, "Edit", "src/other.ts"),
  ];
}

/** Writes the story. Returns the path of the ledger; the activity file is beside it. */
export function writeStory(options: { activity?: boolean; until?: number } = {}): string {
  const dir = folder();
  const path = join(dir, "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  const until = options.until ?? Infinity;
  for (const e of ledgerEvents()) if (Date.parse(e.time) <= T0 + until * 60_000) writer.append(e);
  writer.close();
  if (options.activity !== false) {
    for (const e of activityEvents()) {
      if (Date.parse(e.time) <= T0 + until * 60_000) appendFileSync(join(dir, "activity.jsonl"), `${fixedForm(e)}\n`);
    }
  }
  return path;
}
