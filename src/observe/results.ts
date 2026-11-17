// The result of the checks of a commit, and its changes (#47): what the observer makes of the runs the host gives.
//
// The result of a commit at a moment is of its whole set of checks: for each check, its latest finished run, at a
// moment when no run of the set is still going. It is passed when each of those passed, and failed otherwise, with the
// names of the checks that failed. What is recorded is each change of that result, worked out from all the runs by
// their own times, so a change between two rounds is told too. A check is told by its suite and its name.
// @code_class recording
import type { CheckRun } from "./port.ts";

/** The longest name of a check that is kept, in characters. */
export const NAME_LIMIT = 200;

/** The result of a set of checks: passed, or failed with the names of the checks that failed (sorted, once each). */
export interface State {
  state: "passed" | "failed";
  failed: string[];
}

/** A change of the result: the new state, when it came to be, and the id of the run that completed it. */
export interface Result extends State {
  at: string;
  run: string;
}

/**
 * A name for the ledger: only characters that print (a control character, a format character, a line separator and
 * what is no character at all are taken out), cut to NAME_LIMIT characters whole, never inside one.
 */
export function cleanName(name: string): string {
  return [...name.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "")].slice(0, NAME_LIMIT).join("");
}

/** A run with its times as numbers; one whose time cannot be read is left out. */
interface Timed {
  run: CheckRun;
  check: string;
  /** When it began; -Infinity where the host does not say and nothing before it tells. */
  start: number;
  /** Whether the host said when it began. */
  said: boolean;
  /** When it finished; Infinity for a run going. */
  end: number;
}

const time = (t: string | undefined): number | undefined => {
  if (t === undefined) return undefined;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : ms;
};

/** The ids of two runs, as numbers where they are. */
function byId(a: string, b: string): number {
  return /^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b);
}

function timed(runs: CheckRun[]): Timed[] {
  const found: Timed[] = [];
  for (const run of runs) {
    const check = `${run.suite ?? ""}\u0000${run.name ?? ""}`;
    if (run.result === "pending") {
      const started = time(run.started);
      found.push({ run, check, start: started ?? -Infinity, said: started !== undefined, end: Infinity });
      continue;
    }
    const end = time(run.at);
    if (end === undefined) continue;
    const started = time(run.started);
    found.push({ run, check, start: started === undefined ? -Infinity : Math.min(started, end), said: started !== undefined, end });
  }
  // A run that does not say when it began began after the last run of its check finished.
  for (const t of found) {
    if (t.said) continue;
    const before = found.filter((o) => o !== t && o.check === t.check && o.end <= t.end && o.end !== Infinity).map((o) => o.end);
    if (before.length > 0) t.start = Math.max(...before);
  }
  return found;
}

/** The state of the set at `t`: the latest finished run of each check; null where nothing has finished. */
function stateAt(runs: Timed[], t: number): State | null {
  const latest = new Map<string, Timed>();
  for (const r of runs) {
    if (r.end > t) continue;
    const held = latest.get(r.check);
    if (held === undefined || r.end > held.end || (r.end === held.end && byId(r.run.id, held.run.id) > 0)) latest.set(r.check, r);
  }
  if (latest.size === 0) return null;
  const failing = [...latest.values()].filter((r) => r.run.result === "failed");
  const failed = [...new Set(failing.flatMap((r) => (r.run.name === undefined ? [] : [cleanName(r.run.name)])).filter((n) => n !== ""))].sort();
  return { state: failing.length === 0 ? "passed" : "failed", failed };
}

/** Whether two states say the same: the same result and the same names. */
export function sameState(a: State, b: State): boolean {
  return a.state === b.state && a.failed.length === b.failed.length && a.failed.every((n, i) => n === b.failed[i]);
}

/**
 * The result of the set now: null while a run of it is going, and where there is no run. The same as the last of
 * `resultsOf` when nothing is going.
 */
export function stateOf(runs: CheckRun[]): State | null {
  const all = timed(runs);
  if (all.some((r) => r.end === Infinity)) return null;
  return stateAt(all, Infinity);
}

/**
 * Each change of the result, in the order of time, from the runs. A moment counts when a run finished at it and no run
 * of the set was going at it. A result that says what the one before it said gives none.
 */
export function resultsOf(runs: CheckRun[]): Result[] {
  const all = timed(runs);
  const moments = [...new Set(all.filter((r) => r.end !== Infinity).map((r) => r.end))].sort((a, b) => a - b);
  const results: Result[] = [];
  for (const t of moments) {
    // A run going at the moment: begun before it, and not finished by it.
    if (all.some((r) => r.start < t && r.end > t)) continue;
    const state = stateAt(all, t);
    if (state === null) continue;
    const last = results.at(-1);
    if (last !== undefined && sameState(last, state)) continue;
    const completing = all.filter((r) => r.end === t).sort((a, b) => byId(b.run.id, a.run.id))[0]!;
    results.push({ ...state, at: new Date(t).toISOString(), run: completing.run.id });
  }
  return results;
}

/** The names of the checks that are going, for a head let go while they were. */
export function pendingNames(runs: CheckRun[]): string[] {
  return [...new Set(runs.filter((r) => r.result === "pending" && r.name !== undefined).map((r) => cleanName(r.name!)).filter((n) => n !== ""))].sort();
}

/** The last run of a set to finish: when, and its id. None where no run has finished. */
export function lastFinish(runs: CheckRun[]): { at: string; run: string } | null {
  const done = timed(runs).filter((r) => r.end !== Infinity);
  if (done.length === 0) return null;
  const last = done.sort((a, b) => b.end - a.end || byId(b.run.id, a.run.id))[0]!;
  return { at: new Date(last.end).toISOString(), run: last.run.id };
}
