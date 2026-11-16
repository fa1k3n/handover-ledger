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
  /** #117: in the view of a change, the other changes that hold a part of this session; its start and end are then those of this change's part. */
  also?: string[];
}

export interface Head {
  sha: string;
  time: string;
  /** Who pushed it, when the code host does not say and one agent matches (#21). */
  by?: string;
  checks?: "passed" | "failed";
  checksTime?: string;
}

export interface ChangePart {
  change: string;
  branch?: string;
  /** `by`: the agent behind a person's account, when one matches (#14). */
  opened?: { time: string; actor?: Actor; by?: string };
  heads: Head[];
  /** #28: the comments on the change that are not reviews. */
  comments: number;
  /** #117: the end of this change: its own merge or closing, as the code host showed it. */
  end: End;
}

export interface Round {
  /** #117: the change the round is of. A new head of one change ends no round of another. */
  change?: string;
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
  /** #117: what was asked for. Asked for a change, `changes` holds that change alone. */
  asked: "task" | "change";
  changes: ChangePart[];
  /** #117: the task's other changes, named and not shown. Empty when a task is asked for. */
  otherChanges: string[];
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
  const asksChange = asked.kind === "change" || (asked.kind === undefined && !all.some((e) => e.task === asked.id));
  if (asksChange) {
    if (!all.some((e) => e.change === asked.id)) return null;
    // The task of a change is the one the code host shows; a session's word for it only when the
    // host has none, and never a claim of a change or a review (#51).
    const named = all.filter((e) => e.change === asked.id && e.task !== undefined && !claimOfHost(e));
    task = (named.find(observed) ?? named[0])?.task;
  } else {
    task = asked.id;
  }
  // A change is of the task when the code host or a session's own event names both; a claim of a
  // change or a review links nothing (#51).
  const linked = new Set<string>();
  if (task !== undefined) for (const e of all) if (e.task === task && e.change !== undefined && !claimOfHost(e)) linked.add(e.change);
  const changes = asksChange ? new Set([asked.id]) : linked;

  const found = asksChange ? ofOneChange(all, asked.id, task) : ofTask(all, task!, changes);
  if (found === null || found.events.length === 0) return null;
  const { events, sessions } = found;

  const acting = actingAgents(all);
  const first = firstChange(all, linked);
  const fromHandover = !asksChange || first === undefined || first === asked.id;
  const parts = changeParts(events, changes, acting);
  // The end of a change that is asked for is its own. A task with several changes keeps the end it had
  // (the first merge) until #118.
  const end = asksChange ? (parts[0]?.end ?? endOf(events)) : endOf(events);
  return {
    task,
    asked: asksChange ? "change" : "task",
    changes: parts,
    otherChanges: asksChange ? [...linked].filter((c) => c !== asked.id) : [],
    events,
    handover: events
      .filter((e) => e.type === "task.assigned" && observed(e))
      .map((e) => defined({ time: e.time, actor: e.actor, kind: e.source.kind })),
    sessions: sessionParts(events, activityFrom, found.whole),
    reviews: rounds(events, acting),
    claimed: events.filter(claimOfHost).map((e) => defined({ time: e.time, type: e.type, task: e.task, change: e.change, actor: e.actor })),
    end,
    // The first change of a task is measured from the hand-over; a later one from its own first event.
    summary: summarise(events, end, fromHandover),
  };
}

interface Found {
  events: LedgerEvent[];
  sessions: Set<string>;
  /** In the view of one change: every event of each session, the part outside the view too. */
  whole?: Map<string, { events: LedgerEvent[]; selected: Set<LedgerEvent>; also: string[] }>;
}

