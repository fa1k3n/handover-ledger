// `howl serve`: the dashboard's server. It answers on 127.0.0.1 only, serves the
// built page and read-only JSON over the ledger and the activity file. It takes
// no lock and never writes.
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, normalize, sep } from "node:path";
import { LedgerError } from "../ledger/errors.ts";
import { isProjectName } from "../ledger/place.ts";
import { verify, type Verdict } from "../ledger/verify.ts";
import { activityBeside, byTime, Tail, type Read } from "../read/reader.ts";
import { actingAgents } from "../read/acting.ts";
import { handovers, keyFigures } from "../read/overview.ts";
import { agentStates } from "../read/state.ts";
import { parseFilters, wantsActivity } from "../read/watch.ts";

export interface ServeOptions {
  /** One ledger only. */
  ledger?: string;
  /** Else every project in this folder that holds a ledger.jsonl. */
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
}

interface Project {
  name: string;
  ledger: string;
}

export interface Served {
  url: string;
  close(): Promise<void>;
}

/** An event as the page gets it: ledger lines with their number and hashes. */
export interface Item {
  n?: number;
  from: Read["from"];
  hash?: string;
  prev?: string | null;
  event: Read["event"];
  /** The line as it stands in its file. */
  raw: string;
  /** The agent behind a person's account at the code host, when one matches (#14). */
  by?: string;
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
    .filter((name) => isProjectName(name) && existsSync(join(options.home!, name, "ledger.jsonl")))
    .sort()
    .map((name) => ({ name, ledger: join(options.home!, name, "ledger.jsonl") }));
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
      const reads = byTime([...new Tail(ledger, "ledger").read(), ...new Tail(activityBeside(ledger), "activity").read()]);
      json(res, 200, { now, rows: agentStates(reads.map((r) => r.event), now, { taskFromBranch: pattern }) });
      return;
    }
    case "/api/events":
      json(res, 200, { now: Date.now(), events: events(ledger, url.searchParams) });
      return;
    case "/api/overview": {
      const now = Date.now();
      const items = ledgerItems(ledger);
      json(res, 200, { now, figures: keyFigures(items.map((i) => i.event), now), handovers: handovers(items).slice(0, 50) });
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

/** The number of whole lines of a file. */
function lineCount(path: string): number {
  const bytes = readFileSync(path);
  let n = 0;
  for (const b of bytes) if (b === 0x0a) n++;
  return n;
}

/** The ledger lines after `after` (all when absent), with the activity file when asked or filtered for, the newest `limit`. */
export function events(ledger: string, params: URLSearchParams): Item[] {
  const pairs = params.getAll("filter");
  const filters = parseFilters(pairs);
  const after = Number(params.get("after") ?? 0) || 0;
  const limit = Math.max(1, Math.min(5000, Number(params.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));

  const items: Item[] = ledgerItems(ledger, after);
  // Matched over the whole ledger, so a session before `after` still counts.
  const acting = actingAgents((after > 0 ? ledgerItems(ledger) : items).map((i) => i.event));
  for (const item of items) {
    const by = acting.get(item.event.id)?.agent;
    if (by !== undefined) item.by = by;
  }
  if (params.get("activity") === "1" || wantsActivity(pairs)) {
    for (const r of new Tail(activityBeside(ledger), "activity").read()) items.push({ from: "activity", event: r.event, raw: r.raw });
  }
  const sorted = items
    .map((item, i) => ({ item, i, t: Date.parse(item.event.time) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.item)
    .filter((item) => filters.every((f) => f(item.event)));
  return sorted.slice(-limit);
}

/** The lines of the ledger after line `after`, numbered by their place in the file, so a line howl cannot read still counts. */
export function ledgerItems(ledger: string, after = 0): Item[] {
  const items: Item[] = [];
  const text = readFileSync(ledger, "utf8");
  const whole = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").slice(0, -1);
  whole.forEach((raw, i) => {
    const n = i + 1;
    if (n <= after) return;
    try {
      const line = JSON.parse(raw) as { prev: string | null; hash: string; event: Read["event"] };
      if (!line.event || line.event.type === "ledger.created") return;
      items.push({ n, from: "ledger", hash: line.hash, prev: line.prev, event: line.event, raw });
    } catch {
      // Not a line howl can read: `howl verify` names it.
    }
  });
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
