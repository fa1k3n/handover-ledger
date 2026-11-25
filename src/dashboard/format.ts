// The dashboard's pure parts: the filter text, times in local time and UTC, and
// the fields of a decoded event. No DOM, so node:test can run them.
// @code_class reading
import { ACTIVITY_FILE } from "../ledger/names.ts";
import { isPair } from "../read/filter-text.ts";
import type { KeyFigures } from "../read/overview.ts";
import { concerns, duration } from "../read/words.ts";
import type { Claim, Head, Session, Summary } from "../read/show.ts";
import type { AgentRow } from "../read/state.ts";
import type { LedgerEvent } from "../ledger/schema.ts";
import type { LineIssuer, LineSignature } from "../read/line.ts";
import type { LedgerState } from "./api.ts";
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
  // #216: two files of the log may hold one id with different content: an event of the log is told by its hash too.
  return item.from === "log" ? `${item.project ?? ""}\u0000${item.event.id}\u0000${item.hash ?? ""}` : `${item.project ?? ""}\u0000${item.event.id}`;
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
export function decodedFields(item: Item, timeZone?: string, issuer?: LineIssuer): Field[] {
  const e = item.event;
  const d = (e.data ?? {}) as Record<string, unknown>;
  const actor = e.actor ? `${e.actor.id} (${e.actor.kind === "person" ? "person, pseudonym" : e.actor.kind})` : undefined;
  const fields: (Field | null)[] = [
    // #79: the line number and the hashes are those of this project's ledger.
    item.project !== undefined ? { k: "Project", v: item.project } : null,
    item.from === "ledger" ? { k: "Line", v: String(item.n) } : item.from === "log" ? { k: "Kept", v: texts.decoded.onLog } : { k: "File", v: ACTIVITY_FILE },
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
                  // #202: a valid signature holds under an issuer, and part 7 says which kind: never a bare "valid".
                  issuer === undefined ? texts.provenance.signatureRow.unread : issuer.pinned && issuer.id !== null ? texts.provenance.signatureRow.pinned(issuer.id) : texts.provenance.signatureRow.notPinned,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : `does not hold: ${item.signed.reason ?? "unknown"}`
            : e.sig
              ? `does not hold: ${texts.provenance.signatureRow.noValidIssue}`
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
  const what = item.from === "ledger" ? texts.decoded.line(item.n ?? 0) : item.from === "log" ? texts.decoded.log : texts.decoded.tool;
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

/** #210: the longest detail a row shows; a longer one is cut with "…". */
export const DETAIL_CUT = 80;

/** #210: a row's detail for one line, and whether it was cut. The cut is by whole characters. */
export function cutDetail(text: string): { text: string; cut: boolean } {
  const chars = Array.from(text);
  if (chars.length <= DETAIL_CUT) return { text, cut: false };
  return { text: `${chars.slice(0, DETAIL_CUT).join("")}…`, cut: true };
}

/**
 * #210: the mark of a row's signature, from the server's verdict alone. "pinned"
 * only when the server holds a pin and the signature holds under it. A claim that
 * carries a signature but has no verdict is one whose key has no valid issue (the
 * server sets a verdict on a failure only for a known key): a fault, as part 7 says.
 * A key's issue or revocation has no verdict from the server, so no mark. `pinned`
 * null (the ledger's state not read yet) is never taken for a pin or for no pin.
 */
export function signatureMark(item: Item, pinned: boolean | null): { kind: "pinned" | "open" | "unread" | "fault" | "none"; glyph: string; text: string } {
  const s = item.signed;
  const t = texts.stream.signature;
  if (s === undefined) {
    const e = item.event;
    if (e.sig === undefined || e.type === "key.issued" || e.type === "key.revoked") return { kind: "none", glyph: "", text: "" };
    return { kind: "fault", glyph: "!", text: t.noIssue };
  }
  if (!s.ok) return { kind: "fault", glyph: "!", text: t.fault };
  if (pinned === null) return { kind: "unread", glyph: "○", text: t.unread };
  return pinned ? { kind: "pinned", glyph: "●", text: t.pinned } : { kind: "open", glyph: "○", text: t.open };
}

export type SavedFilter = { name: string; expression: string };

/** #189: the filters every reader has, in order. The first shows everything. */
export function builtInFilters(): SavedFilter[] {
  return texts.stream.builtIn.map((f) => ({ name: f.name, expression: f.expression }));
}

/** #210: the built-in filters, with "Signed, not pinned" where the server is known to serve no pin. */
export function filtersFor(pinned: boolean | null): SavedFilter[] {
  return pinned === false ? [...builtInFilters(), { ...texts.stream.signedNotPinned }] : builtInFilters();
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

/** #189: the text a screen reader reads for a status mark; none for none. */
export function markText(mark: string): string {
  if (mark === "◷") return texts.stream.marks.waits;
  if (mark === "!") return texts.stream.marks.failed;
  if (mark === "✓") return texts.stream.marks.merged;
  return "";
}

/** #189: whether a name is a built-in filter's. A saved name that is there is replaced, so it is not taken. */
export function nameTaken(name: string, _saved: SavedFilter[]): boolean {
  return [...builtInFilters(), texts.stream.signedNotPinned].some((f) => f.name === name.trim());
}

/** #190: one item of the band of what needs a person. */
export interface BandItem {
  mark: "◷";
  agent: string;
  subject: string;
  since: string;
  waited: number;
  session?: string;
  /** A wait is always a session's claim: the state is folded from claimed events only, so this goes when the fold changes. */
  established: ReturnType<typeof establishedBy>;
}

/** #190: the band's items from the agents' rows: each agent in "needs input", the longest wait first. */
export function needsPersonItems(rows: AgentRow[], now: number): BandItem[] {
  return rows
    .filter((r) => r.state === "needs-input")
    .map((r): BandItem => ({
      mark: "◷",
      agent: r.agent,
      subject: teamWorksOn(r),
      since: duration(now - Date.parse(r.since ?? r.last)),
      waited: now - Date.parse(r.since ?? r.last),
      ...(r.session !== undefined ? { session: r.session } : {}),
      established: establishedBy("claimed"),
    }))
    .sort((a, b) => b.waited - a.waited);
}

/** #190: the filter that finds the wait an item rests on: the agent's waits, in the project when the server serves several. */
export function waitFilter(agent: string, project: string | null): string {
  const base = `event.type == "agent.waiting" && has(event.actor) && event.actor.id == ${JSON.stringify(agent)}`;
  return project === null ? base : `${base} && event.project == ${JSON.stringify(project)}`;
}

/**
 * #190: the rows of the list that need a person now: for each agent in "needs input", its latest wait for a person
 * in the list (the list is newest first), in the project of the band when several are served. An answered wait
 * and a wait for instructions are not among them.
 */
export function waitRowKeys(items: Item[], rows: AgentRow[], project: string | null): Set<string> {
  const keys = new Set<string>();
  for (const r of rows) {
    if (r.state !== "needs-input") continue;
    const found = items.find((i) => waitsForPerson(i.event) && i.event.actor?.id === r.agent && (project === null || i.project === project));
    if (found) keys.add(itemKey(found));
  }
  return keys;
}

/**
 * #191: the adapters of a session's hook: run on the machine (`src/hook/hook.ts`)
 * or received over HTTP by `howl up` (`src/inbox/receive.ts`).
 */
const HOOK_ADAPTERS = new Set(["claude-code-hook", "claude-code-http"]);

/** #191: where an event comes from: a session's hook, a team's tool, another claim, howl itself, or a kind the page does not know. */
export type Origin = "hook" | "host" | "claim" | "howl" | "unknown";

export function originOf(e: LedgerEvent): Origin {
  const kind = e.source.kind as string;
  if (kind === "claimed") return HOOK_ADAPTERS.has(e.source.adapter) ? "hook" : "claim";
  if (kind === "observed") return e.source.adapter === "howl" ? "howl" : "host";
  return "unknown";
}

/** #191, part 1: the adapter, the kind, and the references the event holds into its source. */
export function partSource(item: Item): { adapter: string; kind: string; references: { k: string; v: string }[] } {
  const e = item.event;
  const t = texts.provenance.source;
  const kind = e.source.kind as string;
  const refs: [string, string | undefined][] = [
    [t.id, e.id],
    [t.session, e.session],
    [t.repo, e.repo],
    [t.change, e.change],
    [t.head, e.sha],
    [t.branch, e.branch],
    [t.task, e.task],
  ];
  return {
    adapter: e.source.adapter,
    kind: t.kinds[kind] ?? t.unknownKind(kind),
    references: refs.filter((r): r is [string, string] => r[1] !== undefined).map(([k, v]) => ({ k, v })),
  };
}

/** #191, part 2: the time the event states, whose clock that is, and the time howl received it, which no piece records yet. */
export function partTime(item: Item, timeZone?: string): { stated: string; by: string; received: string } {
  const e = item.event;
  return {
    stated: `${localTime(e.time, timeZone)} local · ${utcTime(e.time)}`,
    // A hook received over HTTP is made into an event by howl up, on its own clock.
    by: e.source.adapter === "claude-code-http" ? texts.provenance.time.by.http : texts.provenance.time.by[originOf(e)],
    received: texts.provenance.time.notRecorded,
  };
}

/**
 * #191, part 3: the actor, and the signature's result as `/api/line` gives it:
 * null when the line is not signed, undefined for a tool call, which is outside
 * the chain. A valid signature says under which issuer it holds (#202): the
 * pin the server was given, or only the issuer the ledger names, which anyone
 * who can append to the file could have written. Without a pin nothing reads
 * as known or pinned.
 */
export function partIdentity(item: Item, signature: LineSignature | null | undefined, issuer: LineIssuer): { actor: string; signature: string; limit: string | null; note: string | null } {
  const e = item.event;
  const t = texts.provenance.identity;
  const actor = e.actor ? `${e.actor.id} (${e.actor.kind === "person" ? "person, pseudonym" : e.actor.kind})` : t.noActor;
  const note = e.source.kind === "observed" && originOf(e) === "host" ? t.observed : null;
  // #216: the signature of an event of the log is not checked by the page yet.
  if (item.from === "log") return { actor, signature: t.onLog, limit: null, note };
  if (item.from !== "ledger" || signature === undefined) return { actor, signature: t.tool, limit: null, note };
  if (signature === null) return { actor, signature: t.notSigned, limit: null, note };
  // A key's issue or revocation is checked against the issuer key the line names, which must be the pin when there is one.
  const words = e.type === "key.issued" || e.type === "key.revoked" ? t.validIssuer : t.valid;
  // #202 (review): a key's issue or revocation names the issuer it holds (`data.issuer`), never the `sig.key` it carries: a revocation's is not held to it.
  const named = (e.data as Record<string, unknown> | undefined)?.issuer;
  const key = (e.type !== "key.issued" && e.type !== "key.revoked" ? signature.key : typeof named === "string" ? named : signature.key).slice(0, 12);
  // `pinned` with no id is never read as a pin: the words need the pin itself.
  const pin = issuer.pinned ? issuer.id : null;
  const valid = pin !== null ? words.pinned(key, pin) : words.open(key);
  return { actor, signature: signature.ok ? valid : t.invalid(signature.reason ?? "unknown"), limit: pin !== null ? t.limit.pinned : t.limit.open, note };
}

/** #191, part 5: what was dropped or not kept, by where the event comes from; and its data as kept, or null when it holds none. */
export function partKept(item: Item): { note: string; data: string | null } {
  const e = item.event;
  const data = e.data !== undefined && Object.keys(e.data).length > 0 ? JSON.stringify(e.data, null, 2) : null;
  return { note: texts.provenance.kept[originOf(e)], data };
}

/** #202: what the status bar says of the issuer, once: pinned or not. Nothing before the ledger's state is read. */
export function barIssuer(ledger: LedgerState | null): string | null {
  if (ledger === null) return null;
  return ledger.pinned ? texts.stream.bar.pinned : texts.stream.bar.notPinned;
}
