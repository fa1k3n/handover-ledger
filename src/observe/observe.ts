// `howl observe`: one round brings the inbox in, reads what has changed at the
// code host, and appends one event per thing that happened.
//
// No event twice: the id of an observed event is made from the host, the
// repository and the thing (and its time or commit), never from an account, so
// the same thing read again gives the same id, and an id in the ledger is
// passed over. Where the last round ended is kept in observe.json; without it
// the host is read from the start and nothing is written twice.
//
// The repository in an id is the host's lasting id of it (#48), so a rename or
// a move to another owner leaves the ids as they were. A ledger from before
// that holds ids made from `owner/name`: the names are read from the ledger
// when the observer starts, and an id of either form is the same event. `repo`
// on the event stays the name, as people read it.
//
// The cursor moves on only after a round in which every call went through.
// Otherwise the next round reads the same span again.
// @code_class recording
import { existsSync } from "node:fs";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ingestPass, type Pass, type Places } from "../inbox/ingest.ts";
import { events as ledgerEvents, type LedgerWriter } from "../ledger/ledger.ts";
import type { LedgerEvent } from "../ledger/schema.ts";
import { agentAccounts } from "../howl/project.ts";
import type { People } from "./people.ts";
import { checksOf, lastFinish, latestFailed, pendingNames, resultsOf, sameState, stateOf, type Result, type State } from "./results.ts";
import type { Account, Change, ChecksState, CodeHost, Push, Task } from "./port.ts";
import { happensBefore } from "./order.ts";
import type { TraceResult } from "../howl/trace-read.ts";

export interface ObserveSettings {
  project: string;
  activityDays: number;
  /** The agents as written in `howl.yml`: `name` or `name=account` (#46). */
  agents: string[];
  taskFromBranch?: string;
}

/**
 * #47: a head commit whose checks are watched: finishing them, or running them again, does not update the change. How
 * often it is asked about, and how long, see `plan`.
 */
interface Watched {
  sha: string;
  change: number;
  branch: string;
  task?: string;
  /** Whether the change was open when it was last read. */
  open: boolean;
  /** When the host last updated the change: a change that is updated starts the asking anew. A cursor from before has none. */
  updated?: string;
  /** When the head was pushed, or made; a cursor from before this step has none, and the clock starts when it is read. */
  headAt?: string;
  /** When the change was merged or closed, as the host says; none while it is open. */
  end?: string;
  /** A run of the head was going when it was last asked about: it is asked about in every round. */
  busy?: true;
  /** How long to wait after the last ask, in ms: it doubles with each ask in which nothing is going. */
  gap?: number;
  /** When to ask next, by the machine's clock; none: in the next round. */
  next?: string;
  /** #162: when the writer first refused an event of the head; kept while refusals go on, dropped when an event of it is written. A cursor from before has none. */
  refusedAt?: string;
}

/** #38: a head whose tests have not been read yet: the commit was not on the machine, or the round had read enough. */
interface TracePending {
  sha: string;
  change: number;
  branch: string;
  task?: string;
  /** The head's time, which the event takes. */
  at: string;
  /** Whether the change was open when it was last read. A closed change is asked once more, then let go. */
  open: boolean;
}

/** #44: the heads of a change, as `headsOf` reads them from the host's pushes. */
interface Heads {
  /** The head the change was opened with. */
  opening: string;
  /** Whether that head is the one a round saw, and not what the host said. */
  openingInferred: boolean;
  /** The pushes after the opening, oldest first: its new heads. */
  pushes: Push[];
  /** Whether the host's pushes do not reach the head now: it is then a new head as a round sees it. */
  unpushed: boolean;
  /** When the head now was pushed, else when it was made. */
  headAt: string;
  /** The head that was there at a time. */
  at: (time: string) => string;
  /** Whether the host gave a list of pushes that does not reach the head now: the change may have to wait (#44). */
  missing: boolean;
}

interface Cursor {
  since: string | null;
  watch: Watched[];
  trace: TracePending[];
  /**
   * #44: the host refuses the list of pushes: how many heads were written as inferred because of it, and from when
   * that is counted (none in a cursor of #130, which kept no time).
   */
  refused?: { heads: number; since?: string };
  /**
   * #44: the changes whose head the list of pushes does not reach: the head waited for, and from when, by the machine's
   * clock. The wait is for that head: once the list holds it, the wait is over.
   */
  waiting?: Record<string, { sha: string; since: string }>;
  /** #44: the changes whose list of pushes was refused, and how many rounds running. */
  refusals?: Record<string, number>;
  /**
   * #47: the heads let go, with the time the host last updated their change: a change read again without an update
   * does not watch its head again.
   */
  settled?: Record<string, string>;
}

export interface Round {
  ingested: Pass;
  appended: number;
  /** Whether every call of the round went through. */
  complete: boolean;
}

export interface ObserverParts {
  host: CodeHost;
  /** The writer of the ledger, held for as long as the observer runs. */
  writer: LedgerWriter;
  ledgerPath: string;
  places: Places;
  cursorPath: string;
  people: People;
  settings: ObserveSettings;
  warn: (message: string) => void;
  /** #6: where the first round starts, when there is no cursor yet; none reads from the beginning. */
  start?: string;
  /** #38: what the tests of a commit name, read from the repository on this machine. */
  traceAt?: (sha: string) => TraceResult;
}

