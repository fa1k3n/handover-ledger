// The words of the reading side, in one place (#43): a duration, what an event concerns and the short detail of an
// event. The terminal and the dashboard both use them. No Node, so the page can use it.
// @code_class reading
import type { LedgerEvent } from "../ledger/schema.ts";
import { checksNames } from "./checks-text.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A duration, in one form: 12 s, 50 min, 1 h 05 min, 2.5 d. A span below 0 is 0 s. */
export function duration(ms: number): string {
  if (!(ms > 0)) return "0 s";
  if (ms < MIN) return `${Math.floor(ms / 1000)} s`;
  const min = Math.floor(ms / MIN);
  if (min < 60) return `${min} min`;
  if (ms < 48 * HOUR) return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
  return `${(ms / DAY).toFixed(1)} d`;
}

/** What an event concerns, short: task 12 · change 30. It does not name the session. A row of the team has a task and a change too. */
export function concerns(event: { type?: string; task?: string; change?: string; to?: { id: string } }): string {
  return [
    event.task !== undefined ? `task ${event.task}` : null,
    event.change !== undefined ? `change ${event.change}` : null,
    // #45: the actor column is the one who acted; who a task was given to or taken from is told here.
    event.to !== undefined ? `${event.type === "task.unassigned" ? "taken from" : "to"} ${event.to.id}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The short detail of an event: its data in a few words. */
export function detail(event: LedgerEvent): string {
  const d = (event.data ?? {}) as Record<string, unknown>;
  const sha = event.sha ? event.sha.slice(0, 7) : "";
  switch (event.type) {
    case "tool.used":
      return [d.tool, d.target, d.outcome].filter((x) => typeof x === "string").join(" ");
    case "agent.waiting":
      return String(d.notification_type ?? "");
    case "session.started":
      return [event.model, event.effort, d.source].filter(Boolean).join(" · ");
    case "session.ended":
      return String(d.reason ?? "");
    default:
      // #44: a forced push says so.
      if (event.type.startsWith("change.")) return [event.branch, sha, event.type === "change.updated" && d.forced === true ? "forced" : null].filter(Boolean).join(" ");
      if (event.type.startsWith("checks.")) return [sha, checksNames(event)].filter(Boolean).join(" ");
      if (event.type.startsWith("review.")) return [event.branch, sha].filter(Boolean).join(" ");
      return Object.entries(d)
        .filter(([k]) => k !== "seen")
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
  }
}
