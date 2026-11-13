// howl keyd (#24): a signing service that holds the issuer key and every
// assignment's key, so a session never sees a private key. It answers on a local
// socket, one JSON request and one JSON answer per line: `issue` and `revoke`
// need its admin token; `sign` needs the token of the assignment, and keyd
// refuses a claim outside the assignment (another agent, change or task, a
// passed window, a revoked key).
//
// Said plainly: run as the same user as the sessions, keyd keeps keys out of
// files and enforces the assignment, but that user can still read a session's
// token. Run it as another user (or on another machine) for the keys to be out
// of the sessions' reach.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import type { LedgerEvent } from "../ledger/schema.ts";
import { issueKey, readKey, revokeKey, signEvent, type Assignment } from "./keys.ts";

interface Held {
  data: Record<string, string>;
  token: string;
  revokedAt?: string;
}

export type Answer = { ok: true; [k: string]: unknown } | { ok: false; error: string };

function sameToken(a: string | undefined, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Starts keyd on `socket`, keeping its keys in `state` (mode 0700). */
export async function startKeyd(project: string, socket: string, state: string): Promise<Server> {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  const adminFile = join(state, "admin.token");
  if (!existsSync(adminFile)) writeFileSync(adminFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  const admin = readFileSync(adminFile, "utf8").trim();
  const heldFile = join(state, "assignments.json");
  const held: Record<string, Held> = existsSync(heldFile) ? (JSON.parse(readFileSync(heldFile, "utf8")) as Record<string, Held>) : {};
  const save = () => writeFileSync(heldFile, `${JSON.stringify(held, null, 2)}\n`, { mode: 0o600 });
  const places = { configDir: state, keysDir: join(state, "keys") };

  const answer = (req: Record<string, unknown>): Answer => {
    switch (req.op) {
      case "issue": {
        if (!sameToken(req.admin as string, admin)) return { ok: false, error: "issue needs keyd's admin token" };
        if (typeof req.actor !== "string" || !req.actor) return { ok: false, error: "issue needs an actor" };
        const assignment: Assignment = {
          actor: req.actor,
          task: typeof req.task === "string" ? req.task : undefined,
          change: typeof req.change === "string" ? req.change : undefined,
          role: typeof req.role === "string" ? req.role : undefined,
          hours: typeof req.hours === "number" ? req.hours : 8,
        };
        const r = issueKey(project, assignment, places);
        const token = randomBytes(32).toString("hex");
        held[r.keyId] = { data: r.event.data as Record<string, string>, token };
        save();
        return { ok: true, key: r.keyId, token, event: r.event, issuer: r.issuerId };
      }
      case "revoke": {
        if (!sameToken(req.admin as string, admin)) return { ok: false, error: "revoke needs keyd's admin token" };
        const id = String(req.key ?? "");
        const h = held[id];
        if (!h) return { ok: false, error: `no key ${id.slice(0, 12)}` };
        const event = revokeKey(project, id, places);
        h.revokedAt = (event.data as { at: string }).at;
        save();
        return { ok: true, event };
      }
      case "sign": {
        const id = String(req.key ?? "");
        const h = held[id];
        if (!h) return { ok: false, error: `no key ${id.slice(0, 12)}` };
        if (!sameToken(req.token as string, h.token)) return { ok: false, error: "the assignment's token does not match" };
        if (h.revokedAt !== undefined) return { ok: false, error: "the key is revoked" };
        const event = req.event as LedgerEvent;
        const now = Date.now();
        const t = Date.parse(event?.time ?? "");
        const from = Date.parse(h.data.from!);
        const until = Date.parse(h.data.until!);
        if (now < from || now > until || !(t >= from && t <= until)) return { ok: false, error: "outside the key's window" };
        if (event.actor?.id !== h.data.actor) return { ok: false, error: `${event.actor?.id ?? "no one"} is not the key's agent` };
        if (h.data.change !== undefined && event.change !== undefined && event.change !== h.data.change) return { ok: false, error: "not the key's change" };
        if (h.data.task !== undefined && event.task !== undefined && event.task !== h.data.task) return { ok: false, error: "not the key's task" };
        const signed = signEvent(event, readKey(join(places.keysDir, `${id}.pem`)));
        return { ok: true, sig: signed.sig };
      }
      default:
        return { ok: false, error: "ask issue, revoke or sign" };
    }
  };

  if (existsSync(socket)) rmSync(socket);
  const server = createServer((conn) => {
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buf += chunk;
      let at;
      while ((at = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 1);
        let out: Answer;
        try {
          out = answer(JSON.parse(line) as Record<string, unknown>);
        } catch (e) {
          out = { ok: false, error: (e as Error).message };
        }
        conn.write(`${JSON.stringify(out)}\n`);
      }
    });
    conn.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
  chmodSync(socket, 0o660);
  return server;
}

/** One request to keyd and its answer; a refusal or a socket that does not answer gives ok: false. */
export function request(socket: string, req: Record<string, unknown>, timeoutMs = 2000): Promise<Answer> {
  return new Promise((resolve) => {
    const conn = createConnection(socket);
    let buf = "";
    const done = (a: Answer) => {
      clearTimeout(timer);
      conn.destroy();
      resolve(a);
    };
    const timer = setTimeout(() => done({ ok: false, error: "keyd did not answer" }), timeoutMs);
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(`${JSON.stringify(req)}\n`));
    conn.on("data", (chunk) => {
      buf += chunk;
      const at = buf.indexOf("\n");
      if (at >= 0) {
        try {
          done(JSON.parse(buf.slice(0, at)) as Answer);
        } catch {
          done({ ok: false, error: "keyd's answer is not JSON" });
        }
      }
    });
    conn.on("error", (e) => done({ ok: false, error: `keyd: ${e.message}` }));
  });
}

/** `keyd:<socket>#<key id>:<token>`, the HOWL_KEY of a session that signs through keyd. */
export function parseKeydKey(value: string): { socket: string; key: string; token: string } | null {
  const m = /^keyd:(.+)#([0-9a-f]{64}):([0-9a-f]{64})$/.exec(value);
  return m ? { socket: m[1]!, key: m[2]!, token: m[3]! } : null;
}
