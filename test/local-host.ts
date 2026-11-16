// A code host in a folder of JSON files, for the tests of `howl observe`.
// The same shapes as the port: what the local adapter reads.
// @code_class tests
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Change, Task } from "../src/observe/port.ts";

export class LocalHost {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    for (const sub of ["tasks", "changes", "checks"]) mkdirSync(join(dir, sub), { recursive: true });
  }

  task(task: Task): this {
    writeFileSync(join(this.dir, "tasks", `${task.number}.json`), JSON.stringify(task));
    return this;
  }

  change(change: Change): this {
    writeFileSync(join(this.dir, "changes", `${change.number}.json`), JSON.stringify(change));
    return this;
  }

  /** One verdict and no name of a check: the older form of `checks/<sha>.json`, read as one attempt. */
  checks(sha: string, state: "passed" | "failed" | "pending" | "none", at?: string): this {
    writeFileSync(join(this.dir, "checks", `${sha}.json`), JSON.stringify({ sha, state, at }));
    return this;
  }

  /**
   * #47: the runs of a commit's checks, in the new form of `checks/<sha>.json`. A run with no `attempt` has its place
   * among the runs of its name in the file. Anything else a run holds (as the host's `output`) is kept in the file, and
   * is never read.
   */
  runs(sha: string, runs: { name?: string; result: "passed" | "failed" | "pending"; at?: string; attempt?: number; [other: string]: unknown }[]): this {
    writeFileSync(join(this.dir, "checks", `${sha}.json`), JSON.stringify({ sha, runs }));
    return this;
  }

  /** #48: the lasting id of the repository and the names it had before (`was`), as the file `repository.json` holds them. */
  repository(id: string | number, was: string[] = []): this {
    writeFileSync(join(this.dir, "repository.json"), JSON.stringify(was.length > 0 ? { id, was } : { id }));
    return this;
  }

  /** The calls that fail, as `list`, `task <n>`, `change <n>` or `checks <sha>`. */
  fail(...calls: string[]): this {
    if (calls.length === 0) rmSync(join(this.dir, "fail.json"), { force: true });
    else writeFileSync(join(this.dir, "fail.json"), JSON.stringify(calls));
    return this;
  }
}

export const SHA = {
  a: "a".repeat(40),
  b: "b".repeat(40),
  c: "c".repeat(40),
  d: "d".repeat(40),
};

/** A time on 2026-01-01, `minutes` after midnight. */
export function at(minutes: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
}
