// `howl serve`: the dashboard's server. It answers on 127.0.0.1 only, serves the
// built page and read-only JSON over the ledger and the activity file. It takes
// no lock and never writes.
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { LedgerError } from "../ledger/errors.ts";
import { verify, type Verdict } from "../ledger/verify.ts";
import { activityBeside, byTime, Tail, type Read } from "../read/reader.ts";
import { agentStates } from "../read/state.ts";
import { parseFilters, wantsActivity } from "../read/watch.ts";

export interface ServeOptions {
  ledger: string;
  /** 0 picks a free port. */
  port: number;
  /** The folder of the built page. */
  root: string;
  /** Only a loopback address is accepted. */
  host?: string;
  taskFromBranch?: RegExp;
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
  statSync(options.ledger);

  // Verifying reads the whole ledger: keep the verdict until the file changes.
  let verdict: { size: number; mtime: number; value: Verdict } | null = null;
  const ledgerVerdict = (): Verdict => {
    const s = statSync(options.ledger);
    if (!verdict || verdict.size !== s.size || verdict.mtime !== s.mtimeMs) {
      verdict = { size: s.size, mtime: s.mtimeMs, value: verify(options.ledger) };
    }
    return verdict.value;
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

function handle(req: IncomingMessage, res: ServerResponse, options: ServeOptions, ledgerVerdict: () => Verdict): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  switch (url.pathname) {
    case "/api/agents": {
      const now = Date.now();
      const reads = byTime([...new Tail(options.ledger, "ledger").read(), ...new Tail(activityBeside(options.ledger), "activity").read()]);
      json(res, 200, { now, rows: agentStates(reads.map((r) => r.event), now, { taskFromBranch: options.taskFromBranch }) });
      return;
    }
    case "/api/events":
      json(res, 200, { now: Date.now(), events: events(options.ledger, url.searchParams) });
      return;
    case "/api/ledger": {
      const v = ledgerVerdict();
      json(res, 200, v.ok ? { ok: true, lines: v.lines, head: v.head, trial: v.trial } : { ok: false, lines: v.lines, line: v.line, faults: v.faults });
      return;
    }
    default:
      file(res, options.root, url.pathname);
  }
}

/** The ledger lines after `after` (all when absent), with the activity file when asked or filtered for, the newest `limit`. */
export function events(ledger: string, params: URLSearchParams): Item[] {
  const pairs = params.getAll("filter");
  const filters = parseFilters(pairs);
  const after = Number(params.get("after") ?? 0) || 0;
  const limit = Math.max(1, Math.min(5000, Number(params.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));

  const items: Item[] = [];
  // Numbered by their place in the file, so a line howl cannot read still counts.
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
