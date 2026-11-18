// The state of each agent now, folded from the events of the ledger and the
// activity file: what it is doing, on what, and since when. Pure: events in,
// rows out, the clock passed in. People are never a row.
// @code_class reading
import type { LedgerEvent } from "../ledger/schema.ts";
import { agentTimeline, stateAt, type AgentState } from "./agent.ts";
import { assignee } from "./assignee.ts";
import { byTime } from "./order.ts";

// #39: the state is told by the one fold in `agent.ts`; its words and its working window are those.
export { WORKING_WITHIN_MS, type AgentState } from "./agent.ts";

const DAY_MS = 24 * 3600_000;

export interface AgentRow {
  agent: string;
  state: AgentState;
  task?: string;
  change?: string;
  branch?: string;
  session?: string;
  model?: string;
  effort?: string;
  /** The role the current session named (#17). */
  role?: string;
  /** The last tool call: the tool and its target. */
  tool?: string;
  target?: string;
  /** The time of the agent's last event. */
  last: string;
  /** The type of the agent's last event of its own session. */
  lastType?: string;
  /** #26: what the current session leaves out, so a broken chain shows: "no change or task named", "no role", "unsigned". */
  gaps: string[];
}

export interface StateOptions {
  /** #46: the names in `agents` of the project. When there are any, a session of another name has a gap. */
  agents?: ReadonlySet<string>;
}

/** One row per agent, the most recent first. */
export function agentStates(events: LedgerEvent[], now: number, options: StateOptions = {}): AgentRow[] {
  const sorted = byTime(events.map((event) => ({ event }))).map((x) => x.event);

  // What the code host shows: the change opened on a branch, and its task.
  const onBranch = new Map<string, { change?: string; task?: string }>();
  for (const e of sorted) {
    if (e.branch !== undefined && e.type.startsWith("change.") && e.change !== undefined) {
      onBranch.set(e.branch, { change: e.change, task: e.task ?? onBranch.get(e.branch)?.task });
    }
  }

  const byAgent = new Map<string, LedgerEvent[]>();
  for (const e of sorted) {
    // #45: an agent has a row for what it did, and for a task it got: the actor of a giving is the giver, the receiver is `assignee`.
    const ids = new Set([e.actor, e.type === "task.assigned" ? assignee(e) : undefined].flatMap((a) => (a?.kind === "agent" ? [a.id] : [])));
    for (const id of ids) {
      const list = byAgent.get(id) ?? [];
      list.push(e);
      byAgent.set(id, list);
    }
  }

  const rows: AgentRow[] = [];
  for (const [agent, list] of byAgent) {
    const own = list.filter((e) => e.source.kind === "claimed");
    const lastOwn = own.at(-1);
    const last = list.at(-1)!;
    const row: AgentRow = { agent, state: stateOf(own, now), last: last.time, gaps: [] };
    if (lastOwn) {
      row.lastType = lastOwn.type;
      if (lastOwn.branch !== undefined) row.branch = lastOwn.branch;
      if (lastOwn.session !== undefined) row.session = lastOwn.session;
    }
    // The latest that names them, within the current session when there is one.
    const current = lastOwn?.session === undefined ? own : own.filter((e) => e.session === lastOwn.session);
    const latest = <K extends keyof LedgerEvent>(key: K) => [...current].reverse().find((e) => e[key] !== undefined)?.[key];
    const model = latest("model");
    const effort = latest("effort");
    const role = latest("role");
    if (role !== undefined) row.role = role as string;
    if (model !== undefined) row.model = model as string;
    if (effort !== undefined) row.effort = effort as string;
    const lastTool = [...current].reverse().find((e) => e.type === "tool.used");
    const data = (lastTool?.data ?? {}) as Record<string, unknown>;
    if (typeof data.tool === "string") row.tool = data.tool;
    if (typeof data.target === "string") row.target = data.target;

    const named = { change: latest("change") as string | undefined, task: latest("task") as string | undefined };
    const fromBranch = row.branch === undefined ? undefined : onBranch.get(row.branch);
    const change = named.change ?? (named.task === undefined ? fromBranch?.change : undefined);
    const task = named.task ?? (named.change === undefined ? fromBranch?.task : undefined);
    if (change !== undefined) row.change = change;
    if (task !== undefined) row.task = task;
    if (lastOwn) {
      if (row.change === undefined && row.task === undefined) row.gaps.push("no change or task named");
      if (row.role === undefined) row.gaps.push("no role");
      if (options.agents !== undefined && options.agents.size > 0 && !options.agents.has(agent)) row.gaps.push("not a known agent");
      const signedBefore = own.some((e) => e.sig !== undefined && e.session !== lastOwn.session && now - Date.parse(e.time) <= DAY_MS);
      if (signedBefore && !current.some((e) => e.sig !== undefined)) row.gaps.push("unsigned");
    }
    rows.push(row);
  }
  const first = (r: AgentRow) => (r.state === "needs-input" ? 0 : 1);
  return rows.sort((a, b) => first(a) - first(b) || Date.parse(b.last) - Date.parse(a.last));
}

/**
 * The state now, from the fold (#39): needs input is a wait for a person (a permission prompt, a question from a
 * tool), not the idle wait after a turn. An agent that asks in the text of its answer and ends its turn cannot be
 * told from one that is done: that is waiting. An agent with no event of what it does is idle.
 */
function stateOf(own: LedgerEvent[], now: number): AgentState {
  const points = agentTimeline(own);
  // An event stamped a moment ahead of this clock is read as now, as before.
  const last = points.findLast((p) => p.state !== "idle");
  return stateAt(points, Math.max(now, last === undefined ? now : Date.parse(last.time))) ?? "idle";
}

/** How long ago, short: 12 s, 4 min, 1 h 05 min, 3 d. */
export function since(time: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(time)) / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${String(min % 60).padStart(2, "0")} min`;
  return `${Math.floor(h / 24)} d`;
}

/** What a row works on, in words: task 12 · change 30. */
export function worksOn(row: AgentRow): string {
  return [row.task !== undefined ? `task ${row.task}` : null, row.change !== undefined ? `change ${row.change}` : null]
    .filter(Boolean)
    .join(" · ");
}

/** How many agents are in a state, for the team: never who they wait for. */
export function countOf(rows: AgentRow[], state: AgentState): number {
  return rows.filter((r) => r.state === state).length;
}

/** The rows as lines for a terminal. */
export function renderStatus(rows: AgentRow[], now: number): string {
  if (rows.length === 0) return "no agent in the ledger yet";
  const table = rows.map((r) => [
    r.agent,
    r.state === "needs-input" ? "NEEDS INPUT" : r.state,
    r.role ?? "-",
    worksOn(r) || (r.branch ?? "-"),
    [r.model, r.effort].filter(Boolean).join(" ") || "-",
    [r.tool, r.target].filter(Boolean).join(" ") || "-",
    since(r.last, now),
  ]);
  const widths = table[0]!.map((_, c) => Math.max(...table.map((cells) => cells[c]!.length)));
  const lines = table.map((cells, i) => {
    const line = cells.map((cell, c) => (c === cells.length - 1 ? cell : cell.padEnd(widths[c]!))).join("  ");
    const gaps = rows[i]!.gaps;
    return gaps.length > 0 ? `${line}  missing: ${gaps.join(", ")}` : line;
  });
  const needs = countOf(rows, "needs-input");
  lines.push("", `${rows.length} agent${rows.length === 1 ? "" : "s"}, ${needs} need${needs === 1 ? "s" : ""} input, ${countOf(rows, "waiting")} waiting`);
  return lines.join("\n");
}
