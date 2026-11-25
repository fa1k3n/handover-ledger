// The one reader of the ledger and the activity file: every command, the
// server and the export read through it, so that a change of how the events
// are kept touches this module. It reads without a lock, while a writer may be
// appending. A last line without its line break is half written: it is left
// for the next read. A line howl cannot read (no JSON, no event, or an event
// the event schema refuses) is left out of what is derived, named as a fault
// of that line where the reader reports (#200), and still counts in the numbers
// of the lines. It never makes a reader throw.
// @code_class reading
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { wholeLines } from "../ledger/lines.ts";
import { readLog } from "../ledger/log.ts";
import { ACTIVITY_FILE } from "../ledger/names.ts";
import { eventFaults, type LedgerEvent } from "../ledger/schema.ts";
import { reasonOf, type FaultyLine } from "./faulty.ts";
import { byTime, byTimeAndHash } from "./order.ts";

export { byTime, byTimeAndHash };

export interface Read {
  event: LedgerEvent;
  /** The line as it stands in its file; of the log (#216), the file as it stands. */
  raw: string;
  /** #216: `log`, an event of the branch howl/log, which has no line number and no `prev`. */
  from: "ledger" | "activity" | "log";
  /** Of a line of the ledger: its number in the file, counted over every line. */
  n?: number;
  /** Of a line of the ledger: the hash of its event, and the hash of the line before. Of the log: the hash of its event. */
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
  /** The lines of the last read that were left out (#200). Only of a ledger: a line of the activity file has no number to name. */
  faulty: FaultyLine[] = [];

  constructor(path: string, from: Read["from"]) {
    this.path = path;
    this.from = from;
  }

