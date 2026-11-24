// The ledger file: one line per event. A line is {"prev", "hash", "event"}:
// the event does not know its place, the line does.
//
// `prev` is the SHA-256 of the bytes of the line before as they stand in the
// file, without the line break; a shell script with sha256sum can check it.
// `hash` is the SHA-256 of the event in its fixed form (fixed.ts), and the
// event stands in the line in that form: the bytes hashed are the bytes in the file.
// @code_class evidence
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { isCode, LedgerError } from "./errors.ts";
import { eventHash, fixedForm } from "./fixed.ts";
import { checkEventDepth } from "./json.ts";
import { eventFaults, type LedgerEvent } from "./schema.ts";

export { LedgerError };
export type { LedgerEvent };

export interface LedgerWriter {
  /**
   * Adds one event to the end of the ledger. Returns the hash of the new line.
   * An event whose id is already in the ledger is refused: an id is written once. The refusal says whether the line
   * there holds this same event or another one (#203).
   */
  append(event: LedgerEvent): string;
  /** Whether an event with this id is in the ledger. It says nothing of what the line holds: see `holds`. */
  has(id: string): boolean;
  /**
   * #203: what the ledger holds under the id of `event`. `same`: a line with this very event, the same hash of its
   * fixed form. `other`: the id is taken by a line holding another event. `none`: the id is free. Only `same` makes
   * the event a duplicate that may be dropped; `other` is a fault for a person. Goes by the event in the line, never
   * by the `hash` written beside it, which anyone who can append can write as they like.
   */
  holds(event: LedgerEvent): "none" | "same" | "other";
  /** Lets go of the lock. The writer writes no more. */
  close(): void;
}

export function hashLine(line: Uint8Array): string {
  return createHash("sha256").update(line).digest("hex");
}

/**
 * Opens the ledger for writing, and creates it with its first line when it is
 * not there. Only one writer at a time: the lock file beside the ledger is
 * held until `close`, and a second writer is refused.
 */
export function openLedger(path: string, options: { project: string }): LedgerWriter {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const release = lock(path);
  let fd: number | undefined;
  let head: string;
  const ids = new Set<string>();
  // The hashes of the events held under each id. Read from the file once, the first time a taken id is asked about
  // (#203): a pass with many taken ids reads the ledger once, and a ledger nobody repeats an id in is not hashed at all.
  // Until then an event this writer appends is not entered: the file holds it.
  let hashes: Map<string, Set<string>> | undefined;
  try {
    let created = true;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (e) {
      if (!isCode(e, "EEXIST")) throw e;
      created = false;
      fd = openSync(path, "r+");
    }
    if (created) {
      head = write(fd, 0, null, {
        v: 0,
        id: randomUUID(),
        time: new Date().toISOString(),
        type: "ledger.created",
        source: { adapter: "howl", kind: "observed" },
        project: options.project,
        data: { mode: "trial" },
      }).head;
    } else {
      head = hashLine(lastLine(fd, path));
      for (const id of eventIds(path)) ids.add(id);
    }
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    release();
    throw e;
  }

  let open = true;
  const file = fd;
  const holds = (event: LedgerEvent): "none" | "same" | "other" => {
    if (!ids.has(event.id)) return "none";
    if (hashes === undefined) {
      hashes = new Map();
      for (const e of events(path)) {
        if (typeof e.id !== "string") continue;
        try {
          const hash = eventHash(e as LedgerEvent);
          const held = hashes.get(e.id);
          if (held === undefined) hashes.set(e.id, new Set([hash]));
          else held.add(hash);
        } catch {
          // An event with no fixed form is not any event that is asked about.
          if (!hashes.has(e.id)) hashes.set(e.id, new Set());
        }
      }
    }
    return hashes.get(event.id)?.has(eventHash(event)) ? "same" : "other";
  };
  return {
    append(event) {
      if (!open) throw new LedgerError(`${path}: the writer is closed`);
      if (event.project !== options.project) {
        throw new LedgerError(
          `not an event of this ledger: project is ${JSON.stringify(event.project)}, the ledger is ${JSON.stringify(options.project)}`,
        );
      }
      const held = holds(event);
      if (held === "same") throw new LedgerError(`${event.id}: an event with this id is in the ledger already`);
      if (held === "other") throw new LedgerError(`${event.id}: this id is taken by a line holding another event; this one is not written`);
      const written = write(file, fstatSync(file).size, head, event);
      head = written.head;
      ids.add(event.id);
      hashes?.set(event.id, new Set([written.event]));
      return head;
    },
    has(id) {
      return ids.has(id);
    },
    holds(event) {
      return holds(event);
    },
    close() {
      if (!open) return;
      open = false;
      closeSync(file);
      release();
    },
  };
}

