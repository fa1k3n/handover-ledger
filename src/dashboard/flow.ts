// The flow graph of the change view: one change or task as lanes and arrows (#192). Only what the
// events of the change hold is drawn: no arrow, lane or time that no event gives. No DOM, so
// node:test can run it.
// @code_class reading
import type { LedgerEvent } from "../ledger/schema.ts";
import { accountsGone, assignee, giver } from "../read/assignee.ts";
import { byTime } from "../read/order.ts";
import type { Shown } from "../read/show.ts";
import { duration } from "../read/words.ts";
import { waitsFor } from "../read/wait.ts";
import { establishedBy, waitSpan } from "./format.ts";
import { texts } from "./texts.ts";

const t = texts.flow;

export type LaneKind = "person" | "agent" | "host" | "checks" | "gone";

export interface Lane {
  /** `host`, `checks`, `gone`, or `person:<id>`, `agent:<id>`. */
  key: string;
  kind: LaneKind;
  label: string;
}

/** Who established the row: an observed event is solid, a claimed one dashed, a kind the page does not know dotted. */
export type Origin = "observed" | "claimed" | "unknown";
export type Line = "solid" | "dashed" | "dotted";

export interface Row {
  /** `note`: a wait for a person, in one lane (`from` and `to` are that lane). `arrow`: a handover; `from` and `to` are one lane for an event that names no other (a mark in the lane). */
  kind: "arrow" | "note";
  time: string;
  from: string;
  to: string;
  label: string;
  origin: Origin;
  line: Line;
  /** The agent howl matched to this observed event from a session's time window: howl's reading and a claim, never the sender. */
  matched?: string;
  event: LedgerEvent;
}

export interface Flow {
  lanes: Lane[];
  rows: Row[];
}

type Member = NonNullable<LedgerEvent["actor"]>;

const HOST: Lane = { key: "host", kind: "host", label: t.lanes.host };
const CHECKS: Lane = { key: "checks", kind: "checks", label: t.lanes.checks };

const memberLane = (m: Member): Lane => ({ key: `${m.kind}:${m.id}`, kind: m.kind, label: m.id });
const agentLane = (name: string): Lane => memberLane({ kind: "agent", id: name });

type Step = keyof typeof t.steps | keyof typeof t.reviews;

/** What each type of event is drawn as: its step; the types that are not here are not drawn. */
const STEPS: Partial<Record<LedgerEvent["type"], Step>> = {
  "task.assigned": "task-given",
  "task.unassigned": "task-taken-back",
  "change.opened": "opened",
  "change.updated": "new-head",
  "checks.passed": "checks-passed",
  "checks.failed": "checks-failed",
  "checks.none": "checks-none",
  "checks.unfinished": "checks-unfinished",
  "review.approved": "approved",
  "review.changes_requested": "changes-asked",
  "review.commented": "review-comment",
  "change.merged": "merged",
  "change.closed": "closed",
  "change.reopened": "reopened",
};

const isReviewStep = (step: Step): step is keyof typeof t.reviews => step === "approved" || step === "changes-asked" || step === "review-comment";

const WITH_HEAD = new Set<Step>(["opened", "new-head", "checks-passed", "checks-failed", "checks-none", "checks-unfinished"]);

function originOf(e: LedgerEvent): Origin {
  const code = establishedBy(e.source.kind).code;
  return code === "SOURCE" ? "observed" : code === "CLAIM" ? "claimed" : "unknown";
}

const LINES: Record<Origin, Line> = { observed: "solid", claimed: "dashed", unknown: "dotted" };

/**
 * The change as a flow graph, from what `show` gives: its events, and the agents it matched to an observed opening, head or
 * review from a session's time window. An observed event is drawn from what the code host saw: the account it names, or the
 * code host where none is named (and the label says so). A matched agent is never the sender: it is said in words, as a
 * claim, and only for the very event the match was made for. Lanes are in the order each first appears; rows are in the
 * order of time.
 */