/**
 * #44: how long a change waits for its list of pushes to reach its head, from the first round that found the head
 * missing, by the machine's clock. Until then the list may only lag; after it the head is written as inferred.
 */
export const STILL_MS = 5 * 60_000;

/**
 * #47: how the checks of a head are watched. While a run of it is going it is asked about in every round. Otherwise
 * after CHECKS_FIRST_MS, and then after twice as long each time, up to CHECKS_LAST_MS. A change that the host lists as
 * updated starts that anew. A head of an open change is let go CHECKS_QUIET_MS after its last result; one of a change
 * that ended CHECKS_ENDED_MS after the end, when `checks.none` or `checks.unfinished` is written if it is due.
 */
export const CHECKS_FIRST_MS = 60_000;
export const CHECKS_LAST_MS = 60 * 60_000;
/** #162: how long a head is asked about after the writer first refused its events, before it is let go. */
const REFUSED_MS = 24 * 60 * 60_000;
export const CHECKS_QUIET_MS = 7 * 24 * 60 * 60_000;
export const CHECKS_ENDED_MS = 60 * 60_000;

/** #38: the most heads read in one round: the writer is held while they are, and the rest wait for the next round. */
const MAX_TRACE_READS = 10;

export class Observer {
  /** The head commit of each change when it was opened, as the ledger has it. */
  private readonly openedHeads = new Map<number, string>();
  /** #48: the change openings the ledger holds, as written under any form of id; read at the start. */
  private readonly openings: { id: string; change: number; sha: string }[] = [];
  /** #48: the names the ledger's old ids were made from, apart from the repository's name now. */
  private readonly oldNames = new Set<string>();
  /** #48: what the host said of an old name, asked for once for as long as the observer runs. */
  private readonly confirmed = new Map<string, boolean>();
  /** #48: the start of an id of the lasting form, once the host has said the repository's id. */
  private prefix: string | undefined;
  /** #48: the starts of every id this repository's events have had, the lasting form first. */
  private prefixes: string[] = [];
  private readonly taskPattern: RegExp | null;
  /** #46: the name of an agent by its account at the host. */
  private readonly names: Map<string, string>;
  private readonly host: CodeHost;
  private readonly writer: LedgerWriter;
  private readonly places: Places;
  private readonly cursorPath: string;
  private readonly people: People;
  private readonly settings: ObserveSettings;
  private readonly warn: (message: string) => void;
  private readonly start: string | undefined;
  private readonly traceAt: ObserverParts["traceAt"];
  /** #38: the heads waiting for their tests to be read, by change and commit; of the round that runs. */
  private pendingTrace = new Map<string, TracePending>();
  /** #47: the results of checks the ledger holds, as observed under any form of id; read at the start. */
  private readonly resultsHeld: { id: string; sha: string; time: number; state: State }[] = [];
  /** #47: for each commit, the last result the ledger holds: only a change of result later than it is written. */
  private readonly lastResult = new Map<string, { time: number; state: State }>();

  constructor(parts: ObserverParts) {
    this.start = parts.start;
    this.traceAt = parts.traceAt;
    ({
      host: this.host,
      writer: this.writer,
      places: this.places,
      cursorPath: this.cursorPath,
      people: this.people,
      settings: this.settings,
      warn: this.warn,
    } = parts);
    const { host, settings } = parts;
    this.names = agentAccounts(settings.agents);
    this.taskPattern = settings.taskFromBranch === undefined ? null : new RegExp(settings.taskFromBranch);
    for (const e of ledgerEvents(parts.ledgerPath)) {
      if (e.source?.adapter !== host.name || e.source.kind !== "observed" || typeof e.id !== "string") continue;
      // An id made from a name starts with the name the event's `repo` held then.
      if (typeof e.repo === "string" && e.repo !== host.repository && e.id.startsWith(`${host.name}:${e.repo}:`)) this.oldNames.add(e.repo);
      if (e.type === "change.opened" && e.sha) this.openings.push({ id: e.id, change: Number(e.change), sha: e.sha });
      const sha = e.sha;
      if ((e.type === "checks.passed" || e.type === "checks.failed") && sha !== undefined) {
        const names = (e.data as { failed?: unknown } | undefined)?.failed;
        const state: State = { state: e.type === "checks.passed" ? "passed" : "failed", failed: Array.isArray(names) ? names.map(String).sort() : [] };
        this.resultsHeld.push({ id: e.id, sha, time: Date.parse(e.time ?? ""), state });
      }
    }
  }

