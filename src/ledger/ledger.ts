// The ledger file: one line per event. A line is {"prev", "hash", "event"}:
// the event does not know its place, the line does.
//
// `prev` is the SHA-256 of the bytes of the line before as they stand in the
// file, without the line break; a shell script with sha256sum can check it.
// `hash` is the SHA-256 of the event in its fixed form (fixed.ts), and the
// event stands in the line in that form: the bytes hashed are the bytes in the file.
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
import { fixedForm } from "./fixed.ts";
import { eventFaults, type LedgerEvent } from "./schema.ts";

export { LedgerError };
export type { LedgerEvent };

export interface LedgerWriter {
  /** Adds one event to the end of the ledger. Returns the hash of the new line. */
  append(event: LedgerEvent): string;
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
      });
    } else {
      head = hashLine(lastLine(fd, path));
    }
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    release();
    throw e;
  }

  let open = true;
  const file = fd;
  return {
    append(event) {
      if (!open) throw new LedgerError(`${path}: the writer is closed`);
      if (event.project !== options.project) {
        throw new LedgerError(
          `not an event of this ledger: project is ${JSON.stringify(event.project)}, the ledger is ${JSON.stringify(options.project)}`,
        );
      }
      head = write(file, fstatSync(file).size, head, event);
      return head;
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
 * Returns the hash of the line written.
 */
function write(fd: number, at: number, prev: string | null, event: LedgerEvent): string {
  const line = toLine(prev, event);
  writeSync(fd, line, 0, line.length, at);
  fsyncSync(fd);
  return hashLine(line.subarray(0, -1));
}

/** The bytes of the line for an event, line break included. */
function toLine(prev: string | null, event: LedgerEvent): Buffer {
  // The event is checked as it will stand in the file, in its fixed form.
  const fixed = fixedForm(event);
  const faults = eventFaults(JSON.parse(fixed.toString("utf8")));
  if (faults.length > 0) throw new LedgerError(`not a valid event: ${faults.join("; ")}`);
  const hash = createHash("sha256").update(fixed).digest("hex");
  return Buffer.concat([
    Buffer.from(`{"prev":${JSON.stringify(prev)},"hash":"${hash}","event":`),
    fixed,
    Buffer.from("}\n"),
  ]);
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

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return isCode(e, "EPERM");
  }
}
