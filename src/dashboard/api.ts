// The dashboard's calls to howl serve: read-only JSON.
// @code_class reading
import type { Handover, KeyFigures } from "../read/overview.ts";
import type { AgentRow } from "../read/state.ts";
import type { Provenance } from "../read/line.ts";
import type { Item } from "../serve/server.ts";
import type { Writing } from "../read/writing-text.ts";
import { eventsQuery } from "./format.ts";

export interface Agents {
  now: number;
  rows: AgentRow[];
}

/** #202: `pinned` says whether the server was given the issuer's pin (`--issuer`). */
export type LedgerState = { ok: true; lines: number; head: string; trial: boolean; pinned: boolean } | { ok: false; lines: number; line: number; faults: string[]; pinned: boolean };

/** The project every call asks for; set by the page. */
let project: string | null = null;
export function setProject(name: string | null): void {
  project = name;
}

async function get<T>(path: string): Promise<T> {
  const url = new URL(path, location.href);
  // #79: the event log is asked for with no project: it is every project the server serves.
  // #191: a call that names its project itself (the line of an event of another project) keeps it.
  if (project !== null && url.pathname !== "/api/projects" && url.pathname !== "/api/events" && !url.searchParams.has("project")) url.searchParams.set("project", project);
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export interface Projects {
  /** One ledger only (--ledger): no menu. */
  single: boolean;
  default: string | null;
  /** #102: `writer`, `waiting` and `oldest` are there when the server serves howl's home, not one ledger file. */
  projects: ({ name: string; lines: number } & Partial<Writing>)[];
  now?: number;
  /** #102: projects with events waiting and no ledger yet. */
  unstarted?: { name: string; waiting: number; oldest: number | null }[];
}

export const projects = () => get<Projects>("/api/projects");

/** One change or task's timeline; null when nothing names it. */
export async function show(what: string): Promise<import("../read/show.ts").Shown | null> {
  try {
    return await get(`/api/show?${new URLSearchParams({ what })}`);
  } catch (e) {
    if ((e as Error).message.startsWith("nothing in the ledger")) return null;
    throw e;
  }
}
export const agents = () => get<Agents>("/api/agents");
export const ledger = () => get<LedgerState>("/api/ledger");
export const overview = () => get<{ now: number; figures: KeyFigures; handovers: Handover[] }>("/api/overview");

/** #82: `failed` is there when a filter could not be worked out for some events: how many, and why. */
export function events(filters: string[], tools: boolean, limit = 200): Promise<{ now: number; events: Item[]; failed?: { events: number; reason: string } }> {
  return get(`/api/events?${eventsQuery(filters, tools, limit)}`);
}

/** #216: the provenance of an event named by its hash: a line of the ledger, else an event of the branch howl/log. */
export function lineByHash(of: string | undefined, hash: string): Promise<{ now: number } & Provenance> {
  const q = new URLSearchParams({ hash });
  if (of !== undefined) q.set("project", of);
  return get(`/api/line?${q}`);
}

/** #191: one line's provenance for the event dialog, of the project the event names, else the page's. */
export function line(of: string | undefined, n: number): Promise<{ now: number } & Provenance> {
  const q = new URLSearchParams({ line: String(n) });
  if (of !== undefined) q.set("project", of);
  return get(`/api/line?${q}`);
}