  /**
   * #48: the ids of events, and the heads the ledger has of changes, from the host's id of the repository. An old
   * name is this repository's only when the host says so: an id made from the name of another repository is not
   * this repository's event. A name the host cannot answer for throws.
   */
  private async learn(): Promise<void> {
    const repositoryId = await this.host.repositoryId();
    const names = new Set([this.host.repository]);
    for (const name of this.oldNames) {
      let same = this.confirmed.get(name);
      if (same === undefined) {
        try {
          same = await this.host.isSameRepository(name);
        } catch (e) {
          throw new Error(`the host cannot say whether ${name}, a name in the ledger's ids, is ${this.host.repository}: ${(e as Error).message}`);
        }
        this.confirmed.set(name, same);
      }
      if (same) names.add(name);
    }
    this.prefix = `${this.host.name}:${repositoryId}:`;
    this.prefixes = [...new Set([this.prefix, ...[...names].map((n) => `${this.host.name}:${n}:`)])];
    for (const o of this.openings) {
      if (this.prefixes.some((p) => o.id.startsWith(p))) this.openedHeads.set(o.change, o.sha);
    }
    // #47: the last result of each commit, the latest in time (the later line where two are of one time).
    for (const r of this.resultsHeld) {
      if (!this.prefixes.some((p) => r.id.startsWith(p))) continue;
      const held = this.lastResult.get(r.sha);
      if (held === undefined || r.time >= held.time) this.lastResult.set(r.sha, { time: r.time, state: r.state });
    }
  }

