// How an event leaves a hook or a script (#64): to the writer's server when
// one runs for the project, else into the inbox. The server leaves it in its
// own inbox, so there is still one way into the chain.
//
// The server says where it is in `server.json` in the project's folder, with a
// token: whoever can read that file may send, as whoever can write the inbox
// may leave a file. Only an address of this machine is used, and only while
// the process that wrote the file is alive: a file left by a server that did
// not stop cleanly never sends an event to whatever took its port. Anything
// but a 200 leaves the event in the inbox, and a server that does not answer
// is not asked again for a minute.
// @code_class recording
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixedForm } from "../ledger/fixed.ts";
import { inboxPath, projectDir, serverPath } from "../ledger/place.ts";
import type { LedgerEvent } from "../ledger/schema.ts";
import { markDown, recentlyDown } from "./down.ts";
import { leave } from "./inbox.ts";

/** How long a sender waits for the server: well within a tool call. */
export const SERVER_TIMEOUT_MS = 500;
/** After the server failed to answer, how long it is not asked again. */
export const SERVER_PAUSE_MS = 60_000;

type Env = Record<string, string | undefined>;

export interface ServerFile {
  url: string;
  token: string;
  /** The process of the server. */
  pid: number;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** What `server.json` says, when it names a server on this machine, a token and a process that is alive; else null. */
export function readServerFile(path: string): ServerFile | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ServerFile> | null;
    if (typeof value?.url !== "string" || typeof value.token !== "string" || value.token === "") return null;
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0 || !alive(value.pid)) return null;
    const url = new URL(value.url);
    if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) return null;
    return { url: value.url, token: value.token, pid: value.pid };
  } catch {
    return null;
  }
}

/** Whether a process with this id runs. One of another user counts: it is there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Hands the event to the writer's server, or leaves it in the inbox. Returns
 * null when the server took it, else the path of the file in the inbox.
 */
export async function deliver(project: string, event: LedgerEvent, env: Env): Promise<string | null> {
  const inbox = inboxPath(project, env);
  const server = readServerFile(serverPath(project, env));
  if (server === null) return leave(inbox, event);
  const down = join(projectDir(project, env), "server.down");
  if (recentlyDown(down, SERVER_PAUSE_MS)) return leave(inbox, event);
  const status = await post(server, fixedForm(event));
  if (status === 200) return null;
  if (status === null) markDown(down);
  return leave(inbox, event);
}

/** The status the server answers with, or null when it does not answer in time. */
async function post(server: ServerFile, body: Buffer): Promise<number | null> {
  // Loaded only when there is a server to ask: a hook without one starts as quickly as before.
  const { request } = await import("node:http");
  return await new Promise<number | null>((resolve) => {
    let done = false;
    const finish = (status: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(status);
    };
    const req = request(
      new URL("/api/events", server.url),
      {
        method: "POST",
        // No connection kept: the process ends as soon as the answer is there.
        agent: false,
        headers: { "content-type": "application/json", "content-length": body.length, authorization: `Bearer ${server.token}`, connection: "close" },
      },
      (res) => {
        res.resume();
        finish(res.statusCode ?? null);
      },
    );
    const timer = setTimeout(() => finish(null), SERVER_TIMEOUT_MS);
    req.on("error", () => finish(null));
    req.end(body);
  });
}
