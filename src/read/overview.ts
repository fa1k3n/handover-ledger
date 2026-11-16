// The overview of the dashboard, from the ledger alone: the handovers derived
// from changes and reviews, and the key figures. Pure: events in, rows out.
// No figure is given per person.
// @code_class reading
import type { LedgerEvent } from "../ledger/schema.ts";
import { actingAgents } from "./acting.ts";
import { observed } from "./observed.ts";
import { byTime } from "./order.ts";

const DAY = 24 * 3600_000;
/** The period of the figures. */
export const PERIOD_MS = 30 * DAY;

export interface Handover {
  time: string;
  change: string;
  task?: string;
  from: string;
  /** An actor, or `merged` when the merge ends the chain. */
  to: string;
  step: "Implementation → review" | "Review → fix" | "Review → merge";
  /** The person's account the agents acted through, when the code host named a person (#14). */
  via?: string;
  /** The agent's model and effort at the time, when an agent hands over. */
  model?: string;
  effort?: string;
  /** The hash of the event, of the first one when the row is of several. */
  hash?: string;
  /** #108: how many events the row is of, when more than one: a reviewer's reviews in a row on one change. */
  n?: number;
}

/** The handovers, newest first, from observed events (#51). A review by the author of the change is none. */
export function handovers(items: { event: LedgerEvent; hash?: string }[]): Handover[] {
  const sorted = byTime(items);
  const acting = actingAgents(sorted.map((i) => i.event));
  const author = new Map<string, string>();
  const authorVia = new Map<string, string>();
  const task = new Map<string, string>();
  const rows: Handover[] = [];
  // #108: the last row of each change on its head. A row that only repeats it is counted there, not written
  // again: a review recorded as sixteen comments is one handover, not sixteen.
  const lastOf = new Map<string, Handover>();
  const add = (row: Handover) => {
    const last = lastOf.get(row.change);
    if (last !== undefined && last.step === row.step && last.from === row.from && last.to === row.to && last.via === row.via) {
      last.n = (last.n ?? 1) + 1;
      return;
    }
    rows.push(row);
    lastOf.set(row.change, row);
  };
  for (const { event: e, hash } of sorted) {
    // #51: what a session or a script claims of a change is no handover, and does not say which task it has.
    if (e.change === undefined || !observed(e)) continue;
    if (e.task !== undefined) task.set(e.change, e.task);
    const matched = acting.get(e.id);
    const actor = matched?.agent ?? e.actor?.id;
    if (e.type === "change.opened" && actor !== undefined) {
      author.set(e.change, actor);
      if (matched?.via) authorVia.set(e.change, matched.via);
      continue;
    }
    // A new head starts a new round, as in `howl show`: what is reviewed after it is another handover.
    if (e.type === "change.updated") {
      lastOf.delete(e.change);
      continue;
    }
    const by = author.get(e.change);
    const via = matched?.via ?? authorVia.get(e.change);
    const base = { time: e.time, change: e.change, task: e.task ?? task.get(e.change), hash, ...(via !== undefined && e.type.startsWith("review.") ? { via } : {}) };
    if (e.type.startsWith("review.") && actor !== undefined && by !== undefined && actor !== by) {
      add(
        e.type === "review.changes_requested"
          ? { ...base, from: actor, to: by, step: "Review → fix" }
          : { ...base, from: by, to: actor, step: "Implementation → review" },
      );
    } else if (e.type === "change.merged") {
      add({ ...base, from: actor ?? by ?? "-", to: "merged", step: "Review → merge" });
    }
  }
  // The model of the agent who hands over, as its own sessions last said before the handover.
  const sessions = sorted.filter((i) => i.event.source.kind === "claimed" && i.event.model !== undefined).map((i) => i.event);
  for (const row of rows) {
    const t = Date.parse(row.time);
    const last = sessions.filter((e) => e.actor?.id === row.from && Date.parse(e.time) <= t).at(-1);
    if (last?.model !== undefined) row.model = last.model;
    if (last?.effort !== undefined) row.effort = last.effort;
    if (row.task === undefined) delete row.task;
  }
  return rows.reverse();
}