  async round(now = new Date()): Promise<Round> {
    const ingested = ingestPass(this.places, this.writer, this.settings.activityDays, now.getTime());
    // #48: every id is made from the host's id of the repository, and an old name must be confirmed by the host:
    // without either nothing observed is written, and the cursor stays.
    if (this.prefix === undefined) {
      try {
        await this.learn();
      } catch (e) {
        this.warn(`${this.host.repository}: ${(e as Error).message}`);
        return { ingested, appended: 0, complete: false };
      }
    }
    const seen = now.toISOString();
    const first = !existsSync(this.cursorPath);
    const cursor = this.readCursor();
    if (first && this.start !== undefined) cursor.since = this.start;
    const watch = new Map(cursor.watch.map((w) => [w.sha, w]));
    const settled = { ...(cursor.settled ?? {}) };
    this.pendingTrace = new Map(cursor.trace.map((p) => [`${p.change}:${p.sha}`, p]));
    const found: LedgerEvent[] = [];
    let complete = true;
    const failed = (call: string, e: unknown) => {
      complete = false;
      this.warn(`${call}: ${(e as Error).message}`);
    };

    let latest = cursor.since;
    // #44: the earliest update of a change that waits for its list of pushes: the cursor does not pass it.
    let hold: string | null = null;
    // #44: whether a list of pushes was refused, or read, in this round; the inferred heads written because of a refusal.
    let refused = false;
    let readable = false;
    const refusedIds = new Set<string>();
    // #44: what the rounds remember of the lists of pushes, by change: since when a head is missing, refusals running.
    const waiting = { ...(cursor.waiting ?? {}) };
    const refusals = { ...(cursor.refusals ?? {}) };
    const waited: number[] = [];
    const refusedOnce: number[] = [];
    let refs: Awaited<ReturnType<CodeHost["listUpdated"]>> = [];
    try {
      refs = await this.host.listUpdated(cursor.since);
    } catch (e) {
      failed("list", e);
    }

    for (const ref of refs) {
      if (latest === null || ref.updatedAt > latest) latest = ref.updatedAt;
      if (ref.kind === "task") {
        let task: Task;
        try {
          task = await this.host.task(ref.number);
        } catch (e) {
          failed(`task ${ref.number}`, e);
          continue;
        }
        found.push(...this.taskEvents(task, seen));
      } else {
        let change: Change;
        try {
          change = await this.host.change(ref.number);
        } catch (e) {
          failed(`change ${ref.number}`, e);
          continue;
        }
        // #44: a refusal is believed only when the next round gets it again; a list read starts the count anew. Until
        // then, and while a head the list does not reach waits, nothing of the change is written and the cursor stays.
        const key = String(change.number);
        const heads = this.headsOf(change);
        let later = false;
        if (change.pushesRefused) {
          refusals[key] = (refusals[key] ?? 0) + 1;
          if (refusals[key] < 2) {
            refusedOnce.push(change.number);
            later = true;
          }
        } else if (change.pushes !== undefined) {
          delete refusals[key];
          readable = true;
        }
        // #44: the wait is for one head. Once the list holds the head it waited for, that wait is over, and a later head
        // that is missing starts a wait of its own.
        const wait = waiting[key];
        if (wait !== undefined && (change.pushes ?? []).some((p) => p.sha === wait.sha)) delete waiting[key];
        if (heads.missing) {
          waiting[key] ??= { sha: change.head.sha, since: now.toISOString() };
          if (now.getTime() - Date.parse(waiting[key].since) < STILL_MS) {
            waited.push(change.number);
            later = true;
          }
        }
        if (later) {
          if (hold === null || ref.updatedAt < hold) hold = ref.updatedAt;
          continue;
        }
        // Written: nothing of the change is waited for, and a change that has ended keeps no count of refusals.
        delete waiting[key];
        if (change.closedAt !== undefined || change.mergedAt !== undefined) delete refusals[key];
        const events = this.changeEvents(change, seen, heads);
        found.push(...events);
        if (change.pushesRefused) {
          refused = true;
          for (const e of events) if ((e.data as { inferred?: unknown } | undefined)?.inferred === true) refusedIds.add(e.id);
        }
        this.arm(watch, settled, change, heads);
      }
    }

    // #47: the heads that are due, asked about; one commit's checks never end the round.
    const goes: Watched[] = [];
    for (const [sha, w] of watch) {
      if (w.busy !== true && w.next !== undefined && now.getTime() < Date.parse(w.next)) continue;
      let checks: ChecksState;
      try {
        checks = await this.host.checks(sha);
      } catch (e) {
        failed(`checks ${sha}`, e);
        continue;
      }
      try {
        const outcome = this.checksOf(w, checks, now, seen);
        found.push(...outcome.events);
        // Let go only once its last event is written: below, after the events are.
        if (outcome.ends) goes.push(w);
      } catch (e) {
        this.warn(`${this.host.repository}: checks of ${sha.slice(0, 7)} of change ${w.change}: ${(e as Error).message}`);
      }
    }

    // #6: a reader of the ledger learns that nothing before the start was looked at. Once, in the first round.
    if (first && this.start !== undefined) {
      found.push(this.event("observe:started", "observe.started", seen, undefined, { data: { since: this.start } }, seen));
    }

    found.push(...this.traceEvents(seen));

    let appended = 0;
    let refusedHeads = 0;
    // #112: by time, and at the same time by what can happen first: opened before assigned.
    found.sort(happensBefore);
    // #47: a result that the writer refuses stops the checks of that one commit for the round, and never the round.
    const stopped = new Set<string>();
    const giveUp = new Set<string>();
    for (const e of found) {
      if (this.known(e.id.slice(this.prefix!.length))) continue;
      const ofChecks = e.type.startsWith("checks.") && e.sha !== undefined;
      if (ofChecks && stopped.has(e.sha!)) continue;
      try {
        this.writer.append(e);
      } catch (err) {
        if (!ofChecks) throw err;
        stopped.add(e.sha!);
        // #162: asked again on the schedule of any watched head, and let go once the refusals have gone on for a day.
        const w = watch.get(e.sha!);
        if (w !== undefined) {
          w.refusedAt ??= now.toISOString();
          if (now.getTime() - Date.parse(w.refusedAt) >= REFUSED_MS) {
            giveUp.add(e.sha!);
            this.warn(`${this.host.repository}: checks of ${e.sha!.slice(0, 7)} of change ${e.change}: the writer refused them for a day; its checks were not written, and its head is let go`);
            continue;
          }
          // A head still watched has had its next ask set by its checks; only one that its checks let go has none.
          if (w.busy !== true && goes.includes(w)) {
            w.gap = w.gap === undefined ? CHECKS_FIRST_MS : Math.min(w.gap * 2, CHECKS_LAST_MS);
            w.next = new Date(now.getTime() + w.gap).toISOString();
          }
        }
        this.warn(`${this.host.repository}: checks of ${e.sha!.slice(0, 7)} of change ${e.change}: ${(err as Error).message}; its events of this round are not written, and its head is asked about again`);
        continue;
      }
      appended++;
      if (ofChecks) delete watch.get(e.sha!)?.refusedAt;
      if (refusedIds.has(e.id)) refusedHeads++;
      if (e.type === "change.opened" && e.sha) this.openedHeads.set(Number(e.change), e.sha);
      if ((e.type === "checks.passed" || e.type === "checks.failed") && e.sha) {
        const names = (e.data as { failed?: unknown } | undefined)?.failed;
        this.lastResult.set(e.sha, { time: Date.parse(e.time), state: { state: e.type === "checks.passed" ? "passed" : "failed", failed: Array.isArray(names) ? names.map(String) : [] } });
      }
    }

    // #44: a refused list of pushes is said on every round until a list is read again, with the heads it cost since the
    // count began. A count from a cursor that kept no time says only that it is since the cursor was made.
    let refusal = cursor.refused;
    if (refused) refusal = { heads: (refusal?.heads ?? 0) + refusedHeads, since: refusal === undefined ? now.toISOString() : refusal.since };
    else if (readable) refusal = undefined;
    const numbers = (list: number[]) => `change${list.length === 1 ? "" : "s"} ${list.sort((a, b) => a - b).join(", ")}`;
    for (const n of refusedOnce) this.warn(`${this.host.repository}: change ${n}: the list of pushes was refused once; it is asked again in the next round`);
    if (refusal !== undefined) {
      this.warn(
        `${this.host.repository}: the list of pushes cannot be read: the host refuses it, perhaps for want of a permission; ` +
          `${refusal.heads} head${refusal.heads === 1 ? "" : "s"} written as inferred because of it ` +
          `since ${refusal.since ?? "the cursor in observe.json was made"}`,
      );
    }
    if (waited.length > 0) this.warn(`${this.host.repository}: waiting for the list of pushes to reach the head of ${numbers(waited)}`);

    // #47: a head is let go once its last event is written; one whose event the writer refused stays, and is asked again.
    for (const sha of giveUp) {
      const w = watch.get(sha);
      if (w !== undefined && !goes.includes(w)) goes.push(w);
    }
    for (const w of goes) {
      if (stopped.has(w.sha) && !giveUp.has(w.sha)) continue;
      watch.delete(w.sha);
      if (w.updated !== undefined) settled[w.sha] = w.updated;
    }

    this.people.save();
    const since = complete ? (hold !== null && (latest === null || hold < latest) ? hold : latest) : cursor.since;
    // #47: a head let go is remembered only while its change can still be listed again.
    for (const [sha, updated] of Object.entries(settled)) if (since !== null && updated < since) delete settled[sha];
    this.writeCursor({
      since,
      watch: [...watch.values()],
      trace: [...this.pendingTrace.values()],
      ...(refusal !== undefined ? { refused: refusal } : {}),
      ...(Object.keys(waiting).length > 0 ? { waiting } : {}),
      ...(Object.keys(refusals).length > 0 ? { refusals } : {}),
      ...(Object.keys(settled).length > 0 ? { settled } : {}),
    });
    return { ingested, appended, complete };
  }

