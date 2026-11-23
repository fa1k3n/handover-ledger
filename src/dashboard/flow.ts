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
  /** The person's account an agent acted through, when the code host named one. */
  via?: string;
  event: LedgerEvent;
}

export interface Flow {
  lanes: Lane[];
  rows: Row[];
}

type Member = NonNullable<LedgerEvent["actor"]>;

const HOST: Lane = { key: "host", kind: "host", label: t.lanes.host };
const CHECKS: Lane = { key: "checks", kind: "checks", label: t.lanes.checks };
const GONE: Lane = { key: "gone", kind: "gone", label: t.lanes.gone };

const memberLane = (m: Member): Lane => ({ key: `${m.kind}:${m.id}`, kind: m.kind, label: m.id });
const agentLane = (name: string): Lane => memberLane({ kind: "agent", id: name });

type Step = keyof typeof t.steps;

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

const isReviewStep = (step: Step) => step === "approved" || step === "changes-asked" || step === "review-comment";

const WITH_HEAD = new Set<Step>(["opened", "new-head", "checks-passed", "checks-failed", "checks-none", "checks-unfinished"]);

function originOf(e: LedgerEvent): Origin {
  const code = establishedBy(e.source.kind).code;
  return code === "SOURCE" ? "observed" : code === "CLAIM" ? "claimed" : "unknown";
}

const LINES: Record<Origin, Line> = { observed: "solid", claimed: "dashed", unknown: "dotted" };

/**
 * The change as a flow graph, from what `show` gives: its events and the agents it matched to the
 * person's account behind an opening, a head or a review. Lanes are in the order each first appears;
 * rows are in the order of time.
 */
export function flowOf(shown: Shown): Flow {
  const lanes: Lane[] = [];
  const rows: Row[] = [];
  const lane = (l: Lane): string => {
    if (!lanes.some((x) => x.key === l.key)) lanes.push(l);
    return l.key;
  };
  const events = byTime(shown.events.map((event) => ({ event }))).map((x) => x.event);
  const several = shown.changes.length > 1;

  // The agent behind a person's account, as `show` matched it.
  const matchedOpening = (e: LedgerEvent) => shown.changes.find((c) => c.change === e.change)?.opened?.by;
  const matchedHead = (e: LedgerEvent) => shown.changes.find((c) => c.change === e.change)?.heads.find((h) => h.sha === e.sha && h.time === e.time)?.by;
  const matchedReview = (e: LedgerEvent) =>
    shown.reviews
      .filter((r) => r.change === undefined || r.change === e.change)
      .flatMap((r) => r.reviews)
      .find((x) => x.time === e.time && x.actor?.id === e.actor?.id && `review.${x.outcome}` === e.type)?.by;
  const matched = (e: LedgerEvent, step: Step): string | undefined => (step === "opened" ? matchedOpening(e) : step === "new-head" ? matchedHead(e) : isReviewStep(step) ? matchedReview(e) : undefined);

  // The one who acted: the matched agent, else the account the event names; none when it names no one.
  const actorOf = (e: LedgerEvent, by: string | undefined): { lane: Lane; via?: string } | null => {
    if (by !== undefined) return { lane: agentLane(by), ...(e.actor !== undefined ? { via: e.actor.id } : {}) };
    if (e.actor !== undefined) return { lane: memberLane(e.actor) };
    return e.type.startsWith("review.") && (e.data as { account_removed?: unknown } | undefined)?.account_removed === true ? { lane: GONE } : null;
  };

  // The author of each change: who opened it, as the code host showed it. A review goes to them.
  const author = new Map<string, Lane>();
  for (const e of events) {
    if (e.type !== "change.opened" || e.change === undefined || e.source.kind !== "observed" || author.has(e.change)) continue;
    const who = actorOf(e, matchedOpening(e));
    if (who !== null) author.set(e.change, who.lane);
  }

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
    let from: Lane;
    let to: Lane;
    let via: string | undefined;
    if (step === "task-given" || step === "task-taken-back") {
      const gone = accountsGone(e);
      const by = giver(e);
      const receiver = assignee(e);
      if (step === "task-given") {
        from = gone.by ? GONE : by !== undefined ? memberLane(by) : HOST;
        to = gone.to || receiver === undefined ? GONE : memberLane(receiver);
      } else {
        // The taker is the actor; the one it was taken from is `to`.
        from = e.actor !== undefined ? memberLane(e.actor) : gone.by ? GONE : HOST;
        to = receiver !== undefined ? memberLane(receiver) : GONE;
      }
    } else if (step.startsWith("checks")) {
      from = CHECKS;
      to = HOST;
    } else if (isReviewStep(step)) {
      const who = actorOf(e, matched(e, step));
      from = who?.lane ?? HOST;
      via = who?.via;
      to = (e.change !== undefined ? author.get(e.change) : undefined) ?? HOST;
    } else {
      const who = actorOf(e, matched(e, step));
      from = who?.lane ?? HOST;
      via = who?.via;
      to = HOST;
    }
    let label: string = t.steps[step];
    if (WITH_HEAD.has(step) && e.sha !== undefined) label = t.head(label, e.sha.slice(0, 7));
    if (several && e.change !== undefined) label = t.ofChange(e.change, label);
    const f = lane(from);
    const g = lane(to);
    rows.push({ kind: "arrow", ...base, from: f, to: g, label, ...(via !== undefined ? { via } : {}) });
  }
  return { lanes, rows };
}

/** The accessible name of an arrow or a note: the time, what, from and to, and observed or claimed. `when` is the time as the page writes it. */
export function rowName(row: Row, lanes: Lane[], when: string): string {
  const name = (key: string) => lanes.find((l) => l.key === key)?.label ?? key;
  const origin = t.origin[row.origin];
  return row.from === row.to ? t.inLane(when, row.label, name(row.from), origin, row.via) : t.arrow(when, row.label, name(row.from), name(row.to), origin, row.via);
}

/** The filter that finds one event by its id: the string is written as a JSON string, which a CEL string takes. */
export function eventFilter(id: string): string {
  return `event.id == ${JSON.stringify(id)}`;
}
