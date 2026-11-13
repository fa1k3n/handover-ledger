import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { openLedger, type LedgerEvent } from "../src/ledger/ledger.ts";

const CLI = fileURLToPath(new URL("../src/cli/howl.ts", import.meta.url));

export const PROJECT = "example";

const folders: string[] = [];
after(() => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
});

/** A new, empty folder, removed when the tests of the file are done. */
export function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "howl-test-"));
  folders.push(dir);
  return dir;
}

let count = 0;

/** An event with every field that is always there, and a task of its own. */
export function event(over: Partial<LedgerEvent> = {}): LedgerEvent {
  count++;
  return {
    v: 0,
    id: `test-${count}`,
    time: "2026-01-02T03:04:05Z",
    type: "task.assigned",
    source: { adapter: "test", kind: "observed" },
    project: PROJECT,
    task: String(count),
    ...over,
  };
}

/** Writes a new ledger with its first line and `events` lines after it. Returns its path. */
export function ledgerWith(events: number, dir = folder()): string {
  const path = join(dir, "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  for (let i = 0; i < events; i++) writer.append(event());
  writer.close();
  return path;
}

/** A line of the ledger, read back. */
export interface Line {
  prev: string | null;
  hash: string;
  event: Record<string, unknown>;
}

/** The lines of a file as they stand in it, without their line breaks. */
export function rawLines(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return text.split("\n").slice(0, -1);
}

export function lines(path: string): Line[] {
  return rawLines(path).map((line) => JSON.parse(line) as Line);
}

export function writeLines(path: string, lines: string[]): void {
  writeFileSync(path, lines.map((line) => line + "\n").join(""));
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Runs `howl` as a process of its own. */
export function howl(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd,
    env: { PATH: process.env.PATH ?? "", ...options.env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
