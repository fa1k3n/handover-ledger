// The event schema, compiled once. The JSON Schema file is the source;
// the types in event.gen.ts are generated from it.
import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../../schema/event.v0.schema.json" with { type: "json" };
import type { LedgerEvent } from "./event.gen.ts";

export type { LedgerEvent };

/** The fields of an event in the order they are written to a line. */
export const FIELD_ORDER = Object.keys(schema.properties) as (keyof LedgerEvent)[];

const validate = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true }).compile<LedgerEvent>(
  schema,
);

/** What is wrong with a value as an event, one entry per fault. Empty when it is valid. */
export function eventFaults(value: unknown): string[] {
  if (validate(value)) return [];
  const faults = (validate.errors ?? [])
    // The `if` keyword only reports that a branch failed; the branch reports what.
    .filter((e) => e.keyword !== "if")
    .map((e) => {
      const where = e.instancePath ? e.instancePath.slice(1).replaceAll("/", ".") : "";
      const at = (field: string) => [where, field].filter(Boolean).join(".");
      switch (e.keyword) {
        case "additionalProperties":
          return `${at(e.params.additionalProperty)}: not a field of an event`;
        case "required":
          return `${at(e.params.missingProperty)}: missing`;
        case "enum":
          return `${where}: must be one of ${e.params.allowedValues.join(", ")}`;
        default:
          return `${where || "the line"}: ${e.message}`;
      }
    });
  return [...new Set(faults)];
}