  /**
   * #38: reads the tests of the heads that wait, at most MAX_TRACE_READS in a round. A head whose commit is not on
   * the machine waits for the next round while its change is open, and once more after it is closed. A head that
   * cannot be read at all, as a commit with no settings, is let go.
   */
  private traceEvents(seen: string): LedgerEvent[] {
    const found: LedgerEvent[] = [];
    if (this.traceAt === undefined) return found;
    let reads = 0;
    for (const [key, p] of this.pendingTrace) {
      const id = `trace:${p.change}:${p.sha}`;
      if (this.known(id)) {
        this.pendingTrace.delete(key);
        continue;
      }
      if (reads >= MAX_TRACE_READS) break;
      reads++;
      const result = this.traceAt(p.sha);
      if (result.state === "read") {
        const fields = { change: String(p.change), branch: p.branch, sha: p.sha, task: p.task };
        found.push(this.event(id, "trace.read", p.at, undefined, { ...fields, data: { ...result.summary } }, seen));
        this.pendingTrace.delete(key);
      } else if (result.state === "never") {
        if (!result.quiet) this.warn(`trace ${p.sha.slice(0, 7)} of change ${p.change}: ${result.why}`);
        this.pendingTrace.delete(key);
      } else if (!p.open) {
        this.pendingTrace.delete(key);
      }
    }
    return found;
  }

  private taskEvents(task: Task, seen: string): LedgerEvent[] {
    const n = task.number;
    const of = { task: String(n) };
    const found = [
      this.event(`task:${n}:opened`, "task.opened", task.openedAt, task.openedBy, of, seen),
      // #45: the actor of a giving is the one who gave the task, and `to` the one who got it. Where the host says
      // nothing of who gave it there is no actor. Taken back: the actor took it, `to` is who had it.
      ...task.assignments.map((a) => this.event(`task:${n}:assigned:${a.id}`, "task.assigned", a.at, a.by, of, seen, a.assignee)),
      ...(task.unassignments ?? []).map((u) => this.event(`task:${n}:unassigned:${u.id}`, "task.unassigned", u.at, u.by, of, seen, u.assignee)),
      ...(task.reopenings ?? []).map((r) => this.event(`task:${n}:reopened:${r.id}`, "task.reopened", r.at, r.by, of, seen)),
    ];
    if (task.closedAt) {
      found.push(this.event(`task:${n}:closed:${task.closedAt}`, "task.closed", task.closedAt, task.closedBy, of, seen));
    }
    return found;
  }

