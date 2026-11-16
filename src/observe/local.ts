// The local code host: a folder of JSON files in the shapes of the port. It is
// the test environment, and a way to try `howl observe` with no host at all.
//
//   tasks/<number>.json     a Task
//   changes/<number>.json   a Change; a comment may have a `body` in place of `review`, tested as GitHub's is
//   checks/<sha>.json       a ChecksState; no file is no checks
//   repository.json         {"id": ...}: the repository's lasting id (#48); without the file, its name
//   fail.json               calls that fail: "list", "task <n>", "change <n>", "checks <sha>"
// @code_class recording
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isReviewComment, type Change, type ChecksState, type CodeHost, type Comment, type Ref, type Task } from "./port.ts";

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
    let text: string;
    try {
      text = readFileSync(join(this.dir, "repository.json"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return this.repository;
      throw e;
    }
    let id: unknown;
    try {
      id = (JSON.parse(text) as { id?: unknown }).id;
    } catch {
      throw new Error("repository.json is not JSON");
    }
    if ((typeof id === "string" && id !== "" && !/[\s:]/.test(id)) || (typeof id === "number" && Number.isSafeInteger(id) && id >= 0)) return String(id);
    throw new Error('repository.json needs {"id": ...}: a number, or text without spaces or colons');
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
    try {
      return this.read<ChecksState>(join("checks", `${sha}.json`));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { sha, state: "none" };
      throw e;
    }
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
