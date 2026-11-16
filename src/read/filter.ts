// The filter of `howl watch` and of the event log (#82). A filter text is a
// CEL expression over `event`, or one `field=value` pair as before. Only this
// module names the CEL library; the page never loads it.
//
//   event.project == "a" && event.type.startsWith("review.")
//   has(event.change) && event.change == "30"
//
// A field the event does not have is an error, as in CEL: the event is left
// out and counted, and the first reason is kept. `has(event.change)` tests for
// a field. A wrong expression is refused before any event is read.
//
// A filter never sees a person's pseudonym: for a person, `event.actor.id` and `event.to.id`
// read "a person", so no expression tells two people apart. (A pair still
// matches a pseudonym; refusing that is #53's.)
// @code_class reading
import { Environment } from "@marcbachmann/cel-js";
import { LedgerError } from "../ledger/errors.ts";
import type { LedgerEvent } from "../ledger/schema.ts";
import { isPair } from "./filter-text.ts";

export interface Failed {
  /** How many events an expression could not be worked out for. */
  events: number;
  /** Why, for the first of them. */
  reason: string;
}

export interface Filters {
  /** Whether every filter text holds for the event. An event an expression gives an error for is not in the list. */
  test(event: LedgerEvent): boolean;
  /** What could not be worked out so far; null when nothing. */
  failed(): Failed | null;
}

type Test = (event: LedgerEvent) => boolean;

/** What a person reads as in a filter. */
export const A_PERSON = "a person";

const cel = new Environment().registerVariable("event", "dyn");

/** The filter texts, all of which must hold. Throws a `LedgerError` for a text that is neither a pair nor an expression that can be read. */
export function readFilters(texts: string[]): Filters {
  let events = 0;
  let reason: string | null = null;
  const fail = (why: string) => {
    events++;
    reason ??= why;
  };
  const tests = texts.map((text) => (isPair(text) ? pair(text) : expression(text, fail)));
  return {
    test: (event) => tests.every((t) => t(event)),
    failed: () => (reason === null ? null : { events, reason }),
  };
}

/** `field=value`. A value ending in `*` matches what starts with the rest. */
function pair(text: string): Test {
  const at = text.indexOf("=");
  const field = text.slice(0, at);
  const value = text.slice(at + 1);
  const matches = value.endsWith("*") ? (v: string) => v.startsWith(value.slice(0, -1)) : (v: string) => v === value;
  return (event) => {
    const v = fieldOf(event, field);
    return v !== undefined && matches(v);
  };
}

function fieldOf(event: LedgerEvent, field: string): string | undefined {
  switch (field) {
    case "actor":
      return event.actor?.id;
    case "kind":
      return event.source.kind;
    case "adapter":
      return event.source.adapter;
    default: {
      const v = (event as unknown as Record<string, unknown>)[field];
      return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
    }
  }
}

interface CelError {
  code?: string;
  summary?: string;
  message?: string;
  range?: { start: number; end: number };
}

/** A CEL expression over `event`, checked now and run for each event. */
function expression(text: string, fail: (why: string) => void): Test {
  let run: (context: { event: unknown }) => unknown;
  try {
    const checked = cel.check(text);
    if (!checked.valid) throw checked.error;
    if (checked.type !== "bool" && checked.type !== "dyn") {
      throw new LedgerError(`filter: this gives ${String(checked.type)}; a filter gives true or false`);
    }
    run = cel.parse(text) as unknown as typeof run;
  } catch (e) {
    if (e instanceof LedgerError) throw e;
    throw refusal(text, e as CelError);
  }
  return (event) => {
    let value: unknown;
    try {
      value = run({ event: seen(event) });
    } catch (e) {
      fail(why(e as CelError));
      return false;
    }
    if (value === true) return true;
    if (value !== false) fail("the expression gives no true or false for an event");
    return false;
  };
}

/** The event as a filter sees it: a person's pseudonym is not in it. */
function seen(event: LedgerEvent): LedgerEvent {
  const actor = event.actor?.kind === "person" ? { actor: { ...event.actor, id: A_PERSON } } : {};
  // #45: the same for `to`, a team member as `actor` is.
  const to = event.to?.kind === "person" ? { to: { ...event.to, id: A_PERSON } } : {};
  return { ...event, ...actor, ...to };
}

/** Why an expression is refused: the library's own words, and the place counted from 1. */
function refusal(text: string, e: CelError): LedgerError {
  const what = e.summary ?? e.message ?? "not an expression";
  const where = e.range ? ` at ${e.range.start + 1}` : "";
  // Someone who writes `type == "x"` or a single word means a field of the event.
  const hint = /\bevent\b/.test(text) ? "" : '. The event is `event`: write event.type == "review.approved", or a pair as type=review.*';
  return new LedgerError(`filter${where}: ${what}${hint}`);
}

/** Why an event could not be worked out, with what to write for a field it does not have. */
function why(e: CelError): string {
  const what = e.summary ?? e.message ?? "an error";
  const key = /^No such key: ([A-Za-z_][A-Za-z0-9_]*)$/.exec(what)?.[1];
  return key === undefined ? what : `${what}. Not every event has it: try has(event.${key}) && …`;
}

/**
 * Whether a filter can match a tool call, so that it needs the activity file:
 * a pair on `type` that matches `tool.used`, or an expression that names it.
 */
export function wantsActivity(texts: string[]): boolean {
  return texts.some((text) => {
    if (!isPair(text)) return text.includes("tool.used");
    if (!text.startsWith("type=")) return false;
    const value = text.slice("type=".length);
    return value.endsWith("*") ? "tool.used".startsWith(value.slice(0, -1)) : value === "tool.used";
  });
}
