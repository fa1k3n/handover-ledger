// The one way howl reads JSON it did not write: a line of a ledger, a file of the inbox, the body of a request.
// @code_class evidence
import { LedgerError } from "./errors.ts";

/**
 * The deepest nesting of arrays and objects that is read: 128, each array and object inside another counting one. A
 * ledger line is at most this deep, so an event, which stands one level down in its line, is at most one less.
 *
 * For the Rust twin: serde_json's default limit lets in 127, not 128, so Rust counts the nesting itself, outside
 * strings and not after a `\`, as `checkDepth` does (or turns serde_json's limit off and counts).
 */
export const MAX_DEPTH = 128;

/** What was given is not JSON, or is nested too deep. The message says which, as `the line is <message>`. */
export class NotJson extends LedgerError {}

/** Throws NotJson, `not JSON: nested more than <limit> deep`, when the text is nested deeper than `limit`. The text is not parsed. */
export function checkDepth(text: string, limit: number = MAX_DEPTH): void {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) {
      if (++depth > limit) throw new NotJson(`not JSON: nested more than ${MAX_DEPTH} deep`);
    } else if (c === 0x5d || c === 0x7d) depth--;
  }
}

/** The check on an event in its fixed form: its line holds it one level down, so it is at most 127 deep. */
export function checkEventDepth(fixed: Buffer | string): void {
  checkDepth(fixed.toString("utf8"), MAX_DEPTH - 1);
}

/** A string or key of the text holds a lone surrogate: JSON.parse reads it, but no fixed form can hold it. */
export class LoneSurrogate extends LedgerError {}

/**
 * Parses JSON, after counting how deep it is nested. Throws NotJson: `not JSON`, or `not JSON: nested more than 128
 * deep`. What has no fixed form is refused here too, with the words of the Rust twin (#140): a number beyond a double,
 * which JSON.parse makes Infinity, is NotJson `not JSON`; then a lone surrogate in a string or a key is LoneSurrogate.
 */
export function parseJson(text: string): unknown {
  checkDepth(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new NotJson("not JSON");
  }
  const found = { infinite: false, lone: false };
  look(value, found);
  if (found.infinite) throw new NotJson("not JSON");
  if (found.lone) throw new LoneSurrogate("a string with a lone surrogate has no fixed form");
  return value;
}

/** Notes whether a value read by JSON.parse holds a number that is not finite, or a string or key with a lone surrogate. */
function look(value: unknown, found: { infinite: boolean; lone: boolean }): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) found.infinite = true;
  } else if (typeof value === "string") {
    if (!value.isWellFormed()) found.lone = true;
  } else if (Array.isArray(value)) {
    for (const item of value) look(item, found);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, member] of Object.entries(value)) {
      if (!key.isWellFormed()) found.lone = true;
      look(member, found);
    }
  }
}