  /** The events of a change, with its heads as `headsOf` reads them (#44). */
  private changeEvents(change: Change, seen: string, heads: Heads): LedgerEvent[] {
    const n = change.number;
    const of = (sha: string) => ({ change: String(n), branch: change.branch, sha, task: this.taskOf(change) });
    const head = change.head.sha;
    const found = [
      this.event(`change:${n}:opened`, "change.opened", change.openedAt, change.openedBy, { ...of(heads.opening), ...(heads.openingInferred ? { data: { inferred: true } } : {}) }, seen),
    ];

    // #44: each push after the opening is a new head, with who pushed it and when, as the host says. A head pushed
    // for the first time keeps the id a new head always had; pushed again, or back to the head the change was opened
    // with, it takes the host's id of the push as well.
    const pushed = new Set([heads.opening]);
    for (const p of heads.pushes) {
      const key = pushed.has(p.sha) ? `change:${n}:head:${p.sha}:${p.id}` : `change:${n}:head:${p.sha}`;
      pushed.add(p.sha);
      found.push(this.event(key, "change.updated", p.at, p.by, { ...of(p.sha), ...(p.forced ? { data: { forced: true } } : {}) }, seen));
    }
    // The fall-back: a head the host told no push for, and that is not the one the change was opened with, is a new
    // head as a round sees it, at the time of its commit. It says so.
    if (heads.unpushed && !pushed.has(head)) {
      found.push(this.event(`change:${n}:head:${head}`, "change.updated", change.head.at, undefined, { ...of(head), data: { inferred: true } }, seen));
    }

    // #25: a change to .howl/ is high risk: one event per head that touches it, with the paths.
    const config = (change.files ?? []).filter((f) => f === ".howl" || f.startsWith(".howl/"));
    if (config.length > 0) {
      found.push(this.event(`config:${n}:${head}`, "config.changed", heads.headAt, undefined, { ...of(head), data: { paths: config } }, seen));
    }

    // #38: what the tests of this head name is read once the round has its events: the head waits for that.
    if (this.traceAt !== undefined && !this.known(`trace:${n}:${head}`)) {
      const task = this.taskOf(change);
      this.pendingTrace.set(`${n}:${head}`, { sha: head, change: n, branch: change.branch, ...(task !== undefined ? { task } : {}), at: heads.headAt, open: change.closedAt === undefined });
    }

    // #44: what has no commit of its own is of the head that was there at its time.
    const at = heads.at;
    for (const r of change.reviews) {
      found.push(this.event(`review:${r.id}`, `review.${r.state}`, r.at, r.by, of(r.sha ?? at(r.at)), seen));
    }
    // #45: a change opened again, and a review dismissed. The text of a dismissal is never kept.
    for (const r of change.reopenings ?? []) {
      found.push(this.event(`change:${n}:reopened:${r.id}`, "change.reopened", r.at, r.by, of(at(r.at)), seen));
    }
    // The review that was dismissed is a review that happened. One the host no longer lists is written from what the
    // dismissal names of it, before the dismissal. A review the host names and the ledger does not hold: `review_unseen`.
    // A host that does not say which review: `review_unnamed`, and nothing is said of whether the ledger holds it.
    const listed = new Set(change.reviews.map((r) => r.id));
    for (const d of change.dismissals ?? []) {
      let unseen = false;
      if (d.review !== undefined && !listed.has(d.review) && !this.known(`review:${d.review}`)) {
        if (d.state !== undefined && d.reviewed !== undefined) {
          found.push(this.event(`review:${d.review}`, `review.${d.state}`, d.reviewed.at, d.reviewed.by, of(d.reviewed.sha ?? at(d.reviewed.at)), seen));
        } else unseen = true;
      }
      const data = { ...(d.review !== undefined ? { review: d.review } : {}), ...(d.state !== undefined ? { state: d.state } : {}), ...(unseen ? { review_unseen: true } : {}), ...(d.review === undefined ? { review_unnamed: true } : {}) };
      found.push(this.event(`review:dismissed:${d.id}`, "review.dismissed", d.at, d.by, { ...of(at(d.at)), data }, seen));
    }
    // #28: a comment is a review only when the project's pattern says so. The key is the one comments had as
    // reviews before (#20), so a comment already in the ledger is not written again under another type.
    for (const c of change.comments ?? []) {
      found.push(this.event(`review:c${c.id}`, c.review ? "review.commented" : "change.commented", c.at, c.by, of(at(c.at)), seen));
    }
    if (change.mergedAt) {
      found.push(this.event(`change:${n}:merged`, "change.merged", change.mergedAt, change.mergedBy, of(at(change.mergedAt)), seen));
    } else if (change.closedAt) {
      found.push(this.event(`change:${n}:closed:${change.closedAt}`, "change.closed", change.closedAt, change.closedBy, of(at(change.closedAt)), seen));
    }
    return found;
  }

  /**
   * #44: the heads of a change, from the pushes the host tells. The change was opened with the head of the last push
   * before it; where the list no longer holds that push, with the head the first push after it replaced, which is marked
   * as inferred, as it rests on the list having dropped no push in between. The pushes after the opening, up to its end,
   * are its new heads. A push to the branch after the change was merged or closed is not of it.
   *
   * Where the host's list does not reach the head now (`missing`), the round makes the change wait (STILL_MS): the
   * list may lag. After that, or where the host tells no list (a change from a fork, a list refused), the head now is
   * the one a round sees, marked as inferred. It is never lost.
   */
  private headsOf(change: Change): Heads {
    const head = change.head.sha;
    const recorded = this.openedHeads.get(change.number);
    const time = (p: Push) => Date.parse(p.at);
    const given = change.pushes !== undefined;
    // Stable: pushes of one second keep the order the host gave them in.
    const all = [...(change.pushes ?? [])].sort((a, b) => time(a) - time(b));
    const opened = Date.parse(change.openedAt);
    const end = change.closedAt !== undefined ? Date.parse(change.closedAt) : Infinity;
    const until = all.filter((p) => time(p) <= end);
    let after = until.filter((p) => time(p) > opened);
    const pushedBefore = until.filter((p) => time(p) <= opened).at(-1)?.sha;
    const told = pushedBefore ?? after[0]?.before;
    const opening = recorded ?? told ?? head;
    // A ledger from before this step may hold the change opened with a later head than the host's first, as a round
    // saw it: the pushes up to that head come before what the ledger tells, and are not written now.
    if (recorded !== undefined && told !== undefined && told !== recorded) {
      const i = after.findIndex((p) => p.sha === recorded);
      if (i >= 0) after = after.slice(i + 1);
    }
    // The last head the host's pushes tell of: none when the list tells nothing of this change.
    const lastTold = after.at(-1)?.sha ?? (told !== undefined ? opening : undefined);
    const unpushed = !given || lastTold !== head;
    const lastPush = until.at(-1);
    const headPush = until.findLast((p) => p.sha === head);
    return {
      opening,
      openingInferred: recorded === undefined && pushedBefore === undefined,
      pushes: after,
      unpushed,
      headAt: headPush?.at ?? change.head.at,
      missing: given && unpushed,
      // What has no commit of its own is of the head of the last push before it, as the host's pushes say. Only what
      // comes after the last of those pushes can be of a head the host told no push for. With no list, the head now.
      at: (t) => {
        if (!given) return head;
        const ms = Date.parse(t);
        if (unpushed && (lastPush === undefined || ms > time(lastPush))) return head;
        return until.findLast((p) => time(p) <= ms && time(p) > opened)?.sha ?? opening;
      },
    };
  }

