// The dashboard's pure parts: the filter text, times in local time and UTC, and
// the fields of a decoded event. No DOM, so node:test can run them.
import type { Item } from "../serve/server.ts";

/** The filter text as field=value pairs, split on white space. */
export function filterPairs(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** The time of day to the second in a time zone, the viewer's when none is given. */
export function localTime(time: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(time));
}

/** The date and time in UTC, as stored: 2026-11-13 09:40:18 UTC. */
export function utcTime(time: string): string {
  return `${new Date(time).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export interface Field {
  k: string;
  v: string;
}

/** The fields of an event for the decoded view; a field the event does not have is left out. */
export function decodedFields(item: Item, timeZone?: string): Field[] {
  const e = item.event;
  const d = (e.data ?? {}) as Record<string, unknown>;
  const actor = e.actor ? `${e.actor.id} (${e.actor.kind === "person" ? "person, pseudonym" : e.actor.kind})` : undefined;
  const fields: (Field | null)[] = [
    item.from === "ledger" ? { k: "Line", v: String(item.n) } : { k: "File", v: "activity.jsonl" },
    item.hash !== undefined ? { k: "Line hash", v: item.hash } : null,
    item.from === "ledger" ? { k: "Previous hash", v: item.prev ?? "none: the first line" } : null,
    { k: "Time", v: `${localTime(e.time, timeZone)} local · ${utcTime(e.time)}` },
    { k: "Type", v: e.type },
    actor ? { k: "Actor", v: actor } : null,
    { k: "Source", v: `${e.source.kind} · ${e.source.adapter}` },
    e.task !== undefined ? { k: "Task", v: e.task } : null,
    e.change !== undefined ? { k: "Change", v: e.change } : null,
    e.branch !== undefined ? { k: "Branch", v: e.branch } : null,
    e.sha !== undefined ? { k: "Commit", v: e.sha } : null,
    e.session !== undefined ? { k: "Session", v: e.session } : null,
    e.model !== undefined ? { k: "Model", v: [e.model, e.effort].filter(Boolean).join(" · ") } : null,
    e.type === "tool.used" ? { k: "Tool", v: [d.tool, d.target, d.outcome].filter((x) => typeof x === "string").join(" ") } : null,
  ];
  return fields.filter((f): f is Field => f !== null);
}

/** What an event concerns, short: task 12 · change 30. */
export function concerns(item: Item): string {
  const e = item.event;
  return [e.task !== undefined ? `task ${e.task}` : null, e.change !== undefined ? `change ${e.change}` : null].filter(Boolean).join(" · ");
}

/** The short of an event's data for the stream. */
export function detail(item: Item): string {
  const e = item.event;
  const d = (e.data ?? {}) as Record<string, unknown>;
  if (e.type === "tool.used") return [d.tool, d.target, d.outcome].filter((x) => typeof x === "string").join(" ");
  if (e.type === "agent.waiting") return String(d.notification_type ?? "");
  if (e.type === "session.started") return [e.model, e.effort].filter(Boolean).join(" · ");
  if (e.type.startsWith("change.") || e.type.startsWith("checks.") || e.type.startsWith("review.")) {
    return [e.branch, e.sha?.slice(0, 7)].filter(Boolean).join(" ");
  }
  return "";
}

/** A wait for a person, failed checks and a review asking for changes stand out. */
export function standsOut(item: Item): "warn" | "error" | null {
  const e = item.event;
  if (e.type === "checks.failed") return "error";
  if (e.type === "review.changes_requested") return "warn";
  if (e.type === "agent.waiting" && (e.data as Record<string, unknown> | undefined)?.notification_type !== "idle_prompt") return "warn";
  return null;
}

/** The time of day for an event of today, else its date and time: 12 Nov 21:14. Days are the viewer's. */
export function whenShort(time: string, now: number, timeZone?: string): string {
  const day = (t: Date) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(t);
  const at = new Date(time);
  if (day(at) === day(new Date(now))) return localTime(time, timeZone);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(at).replace(",", "");
}

/** The title of the tab: the number of agents that need input first, so it shows from another tab. */
export function tabTitle(needsInput: number): string {
  return needsInput > 0 ? `(${needsInput}) Handover Ledger` : "Handover Ledger";
}
