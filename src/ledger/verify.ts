// The check of a ledger file: every line is an event the schema accepts, and
// every line holds the hash of the line before. It reads from the first line
// and stops at the first line that fails. It writes nothing and takes no lock.
//
// What the check cannot show: lines cut off the end. The head it reports has
// to be compared with one kept somewhere else.
import { closeSync, openSync, readSync } from "node:fs";
import { hashLine } from "./ledger.ts";
import { eventFaults } from "./schema.ts";

export type Verdict =
  | { ok: true; lines: number; head: string; trial: boolean }
  | { ok: false; lines: number; line: number; faults: string[] };

export function verify(path: string): Verdict {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let lines = 0;
  let head: string | null = null;
  let trial = false;

  /** The faults of one line; empty when it holds. */
  const check = (bytes: Buffer): string[] => {
    const n = ++lines;
    const expected = head;
    head = hashLine(bytes);

    if (bytes.length === 0) return ["the line is empty"];
    let value: unknown;
    try {
      value = JSON.parse(decoder.decode(bytes));
    } catch {
      return ["the line is not JSON"];
    }
    const faults = eventFaults(value);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return faults;
    const event = value as { type?: unknown; prev?: unknown; data?: { mode?: unknown } };

    if (n === 1) {
      if (event.type !== "ledger.created") faults.push("type: the first line must be ledger.created");
      trial = event.data?.mode === "trial";
    } else if (event.type === "ledger.created") {
      faults.push("type: only the first line can be ledger.created");
    }

    if (event.prev !== expected) {
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
