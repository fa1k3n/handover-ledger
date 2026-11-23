// `howl emit`: an event from a script, delivered as a hook delivers one: to the
// writer's server when one runs, else into the inbox (#64).
// Unlike the hook it says what is wrong and ends with 1: a script wants to know.
// @code_class recording
import { randomUUID } from "node:crypto";
import { deliver } from "../inbox/deliver.ts";
import { LedgerError } from "../ledger/errors.ts";
import { fixedForm } from "../ledger/fixed.ts";
import { checkEventDepth, NotJson, parseJson } from "../ledger/json.ts";
import { eventFaults, type LedgerEvent } from "../ledger/schema.ts";
import { findActor, findProject } from "./project.ts";

export interface EmitOptions {
  type: string;
  task?: string;
  change?: string;
  data?: string;
}

/**
 * Delivers the event. Returns "sent" when the server took it, the path of its
 * file when it is left in the inbox, or null outside a repository with
 * `.howl/howl.yml`. Throws a LedgerError on a wrong event.
 */
export async function emit(options: EmitOptions, env: Record<string, string | undefined>, cwd: string): Promise<string | null> {
  const project = findProject(cwd);
  if (!project) return null;

  let data: Record<string, unknown> | undefined;
  if (options.data !== undefined) {
    let value: unknown;
    try {
      value = parseJson(options.data);
    } catch (e) {
      throw new LedgerError(`--data is ${e instanceof NotJson ? e.message : "not JSON"}`);
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
  // As the writer would refuse it, said here and not by the inbox, a file later.
  checkEventDepth(fixedForm(defined));
  return (await deliver(project.project, defined as LedgerEvent, env)) ?? "sent";
}
