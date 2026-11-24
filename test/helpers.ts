// Helpers shared by the tests: folders, events, ledgers, processes and git.
// @code_class tests
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams, type StdioOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
}

/**
 * #137: the executable to start. With HOWL_BIN set, that binary (the Rust `howl`), with HOWL_FALLBACK and HOWL_NODE
 * added so that it hands what it does not do yet to the TypeScript; else the TypeScript, as before.
 */
const BIN = process.env.HOWL_BIN ? resolve(process.env.HOWL_BIN) : undefined;
/** #137: with HOWL_COMPARE set as well, `howl()` runs these read-only commands through both versions. Each piece adds what it moves. */
export const COMPARED = ["help", "verify"];

/** The commands the binary does whole (#141, #142): it never hands them to the TypeScript, so it is started without a fallback. */
const WHOLE = ["hook", "emit"];

/** The program, its arguments and its environment: no environment but PATH and `env`. */
function command(args: string[], env: Record<string, string> = {}, typescript = BIN === undefined) {
  const base = { PATH: process.env.PATH ?? "", ...env };
  if (typescript) return { file: process.execPath, argv: [CLI, ...args], env: base };
  if (WHOLE.includes(args[0] ?? "")) return { file: BIN!, argv: args, env: base };
  return { file: BIN!, argv: args, env: { ...base, HOWL_FALLBACK: CLI, HOWL_NODE: process.execPath } };
}

export interface StartOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdio?: StdioOptions;
}

/** The one spawn of `howl` for the tests: a process that runs while the test goes on. */
export function startHowl(args: string[], options?: Omit<StartOptions, "stdio">): ChildProcessWithoutNullStreams;
export function startHowl(args: string[], options: StartOptions): ChildProcess;
export function startHowl(args: string[], options: StartOptions = {}): ChildProcess {
  const { file, argv, env } = command(args, options.env);
  return spawn(file, argv, { cwd: options.cwd, env, stdio: options.stdio ?? "pipe" });
}

function runSync(args: string[], options: RunOptions, typescript?: boolean): Run {
  const { file, argv, env } = command(args, options.env, typescript);
  const result = spawnSync(file, argv, { cwd: options.cwd, env, input: options.input ?? "", encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs `howl` as a process of its own, with no environment but PATH and `env`. In compare mode, a command of COMPARED runs through both versions, which must agree. */
export function howl(args: string[], options: RunOptions = {}): Run {
  if (BIN === undefined || !process.env.HOWL_COMPARE || !COMPARED.includes(args[0] ?? "")) return runSync(args, options);
  // The same present time for both, unless the test gives one.
  const same = { ...options, env: { HOWL_NOW: new Date().toISOString(), ...options.env } };
  const rust = runSync(args, same, false);
  const typescript = runSync(args, same, true);
  assert.deepEqual(rust, typescript, `howl ${args.join(" ")}: the Rust and the TypeScript differ`);
  return rust;
}

/** As `howl`, but without waiting: for processes that run at the same time. */
export function howlAsync(args: string[], options: RunOptions = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = startHowl(args, { cwd: options.cwd, env: options.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

/** A repository with `.howl/howl.yml`, and a place for the ledger of its own. */
export interface Workspace {
  /** The root of the repository. */
  root: string;
  /** $HOWL_HOME. */
  home: string;
  /** The environment for `howl`: HOWL_HOME and an agent as the actor. */
  env: Record<string, string>;
  inbox: string;
  ledger: string;
  activity: string;
}

export function workspace(options: { yml?: string; actor?: string | null } = {}): Workspace {
  const root = folder();
  const home = folder();
  mkdirSync(join(root, ".howl"));
  writeFileSync(join(root, ".howl", "howl.yml"), options.yml ?? `project: ${PROJECT}\n`);
  const env: Record<string, string> = { HOWL_HOME: home };
  const actor = options.actor === undefined ? "agent-1" : options.actor;
  if (actor !== null) env.HOWL_ACTOR = actor;
  const dir = join(home, PROJECT);
  return {
    root,
    home,
    env,
    inbox: join(dir, "inbox"),
    ledger: join(dir, "ledger.jsonl"),
    activity: join(dir, "activity.jsonl"),
  };
}

/** The event files waiting in an inbox, by name. Not the folder of rejected files. */
export function inboxFiles(inbox: string): string[] {
  if (!existsSync(inbox)) return [];
  return readdirSync(inbox)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

export function inboxEvents(inbox: string): LedgerEvent[] {
  return inboxFiles(inbox).map((name) => JSON.parse(readFileSync(join(inbox, name), "utf8")) as LedgerEvent);
}

/** Runs git in `dir` with a fixed identity, so that the tests need no git configuration. */
export function git(dir: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", ...args],
    { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", HOME: dir } },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