export interface KeyFigures {
  /** Changes opened and neither merged nor closed. */
  open: number;
  /** Changes merged within the period. */
  merged: number;
  /** From a task's first change opened to its merge, median, merges within the period. */
  leadTimeMedianMs: number | null;
  /** Review events per change merged within the period, mean. */
  reviewRoundsMean: number | null;
  periodDays: number;
  /** #25: the changes to .howl/ in the period, the newest first. */
  configChanges: { change: string; time: string; paths: string[] }[];
  /** #26: changes and reviews through a person's account that no agent was matched to, in the period: where the chain may be broken. */
  unattributed: { count: number; changes: string[] };
  /**
   * #38: of the changes merged in the period, those whose merged head names a requirement in its tests,
   * as the repository showed it; `without` names the others that were read, `unrecorded` those never read.
   */
  requirementsNamed: { merged: number; named: number; without: string[]; unrecorded: number };
}

export function keyFigures(events: LedgerEvent[], now: number): KeyFigures {
  const sorted = byTime(events.map((event) => ({ event }))).map((i) => i.event);
  const state = new Map<string, "open" | "done">();
  const firstOpened = new Map<string, number>();
  const reviews = new Map<string, number>();
  const leadTimes: number[] = [];
  const rounds: number[] = [];
  // #38: what the tests of each head name, and the head each merged change was merged at.
  const traced = new Map<string, boolean>();
  const mergedAt = new Map<string, string>();
  for (const e of sorted) {
    // #51: the figures count what the code host showed, never a claim.
    if (e.change === undefined || !observed(e)) continue;
    const t = Date.parse(e.time);
    const work = e.task ?? `change ${e.change}`;
    if (e.type === "trace.read" && e.sha !== undefined) {
      const d = e.data as { covered?: unknown; touched?: unknown } | undefined;
      traced.set(`${e.change}:${e.sha}`, Array.isArray(d?.covered) && Array.isArray(d?.touched) && d.covered.length + d.touched.length > 0);
      continue;
    }
    if (e.type === "change.opened") {
      state.set(e.change, "open");
      if (!firstOpened.has(work)) firstOpened.set(work, t);
    } else if (e.type === "change.closed") {
      state.set(e.change, "done");
    } else if (e.type.startsWith("review.")) {
      reviews.set(e.change, (reviews.get(e.change) ?? 0) + 1);
    } else if (e.type === "change.merged") {
      state.set(e.change, "done");
      if (now - t <= PERIOD_MS) {
        if (e.sha !== undefined) mergedAt.set(e.change, e.sha);
        else mergedAt.set(e.change, "");
        const opened = firstOpened.get(work);
        if (opened !== undefined) leadTimes.push(t - opened);
        rounds.push(reviews.get(e.change) ?? 0);
      }
    }
  }
  const acting = actingAgents(sorted);
  const missing = sorted.filter(
    (e) =>
      observed(e) &&
      e.change !== undefined &&
      now - Date.parse(e.time) <= PERIOD_MS &&
      (e.type === "change.opened" || e.type === "change.updated" || e.type.startsWith("review.")) &&
      (e.actor?.kind === "person" || (e.actor === undefined && e.type === "change.updated")) &&
      !acting.has(e.id),
  );
  const configChanges = sorted
    .filter((e) => e.type === "config.changed" && e.change !== undefined && now - Date.parse(e.time) <= PERIOD_MS)
    .map((e) => ({ change: e.change!, time: e.time, paths: ((e.data as { paths?: string[] } | undefined)?.paths ?? []).filter((p) => typeof p === "string") }))
    .reverse();
  return {
    configChanges,
    unattributed: { count: missing.length, changes: [...new Set(missing.map((e) => e.change!))].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b)) },
    open: [...state.values()].filter((s) => s === "open").length,
    merged: rounds.length,
    leadTimeMedianMs: median(leadTimes),
    reviewRoundsMean: rounds.length === 0 ? null : rounds.reduce((a, b) => a + b, 0) / rounds.length,
    periodDays: PERIOD_MS / DAY,
    requirementsNamed: requirementsNamed(mergedAt, traced),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A duration, short: 50 min, 5 h 40 min, 2.5 d. */
export function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${String(min % 60).padStart(2, "0")} min`;
  return `${(ms / DAY).toFixed(1)} d`;
}

function requirementsNamed(mergedAt: Map<string, string>, traced: Map<string, boolean>): KeyFigures["requirementsNamed"] {
  const without: string[] = [];
  let named = 0;
  let unrecorded = 0;
  for (const [change, sha] of mergedAt) {
    const seen = traced.get(`${change}:${sha}`);
    if (seen === undefined) unrecorded++;
    else if (seen) named++;
    else without.push(change);
  }
  return { merged: mergedAt.size, named, without: without.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b)), unrecorded };
}
