// The order in which the events of a round are written (#112). The code host
// gives times to the second, and what happens together comes in one second: a
// task opened with someone already set on it, a change merged as it is
// approved. By the time first; at the same time by what can happen first, so
// that a task is never given away before it exists; then by the id, so that
// the order is the same in every round.
// @code_class recording

/** What can happen in one moment, in the order it happens in. A type that is not here comes after these. */
const ORDER = [
  "task.opened",
  "task.assigned",
  "change.opened",
  "change.updated",
  "checks.passed",
  "checks.failed",
  "change.commented",
  "review.commented",
  "review.changes_requested",
  "review.approved",
  "change.merged",
  "change.closed",
  "task.closed",
];

/** The place of a type in a moment. The two outcomes of the checks share one: a commit has one of them. */
function place(type: string): number {
  const at = ORDER.indexOf(type === "checks.failed" ? "checks.passed" : type);
  return at < 0 ? ORDER.length : at;
}

/** For `sort`: negative when `a` is written before `b`. */
export function happensBefore(a: { time: string; type: string; id: string }, b: { time: string; type: string; id: string }): number {
  return a.time.localeCompare(b.time) || place(a.type) - place(b.type) || a.id.localeCompare(b.id);
}
