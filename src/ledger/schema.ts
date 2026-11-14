// The schemas, compiled once. The JSON Schema files are the source; the types
// in event.gen.ts and line.gen.ts are generated from them.
// @code_class evidence
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import eventSchema from "../../schema/event.v0.schema.json" with { type: "json" };
import lineSchema from "../../schema/line.v0.schema.json" with { type: "json" };
import type { LedgerEvent } from "./event.gen.ts";
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
  return faults(validateEvent, value, "an event");
}

/** What is wrong with a value as a line of the ledger, leaving its event aside. Empty when it is valid. */
export function lineFaults(value: unknown): string[] {
  return faults(validateLine, value, "a line");
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
          return `${at(e.params.additionalProperty)}: not a field of ${what}`;
        case "required":
          return `${at(e.params.missingProperty)}: missing`;
        case "enum":
          return `${where}: must be one of ${e.params.allowedValues.join(", ")}`;
        default:
          return `${where || what}: ${e.message}`;
      }
    });
  return [...new Set(found)];
}
