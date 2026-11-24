// The local code host: a folder of JSON files in the shapes of the port. It is
// the test environment, and a way to try `howl observe` with no host at all.
//
//   tasks/<number>.json     a Task; each of `assignments` may have `by`, the one who gave it (#45); `unassignments`
//                           and `reopenings` are lists as the port has them, and none is as no list
//   changes/<number>.json   a Change; a comment may have a `body` in place of `review`, tested as GitHub's is;
//                           `reopenings` and `dismissals` (its `id`, `at`, and when the host names them `review`, `state`, `by`
//                           and `reviewed`: who, when and which commit of the review) as the port has them;
//                           `pushes` (#44): each with its `id`, the head `sha`, `at`, and where known `by`, `before`
//                           and `forced`; a file with none is the fall-back, marked as inferred; an empty list waits as
//                           a lagging one does; `pushesRefused: true` is a list the host refuses
//   checks/<sha>.json       #47: {"sha", "runs": [{"id", "name", "suite", "result": "passed|failed|pending", "started", "at"}],
//                           "latest": ["<id>", ...]}: the runs of a commit's checks (`id` defaults to `r<place in the list>`),
//                           and the ids of the runs the host lists as the latest of each check, when it lists any. Of the
//                           older form, {"sha", "state": "passed|failed|pending|none", "at"}: one verdict with no name, read
//                           as one run of a check that has no name. No file is no checks
//   repository.json         {"id": ..., "was": ["owner/old"]}: the repository's lasting id and the names it had
//                           before (#48); without the file, the id is the name and no other name is this repository
//   fail.json               calls that fail: "list", "task <n>", "change <n>", "checks <sha>"
// @code_class recording
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { byUnits } from "../read/order.ts";
import { isReviewComment, type HostName, type Change, type CheckRun, type ChecksState, type CodeHost, type Comment, type Ref, type Task } from "./port.ts";

/** A comment as a file holds it: with `review`, or with a `body` the adapter tests and drops. */
type FileComment = Omit<Comment, "review"> & { review?: boolean; body?: string };

export class LocalHost implements CodeHost {
  readonly name = "local" satisfies HostName;
  readonly repository: string;
  private readonly dir: string;
  private readonly reviewCommentPattern: RegExp | undefined;

  constructor(dir: string, repository: string, reviewCommentPattern?: RegExp) {
    this.dir = dir;
    this.repository = repository;
    this.reviewCommentPattern = reviewCommentPattern;
  }

  async repositoryId(): Promise<string> {
    return this.file()?.id ?? this.repository;
  }

  async isSameRepository(name: string): Promise<boolean> {
    return this.file()?.was.includes(name) ?? false;
  }

  /** `repository.json`: its id and the names before; none when there is no file. */
  private file(): { id: string; was: string[] } | null {
    let text: string;
    try {
      text = readFileSync(join(this.dir, "repository.json"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    let value: { id?: unknown; was?: unknown };
    try {
      value = JSON.parse(text) as typeof value;
    } catch {
      throw new Error("repository.json is not JSON");
    }
    const id = value.id;
    if (!((typeof id === "string" && id !== "" && !/[\s:]/.test(id)) || (typeof id === "number" && Number.isSafeInteger(id) && id >= 0))) {
      throw new Error('repository.json needs {"id": ...}: a number, or text without spaces or colons');
    }
    const was = value.was ?? [];
    if (!Array.isArray(was) || !was.every((n) => typeof n === "string")) {
      throw new Error('was in repository.json is a list of names: ["owner/old"]');
    }
    return { id: String(id), was: was as string[] };
  }

  async listUpdated(since: string | null): Promise<Ref[]> {
    this.maybeFail("list");
    const refs: Ref[] = [];
    for (const kind of ["task", "change"] as const) {
      for (const item of this.all<Task | Change>(`${kind}s`)) {
        if (since === null || item.updatedAt >= since) refs.push({ kind, number: item.number, updatedAt: item.updatedAt });
      }
    }
    return refs.sort((a, b) => byUnits(a.updatedAt, b.updatedAt) || a.number - b.number);
  }

  async task(number: number): Promise<Task> {
    this.maybeFail(`task ${number}`);
    return this.read<Task>(join("tasks", `${number}.json`));
  }

  async change(number: number): Promise<Change> {
    this.maybeFail(`change ${number}`);
    const change = this.read<Omit<Change, "comments"> & { comments?: FileComment[] }>(join("changes", `${number}.json`));
    if (change.comments === undefined) return change as Change;
    const comments = change.comments.map(({ body, review, ...c }): Comment => ({
      ...c,
      review: body === undefined ? review === true : isReviewComment(body, this.reviewCommentPattern),
    }));
    return { ...change, comments };
  }

  async checks(sha: string): Promise<ChecksState> {
    this.maybeFail(`checks ${sha}`);
    let file: { runs?: unknown; latest?: unknown; state?: unknown; at?: unknown };
    try {
      file = this.read(join("checks", `${sha}.json`));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { sha, runs: [] };
      throw e;
    }
    if (file.runs === undefined) {
      // The older form: one verdict, and no name of a check.
      if (file.state === "passed" || file.state === "failed") return { sha, runs: [{ id: "1", result: file.state, ...(typeof file.at === "string" ? { at: file.at } : {}) }] };
      return { sha, runs: file.state === "pending" ? [{ id: "1", result: "pending" }] : [] };
    }
    if (!Array.isArray(file.runs)) throw new Error(`checks/${sha}.json needs "runs": a list`);
    const runs = (file.runs as (Partial<CheckRun> & Record<string, unknown>)[]).map((r, i): CheckRun => {
      // Only what a run is made of is read: the rest of it (an output, a link) is never looked at.
      if (r.result !== "passed" && r.result !== "failed" && r.result !== "pending") throw new Error(`a run in checks/${sha}.json needs "result": passed, failed or pending`);
      return {
        id: typeof r.id === "string" ? r.id : `r${i + 1}`,
        ...(typeof r.name === "string" ? { name: r.name } : {}),
        ...(typeof r.suite === "string" ? { suite: r.suite } : {}),
        result: r.result,
        ...(typeof r.started === "string" ? { started: r.started } : {}),
        ...(typeof r.at === "string" ? { at: r.at } : {}),
      };
    });
    const latest = Array.isArray(file.latest) ? runs.filter((r) => (file.latest as unknown[]).includes(r.id)) : undefined;
    return { sha, runs, ...(latest !== undefined ? { latest } : {}) };
  }

  private all<T>(sub: string): T[] {
    let names: string[];
    try {
      names = readdirSync(join(this.dir, sub)).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    return names.map((n) => this.read<T>(join(sub, n)));
  }

  private read<T>(path: string): T {
    return JSON.parse(readFileSync(join(this.dir, path), "utf8")) as T;
  }

  private maybeFail(call: string): void {
    let failing: string[] = [];
    try {
      failing = JSON.parse(readFileSync(join(this.dir, "fail.json"), "utf8")) as string[];
    } catch {
      return;
    }
    if (failing.includes(call)) throw new Error(`the local host fails ${call}, as fail.json asks`);
  }
}
