// The dashboard's server, for `howl serve` and `howl up`. It answers on
// 127.0.0.1 only, serves the built page and read-only JSON over the ledger and
// the activity file. It takes no lock and never writes.
//
// With `write` (`howl up`, #64) it also takes one event per POST of
// /api/events and hands it to the writer that started it. Without it every
// POST is refused, as before.
// @code_class reading
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, normalize, sep } from "node:path";
import { eventOf } from "../inbox/ingest.ts";
import { LedgerError } from "../ledger/errors.ts";
import { LEDGER_FILE } from "../ledger/names.ts";
import { isProjectName } from "../ledger/place.ts";
import type { LedgerEvent } from "../ledger/schema.ts";
import { verify, type Verdict } from "../ledger/verify.ts";
import { activityFrom, activityLines, byTime, ledgerLines, lineCount, readAll, type Read } from "../read/reader.ts";
import { checkSignatures } from "../keys/keys.ts";
import { actingAgents } from "../read/acting.ts";
import { handovers, keyFigures } from "../read/overview.ts";
import { parseAsked, show } from "../read/show.ts";
import { agentStates } from "../read/state.ts";
import { parseFilters, wantsActivity } from "../read/watch.ts";

export interface ServeOptions {
  /** One ledger only. */
  ledger?: string;
  /** Else every project in this folder that holds a ledger. */
  home?: string;
  /** The project shown first; else the first by name. */
  defaultProject?: string;
  /** 0 picks a free port. */
  port: number;
  /** The folder of the built page. */
  root: string;
  /** Only a loopback address is accepted. */
  host?: string;
  /** For the default project (or the one ledger) only: it comes from that project's howl.yml. */
  taskFromBranch?: RegExp;
  /** #64: the writer behind this server. Without it the server only reads. */
  write?: Write;
}

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

interface Project {
  name: string;
  ledger: string;
}

export interface Served {
  url: string;
  close(): Promise<void>;
}

