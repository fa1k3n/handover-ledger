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
import { findProject } from "../howl/project.ts";
import { LedgerError } from "../ledger/errors.ts";
import { fixedForm } from "../ledger/fixed.ts";
import { NotJson, parseJson } from "../ledger/json.ts";
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
/** The longest folder a hook may name. Longer is no folder of a repository, and walking up it takes time. */
const MAX_CWD = 4096;

/** #64: one event from a session's hook or a script. The answer is given when the whole body is read. */
export function receive(req: IncomingMessage, res: ServerResponse, write: Write): void {
  body(req, res, write, MAX_BODY, (bytes) => {
    let value: unknown;
    try {
      value = parseJson(bytes.toString("utf8"));
    } catch (e) {
      json(res, 400, { error: `the body is ${e instanceof NotJson ? e.message : "not JSON"}` });
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
    // No answer of this endpoint is a JSON object, also not a refusal: plain words only.
    let value: unknown;
    try {
      value = parseJson(bytes.toString("utf8"));
    } catch (e) {
      plain(res, 400, `the body is ${e instanceof NotJson ? e.message : "not JSON"}`);
      return;
    }
    let event: LedgerEvent | null;
    try {
      event = built(value, req, write.project);
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      // Not its reason: a reason may quote what was sent.
      plain(res, 400, "the hook gives no event the schema accepts");
      return;
    }
    if (event !== null) write.take(event);
    res.writeHead(200, { "cache-control": "no-store", "content-length": 0 }).end();
  }, plain);
}

/** The event `howl hook` would build for this hook, for this server's project; null when nothing is recorded. */
function built(value: unknown, req: IncomingMessage, project: string): LedgerEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const hook = value as Record<string, unknown>;
  if (typeof hook.cwd !== "string" || !isAbsolute(hook.cwd) || hook.cwd.length > MAX_CWD) return null;
  // The project first: nothing is read or run in the folder of a project this server does not write.
  if (findProject(hook.cwd)?.project !== project) return null;
  // What the session's environment gives `howl hook` comes as headers. A header is read as Latin-1;
  // `curl` sends the bytes of the variable, which are UTF-8.
  const env: Record<string, string | undefined> = {};
  for (const [variable, header] of Object.entries(HOOK_HEADERS)) {
    const sent = req.headers[header.toLowerCase()];
    const text = Buffer.from((Array.isArray(sent) ? sent[0] : sent) ?? "", "latin1").toString("utf8").trim();
    if (text) env[variable] = text;
  }
  const found = eventOfHook(hook, env, hook.cwd, "claude-code-http");
  if (found === null || found.project.project !== project) return null;
  // As it will stand in the inbox, checked as the writer checks it, and no larger than an event may be sent.
  const event = eventOf(JSON.parse(JSON.stringify(found.event)), project);
  if (fixedForm(event).length > MAX_BODY) throw new LedgerError("the event is larger than an event may be");
  return event;
}

type Answer = (res: ServerResponse, status: number, reason: string, close?: boolean) => void;

/**
 * Reads the body of a POST and hands it to `then`, unless the call is refused.
 * Who may send is decided from the headers, before a byte of the body is
 * read: a sender without the token is answered at once and not heard. A call
 * that says it is larger than `limit` is refused at once too; one that turns
 * out larger is not heard to the end.
 */
function body(
  req: IncomingMessage,
  res: ServerResponse,
  write: Write,
  limit: number,
  then: (bytes: Buffer) => void,
  answer: Answer = (r, status, reason, close) => json(r, status, { error: reason }, close),
): void {
  // Answered, and the rest of what the sender sends is dropped with the connection.
  const refuse = (status: number, reason: string): void => {
    res.once("finish", () => req.destroy());
    answer(res, status, reason, true);
  };
  const refusal = refusalOf(req, write);
  if (refusal !== null) {
    refuse(refusal[0], refusal[1]);
    return;
  }
  const tooLarge = (): void => refuse(413, `the body is larger than ${limit} bytes`);
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
      then(Buffer.concat(chunks));
    } catch (e) {
      // A body nested too deep to walk is the sender's fault, not the server's.
      if (e instanceof RangeError) answer(res, 400, "the body is nested too deep to read");
      else answer(res, 500, "the server could not take it");
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

function json(res: ServerResponse, status: number, value: unknown, close = false): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value), close);
}

function plain(res: ServerResponse, status: number, reason: string, close = false): void {
  send(res, status, "text/plain; charset=utf-8", `${reason}\n`, close);
}

function send(res: ServerResponse, status: number, type: string, text: string, close: boolean): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...(close ? { connection: "close" } : {}) });
  res.end(text);
}