export function flowOf(shown: Shown): Flow {
  const lanes: Lane[] = [];
  const rows: Row[] = [];
  const lane = (l: Lane): string => {
    if (!lanes.some((x) => x.key === l.key)) lanes.push(l);
    return l.key;
  };
  // An account that no longer exists: one lane for each, never one for all (#48).
  const goneLanes = new Map<string, Lane>();
  const goneLane = (key: string): Lane => {
    let l = goneLanes.get(key);
    if (l === undefined) {
      l = { key: `gone:${key}`, kind: "gone", label: t.lanes.gone(goneLanes.size + 1) };
      goneLanes.set(key, l);
    }
    return l;
  };
  const events = byTime(shown.events.map((event) => ({ event }))).map((x) => x.event);
  const several = shown.changes.length > 1;
  const removed = (e: LedgerEvent) => (e.data as { account_removed?: unknown } | undefined)?.account_removed === true;

  // What `show` matched, taken only for an observed event at the very time and of the very type it was made for.
  const matchedOpening = (e: LedgerEvent): string | undefined => {
    const opened = shown.changes.find((c) => c.change === e.change)?.opened;
    return e.type === "change.opened" && opened !== undefined && opened.time === e.time ? opened.by : undefined;
  };
  const matchedHead = (e: LedgerEvent): string | undefined =>
    e.type === "change.updated" ? shown.changes.find((c) => c.change === e.change)?.heads.find((h) => h.sha === e.sha && h.time === e.time)?.by : undefined;
  const reviewEntry = (e: LedgerEvent) =>
    shown.reviews
      .filter((r) => r.change === undefined || r.change === e.change)
      .flatMap((r) => r.reviews)
      .find((x) => x.time === e.time && x.actor?.id === e.actor?.id && `review.${x.outcome}` === e.type);

  // The agent of a session, for a wait whose event names none.
  const sessionAgent = (e: LedgerEvent): Member | undefined => e.actor ?? shown.sessions.find((s) => s.session === e.session)?.actor;

  for (const e of events) {
    const origin = originOf(e);
    const base = { time: e.time, origin, line: LINES[origin], event: e };
    if (e.type === "agent.waiting") {
      if (waitsFor(e) !== "person") continue;
      const who = sessionAgent(e);
      if (who === undefined) continue;
      const waited = shown.sessions.find((s) => s.session === e.session)?.waits.find((w) => w.time === e.time && w.kind === "person");
      const ms = waited === undefined ? undefined : waitSpan(waited.seconds);
      const label = waited === undefined ? t.waited(null) : ms === null || ms === undefined ? t.stillWaiting : t.waited(duration(ms));
      const key = lane(memberLane(who));
      rows.push({ kind: "note", ...base, from: key, to: key, label });
      continue;
    }
    const step = STEPS[e.type];
    if (step === undefined) continue;
    const isObserved = origin === "observed";
    // The sender as the event names it: an account, an account that is gone, or none (the code host stands in).
    const sender = (standIn: string): { lane: Lane; standIn: string } => {
      if (e.actor !== undefined) return { lane: memberLane(e.actor), standIn: "" };
      if (removed(e)) return { lane: goneLane(`${e.id}:by`), standIn: "" };
      return { lane: HOST, standIn };
    };
    let from: Lane;
    let to: Lane;
    let label: string;
    let suffix = "";
    let matched: string | undefined;
    let dismissed: string | undefined;
    if (step === "task-given" || step === "task-taken-back") {
      const gone = accountsGone(e);
      const by = giver(e);
      const receiver = assignee(e);
      label = t.steps[step];
      if (step === "task-given") {
        if (gone.by) from = goneLane(`${e.id}:by`);
        else if (by !== undefined) from = memberLane(by);
        else {
          from = HOST;
          suffix = t.standIn.giver;
        }
        to = gone.to || receiver === undefined ? goneLane(`${e.id}:to`) : memberLane(receiver);
      } else {
        // The taker is the actor; the one it was taken from is `to`.
        const taker = sender(t.standIn.sender);
        from = gone.by ? goneLane(`${e.id}:by`) : taker.lane;
        suffix = gone.by ? "" : taker.standIn;
        to = receiver !== undefined ? memberLane(receiver) : goneLane(`${e.id}:to`);
      }
    } else if (step.startsWith("checks")) {
      from = CHECKS;
      to = HOST;
      label = t.steps[step as keyof typeof t.steps];
    } else if (isReviewStep(step)) {
      // A review is the reviewer's, of the change: the event holds no recipient.
      const who = sender(t.standIn.reviewer);
      from = who.lane;
      suffix = who.standIn;
      to = HOST;
      label = t.reviews[step](e.change);
      const entry = isObserved ? reviewEntry(e) : undefined;
      matched = entry?.by;
      if (entry?.dismissed !== undefined) dismissed = entry.dismissed.time;
    } else {
      const who = sender(t.standIn.sender);
      from = who.lane;
      suffix = who.standIn;
      to = HOST;
      label = t.steps[step as keyof typeof t.steps];
      if (isObserved) matched = step === "opened" ? matchedOpening(e) : step === "new-head" ? matchedHead(e) : undefined;
    }
    if (WITH_HEAD.has(step) && e.sha !== undefined) label = t.head(label, e.sha.slice(0, 7));
    if (several && e.change !== undefined && !isReviewStep(step)) label = t.ofChange(e.change, label);
    if (dismissed !== undefined) label += t.dismissed(`${new Date(dismissed).toISOString().slice(11, 16)} UTC`);
    label += suffix;
    const f = lane(from);
    const g = lane(to);
    rows.push({ kind: "arrow", ...base, from: f, to: g, label, ...(matched !== undefined ? { matched } : {}) });
  }
  return { lanes, rows };
}

/** The accessible name of an arrow or a note: the time, what, from and to, and observed or claimed. `when` is the time as the page writes it. */
export function rowName(row: Row, lanes: Lane[], when: string): string {
  const name = (key: string) => lanes.find((l) => l.key === key)?.label ?? key;
  const origin = t.origin[row.origin];
  const matched = row.matched === undefined ? undefined : t.matched(row.matched);
  return row.from === row.to ? t.inLane(when, row.label, name(row.from), origin, matched) : t.arrow(when, row.label, name(row.from), name(row.to), origin, matched);
}

/** The filter that finds one event by its id: the string is written as a JSON string, which a CEL string takes. */
export function eventFilter(id: string): string {
  return `event.id == ${JSON.stringify(id)}`;
}
