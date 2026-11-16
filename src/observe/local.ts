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
//   checks/<sha>.json       #47: {"sha", "runs": [{"name", "result": "passed|failed|pending", "at", "attempt"}]}, the runs
//                           of a commit's checks; a run without `attempt` has its place among the runs of its name in the
//                           file. Of the older form, {"sha", "state": "passed|failed|pending|none", "at"}: one verdict
//                           with no name, read as one attempt of a check that has no name. No file is no checks
//   repository.json         {"id": ..., "was": ["owner/old"]}: the repository's lasting id and the names it had
//                           before (#48); without the file, the id is the name and no other name is this repository
//   fail.json               calls that fail: "list", "task <n>", "change <n>", "checks <sha>"
// @code_class recording
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isReviewComment, type Change, type CheckRun, type ChecksState, type CodeHost, type Comment, type Ref, type Task } from "./port.ts";

/** A comment as a file holds it: with `review`, or with a `body` the adapter tests and drops. */
type FileComment = Omit<Comment, "review"> & { review?: boolean; body?: string };

export class LocalHost implements CodeHost {
  readonly name = "local";
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
    return refs.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.number - b.number);
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
    let file: { runs?: unknown; state?: unknown; at?: unknown };
    try {
      file = this.read(join("checks", `${sha}.json`));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { sha, runs: [] };
      throw e;
    }
    if (file.runs === undefined) {
      // The older form: one verdict, and no name of a check.
      if (file.state === "passed" || file.state === "failed") return { sha, runs: [{ result: file.state, ...(typeof file.at === "string" ? { at: file.at } : {}), attempt: 1 }] };
      return { sha, runs: file.state === "pending" ? [{ result: "pending", attempt: 1 }] : [] };
    }
    if (!Array.isArray(file.runs)) throw new Error(`checks/${sha}.json needs "runs": a list`);
    const places = new Map<string, number>();
    const runs = (file.runs as (Partial<CheckRun> & Record<string, unknown>)[]).map((r): CheckRun => {
      // Only the name, the result, the time and the attempt are read: the rest of a run is never looked at.
      const key = typeof r.name === "string" ? r.name : "";
      const place = (places.get(key) ?? 0) + 1;
      places.set(key, place);
      if (r.result !== "passed" && r.result !== "failed" && r.result !== "pending") throw new Error(`a run in checks/${sha}.json needs "result": passed, failed or pending`);
      return {
        ...(typeof r.name === "string" ? { name: r.name } : {}),
        result: r.result,
        ...(typeof r.at === "string" ? { at: r.at } : {}),
        attempt: typeof r.attempt === "number" ? r.attempt : place,
      };
    });
    return { sha, runs };
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
