// The dashboard's pure parts: the filter text, times in local time and UTC, and
// the fields of a decoded event. No DOM, so node:test can run them.
// @code_class reading
import { ACTIVITY_FILE } from "../ledger/names.ts";
import { isPair } from "../read/filter-text.ts";
import { duration } from "../read/overview.ts";
import type { Claim, Head, Session } from "../read/show.ts";
import type { Item } from "../serve/server.ts";
import { waitsForPerson } from "../read/wait.ts";
import { writingLine, type Writing } from "../read/writing-text.ts";

/** The filter text as field=value pairs, split on white space. */
export function filterPairs(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * #89: how the event log starts: an empty filter line, and the box "Show tool
 * calls" not ticked. Whether tool calls are in the list is a switch the reader
 * sees, and the line holds only what the reader wrote.
 */
export const STREAM_START = { filter: "", tools: false } as const;

/**
 * #89: what the page asks the event log: the filter texts, the tool calls only
 * with the box ticked, and how many of the newest. A filter that names
 * `tool.used` gets them ticked or not: that is the server's rule.
 */
export function eventsQuery(filters: string[], tools: boolean, limit = 200): string {
  const q = new URLSearchParams();
  for (const f of filters) q.append("filter", f);
  if (tools) q.set("activity", "1");
  q.set("limit", String(limit));
  return q.toString();
}

/**
 * #82: the filter text as the texts the server takes: pairs one by one, as
 * before; anything else whole, as one CEL expression.
 */
export function filterTexts(text: string): string[] {
  const pairs = filterPairs(text);
  return pairs.every(isPair) ? pairs : [text.trim()];
}

/**
 * The filter text narrowed to one value of a field, for a click on a value in
 * the list (#79). On pairs, and on nothing, a pair is added, and one of the
 * same field is taken out first: two values of one field could never both
 * match. On an expression (#82) a clause is added, once; the repository is
 * asked for first, as not every event has one.
 */
export function filterWith(text: string, field: string, value: string): string {
  const pairs = filterPairs(text);
  if (pairs.every(isPair)) return [...pairs.filter((pair) => !pair.startsWith(`${field}=`)), `${field}=${value}`].join(" ");
  const equals = `event.${field} == ${JSON.stringify(value)}`;
  const clause = field === "project" ? equals : `has(event.${field}) && ${equals}`;
  const expression = text.trim();
  return expression.includes(clause) ? expression : `(${expression}) && ${clause}`;
}

/** #79: what tells a row of the event log from every other: its project and its event. */
export function itemKey(item: Item): string {
  return `${item.project ?? ""}\u0000${item.event.id}`;
}

/**
 * #79: the columns the event log adds. The project, when the server serves
 * more than one; the repository, when the rows shown come from more than one.
 */
export function streamColumns(items: Item[], served: number): { project: boolean; repo: boolean } {
  const repos = new Set(items.map((item) => item.event.repo).filter((repo) => repo !== undefined));
  return { project: served > 1, repo: repos.size > 1 };
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
    // #79: the line number and the hashes are those of this project's ledger.
    item.project !== undefined ? { k: "Project", v: item.project } : null,
    item.from === "ledger" ? { k: "Line", v: String(item.n) } : { k: "File", v: ACTIVITY_FILE },
    item.hash !== undefined ? { k: "Line hash", v: item.hash } : null,
    item.from === "ledger" ? { k: "Previous hash", v: item.prev ?? "none: the first line" } : null,
    { k: "Time", v: `${localTime(e.time, timeZone)} local · ${utcTime(e.time)}` },
    { k: "Type", v: e.type },
    actor ? { k: "Actor", v: actor } : null,
    item.by !== undefined ? { k: "Acted by", v: `${item.by} (matched to its session)` } : null,
    { k: "Source", v: `${e.source.kind} · ${e.source.adapter}` },
    e.repo !== undefined ? { k: "Repository", v: e.repo } : null,
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

/**
 * #81: whether the project menu shows. The overview and the change view are of
 * one project, so the menu steers them; the event log is every project the
 * server serves (#79), so it steers nothing there. Not for a server of one
 * ledger, as before.
 */
export function menuShown(view: View, projects: { single: boolean } | null): boolean {
  return view !== "stream" && projects !== null && !projects.single;
}

/**
 * #85: a call for a poll that is not made again while its last answer is still
 * on its way. The page asks every two seconds; a server that needs longer than
 * that would otherwise never catch up. A call that gives no promise is made at
 * every round.
 */
export function oneAtATime(call: () => Promise<unknown> | void): () => void {
  let waiting = false;
  return () => {
    if (waiting) return;
    const answer = call();
    if (answer === undefined) return;
    waiting = true;
    const done = () => {
      waiting = false;
    };
    answer.then(done, done);
  };
}

/** #81: where "needs input" leads: the overview, which starts with the team. */
export function needsInputHref(project: string | null): string {
  return hashFor("overview", project);
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

/**
 * #102: what the page says under its header, one line for each project that
 * has events waiting and no writer, or a writer that is slow. `written` is
 * false for a project nothing writes: only that one is marked in the menu
 * and the event log. Empty when all is well, and for a server of one ledger file.
 */
export function writingLines(
  projects: { projects: ({ name: string } & Partial<Writing>)[]; unstarted?: { name: string; waiting: number; oldest: number | null }[]; now?: number } | null,
  now = Date.now(),
): { project: string; line: string; written: boolean }[] {
  if (projects === null) return [];
  const at = projects.now ?? now;
  const all = [
    ...projects.projects.flatMap((p) => (p.writer === undefined || p.waiting === undefined ? [] : [{ name: p.name, w: { writer: p.writer, waiting: p.waiting, oldest: p.oldest ?? null, ...(p.left ? { left: true as const } : {}) } }])),
    ...(projects.unstarted ?? []).map((p) => ({ name: p.name, w: { writer: false, waiting: p.waiting, oldest: p.oldest } })),
  ];
  return all.flatMap(({ name, w }) => {
    const line = writingLine(name, w, at);
    return line === null ? [] : [{ project: name, line, written: w.writer }];
  });
}

/** #108: the step of a handover row, with the count when the row is of several events: `Implementation → review ×16`. */
export function stepText(h: { step: string; n?: number }): string {
  return h.n !== undefined && h.n > 1 ? `${h.step} ×${h.n}` : h.step;
}
