// The check of a ledger file. For every line, from the first: it is JSON, it
// follows the line schema, its event follows the event schema, `hash` is the
// hash of the event, and `prev` is the hash of the line before. It stops at the
// first line that fails. It writes nothing and takes no lock.
//
// What the check cannot show: lines cut off the end. The head it reports has
// to be compared with one kept somewhere else.
// @code_class evidence
import { closeSync, openSync, readSync } from "node:fs";
import { LedgerError } from "./errors.ts";
import { eventHash } from "./fixed.ts";
import { hashLine } from "./ledger.ts";
import { LoneSurrogate, NotJson, parseJson } from "./json.ts";
import { eventFaults, lineFaults, type LedgerLine } from "./schema.ts";

export type Verdict =
  | { ok: true; lines: number; head: string; trial: boolean }
  | { ok: false; lines: number; line: number; faults: string[] };

export function verify(path: string): Verdict {
  // #140: a byte order mark is kept, so that JSON.parse refuses it, as every reader of the ledger does.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let lines = 0;
  let head: string | null = null;
  let trial = false;

  /** The faults of one line; empty when it holds. */
  const check = (bytes: Buffer): string[] => {
    const n = ++lines;
    const expected = head;
    head = hashLine(bytes);

    // 1. JSON
    if (bytes.length === 0) return ["the line is empty"];
    let value: unknown;
    try {
      value = parseJson(decoder.decode(bytes));
    } catch (e) {
      if (e instanceof LoneSurrogate) return [`the line: ${e.message}`];
      return [`the line is ${e instanceof NotJson ? e.message : "not JSON"}`];
    }

    // 2. The line schema. Without it the other checks have nothing to stand on.
    const faults = lineFaults(value).map((f) => `line: ${f}`);
    if (faults.length > 0) return faults;
    const line = value as LedgerLine;

    // 3. The event schema, and the rules of the first line.
    faults.push(...eventFaults(line.event).map((f) => `event: ${f}`));
    if (n === 1) {
      if (line.event.type !== "ledger.created") faults.push("event: type: the first line must be ledger.created");
      trial = line.event.data?.mode === "trial";
    } else if (line.event.type === "ledger.created") {
      faults.push("event: type: only the first line can be ledger.created");
    }

    // 4. hash
    try {
      if (eventHash(line.event) !== line.hash) faults.push("hash: is not the hash of the event: the event was changed");
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      faults.push(`hash: the event has no fixed form: ${e.message}`);
    }

    // 5. prev
    if (line.prev !== expected) {
      faults.push(
        n === 1
          ? "prev: is not null, so this is not the first line of a ledger: lines before it were removed"
          : `prev: is not the hash of line ${n - 1}: line ${n - 1} was changed, or lines were removed or added between the two`,
      );
    }
    return faults;
  };

  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      const view = chunk.subarray(0, n);
      let from = 0;
      for (;;) {
        const i = view.indexOf(0x0a, from);
        if (i === -1) {
          pending = Buffer.concat([pending, view.subarray(from)]);
          break;
        }
        const faults = check(Buffer.concat([pending, view.subarray(from, i)]));
        if (faults.length > 0) return { ok: false, lines: lines - 1, line: lines, faults };
        pending = Buffer.alloc(0);
        from = i + 1;
      }
    }
    if (pending.length > 0) {
      return { ok: false, lines, line: lines + 1, faults: ["the line is cut off: it does not end with a line break"] };
    }
    if (head === null) {
      return { ok: false, lines: 0, line: 1, faults: ["the ledger is empty: it has no first line"] };
    }
    return { ok: true, lines, head, trial };
  } finally {
    closeSync(fd);
  }
}
