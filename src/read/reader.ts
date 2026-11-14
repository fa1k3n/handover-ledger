// The one reader of the ledger and the activity file: every command, the
// server and the export read through it, so that a change of how the events
// are kept touches this module. It reads without a lock, while a writer may be
// appending. A last line without its line break is half written: it is left
// for the next read. A line howl cannot read is passed over (`howl verify`
// names it) and still counts in the numbers of the lines.
// @code_class reading
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { wholeLines } from "../ledger/lines.ts";
import { ACTIVITY_FILE } from "../ledger/names.ts";
import type { LedgerEvent } from "../ledger/schema.ts";
import { byTime } from "./order.ts";

export { byTime };

export interface Read {
  event: LedgerEvent;
  /** The line as it stands in its file. */
  raw: string;
  from: "ledger" | "activity";
  /** Of a line of the ledger: its number in the file, counted over every line. */
  n?: number;
  /** Of a line of the ledger: the hash of its event, and the hash of the line before. */
  hash?: string;
  prev?: string | null;
}

/** The activity file beside a ledger. */
export function activityBeside(ledger: string): string {
  return join(dirname(ledger), ACTIVITY_FILE);
}

/**
 * Follows one file: each `read` gives the whole lines added since the last.
 * When the file is replaced or shorter than before (the activity file is
 * rewritten when old lines expire), it is read again from the start; the
 * caller passes over what it has seen.
 */
export class Tail {
  private offset = 0;
  /** The whole lines read so far: the number of the last. */
  private lines = 0;
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
        this.lines = 0;
        this.restarted = true;
      }
      this.ino = stat.ino;
      if (stat.size === this.offset) return [];
      const bytes = Buffer.alloc(stat.size - this.offset);
      const n = readSync(fd, bytes, 0, bytes.length, this.offset);
      const whole = bytes.subarray(0, n).lastIndexOf(0x0a) + 1;
      this.offset += whole;
      const raws = bytes.subarray(0, whole).toString("utf8").split("\n").slice(0, -1);
      const found = parseLines(raws, this.from, this.lines);
      this.lines += raws.length;
      return found;
    } finally {
      closeSync(fd);
    }
  }
}

/** The lines howl can read, of whole lines without their line breaks; the first of them is line `before + 1`. */
function parseLines(raws: string[], from: Read["from"], before = 0): Read[] {
  const found: Read[] = [];
  raws.forEach((raw, i) => {
    if (raw === "") return;
    try {
      const value = JSON.parse(raw) as { prev?: string | null; hash?: string; event?: LedgerEvent } & LedgerEvent;
      const event = from === "ledger" ? value.event : value;
      if (event && typeof event === "object" && typeof event.time === "string" && typeof event.type === "string") {
        // The keys in the order the server has always sent them.
        found.push(from === "ledger" ? { n: before + i + 1, from, hash: value.hash, prev: value.prev, event, raw } : { from, event, raw });
      }
    } catch {
      // Not a line howl can read: `howl verify` names it.
    }
  });
  return found;
}

export interface Whole {
  /** Every whole line as bytes, without its line break: what the chain hashes. Split by `src/ledger/lines.ts`. */
  bytes: Buffer[];
  /** The lines howl can read, the first line too, in the order of the file. */
  lines: Read[];
}

/**
 * The ledger read once, as it stands: its bytes line by line, and the lines
 * read. For what copies or hashes the ledger (the export, the checkpoint), so
 * that the bytes and the events are of the same moment.
 */
export function readWhole(ledger: string): Whole {
  const bytes = wholeLines(readFileSync(ledger));
  return {
    bytes,
    lines: parseLines(
      bytes.map((b) => b.toString("utf8")),
      "ledger",
    ),
  };
}

/**
 * The lines of the ledger in the order of the file, each with its number, its
 * hash and the hash of the line before. Not the first line (`ledger.created`)
 * unless asked for.
 */
export function ledgerLines(ledger: string, options: { first?: boolean } = {}): Read[] {
  const { lines } = readWhole(ledger);
  return options.first ? lines : lines.filter((r) => r.event.type !== "ledger.created");
}

/** The lines of the activity file beside a ledger, in the order of the file. None when there is no file. */
export function activityLines(ledger: string): Read[] {
  return new Tail(activityBeside(ledger), "activity").read();
}

/** The number of whole lines of the ledger. */
export function lineCount(ledger: string): number {
  const bytes = readFileSync(ledger);
  let n = 0;
  for (const b of bytes) if (b === 0x0a) n++;
  return n;
}

/** Everything in the ledger and the activity file beside it, in the order of time. Not the ledger's first line. */
export function readAll(ledger: string): Read[] {
  statSync(ledger);
  return byTime([...ledgerLines(ledger, { first: true }), ...activityLines(ledger)].filter((r) => r.event.type !== "ledger.created"));
}

/** The time of the oldest line of the activity file among `reads`, in the order of time; null when it holds none. */
export function activityFrom(reads: Read[]): string | null {
  return reads.find((r) => r.from === "activity")?.event.time ?? null;
}
