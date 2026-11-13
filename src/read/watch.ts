// `howl watch`: one line per event, then the events as they come.
import { LedgerError } from "../ledger/errors.ts";
import type { LedgerEvent } from "../ledger/schema.ts";
import { activityBeside, byTime, Tail, type Read } from "./reader.ts";

export interface WatchOptions {
  since?: string;
  filters: string[];
  json: boolean;
  follow: boolean;
  /** Seconds between two looks at the files while following. */
  interval: number;
  colour: boolean;
}

type Filter = (event: LedgerEvent) => boolean;

/** `field=value` pairs, all of which must match. A value ending in `*` matches what starts with the rest. */
export function parseFilters(pairs: string[]): Filter[] {
  return pairs.map((pair) => {
    const at = pair.indexOf("=");
    if (at <= 0) throw new LedgerError(`--filter ${pair}: give a field and a value, as type=tool.used`);
    const field = pair.slice(0, at);
    const value = pair.slice(at + 1);
    const matches = value.endsWith("*") ? (v: string) => v.startsWith(value.slice(0, -1)) : (v: string) => v === value;
    return (event: LedgerEvent) => {
      const v = fieldOf(event, field);
      return v !== undefined && matches(v);
    };
  });
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

const RED = "\u001b[31m";
const YELLOW = "\u001b[33m";
const RESET = "\u001b[0m";

/** The colour an event stands out in, or none: a wait for a person, failed checks, a review that asks for changes. */
function standOut(event: LedgerEvent): string | null {
  if (event.type === "checks.failed") return RED;
  if (event.type === "review.changes_requested") return YELLOW;
  if (event.type === "agent.waiting" && event.data?.notification_type !== "idle_prompt") return YELLOW;
  return null;
}

/** The time to the second, as UTC. */
export function shortTime(time: string): string {
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** One line: the time, claimed or observed, the actor, the type, what it concerns, and the short of its data. */
export function formatLine(event: LedgerEvent, colour: boolean): string {
  const concerns = [
    event.task !== undefined ? `task ${event.task}` : null,
    event.change !== undefined ? `change ${event.change}` : null,
    // The first 8 characters are enough to tell sessions apart on a screen; --filter takes the whole id.
    event.session !== undefined ? `session ${event.session.slice(0, 8)}` : null,
  ].filter(Boolean);
  const line = [
    shortTime(event.time),
    event.source.kind.padEnd(8),
    (event.actor?.id ?? "-").padEnd(16),
    event.type.padEnd(24),
    [...concerns, short(event)].filter(Boolean).join("  "),
  ].join(" ");
  const c = colour ? standOut(event) : null;
  return c ? `${c}${line}${RESET}` : line;
}

function short(event: LedgerEvent): string {
  const d = (event.data ?? {}) as Record<string, unknown>;
  const sha = event.sha ? event.sha.slice(0, 7) : "";
  switch (event.type) {
    case "tool.used":
      return [d.tool, d.target, d.outcome].filter((x) => typeof x === "string").join(" ");
    case "agent.waiting":
      return String(d.notification_type ?? "");
    case "session.started":
      return [event.model, d.source].filter(Boolean).join(" ");
    case "session.ended":
      return String(d.reason ?? "");
    default:
      if (event.type.startsWith("change.")) return [event.branch, sha].filter(Boolean).join(" ");
      if (event.type.startsWith("checks.") || event.type.startsWith("review.")) return sha;
      return Object.entries(d)
        .filter(([k]) => k !== "seen")
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
  }
}

/** Prints what is there, then, when following, what comes, until the process is stopped. */
export async function watch(ledger: string, options: WatchOptions, write: (line: string) => void): Promise<void> {
  const filters = parseFilters(options.filters);
  const since = options.since === undefined ? null : Date.parse(options.since);
  if (since !== null && Number.isNaN(since)) throw new LedgerError(`--since ${options.since}: not a time`);
  const shown = (r: Read) =>
    r.event.type !== "ledger.created" &&
    (since === null || Date.parse(r.event.time) >= since) &&
    filters.every((f) => f(r.event));
  const print = (r: Read) => write(options.json ? r.raw : formatLine(r.event, options.colour));

  const tails = [new Tail(ledger, "ledger"), new Tail(activityBeside(ledger), "activity")];
  const seen = new Set<string>();
  const take = (reads: Read[]) => {
    for (const r of reads) {
      if (seen.has(r.event.id)) continue;
      seen.add(r.event.id);
      if (shown(r)) print(r);
    }
  };
  take(byTime(tails.flatMap((t) => t.read())));
  if (!options.follow) return;

  let stopped = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopped = true;
    wake?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  while (!stopped) {
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, options.interval * 1000);
    });
    if (!stopped) take(tails.flatMap((t) => t.read()));
  }
}