  read(): Read[] {
    this.restarted = false;
    this.faulty = [];
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
      const found = parseLines(raws, this.from, this.lines, this.faulty);
      this.lines += raws.length;
      return found;
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * The lines howl can read, of whole lines without their line breaks; the first of them is line `before + 1`. A line
 * of a ledger that is left out is added to `faulty` (#200): an event is read only when the event schema accepts it,
 * so that no reader meets an event that lacks a field it expects. A line of the activity file is left out unnamed.
 */
function parseLines(raws: string[], from: Read["from"], before = 0, faulty: FaultyLine[] = [], parsed?: Checkable[]): Read[] {
  const found: Read[] = [];
  const left = (i: number, reason: string) => {
    if (from === "ledger") faulty.push({ line: before + i + 1, reason });
  };
  raws.forEach((raw, i) => {
    if (raw === "") return left(i, "the line is empty");
    let value: ({ prev?: string | null; hash?: string; event?: LedgerEvent } & LedgerEvent) | null;
    try {
      value = JSON.parse(raw);
    } catch {
      return left(i, "the line is not JSON");
    }
    const event = from === "ledger" ? value?.event : value;
    if (event === null || typeof event !== "object" || Array.isArray(event)) return left(i, "the line holds no event");
    // #200: the check of signatures is given every line that parses to an event, also one that is left out: a key's issue or revocation whose
    // `sig` alone was changed still has its effect, and no field the schema refuses can hide it.
    // #200: a line is also held to the shape of the line where a reader copies it on: `hash` a text, `prev` a text or null.
    const shape = from === "ledger" ? shapeFaults(value) : [];
    const faults = [...shape, ...eventFaults(event)];
    parsed?.push(faults.length > 0 ? { n: before + i + 1, event, left: true } : { n: before + i + 1, event });
    if (faults.length > 0) return left(i, reasonOf(faults));
    // The keys in the order the server has always sent them.
    found.push(from === "ledger" ? { n: before + i + 1, from, hash: value!.hash, prev: value!.prev, event, raw } : { from, event, raw });
  });
  return found;
}

/** A line of the ledger as the check of signatures is given it. */
export interface Checkable {
  n: number;
  event: LedgerEvent;
  /** The reader leaves the line out of its lists (#200): the check takes no id from it. */
  left?: boolean;
}

/** What is wrong with the shape of a line that a reader copies on: `hash` is no text, or `prev` is no text or null. A text that is no hash is read: `howl verify` names it. */
function shapeFaults(value: unknown): string[] {
  const line = value as { hash?: unknown; prev?: unknown };
  const found: string[] = [];
  if (typeof line.hash !== "string") found.push(line.hash === undefined ? "line: hash: missing" : "line: hash: not a text");
  if (line.prev !== null && typeof line.prev !== "string") found.push(line.prev === undefined ? "line: prev: missing" : "line: prev: not a text or null");
  return found;
}

export interface Whole {
  /** Every whole line as bytes, without its line break: what the chain hashes. Split by `src/ledger/lines.ts`. */
  bytes: Buffer[];
  /** The lines howl can read, the first line too, in the order of the file. */
  lines: Read[];
  /** The lines it left out, and why (#200). */
  faulty: FaultyLine[];
  /** Every line that parses to an event, those left out too: what the check of signatures is given (#200). */
  parsed: Checkable[];
}

/**
 * The ledger read once, as it stands: its bytes line by line, and the lines
 * read. For what copies or hashes the ledger (the export, the checkpoint), so
 * that the bytes and the events are of the same moment.
 */
export function readWhole(ledger: string): Whole {
  const bytes = wholeLines(readFileSync(ledger));
  const faulty: FaultyLine[] = [];
  const parsed: Checkable[] = [];
  const lines = parseLines(
    bytes.map((b) => b.toString("utf8")),
    "ledger",
    0,
    faulty,
    parsed,
  );
  return { bytes, lines, faulty, parsed };
}

/**
 * The lines of the ledger in the order of the file, each with its number, its
 * hash and the hash of the line before. Not the first line (`ledger.created`)
 * unless asked for.
 */
export function ledgerLines(ledger: string, options: { first?: boolean } = {}): Read[] {
  return readLedger(ledger, options).lines;
}

/** `ledgerLines`, with the lines it left out, and the lines the check of signatures is given (#200): those of the list, and those left out. */
export function readLedger(ledger: string, options: { first?: boolean } = {}): { lines: Read[]; faulty: FaultyLine[]; parsed: Checkable[] } {
  const { lines, faulty, parsed } = readWhole(ledger);
  const kept = (e: { type?: unknown }) => options.first || e.type !== "ledger.created";
  return { lines: lines.filter((r) => kept(r.event)), faulty, parsed: parsed.filter((p) => kept(p.event)) };
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
  return readEverything(ledger).reads;
}

/**
 * #216: the events of the branch howl/log of the repository `repo`, each with its hash; null when there is no such
 * branch. A file that holds no event the schema accepts is left out: `howl verify` names it. Two files with one id
 * and different content are both read.
 */
export function logReads(repo: string): Read[] | null {
  const log = readLog(repo);
  if (log === null) return null;
  const seen = new Set<string>();
  const found: Read[] = [];
  for (const entry of log.entries) {
    if (entry.event === undefined || seen.has(entry.hash)) continue;
    seen.add(entry.hash);
    found.push({ from: "log", hash: entry.hash, event: entry.event, raw: entry.raw });
  }
  return found;
}

/** #216: the lines of the ledger, then the events of the log that no line holds: the same event (by hash) is read once. */
export function withLog(lines: Read[], log: Read[]): Read[] {
  const held = new Set(lines.map((r) => r.hash));
  return [...lines, ...log.filter((r) => !held.has(r.hash))];
}

/**
 * `ledgerLines`, with the events of the log of `repo` that no line holds (#216). Without a branch howl/log it is
 * `readLedger`; with one, a ledger file that is not there holds no line.
 */
export function readEvents(ledger: string, repo?: string): { lines: Read[]; faulty: FaultyLine[]; parsed: Checkable[]; log: boolean } {
  const log = repo === undefined ? null : logReads(repo);
  if (log === null) return { ...readLedger(ledger), log: false };
  const read = existsSync(ledger) ? readLedger(ledger) : { lines: [], faulty: [], parsed: [] };
  return { ...read, lines: withLog(read.lines, log), log: true };
}

/**
 * `readAll`, with the lines of the ledger it left out (#200). With `repo` (#216), the events of its branch howl/log
 * too, ordered by time, then hash; without that branch, as before.
 */
export function readEverything(ledger: string, repo?: string): { reads: Read[]; faulty: FaultyLine[] } {
  const log = repo === undefined ? null : logReads(repo);
  if (log === null) statSync(ledger);
  const { lines, faulty } = log !== null && !existsSync(ledger) ? { lines: [], faulty: [] } : readLedger(ledger, { first: true });
  const all = [...(log === null ? lines : withLog(lines, log)), ...activityLines(ledger)].filter((r) => r.event.type !== "ledger.created");
  return { reads: log === null ? byTime(all) : byTimeAndHash(all), faulty };
}

/** The time of the oldest line of the activity file among `reads`, in the order of time; null when it holds none. */
export function activityFrom(reads: Read[]): string | null {
  return reads.find((r) => r.from === "activity")?.event.time ?? null;
}
