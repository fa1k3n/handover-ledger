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
import { presentTime } from "../read/now.ts";
import { activityBeside, activityFrom, activityLines, byTime, ledgerLines, lineCount, readAll, type Read } from "../read/reader.ts";
import { checkSignatures } from "../keys/keys.ts";
import { actingAgents } from "../read/acting.ts";
import { Kept } from "./kept.ts";
import { projectsWriting, writingOf } from "../read/writing.ts";
import { handovers, keyFigures } from "../read/overview.ts";
import { lineProvenance, prepareLines, type Prepared } from "../read/line.ts";
import { parseAsked, show } from "../read/show.ts";
import { agentStates } from "../read/state.ts";
import { readFilters, wantsActivity, type Failed } from "../read/filter.ts";

export interface ServeOptions {
  /** One ledger only. */
  ledger?: string;
  /** Else every project in this folder that holds a ledger. */
  home?: string;
  /** #54: with `home`, serve this project only. Without it, `home` serves every project, as today (`--all`). */
  project?: string;
  /** The project shown first; else the first by name. */
  defaultProject?: string;
  /** 0 picks a free port. */
  port: number;
  /** The folder of the built page. */
  root: string;
  /** Only a loopback address is accepted. */
  host?: string;
  /** #46: the names of the default project's agents, for the gap "not a known agent". */
  agents?: ReadonlySet<string>;
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
/** #54: the names a request may give in its Host, each with the server's own port. */
const NAMES = ["127.0.0.1", "localhost", "[::1]"];

/** #54: a request for a project this server does not serve. */
class NotServed extends Error {}

/**
 * #54: whether a request is meant for this server: its Host is one of the loopback
 * names with the server's port, and its Origin, when it has one, is that over http://.
 * A page of another name pointed at 127.0.0.1 (DNS rebinding) fails here.
 */
function meantForUs(req: IncomingMessage, port: number): boolean {
  const hosts = NAMES.map((name) => `${name}:${port}`);
  const host = req.headers.host;
  if (host === undefined || !hosts.includes(host.toLowerCase())) return false;
  const origin = req.headers.origin;
  return origin === undefined || hosts.some((h) => origin.toLowerCase() === `http://${h}`);
}
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

  // #85: the lines of each ledger and each activity file as the event log gives them, kept until the file changes.
  const lines: Lines = { ledger: new Kept<Item[]>(), activity: new Kept<Item[]>(), provenance: new Kept<Prepared>() };

  let port = options.port;
  const server = createServer((req, res) => {
    if (!meantForUs(req, port)) {
      json(res, 403, { error: "not a request for this server" });
      return;
    }
    try {
      if (options.write !== undefined && req.method === "POST") {
        const path = pathOf(req);
        if (path === "/api/events") return receive(req, res, options.write);
        if (path === "/api/hook") return receiveHook(req, res, options.write);
      }
      handle(req, res, options, ledgerVerdict, lines);
    } catch (e) {
      const status = e instanceof NotServed ? 404 : e instanceof LedgerError ? 400 : 500;
      json(res, status, { error: (e as Error).message });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => resolve());
  });
  const address = server.address();
  if (typeof address === "object" && address) port = address.port;
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

/** The projects served: the one ledger, the one project of the home (#54), or every folder of the home that holds a ledger, by name. */
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
    .filter((name) => (options.project === undefined || name === options.project) && isProjectName(name) && existsSync(join(options.home!, name, LEDGER_FILE)))
    .sort()
    .map((name) => ({ name, ledger: join(options.home!, name, LEDGER_FILE) }));
}

function defaultOf(projects: Project[], options: ServeOptions): Project | undefined {
  return projects.find((p) => p.name === firstOf(options)) ?? projects[0];
}

/** The project shown first, whose settings (`agents`) the server was given: the one project, else `defaultProject`. */
function firstOf(options: ServeOptions): string | undefined {
  return options.project ?? options.defaultProject;
}

/** The project a call asks for: only a name from the list, never a path. */
function projectFor(params: URLSearchParams, options: ServeOptions): Project {
  const projects = projectsOf(options);
  const asked = params.get("project");
  // #54: started for one project, another is not there to be asked for.
  if (options.project !== undefined && asked !== null && asked !== options.project) throw new NotServed(`no project ${JSON.stringify(asked)}`);
  const found = asked === null ? defaultOf(projects, options) : projects.find((p) => p.name === asked);
  if (!found) throw new LedgerError(asked === null ? "no project with a ledger" : `no project ${JSON.stringify(asked)}`);
  return found;
}

