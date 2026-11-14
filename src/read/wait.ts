// What a wait of an agent waits for, in howl's words: a person (it stands still
// until someone answers) or instructions (it is done and waits for more). The
// hook of each agent tool says so in `data.waits_for`; the readers ask only
// this. No Node, so the dashboard can use it.
// @code_class reading
import type { LedgerEvent } from "../ledger/schema.ts";

export type WaitsFor = "person" | "instructions";

/** The tool's own words for a wait for instructions, for events written before `waits_for` (Claude Code's idle prompt). */
const OLD_INSTRUCTIONS = new Set(["idle_prompt"]);

/** The kind of an `agent.waiting`: `data.waits_for`, else the old mapping of the tool's notification; a person when nothing says. */
export function waitsFor(event: LedgerEvent): WaitsFor {
  const data = (event.data ?? {}) as Record<string, unknown>;
  if (data.waits_for === "person" || data.waits_for === "instructions") return data.waits_for;
  return typeof data.notification_type === "string" && OLD_INSTRUCTIONS.has(data.notification_type) ? "instructions" : "person";
}

/** Whether an event is a wait for a person: what stands out. */
export function waitsForPerson(event: LedgerEvent): boolean {
  return event.type === "agent.waiting" && waitsFor(event) === "person";
}
