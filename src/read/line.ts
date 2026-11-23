// The provenance of one line of the ledger, for the event dialog (#191): the
// line as stored with its hashes, whether the chain is intact to it, the
// checkpoint kept beside the ledger that covers it, the signature's result,
// and the events of the same task or change. It reads the ledger and the
// checkpoint beside it, and writes nothing.
// @code_class reading
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkSignatures, type SignatureCheck } from "../keys/keys.ts";
import { hashLine } from "../ledger/ledger.ts";
import type { Verdict } from "../ledger/verify.ts";
import { actingAgents } from "./acting.ts";
import { readWhole, type Read, type Whole } from "./reader.ts";

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
  /** The line where the check of the chain fails, when it does. */
  broken: number | null;
  /** The line before `broken`, whose hash the line after it does not hold: it may have been changed. */
  doubted: boolean;
  /** The last line of the ledger: held by nothing after it, only by a checkpoint. */
  last: boolean;
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

/** What `/api/line` reads of a ledger as a whole, kept by the server until the file changes. */
export interface Prepared {
  whole: Whole;
  signatures: SignatureCheck;
  acting: Map<string, { agent: string }>;
}

export function prepareLines(ledger: string): Prepared {
  const whole = readWhole(ledger);
  return {
    whole,
    signatures: checkSignatures(whole.lines.map((r) => ({ n: r.n ?? 0, event: r.event }))),
    acting: actingAgents(whole.lines.map((r) => r.event)),
  };
}

/**
 * The first line the check does not prove: the line where it failed, or the
 * line before it when that line's hash is not held by a line after it (a
 * `prev` fault, or a line whose form could not be read).
 */
function firstUnproven(verdict: Verdict): number {
  if (verdict.ok) return verdict.lines + 1;
  const prevHeld = verdict.faults.every((f) => f.startsWith("hash:") || f.startsWith("event:"));
  return prevHeld ? verdict.line : verdict.line - 1;
}

/**
 * The provenance of line `n` of the ledger; null when the ledger has no such
 * line, or howl cannot read it. `verdict` is the check of the whole ledger. A
 * line is intact only when the check proves the chain past it: the last line
 * is held by nothing after it, only by a checkpoint.
 */
export function lineProvenance(ledger: string, prepared: Prepared, n: number, verdict: Verdict, project?: string): Provenance | null {
  const { whole, signatures: check, acting } = prepared;
  const read = whole.lines.find((r) => r.n === n);
  if (read === undefined) return null;
  const item: LineItem = { ...read };
  if (project !== undefined) item.project = project;
  const by = acting.get(read.event.id)?.agent;
  if (by !== undefined) item.by = by;

  const signed = check.byEvent.get(read.event.id);
  if (signed !== undefined) item.signed = signed;
  let signature: LineSignature | null = null;
  if (read.event.sig !== undefined) {
    const fault = check.faults.find((f) => f.line === n);
    // Every signed line that fails has its fault; a key's issue or revocation that holds is in no other list.
    signature = fault !== undefined ? { key: read.event.sig.key, ok: false, reason: fault.reason } : { key: read.event.sig.key, ok: true };
  }

  const unproven = firstUnproven(verdict);
  const intact = n < unproven;
  const broken = verdict.ok ? null : verdict.line;
  const kept = keptCheckpoint(ledger);
  let checkpoint: Covering | null = null;
  if (kept !== null && n <= kept.lines) {
    const bytes = whole.bytes[kept.lines - 1];
    // The head alone is not enough: the chain from this line up to it must hold too.
    checkpoint = { ...kept, holds: bytes !== undefined && hashLine(bytes) === kept.head && kept.lines < unproven };
  }

  return {
    item,
    intact,
    broken,
    doubted: broken !== null && !intact && n === unproven && n < broken,
    last: n === whole.bytes.length,
    checkpoint,
    signature,
    related: relatedEvents(whole.lines, n),
  };
}
