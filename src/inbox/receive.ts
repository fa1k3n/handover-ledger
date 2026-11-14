// The way in for an event over HTTP (#64): one event per POST of /api/events
// on `howl up`. This decides what the one writer takes from the network, so it
// lives with the inbox, not with the server that only reads.
//
// An event is taken only from a process of this machine that can read the
// token, never from a page in a browser, and only when it is a claim of this
// writer's project that the schema accepts. Nothing of a refused call is kept.
// @code_class recording
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LedgerError } from "../ledger/errors.ts";
import type { LedgerEvent } from "../ledger/schema.ts";
import { eventOf } from "./ingest.ts";

export interface Write {
  /** The one project whose events are taken. */
  project: string;
  /** What a sender must show: `Authorization: Bearer <token>`. */
  token: string;
  /** Makes the event safe on the writer's side. It throws when it cannot. */
  take(event: LedgerEvent): void;
}

/** The largest body of a POST. An event is far smaller. */
export const MAX_BODY = 256 * 1024;

/**
 * #64: one event from a session's hook or a script. It is refused unless it
 * comes from a process of this machine that can read the token (never a page
 * in a browser), and is a claim of this server's project that the schema
 * accepts. The answer is given when the whole body is read.
 */
export function receive(req: IncomingMessage, res: ServerResponse, write: Write): void {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size <= MAX_BODY) chunks.push(chunk);
    // Far beyond the limit: the sender is not heard to the end.
    else if (size > 8 * MAX_BODY) req.destroy();
  });
  req.on("error", () => {});
  req.on("end", () => {
    try {
      const refusal = refusalOf(req, write, size);
      if (refusal !== null) {
        json(res, refusal[0], { error: refusal[1] });
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
    } catch (e) {
      // A body nested too deep to walk is the sender's fault, not the server's.
      if (e instanceof RangeError) json(res, 400, { error: "the body is nested too deep to read" });
      else json(res, 500, { error: (e as Error).message });
    }
  });
}

/** Why a POST is refused before its body is looked at: the status and the reason. Null when it may go on. */
function refusalOf(req: IncomingMessage, write: Write, size: number): [number, string] | null {
  // The address the server itself answers on: a name that only resolves to this machine is not enough.
  const port = req.socket.localPort;
  const host = req.headers.host ?? "";
  if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return [403, "the Host is not this server's address"];
  if (req.headers.origin !== undefined) return [403, "a page in a browser cannot send events"];
  const sent = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  if (sent === undefined || !sameText(sent, write.token)) return [401, "no token, or not the token of server.json"];
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return [415, "the content type must be application/json"];
  if (size > MAX_BODY) return [413, `the body is larger than ${MAX_BODY} bytes`];
  return null;
}

/** Whether two texts are the same, in a time that does not depend on where they differ. */
function sameText(a: string, b: string): boolean {
  const hash = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(hash(a), hash(b));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(text);
}
