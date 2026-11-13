// `howl observe`: one round brings the inbox in, reads what has changed at the
// code host, and appends one event per thing that happened.
//
// No event twice: the id of an observed event is made from the host, the
// repository and the thing (and its time or commit), never from an account, so
// the same thing read again gives the same id, and an id in the ledger is
// passed over. Where the last round ended is kept in observe.json; without it
// the host is read from the start and nothing is written twice.
//
// The cursor moves on only after a round in which every call went through.
// Otherwise the next round reads the same span again.
import { existsSync } from "node:fs";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ingestPass, type Pass, type Places } from "../inbox/ingest.ts";
import { events as ledgerEvents, type LedgerWriter } from "../ledger/ledger.ts";
import type { LedgerEvent } from "../ledger/schema.ts";
import type { People } from "./people.ts";
import type { Account, Change, ChecksState, CodeHost, Task } from "./port.ts";

export interface ObserveSettings {
  project: string;
  activityDays: number;
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

interface Cursor {
  since: string | null;
  watch: Watched[];
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
}

export class Observer {
  /** The head commit of each change when it was opened, as the ledger has it. */
  private readonly openedHeads = new Map<number, string>();
  private readonly taskPattern: RegExp | null;
  private readonly host: CodeHost;
  private readonly writer: LedgerWriter;
  private readonly places: Places;
  private readonly cursorPath: string;
  private readonly people: People;
  private readonly settings: ObserveSettings;
  private readonly warn: (message: string) => void;
  private readonly start: string | undefined;

  constructor(parts: ObserverParts) {
    this.start = parts.start;
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
    this.taskPattern = settings.taskFromBranch === undefined ? null : new RegExp(settings.taskFromBranch);
    for (const e of ledgerEvents(parts.ledgerPath)) {
      if (e.type === "change.opened" && e.source?.adapter === host.name && e.repo === host.repository && e.sha) {
        this.openedHeads.set(Number(e.change), e.sha);
      }
    }
  }

  async round(now = new Date()): Promise<Round> {
    const ingested = ingestPass(this.places, this.writer, this.settings.activityDays, now.getTime());
    const seen = now.toISOString();
    const first = !existsSync(this.cursorPath);
    const cursor = this.readCursor();
    if (first && this.start !== undefined) cursor.since = this.start;
    const watch = new Map(cursor.watch.map((w) => [w.sha, w]));
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
        if (!this.writer.has(this.id(`checks:${change.head.sha}`))) {
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
      if (this.writer.has(this.id(`checks:${sha}`))) {
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

    let appended = 0;
    found.sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
    for (const e of found) {
      if (this.writer.has(e.id)) continue;
      this.writer.append(e);
      appended++;
      if (e.type === "change.opened" && e.sha) this.openedHeads.set(Number(e.change), e.sha);
    }

    this.people.save();
    this.writeCursor({ since: complete ? latest : cursor.since, watch: [...watch.values()] });
    return { ingested, appended, complete };
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
    return JSON.parse(
      JSON.stringify({
        v: 0,
        id: this.id(key),
        time: new Date(time).toISOString(),
        type,
        source: { adapter: this.host.name, kind: "observed" },
        project: this.settings.project,
        actor: by ? this.actor(by) : undefined,
        repo: this.host.repository,
        ...fields,
        data: { ...(fields.data ?? {}), seen },
      }),
    ) as LedgerEvent;
  }

  private id(key: string): string {
    return `${this.host.name}:${this.host.repository}:${key}`;
  }

  /** An agent is named by its account; a person by a pseudonym, never by the account. */
  private actor(account: Account): NonNullable<LedgerEvent["actor"]> {
    if (account.bot || this.settings.agents.includes(account.login)) return { kind: "agent", id: account.login };
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
      return { since: typeof value.since === "string" ? value.since : null, watch: Array.isArray(value.watch) ? value.watch : [] };
    } catch {
      return { since: null, watch: [] };
    }
  }

  private writeCursor(cursor: Cursor): void {
    const temporary = join(dirname(this.cursorPath), ".observe.json.tmp");
    writeFileSync(temporary, `${JSON.stringify(cursor, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.cursorPath);
  }
}
