// The dashboard's calls to howl serve: read-only JSON.
// @code_class reading
import type { Handover, KeyFigures } from "../read/overview.ts";
import type { AgentRow } from "../read/state.ts";
import type { Item } from "../serve/server.ts";
import type { Writing } from "../read/writing-text.ts";
import { eventsQuery } from "./format.ts";

export interface Agents {
  now: number;
  rows: AgentRow[];
}

export type LedgerState = { ok: true; lines: number; head: string; trial: boolean } | { ok: false; lines: number; line: number; faults: string[] };

/** The project every call asks for; set by the page. */
let project: string | null = null;
export function setProject(name: string | null): void {
  project = name;
}

async function get<T>(path: string): Promise<T> {
  const url = new URL(path, location.href);
  // #79: the event log is asked for with no project: it is every project the server serves.
  if (project !== null && url.pathname !== "/api/projects" && url.pathname !== "/api/events") url.searchParams.set("project", project);
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
