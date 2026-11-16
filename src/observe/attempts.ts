// The attempts of the checks of a commit (#47): what the observer makes of the runs the host gives.
//
// The host numbers no attempt of the whole set. The adapter gives each run its place among the runs of its name; an
// attempt of the whole set is made here. Attempt n is made of the latest run of each name whose attempt is at most n,
// so that when only the checks that failed are run again, the verdict of the set after it is made of the new runs of
// those names and the first runs of the others. It is finished when every run in it is.
// @code_class recording
import type { CheckRun } from "./port.ts";

export interface Attempt {
  n: number;
  /** pending: a run in it has not finished. */
  state: "passed" | "failed" | "pending";
  /** When the last run in it finished; none while it is pending. */
  at?: string;
  /** The names of the runs in it that failed, sorted and once each; a check that names none leaves none. */
  failed: string[];
}

/** The longest name of a check that is kept. */
export const NAME_LIMIT = 200;

/** The attempts of a set of runs, the first first. No runs, no attempt. */
export function attemptsOf(runs: CheckRun[]): Attempt[] {
  const last = Math.max(0, ...runs.map((r) => r.attempt));
  const attempts: Attempt[] = [];
  for (let n = 1; n <= last; n++) {
    // An attempt is one that some name has a run of.
    if (!runs.some((r) => r.attempt === n)) continue;
    // The latest run of each name that is of attempt n or before it.
    const latest = new Map<string, CheckRun>();
    for (const run of runs) {
      const key = run.name ?? "";
      const held = latest.get(key);
      if (run.attempt <= n && (held === undefined || run.attempt > held.attempt)) latest.set(key, run);
    }
    const members = [...latest.values()];
    const failed = [
      ...new Set(
        members
          .filter((r) => r.result === "failed" && r.name !== undefined)
          .map((r) => r.name!.slice(0, NAME_LIMIT)),
      ),
    ].sort();
    if (members.some((r) => r.result === "pending")) {
      attempts.push({ n, state: "pending", failed });
      continue;
    }
    const at = members
      .map((r) => r.at)
      .filter((t): t is string => typeof t === "string")
      .sort((a, b) => Date.parse(a) - Date.parse(b))
      .at(-1);
    attempts.push({ n, state: members.some((r) => r.result === "failed") ? "failed" : "passed", ...(at !== undefined ? { at } : {}), failed });
  }
  return attempts;
}
