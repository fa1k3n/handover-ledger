// `howl ingest`: the one writer. It takes the files of the inbox in the order
// of their names; evidence goes into the chain of the ledger, activity into a
// file of its own without a chain. A file that is not a valid event is moved
// aside with the reason, and the pass goes on.
//
// If the process stops between writing an event and removing its file, the
// next pass finds the id in the ledger and only removes the file. Activity has
// no such check: a tool call can then be in the activity file twice.
// @code_class recording
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { LedgerError } from "../ledger/errors.ts";
import { fixedForm } from "../ledger/fixed.ts";
import type { LedgerWriter } from "../ledger/ledger.ts";
import { ACTIVITY_TYPES, eventFaults, type LedgerEvent } from "../ledger/schema.ts";
import { isReady } from "./inbox.ts";

export interface Places {
  project: string;
  inbox: string;
  activity: string;
}

export interface Pass {
  ledger: number;
  activity: number;
  rejected: number;
  /** Events whose id was in the ledger already: their files are removed. */
  duplicates: number;
  /** Activity lines removed for their age. */
  expired: number;
}

const DAY = 86_400_000;

/** One pass over the inbox, with the writer of the ledger held by the caller. */
export function ingestPass(places: Places, writer: LedgerWriter, activityDays: number, now = Date.now()): Pass {
  const pass: Pass = { ledger: 0, activity: 0, rejected: 0, duplicates: 0, expired: 0 };
  let names: string[] = [];
  try {
    names = readdirSync(places.inbox).filter(isReady).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  for (const name of names) {
    const path = join(places.inbox, name);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    try {
      const event = parse(text, places.project);
      if (writer.has(event.id)) {
        pass.duplicates++;
      } else if (ACTIVITY_TYPES.has(event.type)) {
        appendFileSync(places.activity, Buffer.concat([fixedForm(event), Buffer.from("\n")]), { mode: 0o600 });
        pass.activity++;
      } else {
        writer.append(event);
        pass.ledger++;
      }
      unlinkSync(path);
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      reject(places.inbox, name, e.message);
      pass.rejected++;
    }
  }

  pass.expired = expire(places.activity, now - activityDays * DAY);
  return pass;
}

/** The event in a file of the inbox, checked as the ledger would check it. */
function parse(text: string, project: string): LedgerEvent {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LedgerError("the file is not JSON");
  }
  const faults = eventFaults(value);
  if (faults.length > 0) throw new LedgerError(`not a valid event: ${faults.join("; ")}`);
  const event = value as LedgerEvent;
  if (event.project !== project) {
    throw new LedgerError(`not an event of this project: project is ${JSON.stringify(event.project)}, not ${JSON.stringify(project)}`);
  }
  if (event.type === "ledger.created") throw new LedgerError("ledger.created is written by the ledger itself");
  // Refuses an event with no fixed form, before anything is written.
  fixedForm(event);
  return event;
}

function reject(inbox: string, name: string, reason: string): void {
  const rejected = join(inbox, "rejected");
  mkdirSync(rejected, { recursive: true, mode: 0o700 });
  renameSync(join(inbox, name), join(rejected, name));
  writeFileSync(join(rejected, `${name}.reason`), `${reason}\n`, { mode: 0o600 });
}

/**
 * Removes the activity lines older than `cutoff`. Lines come in roughly in
 * the order of time, so a file whose first line is young enough is left alone.
 * A line that cannot be read is kept: nothing is removed that is not known to be old.
 */
function expire(path: string, cutoff: number): number {
  if (!existsSync(path)) return 0;
  const lines = readFileSync(path, "utf8").split("\n").slice(0, -1);
  const isOld = (line: string) => {
    try {
      const time = Date.parse((JSON.parse(line) as { time?: string }).time ?? "");
      return Number.isFinite(time) && time < cutoff;
    } catch {
      return false;
    }
  };
  if (lines.length === 0 || !lines.some(isOld)) return 0;
  const kept = lines.filter((line) => !isOld(line));
  const temporary = join(dirname(path), ".activity.jsonl.tmp");
  writeFileSync(temporary, kept.map((line) => `${line}\n`).join(""), { mode: 0o600 });
  renameSync(temporary, path);
  return lines.length - kept.length;
}
