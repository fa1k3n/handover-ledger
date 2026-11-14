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
import { readFileSync, statSync } from "node:fs";
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
    // A plain, small file only: a pipe or a device in its place would hold the hook up.
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ServerFile> | null;
    // A token that cannot stand in a header is no token.
    if (typeof value?.url !== "string" || typeof value.token !== "string" || !/^[\x21-\x7e]+$/.test(value.token)) return null;
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
  let answer: Answer;
  try {
    answer = await post(server, fixedForm(event));
  } catch {
    // Whatever goes wrong in asking, the event is not lost.
    return leave(inbox, event);
  }
  if (answer === "taken") return null;
  if (answer === "silent") markDown(down);
  return leave(inbox, event);
}

/** taken: 200 and `{"ok": true}`. refused: any other answer. silent: no answer in time. */
type Answer = "taken" | "refused" | "silent";

async function post(server: ServerFile, body: Buffer): Promise<Answer> {
  // Loaded only when there is a server to ask: a hook without one starts as quickly as before.
  const { request } = await import("node:http");
  return await new Promise<Answer>((resolve) => {
    let done = false;
    const finish = (answer: Answer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(answer);
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
        if (res.statusCode !== 200) {
          res.resume();
          finish("refused");
          return;
        }
        // Only howl's own answer counts: another program on the port may say 200 to anything.
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          if (text.length > 1024) finish("refused");
        });
        res.on("end", () => {
          try {
            finish((JSON.parse(text) as { ok?: unknown } | null)?.ok === true ? "taken" : "refused");
          } catch {
            finish("refused");
          }
        });
        res.on("error", () => finish("refused"));
      },
    );
    const timer = setTimeout(() => finish("silent"), SERVER_TIMEOUT_MS);
    req.on("error", () => finish("silent"));
    req.end(body);
  });
}
