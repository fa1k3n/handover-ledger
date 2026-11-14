// The dashboard's server, for `howl serve` and `howl up`. It answers on
// 127.0.0.1 only, serves the built page and read-only JSON over the ledger and
// the activity file. It takes no lock and never writes.
//
// With `write` (`howl up`, #64 and #67) a POST of /api/events or /api/hook is
// handed to `src/inbox/receive.ts`, which decides what the writer takes. This module
// only reads. Without `write` every POST is refused, as before.
// @code_class reading
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, normalize, sep } from "node:path";
import { receive, receiveHook, type Write } from "../inbox/receive.ts";
import { LedgerError } from "../ledger/errors.ts";
import { LEDGER_FILE } from "../ledger/names.ts";
import { isProjectName } from "../ledger/place.ts";
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
  /**
   * #79: the project whose ledger or activity file the line is from, by the name
   * the server lists it under. Not from a server of one ledger file (`--ledger`):
   * that file need not lie in a project's folder, and its answers are as they were.
   */
  project?: string;
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
      if (options.write !== undefined && req.method === "POST") {
        const path = pathOf(req);
        if (path === "/api/events") return receive(req, res, options.write);
        if (path === "/api/hook") return receiveHook(req, res, options.write);
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
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  // /api/hook is a POST only, and only on a server that writes: that one never comes here.
  if (url.pathname === "/api/hook") {
    res.writeHead(405, { allow: options.write === undefined ? "" : "POST" }).end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  if (url.pathname === "/api/projects") {
    const projects = projectsOf(options);
    json(res, 200, { single: options.ledger !== undefined, default: defaultOf(projects, options)?.name ?? null, projects: projects.map((p) => ({ name: p.name, lines: lineCount(p.ledger) })) });
    return;
  }
  if (!url.pathname.startsWith("/api/")) {
    file(res, options.root, url.pathname);
    return;
  }
  if (url.pathname === "/api/events") {
    // #79: with no project named, every project the server serves; else the one named.
    const served = url.searchParams.has("project") ? [projectFor(url.searchParams, options)] : projectsOf(options);
    if (served.length === 0) throw new LedgerError("no project with a ledger");
    json(res, 200, { now: Date.now(), events: events(served, url.searchParams, options.ledger === undefined) });
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

/**
 * The event log (#79): the lines of every project given, as one list in the
 * order of time, the newest `limit`; with the activity files when asked or
 * filtered for. With `named`, each item names its project, as a line number and
 * a hash are those of that project's ledger. Events of the same time come in the order of
 * the projects given (by name), then in the order of their file.
 *
 * `after` is a line of one ledger: over several projects it is refused.
 */
function events(projects: Project[], params: URLSearchParams, named: boolean): Item[] {
  const pairs = params.getAll("filter");
  const filters = parseFilters(pairs);
  const after = Number(params.get("after") ?? 0) || 0;
  if (after > 0 && projects.length > 1) throw new LedgerError("after is a line of one ledger: name the project");
  const limit = Math.max(1, Math.min(5000, Number(params.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const activity = params.get("activity") === "1" || wantsActivity(pairs);

  return byTime(projects.flatMap((project) => itemsOf(project, after, activity, named)))
    .filter((item) => filters.every((f) => f(item.event)))
    .slice(-limit);
}

/** The ledger lines of one project after `after` (all when 0), then the lines of its activity file when asked for. */
function itemsOf(project: Project, after: number, activity: boolean, named: boolean): Item[] {
  // Numbered by their place in the file, so a line howl cannot read still counts.
  const all = ledgerLines(project.ledger);
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
  if (activity) items.push(...activityLines(project.ledger));
  if (named) for (const item of items) item.project = project.name;
  return items;
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
