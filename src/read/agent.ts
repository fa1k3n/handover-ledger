// What an agent is doing, folded from the events of its sessions, in one place (#39). Every reader asks this:
// the state of the team (`agentStates`) takes its value now, and the summary of `howl show` adds up the time
// between its values. Pure, and no Node, so the dashboard can use it.
//
// Five types of event move it. `session.started` and `tool.used` are signs of work: the agent is working until
// its next event, or until five minutes after the sign when nothing follows; then it is idle. `agent.waiting`
// is a wait for a person or for instructions, as `waitsFor` says. `session.stopped` is a stopped turn: it waits
// for its next prompt. `session.ended` is the end of the session. Every other event moves nothing. The events
// are read in the order of time, whichever session they are of.
// @code_class reading
import type { LedgerEvent } from "../ledger/schema.ts";
import { byTime } from "./order.ts";
import { waitsFor } from "./wait.ts";

/**
 * working: a sign of work within the last five minutes. needs-input: a wait for a person (a permission prompt, a
 * question from a tool). waiting: a wait for instructions, or a stopped turn. idle: more than five minutes after the
 * last sign of work, with nothing since. ended: the session ended and nothing followed.
 */
export type AgentState = "needs-input" | "working" | "waiting" | "idle" | "ended";

/** A sign of work counts as working for this long, when nothing follows it. */
export const WORKING_WITHIN_MS = 5 * 60_000;

/** From `time` on, the agent is in `state`. */
export interface AgentPoint {
  time: string;
  state: AgentState;
}

/** Whether an event moves the state of an agent: one of the five types. */
export function movesAgent(event: LedgerEvent): boolean {
  return stateAfter(event) !== undefined;
}

function stateAfter(e: LedgerEvent): AgentState | undefined {
  switch (e.type) {
    case "session.started":
    case "tool.used":
      return "working";
    case "agent.waiting":
      return waitsFor(e) === "instructions" ? "waiting" : "needs-input";
    case "session.stopped":
      return "waiting";
    case "session.ended":
      return "ended";
    default:
      return undefined;
  }
}

/**
 * The fold: the events of an agent's sessions in, the states it went through out, each from its time, in the
 * order of time. A point is given only where the state changes. Before the first point the agent has no state.
 */
export function agentTimeline(events: LedgerEvent[]): AgentPoint[] {
  const points: AgentPoint[] = [];
  const add = (time: number, state: AgentState) => {
    if (points.at(-1)?.state !== state) points.push({ time: new Date(time).toISOString(), state });
  };
  let workUntil: number | null = null;
  for (const { event: e } of byTime(events.filter(movesAgent).map((event) => ({ event })))) {
    const t = Date.parse(e.time);
    // Work that nothing followed for five minutes has ended.
    if (workUntil !== null && t > workUntil) add(workUntil, "idle");
    const state = stateAfter(e)!;
    add(t, state);
    workUntil = state === "working" ? t + WORKING_WITHIN_MS : null;
  }
  if (workUntil !== null) add(workUntil, "idle");
  return points;
}

/**
 * The state at `time` (ms): that of the last point at or before it, none before the first. At exactly five minutes
 * after the last sign of work the agent is still working; idle is from just after.
 */
export function stateAt(points: AgentPoint[], time: number): AgentState | undefined {
  let found: AgentState | undefined;
  for (const p of points) {
    const t = Date.parse(p.time);
    if (t < time || (t === time && p.state !== "idle")) found = p.state;
    else break;
  }
  return found;
}
