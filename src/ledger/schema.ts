// The schemas, compiled once. The JSON Schema files are the source; the types
// in event.gen.ts and line.gen.ts are generated from them.
// @code_class evidence
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import eventSchema from "../../schema/event.v0.schema.json" with { type: "json" };
import lineSchema from "../../schema/line.v0.schema.json" with { type: "json" };
import type { LedgerEvent } from "./event.gen.ts";
import { isRealTime } from "./time.ts";
import type { LedgerLine as GeneratedLine } from "./line.gen.ts";

export type { LedgerEvent };

/** The types that are activity, not evidence: they go to a file of their own without a chain. */
export const ACTIVITY_TYPES: ReadonlySet<LedgerEvent["type"]> = new Set(
  eventSchema.$defs.activity.enum as LedgerEvent["type"][],
);

/** A line of the ledger. Its event is checked against the event schema on its own. */
export type LedgerLine = Omit<GeneratedLine, "event"> & { event: LedgerEvent };

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
const validateEvent = ajv.compile<LedgerEvent>(eventSchema);
const validateLine = ajv.compile<GeneratedLine>(lineSchema);

/** What is wrong with a value as an event, one entry per fault. Empty when it is valid. */
export function eventFaults(value: unknown): string[] {
  const found = faults(validateEvent, value, "an event");
  // The pattern of `time` lets in a day that is not on the calendar and an hour that is not on the clock.
  const time = typeof value === "object" && value !== null ? (value as { time?: unknown }).time : undefined;
  if (typeof time === "string" && !isRealTime(time)) found.push("time: not a real time");
  return found;
}

/** What is wrong with a value as a line of the ledger, leaving its event aside. Empty when it is valid. */
export function lineFaults(value: unknown): string[] {
  return faults(validateLine, value, "a line");
}

/** How many characters of a field's name a reason shows. */
const SHOWN = 64;

/**
 * A field name from a line, as a reason shows it (#200): the name is the ledger's, not howl's, and reaches a terminal and a page. A plain
 * name (letters, digits, `_` and `-`, at most 64) stands as it is. Any other is quoted, cut at 64 characters with `…`, and every character
 * of the general categories Cc, Cf, Zl and Zp (controls, formats such as the marks of direction and the zero-width ones, the line and
 * paragraph separators) is written as `\uXXXX`, a character beyond the first plane as its two units. A name with a `.` is quoted, so that a
 * dot in a reason always comes from howl's own path.
 */
export function shown(name: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(name)) return name;
  const chars = [...name];
  const text = chars.slice(0, SHOWN).join("") + (chars.length > SHOWN ? "…" : "");
  return JSON.stringify(text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) =>
    Array.from({ length: c.length }, (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""),
  );
}

function faults(validate: ValidateFunction, value: unknown, what: string): string[] {
  if (validate(value)) return [];
  const found = (validate.errors ?? [])
    // The `if` keyword only reports that a branch failed; the branch reports what.
    .filter((e) => e.keyword !== "if")
    .map((e) => {
      const where = e.instancePath ? e.instancePath.slice(1).replaceAll("/", ".") : "";
      const at = (field: string) => [where, field].filter(Boolean).join(".");
      switch (e.keyword) {
        case "additionalProperties":
          return `${at(shown(e.params.additionalProperty))}: not a field of ${what}`;
        case "required":
          return `${at(e.params.missingProperty)}: missing`;
        case "not":
          // The only `not` of the schema: `to` on a type that is not a task given or taken back.
          return e.schemaPath === "#/not" ? "to: only on task.assigned and task.unassigned" : `${where || what}: ${e.message}`;
        case "enum":
          return `${where}: must be one of ${e.params.allowedValues.join(", ")}`;
        default:
          return `${where || what}: ${e.message}`;
      }
    });
  return [...new Set(found)];
}