  /**
   * #47: the head of a change is watched, whether or not it has a result: a run again later is not missed. A change
   * that is read again and was not updated at the host keeps what its head's watch holds (the intervals); one that was
   * starts anew. A head that was let go is not watched again by a change that was not updated.
   */
  private arm(watch: Map<string, Watched>, settled: Record<string, string>, change: Change, heads: Heads): void {
    const sha = change.head.sha;
    for (const [s, w] of watch) if (w.change === change.number && s !== sha) watch.delete(s);
    const ended = change.closedAt !== undefined || change.mergedAt !== undefined;
    const end = ended ? (change.mergedAt ?? change.closedAt) : undefined;
    const held = watch.get(sha);
    if (held !== undefined && held.change === change.number && held.updated === change.updatedAt) {
      held.open = !ended;
      if (end !== undefined) held.end = end;
      else delete held.end;
      return;
    }
    if (held === undefined && settled[sha] === change.updatedAt) return;
    delete settled[sha];
    watch.set(sha, {
      sha,
      change: change.number,
      branch: change.branch,
      task: this.taskOf(change),
      open: !ended,
      updated: change.updatedAt,
      headAt: heads.headAt,
      ...(end !== undefined ? { end } : {}),
    });
  }

  /**
   * #47: what an ask about a head gives. The events: each change of the result later than the last one the ledger holds
   * for the commit, worked out from every run by its own time, and held against the host's own list of the latest runs
   * (where they differ the host's is written, marked, as the changes before it could not be told); `checks.none` for a
   * commit that never had a check, and `checks.unfinished` for a head let go with runs still going. And whether the head
   * is let go, and when it is asked about next.
   */
  private checksOf(w: Watched, checks: ChecksState, now: Date, seen: string): { events: LedgerEvent[]; ends: boolean } {
    const t = now.getTime();
    const events: LedgerEvent[] = [];
    const of = { change: String(w.change), branch: w.branch, sha: w.sha, task: w.task };
    const going = checks.runs.some((r) => r.result === "pending");
    const last = this.lastResult.get(w.sha);

    // The changes of the result, forward only.
    const fresh: (Result & { untold?: true; differs?: true })[] = [];
    const worked = stateOf(checks.runs);
    const hosts = checks.latest !== undefined ? stateOf(checks.latest) : null;
    const host = checks.latest !== undefined ? lastFinish(checks.latest) : null;
    // The host's list is taken only where it holds every check of the set worked out; where it leaves one out, the
    // result worked out stands and says that the host's list differs.
    const differs = !going && worked !== null && hosts !== null && host !== null && !sameState(worked, hosts);
    const whole = differs && [...checksOf(checks.runs)].every((c) => checksOf(checks.latest!).has(c));
    if (whole) {
      if ((last === undefined || Date.parse(host!.at) > last.time) && (last === undefined || !sameState(last.state, hosts!))) fresh.push({ ...hosts!, at: host!.at, run: host!.run, untold: true });
    } else {
      let prev = last?.state ?? null;
      for (const r of resultsOf(checks.runs)) {
        if (last !== undefined && Date.parse(r.at) <= last.time) continue;
        if (prev !== null && sameState(prev, r)) continue;
        fresh.push(r);
        prev = r;
      }
      const final = fresh.at(-1);
      if (differs && final !== undefined && worked !== null && sameState(final, worked)) final.differs = true;
    }
    fresh.forEach((r, i) => {
      // The first result of a commit keeps the id that a commit's checks have had; a later one the host's id of the run that completed it.
      const key = last === undefined && i === 0 && !this.known(`checks:${w.sha}`) ? `checks:${w.sha}` : `checks:${w.sha}:${r.run}`;
      const data = { ...(r.state === "failed" ? { failed: r.failed } : {}), ...(r.untold ? { changes_untold: true } : {}), ...(r.differs ? { host_list_differs: true } : {}) };
      events.push(this.event(key, `checks.${r.state}`, r.at, undefined, { ...of, data }, seen));
    });

    // How long it is watched, and how often it is asked about.
    const finished = checks.runs.map((r) => Date.parse(r.at ?? "")).filter((x) => !Number.isNaN(x));
    const next = (until: number) => {
      w.gap = w.gap === undefined ? CHECKS_FIRST_MS : Math.min(w.gap * 2, CHECKS_LAST_MS);
      w.next = new Date(Math.min(t + w.gap, until)).toISOString();
    };
    w.headAt ??= seen;
    if (going) {
      // Asked about in every round while a run of it goes.
      w.busy = true;
      delete w.next;
      delete w.gap;
    } else {
      delete w.busy;
    }
    if (w.open) {
      if (going) return { events, ends: false };
      const quiet = Math.max(Date.parse(w.headAt), ...finished) + CHECKS_QUIET_MS;
      if (t >= quiet) return { events, ends: true };
      next(quiet);
      return { events, ends: false };
    }
    w.end ??= seen;
    const limit = Date.parse(w.end) + CHECKS_ENDED_MS;
    if (t < limit) {
      if (!going) next(limit);
      return { events, ends: false };
    }
    if (checks.runs.length === 0 && last === undefined && fresh.length === 0 && !this.known(`checks:${w.sha}:none`)) {
      events.push(this.event(`checks:${w.sha}:none`, "checks.none", w.end, undefined, of, seen));
    } else if (going && !this.known(`checks:${w.sha}:unfinished`)) {
      events.push(this.event(`checks:${w.sha}:unfinished`, "checks.unfinished", new Date(limit).toISOString(), undefined, { ...of, data: { unfinished: pendingNames(checks.runs), failed: latestFailed(checks.runs) } }, seen));
    }
    return { events, ends: true };
  }

