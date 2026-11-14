// `howl emit`: an event from a script, left in the inbox as a hook leaves one.
// Unlike the hook it says what is wrong and ends with 1: a script wants to know.
// @code_class recording
import { randomUUID } from "node:crypto";
import { leave } from "../inbox/inbox.ts";
import { LedgerError } from "../ledger/errors.ts";
import { inboxPath } from "../ledger/place.ts";
import { eventFaults, type LedgerEvent } from "../ledger/schema.ts";
import { findActor, findProject } from "./project.ts";

export interface EmitOptions {
  type: string;
  task?: string;
  change?: string;
  data?: string;
}

/**
 * Leaves the event in the inbox. Returns the path of its file, or null outside
 * a repository with `.howl/howl.yml`. Throws a LedgerError on a wrong event.
 */
export function emit(options: EmitOptions, env: Record<string, string | undefined>, cwd: string): string | null {
  const project = findProject(cwd);
  if (!project) return null;

  let data: Record<string, unknown> | undefined;
  if (options.data !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(options.data);
    } catch {
      throw new LedgerError("--data is not JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new LedgerError("--data must be a JSON object");
    }
    data = value as Record<string, unknown>;
  }
  if (options.type === "ledger.created") throw new LedgerError("type: ledger.created is written by the ledger itself");

  const actor = findActor(project.root, env);
  const event = {
    v: 0,
    id: randomUUID(),
    time: new Date().toISOString(),
    type: options.type,
    source: { adapter: "emit", kind: "claimed" },
    project: project.project,
    actor: actor ? { kind: "agent", id: actor } : undefined,
    task: options.task,
    change: options.change,
    data,
  };
  const defined = JSON.parse(JSON.stringify(event)) as unknown;
  const faults = eventFaults(defined);
  if (faults.length > 0) throw new LedgerError(`not a valid event: ${faults.join("; ")}`);
  return leave(inboxPath(project.project, env), defined as LedgerEvent);
}
