// `howl show`: the timeline of one assignment, from the hand-over to the merge.
//
// Which events belong together: an event belongs to the assignment when it
// names the task; or names a change of the task; or holds the branch or a
// commit of such a change; or belongs to a session that has such an event. An
// event that names another task, or a change of another task, never does.
//
// People are not measured one by one: a person is shown by a pseudonym, a wait
// for a person is shown with its length and without who, and nothing is summed
// per person. Everything is ordered and computed by `time`, never by the order
// of the lines.
// @code_class reading
import { traceText, type HeadTrace } from "./trace-text.ts";
import type { LedgerEvent } from "../ledger/schema.ts";
import { actingAgents, type Acting } from "./acting.ts";
import { claimOfHost, observed } from "./observed.ts";
import { waitsFor } from "./wait.ts";
import { roundText } from "./rounds.ts";
import { shortTime, zoneLine } from "./watch.ts";

type Actor = NonNullable<LedgerEvent["actor"]>;

export interface Wait {
  time: string;
  /** person: the agent stands still until a person answers. instructions: the agent is done and waits for more. */
  kind: "person" | "instructions";
  notification_type?: string;
  /** Until the next event of the session; null when there is none yet. */
  seconds: number | null;
}

export interface Session {
  session: string;
  actor?: Actor;
  /** The role the session named (#17). */
  role?: string;
  start: string;
  end: string | null;
  tools: Record<string, number>;
  files: string[];
  waits: Wait[];
  /** kept: the tool calls are in the activity file. no longer kept: they have expired. none: there were none. */
  activity: "kept" | "no longer kept" | "none";
}

export interface Head {
  sha: string;
  time: string;
  /** Who pushed it, when the code host does not say and one agent matches (#21). */
  by?: string;
  checks?: "passed" | "failed";
  checksTime?: string;
  /** #38: what the tests of this commit name, as the code host's repository shows it; none when it was not read. */
  trace?: HeadTrace;
}

export interface ChangePart {
  change: string;
  branch?: string;
  /** `by`: the agent behind a person's account, when one matches (#14). */
  opened?: { time: string; actor?: Actor; by?: string };
  heads: Head[];
  /** #28: the comments on the change that are not reviews. */
  comments: number;
}

export interface Round {
  reviews: { time: string; actor?: Actor; outcome: string; by?: string }[];
  /** The type of what came next: a new head, the merge, or none yet. */
  followedBy: string | null;
}

export type End = { state: "merged" | "closed"; time: string; actor?: Actor } | { state: "open" };

/** #51: an event of a task, a change or a review that a session or a script sent, and no adapter read. */
export interface Claim {
  time: string;
  type: string;
  task?: string;
  change?: string;
  actor?: Actor;
}

export interface Summary {
  from: string;
  to: string;
  open: boolean;
  seconds: number;
  /** How the time divides: every second belongs to exactly one part. */
  parts: { work: number; person: number; instructions: number; checks: number; review: number };
  reviewRounds: number;
  actors: Actor[];
}

export interface Shown {
  task?: string;
  changes: ChangePart[];
  events: LedgerEvent[];
  handover: { time: string; actor?: Actor; kind: string }[];
  sessions: Session[];
  reviews: Round[];
  /** Claimed, not seen at the code host: shown, and counted nowhere (#51). */
  claimed: Claim[];
  end: End;
  summary: Summary;
}

export interface Asked {
  kind?: "task" | "change";
  id: string;
}

/** `task:12`, `change:30`, or a bare number that is looked for as a task, then as a change. */
export function parseAsked(text: string): Asked {
  const match = /^(task|change):(.+)$/.exec(text);
  return match ? { kind: match[1] as Asked["kind"], id: match[2]! } : { id: text };
}

/**
 * The assignment's timeline from all events of the ledger and the activity
 * file, in the order of time. Null when nothing names the task or change.
 * `activityFrom` is the time of the oldest line of the activity file, or null
 * when it holds none.
 */
