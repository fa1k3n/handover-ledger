// The provenance of one line of the ledger, for the event dialog (#191): the
// line as stored with its hashes, whether the chain is intact to it, the
// checkpoint kept beside the ledger that covers it, the signature's result,
// and the events of the same task or change. It reads the ledger and the
// checkpoint beside it, and writes nothing.
// @code_class reading
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkSignatures } from "../keys/keys.ts";
import { hashLine } from "../ledger/ledger.ts";
import type { Verdict } from "../ledger/verify.ts";
import { actingAgents } from "./acting.ts";
import { readWhole, type Read } from "./reader.ts";

/** One event related to the line, as the dialog lists it. */
export interface Related {
  n: number;
  time: string;
  type: string;
  actor?: string;
  task?: string;
  change?: string;
  repo?: string;
}

export interface RelatedEvents {
  /** The nearest before the line, in the order of the lines. */
  before: Related[];
  /** The nearest after the line, in the order of the lines. */
  after: Related[];
  /** How many more there are beyond those given. */
  beforeMore: number;
  afterMore: number;
}

/** The checkpoint beside the ledger that covers a line: the number of lines it names, their head, when, and whether the ledger still holds that head. */
export interface Covering {
  lines: number;
  head: string;
  time: string;
  holds: boolean;
}

/** The signature's result for a signed line. */
export interface LineSignature {
  key: string;
  ok: boolean;
  reason?: string;
}

/** The same read as the event list gives it, with what the server adds. */
export interface LineItem extends Read {
  project?: string;
  by?: string;
  signed?: { key: string; actor: string; task?: string; change?: string; role?: string; until: string; ok: boolean; reason?: string };
}

export interface Provenance {
  item: LineItem;
  intact: boolean;
  /** The line where the chain breaks, when it does. */
  broken: number | null;
  checkpoint: Covering | null;
  signature: LineSignature | null;
  related: RelatedEvents;
}

/** The file beside the ledger where `howl up` and `howl observe` keep their last checkpoint. */
export const ANCHOR_FILE = "anchor.json";

const NEAREST = 10;

/** Whether two events concern the same task, or the same change of the same repository. */
function sameSubject(a: Read["event"], b: Read["event"]): boolean {
  if (a.task !== undefined && a.task === b.task) return true;
  return a.change !== undefined && a.change === b.change && a.repo === b.repo;
}

/**
 * The events of the same task or change as line `n`, the nearest ten before
 * it and after it, each side in the order of the lines. The order of the
 * lines is the ledger's; the time an event states may say otherwise.
 */
export function relatedEvents(lines: Read[], n: number): RelatedEvents {
  const line = lines.find((r) => r.n === n);
  const none = { before: [], after: [], beforeMore: 0, afterMore: 0 };
  if (line === undefined) return none;
  const found = lines.filter((r) => r.n !== undefined && r.n !== n && sameSubject(line.event, r.event)).sort((a, b) => a.n! - b.n!);
  const before = found.filter((r) => r.n! < n);
  const after = found.filter((r) => r.n! > n);
  return {
    before: before.slice(-NEAREST).map(related),
    after: after.slice(0, NEAREST).map(related),
    beforeMore: Math.max(0, before.length - NEAREST),
    afterMore: Math.max(0, after.length - NEAREST),
  };
}

function related(r: Read): Related {
  const e = r.event;
  const out: Related = { n: r.n!, time: e.time, type: e.type };
  if (e.actor !== undefined) out.actor = e.actor.id;
  if (e.task !== undefined) out.task = e.task;
  if (e.change !== undefined) out.change = e.change;
  if (e.repo !== undefined) out.repo = e.repo;
  return out;
}

/** The checkpoint kept beside the ledger, when it is there and can be read; else null. */
function keptCheckpoint(ledger: string): { lines: number; head: string; time: string } | null {
  try {
    const value = JSON.parse(readFileSync(join(dirname(ledger), ANCHOR_FILE), "utf8")) as Record<string, unknown>;
    const { at, lines, head } = value;
    if (typeof at !== "string" || typeof head !== "string" || typeof lines !== "number" || !Number.isInteger(lines) || lines < 1) return null;
    return { lines, head, time: at };
  } catch {
    return null;
  }
}

/**
 * The provenance of line `n` of the ledger; null when the ledger has no such
 * line, or howl cannot read it. `verdict` is the check of the whole ledger.
 */
export function lineProvenance(ledger: string, n: number, verdict: Verdict, project?: string): Provenance | null {
  const whole = readWhole(ledger);
  const read = whole.lines.find((r) => r.n === n);
  if (read === undefined) return null;
  const item: LineItem = { ...read };
  if (project !== undefined) item.project = project;
  const by = actingAgents(whole.lines.map((r) => r.event)).get(read.event.id)?.agent;
  if (by !== undefined) item.by = by;

  const check = checkSignatures(whole.lines.map((r) => ({ n: r.n ?? 0, event: r.event })));
  const signed = check.byEvent.get(read.event.id);
  if (signed !== undefined) item.signed = signed;
  let signature: LineSignature | null = null;
  if (read.event.sig !== undefined) {
    const fault = check.faults.find((f) => f.line === n);
    // Every signed line that fails has its fault; a key's issue or revocation that holds is in no other list.
    signature = fault !== undefined ? { key: read.event.sig.key, ok: false, reason: fault.reason } : { key: read.event.sig.key, ok: true };
  }

  const intact = verdict.ok || n < verdict.line;
  const kept = keptCheckpoint(ledger);
  let checkpoint: Covering | null = null;
  if (kept !== null && n <= kept.lines) {
    const bytes = whole.bytes[kept.lines - 1];
    checkpoint = { ...kept, holds: bytes !== undefined && hashLine(bytes) === kept.head };
  }

  return { item, intact, broken: verdict.ok ? null : verdict.line, checkpoint, signature, related: relatedEvents(whole.lines, n) };
}
