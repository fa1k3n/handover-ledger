// Reading the ledger and the activity file together, without a lock, while a
// writer may be appending. A last line without its line break is half written:
// it is left for the next read.
// @code_class reading
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LedgerEvent } from "../ledger/schema.ts";

export interface Read {
  event: LedgerEvent;
  /** The line as it stands in its file. */
  raw: string;
  from: "ledger" | "activity";
}

/** The activity file beside a ledger. */
export function activityBeside(ledger: string): string {
  return join(dirname(ledger), "activity.jsonl");
}

/**
 * Follows one file: each `read` gives the whole lines added since the last.
 * When the file is replaced or shorter than before (the activity file is
 * rewritten when old lines expire), it is read again from the start; the
 * caller passes over what it has seen.
 */
export class Tail {
  private offset = 0;
  private ino: number | null = null;
  private readonly path: string;
  private readonly from: Read["from"];
  /** Whether the last read started again from the beginning of a replaced file. */
  restarted = false;

  constructor(path: string, from: Read["from"]) {
    this.path = path;
    this.from = from;
  }

  read(): Read[] {
    this.restarted = false;
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    try {
      const stat = fstatSync(fd);
      if ((this.ino !== null && stat.ino !== this.ino) || stat.size < this.offset) {
        this.offset = 0;
        this.restarted = true;
      }
      this.ino = stat.ino;
      if (stat.size === this.offset) return [];
      const bytes = Buffer.alloc(stat.size - this.offset);
      const n = readSync(fd, bytes, 0, bytes.length, this.offset);
      const whole = bytes.subarray(0, n).lastIndexOf(0x0a) + 1;
      this.offset += whole;
      return parseLines(bytes.subarray(0, whole).toString("utf8"), this.from);
    } finally {
      closeSync(fd);
    }
  }
}

function parseLines(text: string, from: Read["from"]): Read[] {
  const found: Read[] = [];
  for (const raw of text.split("\n")) {
    if (raw === "") continue;
    try {
      const value = JSON.parse(raw) as { event?: LedgerEvent } & LedgerEvent;
      const event = from === "ledger" ? value.event : value;
      if (event && typeof event === "object" && typeof event.time === "string" && typeof event.type === "string") {
        found.push({ event, raw, from });
      }
    } catch {
      // Not a line howl can read: `howl verify` names it.
    }
  }
  return found;
}

/** Sorts by time; events of the same time keep the order they were read in. */
export function byTime(reads: Read[]): Read[] {
  return reads
    .map((r, i) => ({ r, i, t: Date.parse(r.event.time) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.r);
}

/** Everything in the ledger and the activity file beside it, in the order of time. Not the ledger's first line. */
export function readAll(ledger: string): Read[] {
  statSync(ledger);
  const all = [...new Tail(ledger, "ledger").read(), ...new Tail(activityBeside(ledger), "activity").read()];
  return byTime(all.filter((r) => r.event.type !== "ledger.created"));
}
