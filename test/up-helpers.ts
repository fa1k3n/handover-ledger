// A running `howl up` for the tests of issue #64: a child process, its server file and its end.
// @code_class tests
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { folder, PROJECT, workspace, type Workspace } from "./helpers.ts";
import { LocalHost } from "./local-host.ts";

const CLI = fileURLToPath(new URL("../src/cli/howl.ts", import.meta.url));

export interface Up {
  ws: Workspace;
  host: LocalHost;
  child: ChildProcess;
  /** `server.json` of the project. */
  file: string;
  url: string;
  token: string;
  /** What it printed so far, on both streams. */
  output(): string;
  /** Sends SIGTERM and waits for the end. The status it ended with. */
  stop(): Promise<number | null>;
}

/** A repository observed through a local code host. */
export function observed(): { ws: Workspace; host: LocalHost } {
  const dir = folder();
  const ws = workspace({ yml: `project: ${PROJECT}\nhost: local\nlocal: ${dir}\nrepository: team/product\n` });
  return { ws, host: new LocalHost(dir) };
}

export function serverFile(ws: Workspace): string {
  return join(dirname(ws.ledger), "server.json");
}

/** Waits until `ready` gives a value, at most `ms`. */
export async function until<T>(ready: () => T | undefined | null | false, ms = 15_000, what = "the wait"): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = ready();
    if (value) return value;
    if (Date.now() > end) throw new Error(`${what} took more than ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Starts `howl up` on a free port and waits for its server file. Rounds are an hour apart: only the first runs. */
export async function up(setup = observed(), args: string[] = []): Promise<Up> {
  const { ws, host } = setup;
  const child = spawn(process.execPath, [CLI, "up", "--port", "0", "--interval", "3600", ...args], {
    cwd: ws.root,
    env: { PATH: process.env.PATH ?? "", ...ws.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // A test run that ends early does not leave it running.
  const kill = () => void child.kill();
  process.once("exit", kill);
  child.once("close", () => process.off("exit", kill));
  let text = "";
  child.stdout!.on("data", (d) => (text += d));
  child.stderr!.on("data", (d) => (text += d));
  let ended: number | null | undefined;
  const done = new Promise<number | null>((resolve) => child.on("close", (status) => resolve((ended = status))));
  const file = serverFile(ws);
  await until(() => {
    if (ended !== undefined) throw new Error(`howl up ended with ${ended}: ${text}`);
    return existsSync(file);
  }, 15_000, "the start of howl up");
  const { url, token } = JSON.parse(readFileSync(file, "utf8")) as { url: string; token: string };
  return {
    ws,
    host,
    child,
    file,
    url,
    token,
    output: () => text,
    stop: async () => {
      if (ended === undefined) child.kill("SIGTERM");
      return await done;
    },
  };
}

let n = 0;
/** An event as a session's hook would send it. */
export function claim(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 0,
    id: `sent-${++n}-${Date.now()}`,
    time: new Date().toISOString(),
    type,
    source: { adapter: "claude-code-hook", kind: "claimed" },
    project: PROJECT,
    actor: { kind: "agent", id: "agent-1" },
    session: "s1",
    ...extra,
  };
}

/** A POST of an event to a server, as the hook sends it unless `headers` say otherwise. */
export function send(url: string, token: string | null, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
