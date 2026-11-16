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
import type { Account, Change, ChecksState, CodeHost, Task } from "./port.ts";
import { happensBefore } from "./order.ts";
import type { TraceResult } from "../howl/trace-read.ts";

export interface ObserveSettings {
  project: string;
  activityDays: number;
  /** The agents as written in `howl.yml`: `name` or `name=account` (#46). */
  agents: string[];
  taskFromBranch?: string;
}

/** A head commit whose checks have not finished: finishing them does not update the change. */
interface Watched {
  sha: string;
  change: number;
  branch: string;
  task?: string;
  /** Whether the change was open when it was last read. A closed change is asked once more, then let go. */
  open: boolean;
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

interface Cursor {
  since: string | null;
  watch: Watched[];
  trace: TracePending[];
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
    this.pendingTrace = new Map(cursor.trace.map((p) => [`${p.change}:${p.sha}`, p]));
    const found: LedgerEvent[] = [];
    let complete = true;
    const failed = (call: string, e: unknown) => {
      complete = false;
      this.warn(`${call}: ${(e as Error).message}`);
    };

    let latest = cursor.since;
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
        found.push(...this.changeEvents(change, seen));
        for (const [sha, w] of watch) if (w.change === change.number) watch.delete(sha);
        if (!this.known(`checks:${change.head.sha}`)) {
          watch.set(change.head.sha, {
            sha: change.head.sha,
            change: change.number,
            branch: change.branch,
            task: this.taskOf(change),
            open: change.closedAt === undefined,
          });
        }
      }
    }

    for (const [sha, w] of watch) {
      if (this.known(`checks:${sha}`)) {
        watch.delete(sha);
        continue;
      }
      let checks: ChecksState;
      try {
        checks = await this.host.checks(sha);
      } catch (e) {
        failed(`checks ${sha}`, e);
        continue;
      }
      if (checks.state === "passed" || checks.state === "failed") {
        found.push(this.checksEvent(w, checks, seen));
        watch.delete(sha);
      } else if (!w.open) {
        watch.delete(sha);
      }
    }

    // #6: a reader of the ledger learns that nothing before the start was looked at. Once, in the first round.
    if (first && this.start !== undefined) {
      found.push(this.event("observe:started", "observe.started", seen, undefined, { data: { since: this.start } }, seen));
    }

    found.push(...this.traceEvents(seen));

    let appended = 0;
    // #112: by time, and at the same time by what can happen first: opened before assigned.
    found.sort(happensBefore);
    for (const e of found) {
      if (this.known(e.id.slice(this.prefix!.length))) continue;
      this.writer.append(e);
      appended++;
      if (e.type === "change.opened" && e.sha) this.openedHeads.set(Number(e.change), e.sha);
    }

    this.people.save();
    this.writeCursor({ since: complete ? latest : cursor.since, watch: [...watch.values()], trace: [...this.pendingTrace.values()] });
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
      // The actor of an assignment is the one who got the task: the hand-over is to them.
      ...task.assignments.map((a) => this.event(`task:${n}:assigned:${a.id}`, "task.assigned", a.at, a.assignee, of, seen)),
    ];
    if (task.closedAt) {
      found.push(this.event(`task:${n}:closed:${task.closedAt}`, "task.closed", task.closedAt, task.closedBy, of, seen));
    }
    return found;
  }

  private changeEvents(change: Change, seen: string): LedgerEvent[] {
    const n = change.number;
    const of = (sha: string) => ({ change: String(n), branch: change.branch, sha, task: this.taskOf(change) });
    const head = change.head.sha;
    const found = [this.event(`change:${n}:opened`, "change.opened", change.openedAt, change.openedBy, of(head), seen)];

    // A head that is not the one the change was opened with is a new head. When
    // the ledger has no opening yet, it is written now with this head.
    const openedWith = this.openedHeads.get(n);
    if (openedWith !== undefined && openedWith !== head) {
      found.push(this.event(`change:${n}:head:${head}`, "change.updated", change.head.at, undefined, of(head), seen));
    }

    // #25: a change to .howl/ is high risk: one event per head that touches it, with the paths.
    const config = (change.files ?? []).filter((f) => f === ".howl" || f.startsWith(".howl/"));
    if (config.length > 0) {
      found.push(this.event(`config:${n}:${head}`, "config.changed", change.head.at, undefined, { ...of(head), data: { paths: config } }, seen));
    }

    // #38: what the tests of this head name is read once the round has its events: the head waits for that.
    if (this.traceAt !== undefined && !this.known(`trace:${n}:${head}`)) {
      const task = this.taskOf(change);
      this.pendingTrace.set(`${n}:${head}`, { sha: head, change: n, branch: change.branch, ...(task !== undefined ? { task } : {}), at: change.head.at, open: change.closedAt === undefined });
    }

    for (const r of change.reviews) {
      found.push(this.event(`review:${r.id}`, `review.${r.state}`, r.at, r.by, of(r.sha ?? head), seen));
    }
    // #28: a comment is a review only when the project's pattern says so. The key is the one comments had as
    // reviews before (#20), so a comment already in the ledger is not written again under another type.
    for (const c of change.comments ?? []) {
      found.push(this.event(`review:c${c.id}`, c.review ? "review.commented" : "change.commented", c.at, c.by, of(head), seen));
    }
    if (change.mergedAt) {
      found.push(this.event(`change:${n}:merged`, "change.merged", change.mergedAt, change.mergedBy, of(head), seen));
    } else if (change.closedAt) {
      found.push(this.event(`change:${n}:closed:${change.closedAt}`, "change.closed", change.closedAt, change.closedBy, of(head), seen));
    }
    return found;
  }

  private checksEvent(w: Watched, checks: ChecksState, seen: string): LedgerEvent {
    return this.event(`checks:${w.sha}`, `checks.${checks.state as "passed" | "failed"}`, checks.at ?? seen, undefined, {
      change: String(w.change),
      branch: w.branch,
      sha: w.sha,
      task: w.task,
    }, seen);
  }

  private event(
    key: string,
    type: LedgerEvent["type"],
    time: string,
    by: Account | undefined,
    fields: Partial<LedgerEvent>,
    seen: string,
  ): LedgerEvent {
    // #48: an account that is gone names no one, and the event says so, so it is not taken for an event nobody did.
    const gone = by !== undefined && "removed" in by;
    // #46: an agent that has a name other than its account keeps the account in data, as it is no person's.
    const named = by && !gone ? this.names.get(by.login.toLowerCase()) : undefined;
    const account = by && !gone && named !== undefined && named !== by.login ? { account: by.login } : {};
    return JSON.parse(
      JSON.stringify({
        v: 0,
        id: this.id(key),
        time: new Date(time).toISOString(),
        type,
        source: { adapter: this.host.name, kind: "observed" },
        project: this.settings.project,
        actor: by && !gone ? this.actor(by) : undefined,
        repo: this.host.repository,
        ...fields,
        data: { ...(fields.data ?? {}), ...account, ...(gone ? { account_removed: true } : {}), seen },
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
