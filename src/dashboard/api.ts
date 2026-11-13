// The dashboard's calls to howl serve: read-only JSON.
import type { Handover, KeyFigures } from "../read/overview.ts";
import type { AgentRow } from "../read/state.ts";
import type { Item } from "../serve/server.ts";

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
  if (project !== null && url.pathname !== "/api/projects") url.searchParams.set("project", project);
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
  projects: { name: string; lines: number }[];
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

export function events(filters: string[], activity: boolean, limit = 200): Promise<{ now: number; events: Item[] }> {
  const q = new URLSearchParams();
  for (const f of filters) q.append("filter", f);
  if (activity) q.set("activity", "1");
  q.set("limit", String(limit));
  return get(`/api/events?${q}`);
}