/** The assignment of a task: what names it or one of its changes, the events on their branches and commits, and those sessions. */
function ofTask(all: LedgerEvent[], task: string, changes: Set<string>): Found | null {
  if (!all.some((e) => e.task === task)) return null;
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
    claimOfHost(e) && (e.task === task || (e.change !== undefined && changes.has(e.change)));
  const elsewhere = (e: LedgerEvent) =>
    !claimHere(e) && ((e.task !== undefined && e.task !== task) || (e.change !== undefined && !changes.has(e.change)));
  const direct = (e: LedgerEvent) =>
    e.task === task ||
    (e.change !== undefined && changes.has(e.change)) ||
    (e.branch !== undefined && branches.has(e.branch)) ||
    (e.sha !== undefined && shas.has(e.sha));
  const sessions = new Set(all.filter((e) => e.session && !claimOfHost(e) && !elsewhere(e) && direct(e)).map((e) => e.session!));
  const events = all.filter((e) => !elsewhere(e) && (direct(e) || (e.session !== undefined && sessions.has(e.session))));
  return { events, sessions };
}

/**
 * #117: the change that was asked for, alone. Selected are the events that name it, the events
 * on its commits, its sessions, and the task's own events (opened, given, closed). An event that
 * names another change is not selected. An event of a session that names neither a change nor a
 * commit is of the change whose life holds its time.
 */
function ofOneChange(all: LedgerEvent[], change: string, task: string | undefined): Found {
  const place = placer(all);
  const claimHere = (e: LedgerEvent) => claimOfHost(e) && ((task !== undefined && e.task === task) || e.change === change);
  const elsewhere = (e: LedgerEvent) =>
    (e.change !== undefined && e.change !== change) || (!claimHere(e) && e.task !== undefined && e.task !== task);
  // Of this change by its name, by its commit or by its time; null where nothing places the event.
  const mine = (e: LedgerEvent): boolean | null => {
    const where = place(e);
    return where === null ? null : where.includes(change);
  };
  const direct = (e: LedgerEvent): boolean => {
    if (e.change === change) return true;
    if (claimOfHost(e)) return claimHere(e);
    // The task's own: opened, given, closed.
    if (task !== undefined && e.task === task && e.change === undefined && e.session === undefined) return true;
    const here = mine(e);
    // A session event of the task that nothing places stays with the task.
    return here === null ? task !== undefined && e.task === task : here;
  };
  const sessions = new Set(all.filter((e) => e.session && !claimOfHost(e) && !elsewhere(e) && direct(e)).map((e) => e.session!));
  const events = all.filter((e) => {
    if (elsewhere(e)) return false;
    if (direct(e)) return true;
    // The rest of a session of the change: what is placed elsewhere in time is not of this change.
    return e.session !== undefined && sessions.has(e.session) && !claimOfHost(e) && mine(e) === null;
  });
  const selected = new Set(events);
  const whole = new Map<string, { events: LedgerEvent[]; selected: Set<LedgerEvent>; also: string[] }>();
  for (const session of sessions) {
    const own = all.filter((e) => e.session === session && !claimOfHost(e));
    const also: string[] = [];
    for (const e of own) {
      if (selected.has(e)) continue;
      for (const other of place(e) ?? []) if (other !== change && !also.includes(other)) also.push(other);
    }
    whole.set(session, { events: own, selected, also });
  }
  return { events, sessions, whole };
}

/**
 * Where an event is placed among the changes: by the change it names, by the commit it sits on, or by
 * its time on its branch. A branch with one change is wholly that change's. Where it has more, the
 * life of a change runs from the end of the change before it (from the beginning, for the first) to
 * its own end, and an event after the last change has ended is of none. Null: nothing places it
 * (no branch, and no change or commit known).
 */