export function show(all: LedgerEvent[], asked: Asked, activityFrom: string | null): Shown | null {
  let task: string | undefined;
  const changes = new Set<string>();
  const namesTask = all.some((e) => e.task === asked.id);
  if (asked.kind === "change" || (asked.kind === undefined && !namesTask)) {
    if (!all.some((e) => e.change === asked.id)) return null;
    changes.add(asked.id);
    // The task of a change is the one the code host shows; a session's word for it only when the
    // host has none, and never a claim of a change or a review (#51).
    const named = all.filter((e) => e.change === asked.id && e.task !== undefined && !claimOfHost(e));
    task = (named.find(observed) ?? named[0])?.task;
  } else {
    if (!namesTask) return null;
    task = asked.id;
  }
  // A change is of the task when the code host or a session's own event names both; a claim of a
  // change or a review links nothing (#51).
  if (task !== undefined) for (const e of all) if (e.task === task && e.change !== undefined && !claimOfHost(e)) changes.add(e.change);

  const branches = new Set<string>();
  const shas = new Set<string>();
  for (const e of all) {
    // The branch and the commits of a change are what the code host shows. A session that names the
    // change itself may sit on another branch (a review in a folder of its own on the default branch).
    if (e.change !== undefined && changes.has(e.change) && e.source.kind === "observed") {
      if (e.branch) branches.add(e.branch);
      if (e.sha) shas.add(e.sha);
    }
  }
  // A claim of a task, a change or a review decides nothing here. It is shown, as a claim, with
  // the task it names and with the change it names, whatever else it names (#51).
  const claimHere = (e: LedgerEvent) =>
    claimOfHost(e) && ((task !== undefined && e.task === task) || (e.change !== undefined && changes.has(e.change)));
  const elsewhere = (e: LedgerEvent) =>
    !claimHere(e) && ((e.task !== undefined && e.task !== task) || (e.change !== undefined && !changes.has(e.change)));
  const direct = (e: LedgerEvent) =>
    (task !== undefined && e.task === task) ||
    (e.change !== undefined && changes.has(e.change)) ||
    (e.branch !== undefined && branches.has(e.branch)) ||
    (e.sha !== undefined && shas.has(e.sha));
  const sessions = new Set(all.filter((e) => e.session && !claimOfHost(e) && !elsewhere(e) && direct(e)).map((e) => e.session!));
  const events = all.filter((e) => !elsewhere(e) && (direct(e) || (e.session !== undefined && sessions.has(e.session))));
  if (events.length === 0) return null;

  const end = endOf(events);
  const acting = actingAgents(all);
  return {
    task,
    changes: changeParts(events, changes, acting),
    events,
    handover: events
      .filter((e) => e.type === "task.assigned" && observed(e))
      .map((e) => defined({ time: e.time, actor: e.actor, kind: e.source.kind })),
    sessions: sessionParts(events, activityFrom),
    reviews: rounds(events, acting),
    claimed: events.filter(claimOfHost).map((e) => defined({ time: e.time, type: e.type, task: e.task, change: e.change, actor: e.actor })),
    end,
    summary: summarise(events, end),
  };
}

