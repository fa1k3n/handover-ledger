// The one way howl reads JSON it did not write: a line of a ledger, a file of the inbox, the body of a request.
// @code_class evidence
import { LedgerError } from "./errors.ts";

/** The deepest nesting of arrays and objects that is read. The same in both versions of howl. */
export const MAX_DEPTH = 128;

/** What was given is not JSON, or is nested too deep. The message says which, as `the line is <message>`. */
export class NotJson extends LedgerError {}

/**
 * Parses JSON, after counting how deep it is nested without reading it: brackets inside a string do not count.
 * Throws NotJson: `not JSON`, or `not JSON: nested more than 128 deep`.
 */
export function parseJson(text: string): unknown {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) {
      if (++depth > MAX_DEPTH) throw new NotJson(`not JSON: nested more than ${MAX_DEPTH} deep`);
    } else if (c === 0x5d || c === 0x7d) depth--;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new NotJson("not JSON");
  }
}