function placer(all: LedgerEvent[]): (e: LedgerEvent) => string[] | null {
  // What the code host showed: the branch, the commits and the end of each change.
  const first = new Map<string, number>();
  const ended = new Map<string, number>();
  const endedBy = new Map<string, "merged" | "closed">();
  const onBranch = new Map<string, string[]>();
  const bySha = new Map<string, string[]>();
  for (const e of all) {
    if (e.change === undefined || !observed(e)) continue;
    const t = Date.parse(e.time);
    if (!first.has(e.change)) first.set(e.change, t);
    // The first merge, or else the last closing, as `endOfChange` has it.
    if ((e.type === "change.merged" || e.type === "change.closed") && endedBy.get(e.change) !== "merged") {
      ended.set(e.change, t);
      endedBy.set(e.change, e.type === "change.merged" ? "merged" : "closed");
    }
    if (e.branch) {
      const list = onBranch.get(e.branch) ?? [];
      if (!list.includes(e.change)) onBranch.set(e.branch, [...list, e.change]);
    }
    if (e.sha) {
      const list = bySha.get(e.sha) ?? [];
      if (!list.includes(e.change)) bySha.set(e.sha, [...list, e.change]);
    }
  }
  const lives = new Map<string, { change: string; after: number; until: number }[]>();
  for (const [branch, list] of onBranch) {
    // `list` is in the order of the first event of each change, as `all` is in the order of time.
    const ordered = list;
    // Where one change ends and the next begins: the end of the first, or the opening of the next when that comes sooner.
    lives.set(
      branch,
      ordered.map((change, i) => {
        if (ordered.length === 1) return { change, after: -Infinity, until: Infinity };
        const edge = (j: number) => Math.min(ended.get(ordered[j]!) ?? Infinity, first.get(ordered[j + 1]!)!);
        return { change, after: i === 0 ? -Infinity : edge(i - 1), until: i < ordered.length - 1 ? edge(i) : (ended.get(change) ?? Infinity) };
      }),
    );
  }
  // An event that names neither a branch nor a change rides with the branch its session was last on.
  const branchOf = new Map<LedgerEvent, string | undefined>();
  const lastBranch = new Map<string, string>();
  const firstBranch = new Map<string, string>();
  for (const e of all) if (e.session && e.branch && !firstBranch.has(e.session)) firstBranch.set(e.session, e.branch);
  for (const e of all) {
    if (e.session && e.branch) lastBranch.set(e.session, e.branch);
    branchOf.set(e, e.branch ?? (e.session ? (lastBranch.get(e.session) ?? firstBranch.get(e.session)) : undefined));
  }
  return (e) => {
    if (e.change !== undefined) return [e.change];
    const onCommit = e.sha !== undefined ? bySha.get(e.sha) : undefined;
    if (onCommit) return onCommit;
    const branch = branchOf.get(e) ?? e.branch;
    const list = branch !== undefined ? lives.get(branch) : undefined;
    if (!list) return null;
    const t = Date.parse(e.time);
    return list.filter((l) => t > l.after && t <= l.until).map((l) => l.change);
  };
}

/** The first change of the task: the first that the code host showed opened. */
function firstChange(all: LedgerEvent[], changes: Set<string>): string | undefined {
  let found: string | undefined;
  let at = Infinity;
  for (const e of all) {
    if (e.type !== "change.opened" || !observed(e) || e.change === undefined || !changes.has(e.change)) continue;
    const t = Date.parse(e.time);
    if (t < at) {
      at = t;
      found = e.change;
    }
  }
  return found;
}

function sessionParts(events: LedgerEvent[], activityFrom: string | null, whole?: Found["whole"]): Session[] {
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
      // #117: of a session that goes on in another change, this is a part. What comes after it is the part's end.
      const rest = whole?.get(session);
      const last = (ended ?? own.at(-1)!).time;
      const goesOn = rest !== undefined && rest.events.some((e) => !rest.selected.has(e) && Date.parse(e.time) > Date.parse(own.at(-1)!.time));
      const waits = own
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.type === "agent.waiting")
        .map(({ e, i }): Wait => {
          // The session's next event, in this part or, at its end, in the part that follows.
          const next = own[i + 1] ?? rest?.events.find((x) => !rest.selected.has(x) && Date.parse(x.time) > Date.parse(e.time));
          const type = typeof e.data?.notification_type === "string" ? e.data.notification_type : undefined;
          return defined({
            time: e.time,
            kind: waitsFor(e),
            notification_type: type,
            seconds: next ? seconds(e.time, next.time) : null,
          });
        });
      const start = (started ?? own[0]!).time;
      const activity: Session["activity"] =
        Object.keys(tools).length > 0
          ? "kept"
          : activityFrom === null || Date.parse(activityFrom) > Date.parse(last)
            ? "no longer kept"
            : "none";
      return defined({
        session,
        actor: own.find((e) => e.actor)?.actor,
        role: own.findLast((e) => e.role !== undefined)?.role,
        start,
        end: ended?.time ?? (goesOn ? last : null),
        tools,
        files: [...files].sort(),
        waits,
        activity,
        also: rest !== undefined && rest.also.length > 0 ? rest.also : undefined,
      });
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
    }
    parts.push(
      defined({
        change,
        branch: seen.find((e) => e.branch)?.branch,
        opened: opened ? defined({ time: opened.time, actor: opened.actor, by: acting.get(opened.id)?.agent }) : undefined,
        heads,
        comments: seen.filter((e) => e.type === "change.commented").length,
        end: endOfChange(own),
      }),
    );
  }
  return parts.sort((a, b) => Date.parse(a.opened?.time ?? a.heads[0]?.time ?? "") - Date.parse(b.opened?.time ?? b.heads[0]?.time ?? ""));
}

