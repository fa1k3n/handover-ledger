// The fixed form of an event: the JSON Canonicalization Scheme, RFC 8785.
// The same event gives the same bytes, and the same hash, wherever it is written.
//
// Keys are sorted by their UTF-16 code units, which is what the default sort
// of JavaScript compares. Numbers and strings are written as JSON.stringify
// writes them, which is what RFC 8785 prescribes. The object is serialised by
// hand: a JavaScript object puts keys that look like numbers first, whatever
// order they were added in.
// @code_class evidence
import { createHash } from "node:crypto";
import { LedgerError } from "./errors.ts";
import type { LedgerEvent } from "./schema.ts";

/** The fixed form of a JSON value, in UTF-8. A member whose value is undefined is left out, as JSON leaves it out. */
export function fixedForm(value: unknown): Buffer {
  return Buffer.from(write(value, "the value"), "utf8");
}

/** The SHA-256, in hex, of the fixed form of an event. */
export function eventHash(event: LedgerEvent): string {
  return createHash("sha256").update(fixedForm(event)).digest("hex");
}

function write(value: unknown, where: string): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new LedgerError(`${where}: ${value} is not a JSON number`);
    return JSON.stringify(value);
  }
  if (typeof value === "string") return string(value, where);
  if (Array.isArray(value)) {
    return `[${value.map((item, i) => write(item, `${where}[${i}]`)).join(",")}]`;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const members: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member === undefined) continue;
      members.push(`${string(key, `${where}: a key`)}:${write(member, `${where}.${key}`)}`);
    }
    return `{${members.join(",")}}`;
  }
  throw new LedgerError(`${where}: a ${typeof value} is not a JSON value`);
}

function string(value: string, where: string): string {
  if (!value.isWellFormed()) {
    throw new LedgerError(`${where}: a string with a lone surrogate has no fixed form`);
  }
  return JSON.stringify(value);
}
