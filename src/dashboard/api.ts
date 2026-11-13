// The dashboard's calls to howl serve: read-only JSON.
import type { Handover, KeyFigures } from "../read/overview.ts";
import type { AgentRow } from "../read/state.ts";
import type { Item } from "../serve/server.ts";

export interface Agents {
  now: number;
  rows: AgentRow[];
}

export type LedgerState = { ok: true; lines: number; head: string; trial: boolean } | { ok: false; lines: number; line: number; faults: string[] };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
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