/**
 * Writes one event as a line at `at`, after the line whose hash is `prev`.
 * Refuses an event the schema does not accept; nothing is written then.
 * Returns the hash of the line written, and the hash of the event in it.
 */
function write(fd: number, at: number, prev: string | null, event: LedgerEvent): { head: string; event: string } {
  const { line, hash } = toLine(prev, event);
  writeSync(fd, line, 0, line.length, at);
  fsyncSync(fd);
  return { head: hashLine(line.subarray(0, -1)), event: hash };
}

/** The bytes of the line for an event, line break included, and the hash of the event. */
function toLine(prev: string | null, event: LedgerEvent): { line: Buffer; hash: string } {
  // The event is checked as it will stand in the file, in its fixed form.
  const fixed = fixedForm(event);
  // The line holds the event one level down, and `howl verify` reads no line deeper than 128.
  checkEventDepth(fixed);
  const faults = eventFaults(JSON.parse(fixed.toString("utf8")));
  if (faults.length > 0) throw new LedgerError(`not a valid event: ${faults.join("; ")}`);
  const hash = createHash("sha256").update(fixed).digest("hex");
  const line = Buffer.concat([
    Buffer.from(`{"prev":${JSON.stringify(prev)},"hash":"${hash}","event":`),
    fixed,
    Buffer.from("}\n"),
  ]);
  return { line, hash };
}

/** The ids of the events in a ledger file. A line that cannot be read is passed over: `howl verify` names it. */
export function* eventIds(path: string): Generator<string> {
  for (const event of events(path)) if (typeof event.id === "string") yield event.id;
}

/** The events of a ledger file, line by line. A line that cannot be read is passed over: `howl verify` names it. */
export function* events(path: string): Generator<Partial<LedgerEvent>> {
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const event = (JSON.parse(line) as { event?: unknown }).event;
      if (typeof event === "object" && event !== null) yield event as Partial<LedgerEvent>;
    } catch {
      // Not a line of the ledger.
    }
  }
}

/** The bytes of the last line, read from the end of the file without reading the lines before it. */
function lastLine(fd: number, path: string): Buffer {
  const size = fstatSync(fd).size;
  if (size === 0) throw new LedgerError(`${path}: the ledger is empty, it has no first line`);
  const chunk = Buffer.alloc(64 * 1024);
  readSync(fd, chunk, 0, 1, size - 1);
  if (chunk[0] !== 0x0a) {
    throw new LedgerError(`${path}: the last line is cut off, run \`howl verify\``);
  }
  // The line starts after the line break before it, or at the start of the file.
  const end = size - 1;
  let start = 0;
  let pos = end;
  while (pos > 0) {
    const n = Math.min(chunk.length, pos);
    pos -= n;
    readSync(fd, chunk, 0, n, pos);
    const i = chunk.subarray(0, n).lastIndexOf(0x0a);
    if (i !== -1) {
      start = pos + i + 1;
      break;
    }
  }
  if (start === end) throw new LedgerError(`${path}: the last line is empty, run \`howl verify\``);
  const bytes = Buffer.alloc(end - start);
  readSync(fd, bytes, 0, bytes.length, start);
  return bytes;
}

function lock(path: string): () => void {
  const lockPath = `${path}.lock`;
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (e) {
    if (!isCode(e, "EEXIST")) throw e;
    let holder = "";
    try {
      holder = readFileSync(lockPath, "utf8").trim();
    } catch {
      // The holder let go between the two calls. Still refuse: the caller may try again.
    }
    const gone = /^\d+$/.test(holder) && !isRunning(Number(holder));
    throw new LedgerError(
      gone
        ? `${lockPath}: left by process ${holder}, which no longer runs. Run \`howl verify\`, then remove the file`
        : `${lockPath}: another process${holder ? ` (${holder})` : ""} is writing to the ledger`,
    );
  }
  try {
    writeSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
  return () => unlinkSync(lockPath);
}

/**
 * The lock of a ledger as it stands (#102): `held` by a process that writes
 * now, `left` by one that no longer runs, or `none`. Only reads: the lock is
 * not taken. A lock that cannot be read, or holds no number yet, is being
 * taken and counts as held, as `openLedger` would refuse it.
 */
export function lockOf(path: string): "none" | "held" | "left" {
  let holder: string;
  try {
    holder = readFileSync(`${path}.lock`, "utf8").trim();
  } catch (e) {
    return isCode(e, "ENOENT") ? "none" : "held";
  }
  return !/^\d+$/.test(holder) || isRunning(Number(holder)) ? "held" : "left";
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return isCode(e, "EPERM");
  }
}