function sessionParts(events: LedgerEvent[], activityFrom: string | null): Session[] {
  const by = new Map<string, LedgerEvent[]>();
  // A claim of what the code host owns is no part of a session, whatever it carries (#51).
  for (const e of events) if (e.session && !claimOfHost(e)) by.set(e.session, [...(by.get(e.session) ?? []), e]);
  return [...by.entries()]
    .map(([session, own]): Session => {
      const started = own.find((e) => e.type === "session.started");
      const ended = own.findLast((e) => e.type === "session.ended");
      const tools: Record<string, number> = {};
      const files = new Set<string>();
      for (const e of own.filter((x) => x.type === "tool.used")) {
        const tool = String(e.data?.tool ?? "unknown");
        tools[tool] = (tools[tool] ?? 0) + 1;
        if (tool !== "Bash" && typeof e.data?.target === "string") files.add(e.data.target);
      }
      const waits = own
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.type === "agent.waiting")
        .map(({ e, i }): Wait => {
          const next = own[i + 1];
          const type = typeof e.data?.notification_type === "string" ? e.data.notification_type : undefined;
          return defined({
            time: e.time,
            kind: waitsFor(e),
            notification_type: type,
            seconds: next ? seconds(e.time, next.time) : null,
          });
        });
      const start = (started ?? own[0]!).time;
      const last = (ended ?? own.at(-1)!).time;
      const activity: Session["activity"] =
        Object.keys(tools).length > 0
          ? "kept"
          : activityFrom === null || Date.parse(activityFrom) > Date.parse(last)
            ? "no longer kept"
            : "none";
      return defined({ session, actor: own.find((e) => e.actor)?.actor, role: own.findLast((e) => e.role !== undefined)?.role, start, end: ended?.time ?? null, tools, files: [...files].sort(), waits, activity });
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

function changeParts(events: LedgerEvent[], changes: Set<string>, acting: Map<string, Acting> = new Map()): ChangePart[] {
  const parts: ChangePart[] = [];
  for (const change of changes) {
    const own = events.filter((e) => e.change === change);
    // #51: the opening, the heads and the comments are what the code host showed.
    const seen = own.filter(observed);
    const opened = seen.find((e) => e.type === "change.opened");
    const heads: Head[] = seen
      .filter((e) => (e.type === "change.opened" || e.type === "change.updated") && e.sha)
      .map((e) => defined({ sha: e.sha!, time: e.time, by: e.type === "change.updated" ? acting.get(e.id)?.agent : undefined }));
    for (const head of heads) {
      const checks = own.find((e) => (e.type === "checks.passed" || e.type === "checks.failed") && e.sha === head.sha);
      if (checks) {
        head.checks = checks.type === "checks.passed" ? "passed" : "failed";
        head.checksTime = checks.time;
      }
      // #38: only what was read from the repository counts, never a claim of a session.
      const read = seen.find((e) => e.type === "trace.read" && e.sha === head.sha);
      const data = read?.data as { covered?: unknown; touched?: unknown; tests?: unknown; covering?: unknown } | undefined;
      if (data !== undefined && Array.isArray(data.covered) && Array.isArray(data.touched) && typeof data.tests === "number") {
        head.trace = defined({ covered: data.covered.map(String), touched: data.touched.map(String), tests: data.tests, covering: typeof data.covering === "number" ? data.covering : undefined });
      }
    }
    parts.push(
      defined({
        change,
        branch: seen.find((e) => e.branch)?.branch,
        opened: opened ? defined({ time: opened.time, actor: opened.actor, by: acting.get(opened.id)?.agent }) : undefined,
        heads,
        comments: seen.filter((e) => e.type === "change.commented").length,
      }),
    );
  }
  return parts.sort((a, b) => Date.parse(a.opened?.time ?? a.heads[0]?.time ?? "") - Date.parse(b.opened?.time ?? b.heads[0]?.time ?? ""));
}

/** Reviews as rounds: a review after a new head commit starts a new round. From observed events only (#51). */
function rounds(all: LedgerEvent[], acting: Map<string, Acting> = new Map()): Round[] {
  const events = all.filter(observed);
  const found: Round[] = [];
  let current: Round | null = null;
  let newHead = false;
  let lastReview = -1;
  for (const [i, e] of events.entries()) {
    if (e.type.startsWith("review.")) {
      if (current === null || newHead) {
        current = { reviews: [], followedBy: null };
        found.push(current);
        newHead = false;
      }
      current.reviews.push(defined({ time: e.time, actor: e.actor, outcome: e.type.slice("review.".length), by: acting.get(e.id)?.agent }));
      lastReview = i;
    } else if (e.type === "change.updated" && current !== null) {
      newHead = true;
    }
    if (current && i > lastReview && current.followedBy === null && /^change\.(updated|merged|closed)$/.test(e.type)) {
      current.followedBy = e.type;
    }
  }
  return found;
}

/** The end of the assignment as the code host showed it: a claimed merge or closing ends nothing (#51). */
function endOf(events: LedgerEvent[]): End {
  const merged = events.find((e) => e.type === "change.merged" && observed(e));
  if (merged) return defined({ state: "merged" as const, time: merged.time, actor: merged.actor });
  // The changes the code host showed: one that only a claim names keeps nothing open.
  const changes = new Set(events.filter((e) => e.change && observed(e)).map((e) => e.change));
  const closed = events.filter((e) => e.type === "change.closed" && observed(e));
  // Closed only when every change of the assignment is closed without merge.
  if (closed.length > 0 && new Set(closed.map((e) => e.change)).size === changes.size) {
    const last = closed.at(-1)!;
    return defined({ state: "closed" as const, time: last.time, actor: last.actor });
  }
  return { state: "open" };
}

/**
 * From the hand-over to the merge, every second in exactly one part, by the
 * state after the last event before it. The agent working comes first; then a
 * wait for a person; then what the change waits for; then an idle agent
 * waiting for instructions. What is left is work, by whoever does it.
 *
 * #51: a claim of what the code host owns moves nothing here: not the start,
 * not the state of the change, not the end, and not who took part.
 */
function summarise(all: LedgerEvent[], end: End): Summary {
  const events = all.filter((e) => !claimOfHost(e));
  if (events.length === 0) {
    // Only claims name the assignment: nothing was seen, so nothing is measured.
    const at = all[0]!.time;
    return { from: at, to: at, open: true, seconds: 0, parts: { work: 0, person: 0, instructions: 0, checks: 0, review: 0 }, reviewRounds: 0, actors: [] };
  }
  const handover = events.find((e) => e.type === "task.assigned");
  // #22: without a hand-over, from the first sign of work, not from when the task was opened (it may wait for days).
  const work = events.find((e) => e.type.startsWith("session.") || e.type.startsWith("change.") || e.type === "tool.used");
  const from = (handover ?? work ?? events[0]!).time;
  const to = end.state === "open" ? events.at(-1)!.time : end.time;
  const parts = { work: 0, person: 0, instructions: 0, checks: 0, review: 0 };
  const checked = new Set(events.filter((e) => e.type.startsWith("checks.") && e.sha).map((e) => e.sha!));

  // Until a session of an agent is seen, nothing is known of it: the change says what is waited for.
  let agent: "unknown" | "working" | "blocked" | "idle" = "unknown";
  let change: "none" | "checks" | "review" | "approved" | "done" = "none";
  const part = (): keyof typeof parts => {
    if (agent === "working") return "work";
    if (agent === "blocked") return "person";
    if (change === "checks") return "checks";
    if (change === "review") return "review";
    if (change === "approved") return "person";
    if (agent === "idle") return "instructions";
    return "work";
  };

  const start = Date.parse(from);
  const stop = Date.parse(to);
  let at = start;
  for (const e of events) {
    const t = Date.parse(e.time);
    if (t > stop) break;
    if (t > at) {
      parts[part()] += (t - at) / 1000;
      at = t;
    }
    switch (e.type) {
      case "session.started":
      case "tool.used":
        agent = "working";
        break;
      case "agent.waiting":
        agent = waitsFor(e) === "instructions" ? "idle" : "blocked";
        break;
      case "session.stopped":
      case "session.ended":
        agent = "idle";
        break;
      case "change.opened":
      case "change.updated":
        change = e.sha && checked.has(e.sha) ? "checks" : "review";
        break;
      case "checks.passed":
        change = "review";
        break;
      case "checks.failed":
      case "review.changes_requested":
      case "review.commented":
        change = "none";
        break;
      case "review.approved":
        change = "approved";
        break;
      case "change.merged":
      case "change.closed":
        change = "done";
        break;
    }
  }
  if (stop > at) parts[part()] += (stop - at) / 1000;

  const actors = new Map<string, Actor>();
  for (const e of events) if (e.actor) actors.set(`${e.actor.kind}:${e.actor.id}`, e.actor);
  return {
    from,
    to,
    open: end.state === "open",
    seconds: (stop - start) / 1000,
    parts,
    reviewRounds: rounds(all).length,
    actors: [...actors.values()],
  };
}

/** The timeline as text for a person to read. */
export function render(shown: Shown, options: { utc?: boolean } = {}): string {
  const out: string[] = [];
  const who = (a?: Actor) => a?.id ?? "someone";
  const t = (time: string) => shortTime(time, options.utc ?? false);
  const by = (agent: string | undefined, actor?: Actor) => (agent === undefined ? who(actor) : `${agent} via ${who(actor)}`);
  const title = shown.task !== undefined ? `Task ${shown.task}` : `Change ${shown.changes[0]?.change}`;
  out.push(`${title}: ${shown.end.state}`, "");

  out.push("Hand-over");
  const opened = shown.events.find((e) => e.type === "task.opened" && e.task === shown.task && observed(e));
  if (opened) out.push(`  ${t(opened.time)}  ${opened.source.kind.padEnd(8)}  task opened by ${who(opened.actor)}`);
  if (shown.handover.length === 0) out.push("  given to no one in the ledger");
  for (const h of shown.handover) out.push(`  ${t(h.time)}  ${h.kind.padEnd(8)}  given to ${who(h.actor)}`);

  out.push("", "Sessions");
  if (shown.sessions.length === 0) out.push("  none in the ledger");
  for (const s of shown.sessions) {
    const span = s.end ? `${t(s.start)} to ${t(s.end)}, ${duration(seconds(s.start, s.end))}` : `${t(s.start)}, not ended`;
    out.push(`  session ${s.session}  claimed  ${who(s.actor)}${s.role ? `  role ${s.role}` : ""}  ${span}`);
    if (s.activity === "kept") {
      const tools = Object.entries(s.tools)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tool, n]) => `${tool} ${n}`)
        .join(", ");
      out.push(`    tool calls: ${tools}`);
      if (s.files.length > 0) out.push(`    files: ${s.files.join(", ")}`);
    } else if (s.activity === "no longer kept") {
      out.push("    the activity is no longer kept");
    } else {
      out.push("    no tool calls");
    }
    for (const w of s.waits) {
      const what = w.kind === "person" ? "waited for a person" : "waited for instructions";
      out.push(`    ${t(w.time)}  ${what}${w.notification_type ? ` (${w.notification_type})` : ""}: ${w.seconds === null ? "still waiting" : duration(w.seconds)}`);
    }
  }

  for (const c of shown.changes) {
    out.push("", `Change ${c.change}${c.branch ? `  branch ${c.branch}` : ""}`);
    if (c.opened) out.push(`  ${t(c.opened.time)}  observed  opened by ${by(c.opened.by, c.opened.actor)}`);
    for (const [i, h] of c.heads.entries()) {
      const checks = h.checks ? `, checks ${h.checks} at ${t(h.checksTime!)}` : "";
      out.push(`  ${t(h.time)}  observed  ${i === 0 ? "head" : "new head"} ${h.sha.slice(0, 7)}${h.by ? ` by ${h.by} (matched)` : ""}${checks}`);
      out.push(`      ${traceText(h.trace)}`);
    }
    if (c.comments > 0) out.push(`  comments: ${c.comments}, not counted as reviews`);
  }

  out.push("", "Reviews");
  if (shown.reviews.length === 0) out.push("  none");
  for (const [i, r] of shown.reviews.entries()) {
    const reviews = roundText(r.reviews);
    const next = r.followedBy === null ? "" : `; followed by ${FOLLOWED[r.followedBy] ?? r.followedBy}`;
    out.push(`  round ${i + 1}: ${reviews}${next}`);
  }

  if (shown.claimed.length > 0) {
    out.push("", "Claimed, not seen at the code host");
    for (const c of shown.claimed) {
      const on = c.change !== undefined ? ` on change ${c.change}` : c.task !== undefined ? ` on task ${c.task}` : "";
      out.push(`  ${t(c.time)}  claimed  ${c.type}${on} by ${who(c.actor)}`);
    }
  }

  out.push("", "End");
  out.push(shown.end.state === "open" ? "  open" : `  ${t(shown.end.time)}  observed  ${shown.end.state} by ${who(shown.end.actor)}`);
  const closed = shown.events.findLast((e) => e.type === "task.closed" && e.task === shown.task && observed(e));
  if (closed) out.push(`  ${t(closed.time)}  ${closed.source.kind.padEnd(8)}  task closed by ${who(closed.actor)}`);

  const s = shown.summary;
  out.push("", "Summary");
  const from = shown.handover.length > 0 ? "hand-over" : "first event";
  out.push(`  ${s.open ? `${from} to the last event, still open` : `${from} to the end`}: ${duration(s.seconds)}`);
  out.push(
    `  work ${duration(s.parts.work)}, waiting for a person ${duration(s.parts.person)}, waiting for instructions ${duration(
      s.parts.instructions,
    )}, waiting for checks ${duration(s.parts.checks)}, waiting for review ${duration(s.parts.review)}`,
  );
  out.push(`  review rounds: ${s.reviewRounds}`);
  out.push(`  taking part: ${s.actors.map((a) => a.id).join(", ")}`);
  if (!options.utc) out.push("", zoneLine());
  return out.join("\n");
}

const FOLLOWED: Record<string, string> = {
  "change.updated": "a new head",
  "change.merged": "the merge",
  "change.closed": "closing the change",
};

function seconds(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 1000;
}

function duration(total: number): string {
  const s = Math.round(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return rest > 0 ? `${m}m ${rest}s` : `${m}m`;
  return `${rest}s`;
}

function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
