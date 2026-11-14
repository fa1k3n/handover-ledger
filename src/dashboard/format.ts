// The dashboard's pure parts: the filter text, times in local time and UTC, and
// the fields of a decoded event. No DOM, so node:test can run them.
// @code_class reading
import { ACTIVITY_FILE } from "../ledger/names.ts";
import { duration } from "../read/overview.ts";
import type { Claim, Head, Session } from "../read/show.ts";
import type { Item } from "../serve/server.ts";
import { waitsForPerson } from "../read/wait.ts";

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
    item.from === "ledger" ? { k: "Line", v: String(item.n) } : { k: "File", v: ACTIVITY_FILE },
    item.hash !== undefined ? { k: "Line hash", v: item.hash } : null,
    item.from === "ledger" ? { k: "Previous hash", v: item.prev ?? "none: the first line" } : null,
    { k: "Time", v: `${localTime(e.time, timeZone)} local · ${utcTime(e.time)}` },
    { k: "Type", v: e.type },
    actor ? { k: "Actor", v: actor } : null,
    item.by !== undefined ? { k: "Acted by", v: `${item.by} (matched to its session)` } : null,
    { k: "Source", v: `${e.source.kind} · ${e.source.adapter}` },
    e.task !== undefined ? { k: "Task", v: e.task } : null,
    e.change !== undefined ? { k: "Change", v: e.change } : null,
    e.branch !== undefined ? { k: "Branch", v: e.branch } : null,
    e.sha !== undefined ? { k: "Commit", v: e.sha } : null,
    e.session !== undefined ? { k: "Session", v: e.session } : null,
    e.model !== undefined ? { k: "Model", v: [e.model, e.effort].filter(Boolean).join(" · ") } : null,
    e.role !== undefined ? { k: "Role", v: e.role } : null,
    e.type === "config.changed" ? { k: "Paths", v: ((d.paths as string[] | undefined) ?? []).join(", ") } : null,
    item.from === "ledger" && e.source.kind === "claimed" && !e.type.startsWith("key.")
      ? {
          k: "Signature",
          v: item.signed
            ? item.signed.ok
              ? [
                  "valid",
                  `key ${item.signed.key.slice(0, 12)}`,
                  item.signed.actor,
                  item.signed.task !== undefined ? `task ${item.signed.task}` : null,
                  item.signed.change !== undefined ? `change ${item.signed.change}` : null,
                  `until ${utcTime(item.signed.until)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : `does not hold: ${item.signed.reason ?? "unknown"}`
            : e.sig
              ? "does not hold: its key is not issued in the ledger"
              : "unsigned",
        }
      : null,
    e.prompt !== undefined ? { k: "Role prompt", v: `${e.prompt.file} · ${e.prompt.sha256.slice(0, 12)}` } : null,
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
  if (waitsForPerson(e)) return "warn";
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

export type View = "overview" | "stream" | "change";

/** The view, the project and what the change view shows, in the address: `#change?project=name&what=change:30`. */
export function parseHash(hash: string): { view: View; project: string | null; what?: string } {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
  const q = new URLSearchParams(query);
  const view: View = path === "stream" || path === "change" ? path : "overview";
  const what = q.get("what");
  return what === null ? { view, project: q.get("project") } : { view, project: q.get("project"), what };
}

export function hashFor(view: View, project: string | null, what: string | null = null): string {
  const q = new URLSearchParams();
  if (project !== null) q.set("project", project);
  if (what !== null) q.set("what", what);
  const query = q.toString();
  return query ? `#${view}?${query}` : `#${view}`;
}

/** A head of a change for the change view: `new head 399a7cb by agent-1 (matched) · checks failed`. */
export function headText(h: Head, first: boolean): string {
  return [`${first ? "head" : "new head"} ${h.sha.slice(0, 7)}${h.by ? ` by ${h.by} (matched)` : ""}`, h.checks ? `checks ${h.checks}` : null]
    .filter(Boolean)
    .join(" · ");
}

/** A claim for the change view: `review.approved · change 30 · agent-1`; its task when it names no change. */
export function claimText(c: Claim): string {
  const on = c.change !== undefined ? `change ${c.change}` : c.task !== undefined ? `task ${c.task}` : null;
  return [c.type, on, c.actor?.id ?? "someone"].filter(Boolean).join(" · ");
}

/** A session for the change view: `agent-1 · fix · 33 min · Bash 54, Read 1`. */
export function sessionText(s: Session): string {
  const span = s.end === null ? "still open" : duration(Date.parse(s.end) - Date.parse(s.start));
  const tools = Object.entries(s.tools)
    .sort((a, b) => b[1] - a[1])
    .map(([tool, n]) => `${tool} ${n}`)
    .join(", ");
  return [s.actor?.id ?? "someone", s.role, span, tools || null].filter(Boolean).join(" · ");
}