function handle(req: IncomingMessage, res: ServerResponse, options: ServeOptions, ledgerVerdict: (ledger: string) => Verdict, lines: Lines): void {
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
    // #102: whether each project is being written and what waits for its writer. Not for a server of one ledger file: that file need not lie in a project's folder.
    const one = options.ledger !== undefined;
    json(res, 200, {
      now: presentTime(),
      single: one || options.project !== undefined,
      default: defaultOf(projects, options)?.name ?? null,
      projects: projects.map((p) => ({ name: p.name, lines: lineCount(p.ledger), ...(one ? {} : writingOf(p.ledger)) })),
      // A project with events waiting and no ledger yet is in no list above: nothing has written it, ever.
      ...(one ? {} : { unstarted: projectsWriting(options.home!).filter((p) => !p.ledger && (options.project === undefined || p.name === options.project)).map(({ name, waiting, oldest }) => ({ name, waiting, oldest })) }),
    });
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
    const found = events(served, url.searchParams, options.ledger === undefined, lines);
    // #82: what a filter could not work out is said only when there is something to say.
    json(res, 200, found.failed === null ? { now: presentTime(), events: found.events } : { now: presentTime(), events: found.events, failed: found.failed });
    return;
  }
  const project = projectFor(url.searchParams, options);
  const ledger = project.ledger;
  const agents = options.ledger !== undefined || project.name === firstOf(options) ? options.agents : undefined;
  switch (url.pathname) {
    case "/api/agents": {
      const now = presentTime();
      json(res, 200, { now, rows: agentStates(readAll(ledger).map((r) => r.event), now, { agents }) });
      return;
    }
    case "/api/overview": {
      const now = presentTime();
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
    case "/api/line": {
      // #191: one line's provenance, for the event dialog. A whole number, never a path; line 0 is not there.
      const asked = url.searchParams.get("line") ?? "";
      if (!/^(0|[1-9][0-9]{0,14})$/.test(asked)) throw new LedgerError("give line: the number of a line of the ledger");
      const n = Number(asked);
      const prepared = lines.provenance.of(ledger, () => prepareLines(ledger));
      const found = lineProvenance(ledger, prepared, n, ledgerVerdict(ledger), options.ledger === undefined ? project.name : undefined);
      if (found === null) {
        json(res, 404, { error: `the ledger has no line ${n} that howl can read` });
        return;
      }
      json(res, 200, { now: presentTime(), ...found });
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
function events(projects: Project[], params: URLSearchParams, named: boolean, lines: Lines): { events: Item[]; failed: Failed | null } {
  const pairs = params.getAll("filter");
  const filters = readFilters(pairs);
  const after = Number(params.get("after") ?? 0) || 0;
  if (after > 0 && projects.length > 1) throw new LedgerError("after is a line of one ledger: name the project");
  const limit = Math.max(1, Math.min(5000, Number(params.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const activity = params.get("activity") === "1" || wantsActivity(pairs);

  const found = byTime(projects.flatMap((project) => itemsOf(project, after, activity, named, lines)))
    .filter((item) => filters.test(item.event))
    .slice(-limit);
  return { events: found, failed: filters.failed() };
}

/** What the event log has read of the files, kept until a file changes (#85). */
interface Lines {
  ledger: Kept<Item[]>;
  activity: Kept<Item[]>;
  /** #191: what /api/line reads of a ledger as a whole. */
  provenance: Kept<Prepared>;
}

/**
 * The ledger lines of one project after `after` (all when 0), then the lines of
 * its activity file when asked for. The items are those kept for the files as
 * they stand: they are shared by every answer and never changed.
 */
function itemsOf(project: Project, after: number, activity: boolean, named: boolean, lines: Lines): Item[] {
  const name = named ? project.name : undefined;
  const ledger = lines.ledger.of(project.ledger, () => {
    // Numbered by their place in the file, so a line howl cannot read still counts.
    const all: Item[] = ledgerLines(project.ledger);
    // Matched over the whole ledger, so a session before `after` still counts.
    const acting = actingAgents(all.map((i) => i.event));
    // #199: by line, so that a copy under a repeated id never shows another line's verdict.
    const signatures = checkSignatures(all.map((i) => ({ n: i.n ?? 0, event: i.event }))).byLine;
    for (const item of all) {
      const by = acting.get(item.event.id)?.agent;
      if (by !== undefined) item.by = by;
      const signed = signatures.get(item.n ?? 0);
      if (signed !== undefined) item.signed = signed;
      if (name !== undefined) item.project = name;
    }
    return all;
  });
  const items = after > 0 ? ledger.filter((r) => r.n! > after) : ledger;
  if (!activity) return items;
  const tools = lines.activity.of(activityBeside(project.ledger), () => {
    const read: Item[] = activityLines(project.ledger);
    if (name !== undefined) for (const item of read) item.project = name;
    return read;
  });
  return [...items, ...tools];
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