/**
 * Reviews as rounds: a review after a new head commit starts a new round. From observed events only (#51).
 * #117: made per change, so a new head of one change ends no round of another.
 */
function rounds(all: LedgerEvent[], acting: Map<string, Acting> = new Map()): Round[] {
  const events = all.filter(observed);
  // An event that names no change belongs to the one change there is, when there is only one.
  const named = new Set(events.flatMap((e) => (e.change === undefined ? [] : [e.change])));
  const only = named.size === 1 ? [...named][0] : undefined;
  const groups = new Map<string, LedgerEvent[]>();
  for (const e of events) {
    const key = e.change ?? only ?? "";
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const found: Round[] = [];
  for (const [change, own] of groups) found.push(...roundsOf(own, acting, change === "" ? undefined : change));
  return found;
}

function roundsOf(events: LedgerEvent[], acting: Map<string, Acting>, change: string | undefined): Round[] {
  const found: Round[] = [];
  let current: Round | null = null;
  let newHead = false;
  let lastReview = -1;
  for (const [i, e] of events.entries()) {
    if (e.type.startsWith("review.")) {
      if (current === null || newHead) {
        current = defined({ change, reviews: [], followedBy: null });
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

/** The end of one change as the code host showed it: its first merge, or else its last closing. */
function endOfChange(own: LedgerEvent[]): End {
  const merged = own.find((e) => e.type === "change.merged" && observed(e));
  if (merged) return defined({ state: "merged" as const, time: merged.time, actor: merged.actor });
  const closed = own.findLast((e) => e.type === "change.closed" && observed(e));
  if (closed) return defined({ state: "closed" as const, time: closed.time, actor: closed.actor });
  return { state: "open" };
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
function summarise(all: LedgerEvent[], end: End, fromHandover: boolean): Summary {
  const events = all.filter((e) => !claimOfHost(e));
  if (events.length === 0) {
    // Only claims name the assignment: nothing was seen, so nothing is measured.
    const at = all[0]!.time;
    return { from: at, to: at, open: true, seconds: 0, parts: { work: 0, person: 0, instructions: 0, checks: 0, review: 0 }, reviewRounds: 0, actors: [] };
  }
  const handover = events.find((e) => e.type === "task.assigned");
  // #22: without a hand-over, from the first sign of work, not from when the task was opened (it may wait for days).
  const work = events.find((e) => e.type.startsWith("session.") || e.type.startsWith("change.") || e.type === "tool.used");
  // #117: a later change of a task is measured from its own first event. The hand-over is the task's
  // first change's, and the life of the changes before it is not its work.
  const own = events.find((e) => !e.type.startsWith("task."));
  const from = (fromHandover ? (handover ?? work ?? events[0]!) : (own ?? events[0]!)).time;
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
  const one = shown.asked === "change";
  const change = shown.changes[0]?.change;
  const title = one ? (shown.task !== undefined ? `Change ${change} of task ${shown.task}` : `Change ${change}`) : shown.task !== undefined ? `Task ${shown.task}` : `Change ${change}`;
  out.push(`${title}: ${shown.end.state}`);
  if (shown.task !== undefined && shown.otherChanges.length > 0) out.push(otherChangesText(shown.task, shown.otherChanges));
  out.push("", "Hand-over");
  const opened = shown.events.find((e) => e.type === "task.opened" && e.task === shown.task && observed(e));
  if (opened) out.push(`  ${t(opened.time)}  ${opened.source.kind.padEnd(8)}  task opened by ${who(opened.actor)}`);
  if (shown.handover.length === 0) out.push("  given to no one in the ledger");
  for (const h of shown.handover) out.push(`  ${t(h.time)}  ${h.kind.padEnd(8)}  given to ${who(h.actor)}`);
  // #117: the task's closing is the task's, not the change's end: it stands with the task's opening and giving.
  const closed = shown.events.findLast((e) => e.type === "task.closed" && e.task === shown.task && observed(e));
  if (closed && one) out.push(`  ${t(closed.time)}  ${closed.source.kind.padEnd(8)}  task closed by ${who(closed.actor)}`);

  out.push("", "Sessions");
  if (shown.sessions.length === 0) out.push("  none in the ledger");
  for (const s of shown.sessions) {
    const span = s.end ? `${t(s.start)} to ${t(s.end)}, ${duration(seconds(s.start, s.end))}` : `${t(s.start)}, not ended`;
    const also = s.also !== undefined && s.also.length > 0 ? `  also under change${s.also.length === 1 ? "" : "s"} ${s.also.join(", ")}` : "";
    out.push(`  session ${s.session}  claimed  ${who(s.actor)}${s.role ? `  role ${s.role}` : ""}  ${span}${also}`);
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
    }
    if (c.comments > 0) out.push(`  comments: ${c.comments}, not counted as reviews`);
  }

  out.push("", "Reviews");
  if (shown.reviews.length === 0) out.push("  none");
  const several = shown.changes.length > 1;
  const counted = new Map<string, number>();
  for (const r of shown.reviews) {
    const key = r.change ?? "";
    counted.set(key, (counted.get(key) ?? 0) + 1);
    const reviews = roundText(r.reviews);
    const next = r.followedBy === null ? "" : `; followed by ${FOLLOWED[r.followedBy] ?? r.followedBy}`;
    // #117: where the view has more than one change, a round says which change it is of.
    const of = several && r.change !== undefined ? ` of change ${r.change}` : "";
    out.push(`  round ${counted.get(key)}${of}: ${reviews}${next}`);
  }

  if (shown.claimed.length > 0) {
    out.push("", "Claimed, not seen at the code host");
    for (const c of shown.claimed) {
      const on = c.change !== undefined ? ` on change ${c.change}` : c.task !== undefined ? ` on task ${c.task}` : "";
      out.push(`  ${t(c.time)}  claimed  ${c.type}${on} by ${who(c.actor)}`);
    }
  }

  out.push("", "End");
  const ending = (e: End) => (e.state === "open" ? "open" : `${t(e.time)}  observed  ${e.state} by ${who(e.actor)}`);
  // #117: where the view has more than one change, each end says which change it is of.
  if (several) for (const c of shown.changes) out.push(`  change ${c.change}  ${ending(c.end)}`);
  else out.push(`  ${ending(shown.end)}`);
  if (closed && !one) out.push(`  ${t(closed.time)}  ${closed.source.kind.padEnd(8)}  task closed by ${who(closed.actor)}`);

  const s = shown.summary;
  out.push("", "Summary");
  // #117: a later change is measured from its own first event, not from the hand-over.
  const from = shown.handover.some((h) => h.time === s.from) ? "hand-over" : "first event";
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

/** `Task 40 has another change: 63`: the one line that names the changes of a task that were not asked for. */
function otherChangesText(task: string, others: string[]): string {
  return `Task ${task} has ${others.length === 1 ? "another change" : "other changes"}: ${others.join(", ")}`;
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
