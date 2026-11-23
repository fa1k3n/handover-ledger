// The dashboard's pure parts: the filter text, times in local time and UTC, and
// the fields of a decoded event. No DOM, so node:test can run them.
// @code_class reading
import { ACTIVITY_FILE } from "../ledger/names.ts";
import { isPair } from "../read/filter-text.ts";
import type { KeyFigures } from "../read/overview.ts";
import { concerns, duration } from "../read/words.ts";
import type { Claim, Head, Session, Summary } from "../read/show.ts";
import type { AgentRow } from "../read/state.ts";
import type { Item } from "../serve/server.ts";
import { waitsForPerson } from "../read/wait.ts";
import { writingLine, type Writing } from "../read/writing-text.ts";
import { texts } from "./texts.ts";

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

/** An array of IDs for the decoded view: `R-1, R-2`, or `none`. */
function listText(value: unknown): string {
  return Array.isArray(value) && value.length > 0 ? value.map(String).join(", ") : "none";
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
    // #45: who a task was given to, or taken from.
    e.to ? { k: e.type === "task.unassigned" ? "Taken from" : "To", v: `${e.to.id} (${e.to.kind === "person" ? "person, pseudonym" : e.to.kind})` } : null,
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
    // #38: what the tests of a head name, as the repository showed it.
    e.type === "trace.read" ? { k: "Covered", v: listText(d.covered) } : null,
    e.type === "trace.read" ? { k: "Touched only", v: listText(d.touched) } : null,
    e.type === "trace.read" ? { k: "Tests naming one", v: `${String(d.tests ?? "?")}, ${String(d.covering ?? "?")} of them covering` } : null,
    e.type === "trace.read" && typeof d.list === "string" ? { k: "List hash", v: d.list } : null,
  ];
  return fields.filter((f): f is Field => f !== null);
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

/** #93: the question the event log asks: the filter texts and whether tool calls are shown. */
export type Question = { filters: string[]; tools: boolean };

/**
 * #93: whether the answer to `asked` is still wanted while the page holds
 * `now`. Two questions are the same when the filter texts are the same in the
 * same order and `tools` is the same. An answer carries no number: it is
 * matched by the question it was asked for.
 */
export function answerWanted(asked: Question, now: Question): boolean {
  return (
    asked.tools === now.tools &&
    asked.filters.length === now.filters.length &&
    asked.filters.every((f, i) => f === now.filters[i])
  );
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

/**
 * A head of a change for the change view: `new head 399a7cb by agent-1 (matched) · checks failed`. #44: where the host
 * named who pushed it, `pushed by`, with the agent behind a person's account, and a forced push; a head a round saw says so.
 */
export function headText(h: Head, first: boolean): string {
  const pusher = h.actor ? ` pushed by ${h.by ? `${h.by} via ${h.actor.id}` : h.actor.id}` : h.gone ? " pushed by an account that no longer exists" : h.by ? ` by ${h.by} (matched)` : "";
  return [`${first ? "head" : "new head"} ${h.sha.slice(0, 7)}${pusher}${h.forced ? ", forced" : ""}`, h.inferred ? "as a round of howl saw it" : null, checksText(h)]
    .filter(Boolean)
    .join(" · ");
}

/**
 * #47: the checks of a head, short: `checks failed (static-analysis), then passed` for a head with more than one result,
 * the checks that failed named; a head whose change ended with none says so.
 */
function checksText(h: Head): string | null {
  if (h.checks === "none") return "no checks";
  if (h.results === undefined || h.results.length === 0) return h.checks ? `checks ${h.checks}` : null;
  const each = h.results.map((r) => `${r.result}${r.failed !== undefined ? ` (${r.failed.join(", ")})` : ""}`);
  return `checks ${each.join(", then ")}`;
}

/** #38: the line under a head in the change view: what its tests name, a gap said plainly, or that nothing was read. */
export { traceText } from "../read/trace-text.ts";

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
  return [s.actor?.id ?? "someone", s.role, span, tools || null, s.also !== undefined && s.also.length > 0 ? texts.change.alsoUnder(s.also) : null].filter(Boolean).join(" · ");
}

/**
 * #117: the line of the other changes of a task: a link to the task and one to each change. The
 * text comes from `texts.change.otherChanges`; the links keep the project the page shows.
 */
