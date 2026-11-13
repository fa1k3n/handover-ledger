// Who acted behind a person's account at the code host. When agents open
// changes and write reviews through a person's token, the code host names the
// person. The agent behind it is found by matching, here in the reading layer:
// the observed event is evidence and is never rewritten.
import type { LedgerEvent } from "../ledger/schema.ts";

/** A session's events this long before an observed event count for it. */
export const BEFORE_MS = 10 * 60_000;
/** And this long after: the hook of the call that made it comes a moment later. */
export const AFTER_MS = 2 * 60_000;

export interface Acting {
  agent: string;
  /** The account the code host saw. */
  via: string;
}

/**
 * For each observed change or review whose actor is a person, the one agent
 * whose own session was at it then: on the change's branch for an opened or
 * updated change, naming the change for a review. None when no agent or more
 * than one matches.
 */
export function actingAgents(events: LedgerEvent[]): Map<string, Acting> {
  const own = events.filter((e) => e.source.kind === "claimed" && e.actor?.kind === "agent");
  const found = new Map<string, Acting>();
  for (const e of events) {
    if (e.source.kind !== "observed" || e.actor?.kind !== "person" || e.change === undefined) continue;
    const isChange = e.type === "change.opened" || e.type === "change.updated";
    if (!isChange && !e.type.startsWith("review.")) continue;
    if (isChange && e.branch === undefined) continue;
    const t = Date.parse(e.time);
    const agents = new Set(
      own
        .filter((s) => {
          const d = Date.parse(s.time) - t;
          if (d < -BEFORE_MS || d > AFTER_MS) return false;
          return isChange ? s.branch === e.branch && (s.change === undefined || s.change === e.change) : s.change === e.change;
        })
        .map((s) => s.actor!.id),
    );
    if (agents.size === 1) found.set(e.id, { agent: [...agents][0]!, via: e.actor.id });
  }
  return found;
}
