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

/** Parses JSON, after counting how deep it is nested. Throws NotJson: `not JSON`, or `not JSON: nested more than 128 deep`. */
export function parseJson(text: string): unknown {
  checkDepth(text);
  try {
    return JSON.parse(text);
  } catch {
    throw new NotJson("not JSON");
  }
}