export function otherChangeLinks(
  task: string,
  others: string[],
  project: string | null,
): { task: { label: string; href: string }; changes: { label: string; href: string }[] } {
  return {
    task: { label: texts.change.task(task), href: hashFor("change", project, `task:${task}`) },
    changes: others.map((change) => ({ label: change, href: hashFor("change", project, `change:${change}`) })),
  };
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

/** #120: the address a row of the handovers opens: the change's view, or the task's for the giving of a task. */
export function handoverLink(h: { change?: string; task?: string }, project: string | null): string {
  return hashFor("change", project, h.change !== undefined ? `change:${h.change}` : `task:${h.task}`);
}

/** #120: the key of a row of the handovers; a row of a task has no change, and two rows are never one. */
export function handoverKey(h: { time: string; change?: string; task?: string; step: string; from: string; to: string; hash?: string }): string {
  return [h.time, h.change !== undefined ? `change:${h.change}` : `task:${h.task ?? ""}`, h.step, h.from, h.to, h.hash ?? ""].join("|");
}

/** #120: for a giving that was taken back, when; none for every other row. */
export function takenBackText(h: { takenBack?: string }, now: number): string | null {
  return h.takenBack === undefined ? null : texts.overview.takenBack(whenShort(h.takenBack, now));
}

/**
 * #110: the field a decoded row can narrow the event log by, or null. The
 * project and the repository, as a click on their cells did since #79.
 */
export function narrowOf(f: Field, item: Item): { field: "project" | "repo"; value: string } | null {
  if (f.k === "Project" && item.project !== undefined) return { field: "project", value: item.project };
  if (f.k === "Repository" && item.event.repo !== undefined) return { field: "repo", value: item.event.repo };
  return null;
}

/**
 * #110: the events beside one in the list as the page holds it, newest first:
 * what "Newer" and "Older" of the dialog step to. None at an end of the list,
 * and none for an event that is no longer in it.
 */
export function neighbours(items: Item[], key: string): { newer: string | null; older: string | null } {
  const at = items.findIndex((i) => itemKey(i) === key);
  if (at < 0) return { newer: null, older: null };
  const of = (i: Item | undefined) => (i === undefined ? null : itemKey(i));
  return { newer: at === 0 ? null : of(items[at - 1]), older: of(items[at + 1]) };
}

/** #110: what "Copy line" copies: the line as it is stored, byte for byte. The hash is over these bytes, not over an indented form. */
export function lineToCopy(item: Item): string {
  return item.raw;
}

/** #110: the heading of the dialog of an event: its line and its project, or that it is a tool call. */
export function dialogHeading(item: Item): string {
  const what = item.from === "ledger" ? texts.decoded.line(item.n ?? 0) : texts.decoded.tool;
  return item.project !== undefined ? `${what} · ${item.project}` : what;
}

/**
 * #110: a stored line with line breaks and indents put between its parts, and
 * nothing else changed: every name, value and escape stands as it is stored.
 * Reading the line and writing it again would turn an escape as `\u00e5` into
 * its letter, and the panel would no longer show what the hash is over.
 */
export function indentStored(raw: string): string {
  let out = "";
  let depth = 0;
  let inText = false;
  const pad = () => `\n${"  ".repeat(depth)}`;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (inText) {
      out += c;
      // An escaped character is taken with its backslash, so an escaped quote ends nothing.
      if (c === "\\") out += raw[++i] ?? "";
      else if (c === '"') inText = false;
      continue;
    }
    if (c === '"') {
      inText = true;
      out += c;
    } else if (c === "{" || c === "[") {
      const empty = raw[i + 1] === (c === "{" ? "}" : "]");
      if (empty) out += c + raw[++i];
      else {
        depth++;
        out += c + pad();
      }
    } else if (c === "}" || c === "]") {
      depth = Math.max(0, depth - 1);
      out += pad() + c;
    } else if (c === ",") out += c + pad();
    else if (c === ":") out += ": ";
    else if (!/\s/.test(c)) out += c;
  }
  return out;
}

/** #52: whether the tile "No agent matched" and its list are shown: only when the ledger holds an agent in the period. */
export function showsUnattributed(figures: KeyFigures): boolean {
  return figures.unattributed !== undefined;
}

/** The team's "since" cell: the time from the last event of a row to now. */
export function teamSince(row: AgentRow, now: number): string {
  return duration(now - Date.parse(row.last));
}

/** The team's "works on" cell: what the row's task and change are, as `concerns` writes it. */
export function teamWorksOn(row: AgentRow): string {
  return concerns(row);
}

/** The change view's summary in milliseconds, from the seconds of `Summary`: the waits for a person and for instructions are one. */
export function summarySpans(s: Summary): { all: number; work: number; checks: number; review: number; waits: number; unknown: number } {
  return { all: s.seconds * 1000, work: s.parts.work * 1000, checks: s.parts.checks * 1000, review: s.parts.review * 1000, waits: (s.parts.person + s.parts.instructions) * 1000, unknown: s.parts.unknown * 1000 };
}

/** A wait of the change view in milliseconds, from its seconds; `null` for one that is still going. */
export function waitSpan(seconds: number | null): number | null {
  return seconds === null ? null : seconds * 1000;
}

/** #189: who established an event, as a badge: its code and its mark; a claim is outlined and its row in italics. */
export function establishedBy(kind: string): { code: "SOURCE" | "CLAIM" | "UNKNOWN"; mark: string; claimed: boolean } {
  if (kind === "observed") return { code: "SOURCE", mark: "▣", claimed: false };
  if (kind === "claimed") return { code: "CLAIM", mark: "▢", claimed: true };
  // A kind the page does not know (derived comes with the checker) is never taken for observed.
  return { code: "UNKNOWN", mark: "?", claimed: false };
}

/** #189: the mark of a status in the first column: a wait for a person, failed checks, merged; else none. */
export function statusMark(item: Item): "◷" | "!" | "✓" | "" {
  const e = item.event;
  if (waitsForPerson(e)) return "◷";
  if (e.type === "checks.failed") return "!";
  if (e.type === "change.merged") return "✓";
  return "";
}

export type SavedFilter = { name: string; expression: string };

/** #189: the filters every reader has, in order. The first shows everything. */
export function builtInFilters(): SavedFilter[] {
  return texts.stream.builtIn.map((f) => ({ name: f.name, expression: f.expression }));
}

/** #189: the filters a reader saved, read from the stored text. A broken value gives none; a broken entry is left out. */
export function readSavedFilters(raw: string | null): SavedFilter[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: SavedFilter[] = [];
  for (const f of parsed) {
    if (typeof f !== "object" || f === null) continue;
    const { name, expression } = f as Record<string, unknown>;
    if (typeof name === "string" && name !== "" && typeof expression === "string") out.push({ name, expression });
  }
  return out;
}

/** #189: the text to store for the saved filters. */
export function writeSavedFilters(filters: SavedFilter[]): string {
  return JSON.stringify(filters);
}

/** #189: the key of the saved filters in the browser's storage. */
export const SAVED_FILTERS_KEY = "howl.savedFilters";