/** An event as the page gets it: what the reader gives (a ledger line with its number and hashes), and what the server adds. */
export interface Item extends Read {
  /** The agent behind a person's account at the code host, when one matches (#14). */
  by?: string;
  /** The signature's check (#23): the key, its assignment, and whether it holds. */
  signed?: { key: string; actor: string; task?: string; change?: string; role?: string; until: string; ok: boolean; reason?: string };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const DEFAULT_LIMIT = 500;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

export async function startServer(options: ServeOptions): Promise<Served> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) throw new LedgerError(`howl serve answers on 127.0.0.1 only, not on ${host}`);
  if (options.ledger !== undefined) statSync(options.ledger);
  else if (options.home === undefined) throw new LedgerError("howl serve needs a ledger or the folder of the projects");

  // Verifying reads the whole ledger: keep each verdict until its file changes.
  const verdicts = new Map<string, { size: number; mtime: number; value: Verdict }>();
  const ledgerVerdict = (ledger: string): Verdict => {
    const s = statSync(ledger);
    const kept = verdicts.get(ledger);
    if (kept && kept.size === s.size && kept.mtime === s.mtimeMs) return kept.value;
    const value = verify(ledger);
    verdicts.set(ledger, { size: s.size, mtime: s.mtimeMs, value });
    return value;
  };

  const server = createServer((req, res) => {
    try {
      if (options.write !== undefined && req.method === "POST" && pathOf(req) === "/api/events") {
        receive(req, res, options.write);
        return;
      }
      handle(req, res, options, ledgerVerdict);
    } catch (e) {
      const status = e instanceof LedgerError ? 400 : 500;
      json(res, status, { error: (e as Error).message });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const shown = host === "::1" ? "[::1]" : host === "localhost" ? "127.0.0.1" : host;
  return {
    url: `http://${shown}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "";
  }
}

/**
 * #64: one event from a session's hook or a script. It is refused unless it
 * comes from a process of this machine that can read the token (never a page
 * in a browser), and is a claim of this server's project that the schema
 * accepts. The answer is given when the whole body is read.
 */
function receive(req: IncomingMessage, res: ServerResponse, write: Write): void {
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
      json(res, 500, { error: (e as Error).message });
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

/** The projects served: the one ledger, or every folder of the home that holds a ledger, by name. */
function projectsOf(options: ServeOptions): Project[] {
  if (options.ledger !== undefined) {
    const name = basename(dirname(options.ledger));
    return [{ name: isProjectName(name) ? name : "ledger", ledger: options.ledger }];
  }
  let names: string[];
  try {
    names = readdirSync(options.home!);
  } catch {
    return [];
  }
  return names
    .filter((name) => isProjectName(name) && existsSync(join(options.home!, name, LEDGER_FILE)))
    .sort()
    .map((name) => ({ name, ledger: join(options.home!, name, LEDGER_FILE) }));
}

function defaultOf(projects: Project[], options: ServeOptions): Project | undefined {
  return projects.find((p) => p.name === options.defaultProject) ?? projects[0];
}

/** The project a call asks for: only a name from the list, never a path. */
function projectFor(params: URLSearchParams, options: ServeOptions): Project {
  const projects = projectsOf(options);
  const asked = params.get("project");
  const found = asked === null ? defaultOf(projects, options) : projects.find((p) => p.name === asked);
  if (!found) throw new LedgerError(asked === null ? "no project with a ledger" : `no project ${JSON.stringify(asked)}`);
  return found;
}

function handle(req: IncomingMessage, res: ServerResponse, options: ServeOptions, ledgerVerdict: (ledger: string) => Verdict): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/projects") {
    const projects = projectsOf(options);
    json(res, 200, { single: options.ledger !== undefined, default: defaultOf(projects, options)?.name ?? null, projects: projects.map((p) => ({ name: p.name, lines: lineCount(p.ledger) })) });
    return;
  }
  if (!url.pathname.startsWith("/api/")) {
    file(res, options.root, url.pathname);
    return;
  }
  const project = projectFor(url.searchParams, options);
  const ledger = project.ledger;
  const pattern = options.ledger !== undefined || project.name === options.defaultProject ? options.taskFromBranch : undefined;
  switch (url.pathname) {
    case "/api/agents": {
      const now = Date.now();
      json(res, 200, { now, rows: agentStates(readAll(ledger).map((r) => r.event), now, { taskFromBranch: pattern }) });
      return;
    }
    case "/api/events":
      json(res, 200, { now: Date.now(), events: events(ledger, url.searchParams) });
      return;
    case "/api/overview": {
      const now = Date.now();
      const items = ledgerLines(ledger);
      json(res, 200, { now, figures: keyFigures(items.map((i) => i.event), now), handovers: handovers(items).slice(0, 50) });
      return;
    }
    case "/api/show": {
      const what = url.searchParams.get("what")?.trim() ?? "";
      if (!what) throw new LedgerError("give what: 12, task:12 or change:30");
      const asked = parseAsked(what);
      const reads = readAll(ledger);
      const shown = show(
        reads.map((r) => r.event),
        asked,
        activityFrom(reads),
      );
      if (shown === null) {
        json(res, 404, { error: `nothing in the ledger names ${what}` });
        return;
      }
      json(res, 200, shown);
      return;
    }
    case "/api/ledger": {
      const v = ledgerVerdict(ledger);
      json(res, 200, v.ok ? { ok: true, lines: v.lines, head: v.head, trial: v.trial } : { ok: false, lines: v.lines, line: v.line, faults: v.faults });
      return;
    }
    default:
      json(res, 404, { error: `no endpoint ${url.pathname}` });
  }
}

/** The ledger lines after `after` (all when absent), with the activity file when asked or filtered for, the newest `limit`. */
export function events(ledger: string, params: URLSearchParams): Item[] {
  const pairs = params.getAll("filter");
  const filters = parseFilters(pairs);
  const after = Number(params.get("after") ?? 0) || 0;
  const limit = Math.max(1, Math.min(5000, Number(params.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));

  // Numbered by their place in the file, so a line howl cannot read still counts.
  const all = ledgerLines(ledger);
  const items: Item[] = all.filter((r) => r.n! > after);
  // Matched over the whole ledger, so a session before `after` still counts.
  const acting = actingAgents(all.map((i) => i.event));
  const signatures = checkSignatures(all.map((i) => ({ n: i.n ?? 0, event: i.event }))).byEvent;
  for (const item of items) {
    const by = acting.get(item.event.id)?.agent;
    if (by !== undefined) item.by = by;
    const signed = signatures.get(item.event.id);
    if (signed !== undefined) item.signed = signed;
  }
  if (params.get("activity") === "1" || wantsActivity(pairs)) {
    items.push(...activityLines(ledger));
  }
  return byTime(items)
    .filter((item) => filters.every((f) => f(item.event)))
    .slice(-limit);
}

function file(res: ServerResponse, root: string, pathname: string): void {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    res.writeHead(404).end();
    return;
  }
  if (path === "/" || path === "") path = "/index.html";
  const full = normalize(join(root, path));
  if (!full.startsWith(normalize(root) + sep) || path.includes("\0")) {
    res.writeHead(404).end();
    return;
  }
  let size: number;
  try {
    const s = statSync(full);
    if (!s.isFile()) throw new Error("not a file");
    size = s.size;
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(full)] ?? "application/octet-stream",
    "content-length": size,
    "x-content-type-options": "nosniff",
    "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(full).pipe(res);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(text);
}
