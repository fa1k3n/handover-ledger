// The overview of the dashboard, from the ledger alone: the handovers derived
// from changes and reviews, and the key figures. Pure: events in, rows out.
// No figure is given per person.
import type { LedgerEvent } from "../ledger/schema.ts";

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
  /** The agent's model and effort at the time, when an agent hands over. */
  model?: string;
  effort?: string;
  hash?: string;
}

/** The handovers, newest first. A review by the author of the change is none. */
export function handovers(items: { event: LedgerEvent; hash?: string }[]): Handover[] {
  const sorted = byTime(items);
  const author = new Map<string, string>();
  const task = new Map<string, string>();
  const rows: Handover[] = [];
  for (const { event: e, hash } of sorted) {
    if (e.change === undefined) continue;
    if (e.task !== undefined) task.set(e.change, e.task);
    const actor = e.actor?.id;
    if (e.type === "change.opened" && actor !== undefined) {
      author.set(e.change, actor);
      continue;
    }
    const by = author.get(e.change);
    const base = { time: e.time, change: e.change, task: e.task ?? task.get(e.change), hash };
    if (e.type.startsWith("review.") && actor !== undefined && by !== undefined && actor !== by) {
      rows.push(
        e.type === "review.changes_requested"
          ? { ...base, from: actor, to: by, step: "Review → fix" }
          : { ...base, from: by, to: actor, step: "Implementation → review" },
      );
    } else if (e.type === "change.merged") {
      rows.push({ ...base, from: actor ?? by ?? "-", to: "merged", step: "Review → merge" });
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
}

export function keyFigures(events: LedgerEvent[], now: number): KeyFigures {
  const sorted = byTime(events.map((event) => ({ event }))).map((i) => i.event);
  const state = new Map<string, "open" | "done">();
  const firstOpened = new Map<string, number>();
  const reviews = new Map<string, number>();
  const leadTimes: number[] = [];
  const rounds: number[] = [];
  for (const e of sorted) {
    if (e.change === undefined) continue;
    const t = Date.parse(e.time);
    const work = e.task ?? `change ${e.change}`;
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
        const opened = firstOpened.get(work);
        if (opened !== undefined) leadTimes.push(t - opened);
        rounds.push(reviews.get(e.change) ?? 0);
      }
    }
  }
  return {
    open: [...state.values()].filter((s) => s === "open").length,
    merged: rounds.length,
    leadTimeMedianMs: median(leadTimes),
    reviewRoundsMean: rounds.length === 0 ? null : rounds.reduce((a, b) => a + b, 0) / rounds.length,
    periodDays: PERIOD_MS / DAY,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function byTime<T extends { event: LedgerEvent }>(items: T[]): T[] {
  return items
    .map((item, i) => ({ item, i, t: Date.parse(item.event.time) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.item);
}

/** A duration, short: 50 min, 5 h 40 min, 2.5 d. */
export function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${String(min % 60).padStart(2, "0")} min`;
  return `${(ms / DAY).toFixed(1)} d`;
}
