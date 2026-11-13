// The state of each agent now, folded from the events of the ledger and the
// activity file: what it is doing, on what, and since when. Pure: events in,
// rows out, the clock passed in. People are never a row.
import type { LedgerEvent } from "../ledger/schema.ts";

export type AgentState = "working" | "waiting" | "idle" | "ended";

/** A tool call or a session event within this time counts as working. */
export const WORKING_WITHIN_MS = 5 * 60_000;

export interface AgentRow {
  agent: string;
  state: AgentState;
  task?: string;
  change?: string;
  branch?: string;
  session?: string;
  model?: string;
  effort?: string;
  /** The last tool call: the tool and its target. */
  tool?: string;
  target?: string;
  /** The time of the agent's last event. */
  last: string;
  /** The type of the agent's last event of its own session. */
  lastType?: string;
}

export interface StateOptions {
  /** Takes a task's number from a branch name: its first group, else the whole match. */
  taskFromBranch?: RegExp;
}

/** One row per agent, the most recent first. */
export function agentStates(events: LedgerEvent[], now: number, options: StateOptions = {}): AgentRow[] {
  const sorted = events
    .map((e, i) => ({ e, i, t: Date.parse(e.time) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.e);

  // What the code host shows: the change opened on a branch, and its task.
  const onBranch = new Map<string, { change?: string; task?: string }>();
  for (const e of sorted) {
    if (e.branch !== undefined && e.type.startsWith("change.") && e.change !== undefined) {
      onBranch.set(e.branch, { change: e.change, task: e.task ?? onBranch.get(e.branch)?.task });
    }
  }

  const byAgent = new Map<string, LedgerEvent[]>();
  for (const e of sorted) {
    if (e.actor?.kind !== "agent") continue;
    const list = byAgent.get(e.actor.id) ?? [];
    list.push(e);
    byAgent.set(e.actor.id, list);
  }

  const rows: AgentRow[] = [];
  for (const [agent, list] of byAgent) {
    const own = list.filter((e) => e.source.kind === "claimed");
    const lastOwn = own.at(-1);
    const last = list.at(-1)!;
    const row: AgentRow = { agent, state: stateOf(lastOwn, now), last: last.time };
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
    if (model !== undefined) row.model = model as string;
    if (effort !== undefined) row.effort = effort as string;
    const lastTool = [...current].reverse().find((e) => e.type === "tool.used");
    const data = (lastTool?.data ?? {}) as Record<string, unknown>;
    if (typeof data.tool === "string") row.tool = data.tool;
    if (typeof data.target === "string") row.target = data.target;

    const named = { change: latest("change") as string | undefined, task: latest("task") as string | undefined };
    const fromBranch = row.branch === undefined ? undefined : onBranch.get(row.branch);
    const change = named.change ?? (named.task === undefined ? fromBranch?.change : undefined);
    const task = named.task ?? (named.change === undefined ? fromBranch?.task : undefined) ?? taskOf(row.branch, options.taskFromBranch);
    if (change !== undefined) row.change = change;
    if (task !== undefined) row.task = task;
    rows.push(row);
  }
  return rows.sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
}

/**
 * Waiting: its last event is a wait, or a stopped turn (it waits for its next
 * prompt). Ended: its session ended and nothing followed. Working: its last
 * event is recent. Idle otherwise.
 */
function stateOf(last: LedgerEvent | undefined, now: number): AgentState {
  if (last === undefined) return "idle";
  if (last.type === "agent.waiting" || last.type === "session.stopped") return "waiting";
  if (last.type === "session.ended") return "ended";
  return now - Date.parse(last.time) <= WORKING_WITHIN_MS ? "working" : "idle";
}

function taskOf(branch: string | undefined, pattern: RegExp | undefined): string | undefined {
  if (branch === undefined || pattern === undefined) return undefined;
  const found = branch.match(pattern);
  return found ? (found[1] ?? found[0]) : undefined;
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

/** The agents waiting, for the team: how many, never who they wait for. */
export function waitingCount(rows: AgentRow[]): number {
  return rows.filter((r) => r.state === "waiting").length;
}

/** The rows as lines for a terminal. */
export function renderStatus(rows: AgentRow[], now: number): string {
  if (rows.length === 0) return "no agent in the ledger yet";
  const table = rows.map((r) => [
    r.agent,
    r.state,
    worksOn(r) || (r.branch ?? "-"),
    [r.model, r.effort].filter(Boolean).join(" ") || "-",
    [r.tool, r.target].filter(Boolean).join(" ") || "-",
    since(r.last, now),
  ]);
  const widths = table[0]!.map((_, c) => Math.max(...table.map((cells) => cells[c]!.length)));
  const lines = table.map((cells) => cells.map((cell, c) => (c === cells.length - 1 ? cell : cell.padEnd(widths[c]!))).join("  "));
  const waiting = waitingCount(rows);
  lines.push("", `${rows.length} agent${rows.length === 1 ? "" : "s"}, ${waiting} waiting`);
  return lines.join("\n");
}
