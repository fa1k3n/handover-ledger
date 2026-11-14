// The way in over HTTP on `howl up`. This decides what the one writer takes
// from the network, so it lives with the inbox, not with the server that only
// reads.
//
// POST /api/events (#64): one event, built by the sender (`howl hook`, `howl emit`).
// POST /api/hook (#67): the JSON of a coding agent's hook as it stands, sent by
// a hook line that is only `curl`; the event is built here, with the code of
// `howl hook`.
//
// Either is taken only from a process of this machine that can read a token,
// never from a page in a browser, and only as a claim of this writer's
// project. Nothing of a refused call is kept, and of a hook's JSON only the
// event built from it: the body holds a tool's whole input and answer, and is
// never written, logged or sent back.
// @code_class recording
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { eventOfHook } from "../hook/hook.ts";
import { HOOK_HEADERS } from "../hook/line.ts";
import { LedgerError } from "../ledger/errors.ts";
import type { LedgerEvent } from "../ledger/schema.ts";
import { eventOf } from "./ingest.ts";

export interface Write {
  /** The one project whose events are taken. */
  project: string;
  /** What a sender must show, one of them: `Authorization: Bearer <token>`. */
  tokens: string[];
  /** Makes the event safe on the writer's side. It throws when it cannot. */
  take(event: LedgerEvent): void;
}

/** The largest body of an event. An event is far smaller. */
export const MAX_BODY = 256 * 1024;
/** The largest body of a hook's JSON: it holds what a tool read or wrote, which can be a whole file. */
export const MAX_HOOK_BODY = 32 * 1024 * 1024;

/** #64: one event from a session's hook or a script. The answer is given when the whole body is read. */
export function receive(req: IncomingMessage, res: ServerResponse, write: Write): void {
  body(req, res, write, MAX_BODY, (bytes) => {
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      json(res, 400, { error: "the body is not JSON" });
      return;
    }
    let event: LedgerEvent;
    try {
      event = eventOf(value, write.project);
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      json(res, 400, { error: e.message });
      return;
    }
    if (event.source.kind !== "claimed") {
      json(res, 400, { error: "source.kind must be claimed: what is sent to the server is a claim, never what an adapter observed" });
      return;
    }
    write.take(event);
    json(res, 200, { ok: true });
  });
}

/**
 * #67: the JSON of a hook of Claude Code. The answer to a call that is let in
 * is 200 with an empty body, whether an event was taken or nothing is recorded
 * (no agent, another project's folder, a hook howl does not record): Claude
 * Code reads a JSON object in an answer as a decision.
 */
export function receiveHook(req: IncomingMessage, res: ServerResponse, write: Write): void {
  body(req, res, write, MAX_HOOK_BODY, (bytes) => {
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      json(res, 400, { error: "the body is not JSON" });
      return;
    }
    let event: LedgerEvent | null;
    try {
      event = built(value, req, write.project);
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      // Not its reason: a reason may quote what was sent.
      json(res, 400, { error: "the hook gives no event the schema accepts" });
      return;
    }
    if (event !== null) write.take(event);
    res.writeHead(200, { "cache-control": "no-store", "content-length": 0 }).end();
  });
}

/** The event `howl hook` would build for this hook, for this server's project; null when nothing is recorded. */
function built(value: unknown, req: IncomingMessage, project: string): LedgerEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const hook = value as Record<string, unknown>;
  if (typeof hook.cwd !== "string" || !isAbsolute(hook.cwd)) return null;
  // What the session's environment gives `howl hook` comes as headers.
  const env: Record<string, string | undefined> = {};
  for (const [variable, header] of Object.entries(HOOK_HEADERS)) {
    const sent = req.headers[header.toLowerCase()];
    const text = (Array.isArray(sent) ? sent[0] : sent)?.trim();
    if (text) env[variable] = text;
  }
  const found = eventOfHook(hook, env, hook.cwd, "claude-code-http");
  if (found === null || found.project.project !== project) return null;
  // As it will stand in the inbox, and checked as the writer checks it.
  return eventOf(JSON.parse(JSON.stringify(found.event)), project);
}

/**
 * Reads the body of a POST and hands it to `then`, unless the call is refused.
 * A call that says it is larger than `limit` is refused at once; one that
 * turns out larger is not heard to the end.
 */
function body(req: IncomingMessage, res: ServerResponse, write: Write, limit: number, then: (bytes: Buffer) => void): void {
  const tooLarge = (): void => {
    res.writeHead(413, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", connection: "close" });
    res.end(JSON.stringify({ error: `the body is larger than ${limit} bytes` }), () => req.destroy());
  };
  if (Number(req.headers["content-length"]) > limit) {
    tooLarge();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let refused = false;
  req.on("data", (chunk: Buffer) => {
    if (refused) return;
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
    else {
      refused = true;
      tooLarge();
    }
  });
  req.on("error", () => {});
  req.on("end", () => {
    if (refused) return;
    try {
      const refusal = refusalOf(req, write);
      if (refusal !== null) json(res, refusal[0], { error: refusal[1] });
      else then(Buffer.concat(chunks));
    } catch (e) {
      // A body nested too deep to walk is the sender's fault, not the server's.
      if (e instanceof RangeError) json(res, 400, { error: "the body is nested too deep to read" });
      else json(res, 500, { error: "the server could not take it" });
    }
  });
}

/** Why a POST is refused before its body is looked at: the status and the reason. Null when it may go on. */
function refusalOf(req: IncomingMessage, write: Write): [number, string] | null {
  // The address the server itself answers on: a name that only resolves to this machine is not enough.
  const port = req.socket.localPort;
  const host = req.headers.host ?? "";
  if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return [403, "the Host is not this server's address"];
  if (req.headers.origin !== undefined) return [403, "a page in a browser cannot send events"];
  const sent = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  // Every token is compared, so the time says nothing of which one was close.
  const known = sent === undefined ? false : write.tokens.map((token) => sameText(sent, token)).some(Boolean);
  if (!known) return [401, "no token, or not a token of this server"];
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return [415, "the content type must be application/json"];
  return null;
}

/** Whether two texts are the same, in a time that does not depend on where they differ. */
function sameText(a: string, b: string): boolean {
  const hash = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(hash(a), hash(b));
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(text);
}
