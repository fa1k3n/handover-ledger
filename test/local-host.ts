// A code host in a folder of JSON files, for the tests of `howl observe`.
// The same shapes as the port: what the local adapter reads.
// @code_class tests
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Change, ChecksState, Task } from "../src/observe/port.ts";

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

  checks(sha: string, state: ChecksState["state"], at?: string): this {
    writeFileSync(join(this.dir, "checks", `${sha}.json`), JSON.stringify({ sha, state, at }));
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