  private event(
    key: string,
    type: LedgerEvent["type"],
    time: string,
    by: Account | undefined,
    fields: Partial<LedgerEvent>,
    seen: string,
    to?: Account,
  ): LedgerEvent {
    // #48: an account that is gone names no one, and the event says so, so it is not taken for an event nobody did:
    // `account_removed` of the actor, `to_account_removed` of `to` (`accountsGone` in src/read reads them).
    const gone = by !== undefined && "removed" in by;
    // #46: an agent that has a name other than its account keeps the account in data, as it is no person's.
    const named = by && !gone ? this.names.get(by.login.toLowerCase()) : undefined;
    const account = by && !gone && named !== undefined && named !== by.login ? { account: by.login } : {};
    // #45: the same of `to`: its account in `to_account`. A `to` that is gone is left out and says `to_account_removed`.
    const toGone = to !== undefined && "removed" in to;
    const toNamed = to && !toGone ? this.names.get(to.login.toLowerCase()) : undefined;
    const toAccount = to && !toGone && toNamed !== undefined && toNamed !== to.login ? { to_account: to.login } : {};
    return JSON.parse(
      JSON.stringify({
        v: 0,
        id: this.id(key),
        time: new Date(time).toISOString(),
        type,
        source: { adapter: this.host.name, kind: "observed" },
        project: this.settings.project,
        actor: by && !gone ? this.actor(by) : undefined,
        to: to && !toGone ? this.actor(to) : undefined,
        repo: this.host.repository,
        ...fields,
        data: { ...(fields.data ?? {}), ...account, ...toAccount, ...(gone ? { account_removed: true } : {}), ...(toGone ? { to_account_removed: true } : {}), seen },
      }),
    ) as LedgerEvent;
  }

  /** The id of a thing of this repository: its lasting form. */
  private id(key: string): string {
    return `${this.prefix!}${key}`;
  }

  /** Whether the ledger has the thing already, under the lasting id or under an id made from a name (#48). */
  private known(key: string): boolean {
    return this.prefixes.some((p) => this.writer.has(`${p}${key}`));
  }

  /** An agent is named by its account; a person by a pseudonym, never by the account. */
  private actor(account: Exclude<Account, { removed: true }>): NonNullable<LedgerEvent["actor"]> {
    const named = this.names.get(account.login.toLowerCase());
    if (named !== undefined) return { kind: "agent", id: named };
    if (account.bot) return { kind: "agent", id: account.login };
    return { kind: "person", id: this.people.pseudonym(account.login) };
  }

  /** The task of a change: the host's link, else the number in the branch name, else none. */
  private taskOf(change: Change): string | undefined {
    if (change.tasks.length > 0) return String(change.tasks[0]);
    const match = this.taskPattern?.exec(change.branch);
    return match ? (match[1] ?? match[0]) : undefined;
  }

  private readCursor(): Cursor {
    try {
      const value = JSON.parse(readFileSync(this.cursorPath, "utf8")) as Partial<Cursor>;
      return {
        since: typeof value.since === "string" ? value.since : null,
        watch: Array.isArray(value.watch) ? value.watch : [],
        trace: Array.isArray(value.trace) ? value.trace : [],
        ...(value.refused && typeof value.refused.heads === "number"
          ? { refused: { heads: value.refused.heads, ...(typeof value.refused.since === "string" ? { since: value.refused.since } : {}) } }
          : {}),
        // #44: a cursor with none of these, as one of #130, remembers nothing of them.
        ...(isWaiting(value.waiting) ? { waiting: value.waiting } : {}),
        ...(isRecord(value.refusals, "number") ? { refusals: value.refusals } : {}),
        ...(isStrings(value.settled) ? { settled: value.settled } : {}),
      };
    } catch {
      return { since: null, watch: [], trace: [] };
    }
  }

  private writeCursor(cursor: Cursor): void {
    const temporary = join(dirname(this.cursorPath), ".observe.json.tmp");
    writeFileSync(temporary, `${JSON.stringify(cursor, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.cursorPath);
  }
}

/** #44: an object of numbers by change, as a cursor keeps the refusals. */
function isRecord(value: unknown, kind: "number"): value is Record<string, number> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === kind);
}

/** #47: an object of text by commit, as a cursor keeps the heads let go. */
function isStrings(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string");
}

/** #44: the waits of a cursor, each a head and a time. Any other form (as a draft of #131 wrote) is nothing remembered. */
function isWaiting(value: unknown): value is Record<string, { sha: string; since: string }> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "object" && v !== null && typeof v.sha === "string" && typeof v.since === "string")
  );
}
