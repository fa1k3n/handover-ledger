// The local code host: a folder of JSON files in the shapes of the port. It is
// the test environment, and a way to try `howl observe` with no host at all.
//
//   tasks/<number>.json     a Task
//   changes/<number>.json   a Change
//   checks/<sha>.json       a ChecksState; no file is no checks
//   fail.json               calls that fail: "list", "task <n>", "change <n>", "checks <sha>"
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Change, ChecksState, CodeHost, Ref, Task } from "./port.ts";

export class LocalHost implements CodeHost {
  readonly name = "local";
  readonly repository: string;
  private readonly dir: string;

  constructor(dir: string, repository: string) {
    this.dir = dir;
    this.repository = repository;
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
    return this.read<Change>(join("changes", `${number}.json`));
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
