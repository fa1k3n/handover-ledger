// The binary and the TypeScript side by side, for the tests that set what one leaves against what the other leaves (#141, #142).
// The binary is started without HOWL_FALLBACK: what it does is its own work.
// @code_class tests
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT, folder, type Workspace } from "./helpers.ts";
import type { LedgerEvent } from "../src/ledger/schema.ts";

export const CLI = fileURLToPath(new URL("../src/cli/howl.ts", import.meta.url));
export const bin = process.env.HOWL_BIN;
/** The reason a test of the binary is skipped, or false. */
export const binary: string | false = bin ? false : "HOWL_BIN is not set";

export type Version = "rust" | "typescript";
export const VERSIONS: Version[] = ["rust", "typescript"];

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function program(version: Version, args: string[]): [string, string[]] {
  return version === "rust" ? [resolve(bin!), args] : [process.execPath, [CLI, ...args]];
}

/** `howl <args>` of one version, with no environment but PATH and `env`. */
export function run(version: Version, args: string[], cwd: string, env: Record<string, string>, input = ""): Run {
  const [file, argv] = program(version, args);
  const done = spawnSync(file, argv, { cwd, env: { PATH: process.env.PATH ?? "", ...env }, input, encoding: "utf8" });
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
}

/** As `run`, but without holding this process up: for a test that has a server of its own to answer. */
export function runAsync(version: Version, args: string[], cwd: string, env: Record<string, string>, input = ""): Promise<Run & { ms: number }> {
  const [file, argv] = program(version, args);
  const started = Date.now();
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, argv, { cwd, env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(input);
  });
}

/** The JSON of a hook of Claude Code. */
export function hookJson(ws: Workspace, name = "SessionStart", extra: Record<string, unknown> = { source: "startup" }): string {
  return JSON.stringify({ session_id: "session-1", transcript_path: "/nowhere/t.jsonl", cwd: ws.root, hook_event_name: name, ...extra });
}

/** The events waiting in the inbox of a home, with the names of their files. */
export function leftIn(home: string): { name: string; event: LedgerEvent }[] {
  const inbox = join(home, PROJECT, "inbox");
  if (!existsSync(inbox)) return [];
  return readdirSync(inbox)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ name, event: JSON.parse(readFileSync(join(inbox, name), "utf8")) as LedgerEvent }));
}

/** An event without its `id` and `time`: what must be the same whichever version made it. */
export function sameButForIdAndTime(event: unknown): unknown {
  const { id: _id, time: _time, ...rest } = event as Record<string, unknown>;
  return rest;
}

/** A home of its own for one run. */
export const home = (): string => folder();
