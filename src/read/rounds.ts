// What a round is, and a review round in words, for `howl show` and the dashboard: the same reviewer and outcome in a row folds into one entry with a count. No Node, so the page can use it.
// @code_class reading
import type { LedgerEvent } from "../ledger/schema.ts";
import type { Acting } from "./acting.ts";
import { isReview, observed } from "./observed.ts";

type Actor = NonNullable<LedgerEvent["actor"]>;

export interface RoundReview {
  actor?: { id: string };
  outcome: string;
  /** The agent behind a person's account, when one matches (#14). */
  by?: string;
  /** #45: the review was dismissed, when and by whom. */
  dismissed?: { time: string; actor?: { id: string } };
}

/** `agent-1 via person-aaaa commented ×16, bob approved`. */
export function roundText(reviews: RoundReview[], time?: (t: string) => string): string {
  const who = (x: RoundReview) => (x.by ? `${x.by} via ${x.actor?.id ?? "someone"}` : (x.actor?.id ?? "someone"));
  const parts: { text: string; n: number }[] = [];
  for (const x of reviews) {
    const dismissed = x.dismissed === undefined ? "" : ` (dismissed by ${x.dismissed.actor?.id ?? "someone"}${time ? ` at ${time(x.dismissed.time)}` : ""})`;
    const text = `${who(x)} ${x.outcome.replace("_", " ")}${dismissed}`;
    const last = parts.at(-1);
    // #48: reviews with no actor (accounts that are gone) are not one reviewer, so they stay apart.
    if (last && last.text === text && x.actor !== undefined) last.n++;
    else parts.push({ text, n: 1 });
  }
  return parts.map((p) => (p.n > 1 ? `${p.text} ×${p.n}` : p.text)).join(", ");
}

export interface Round {
  /** #117: the change the round is of. A new head of one change ends no round of another. */
  change?: string;
  /** `dismissed`: #45: the review happened and was dismissed, when and by whom. */
  reviews: { time: string; actor?: Actor; outcome: string; by?: string; dismissed?: { time: string; actor?: Actor } }[];
  /** The type of what came next: a new head, the merge, or none yet. */
  followedBy: string | null;
  /** #45: when the change was closed and then went on (opened again, closed again, merged): what came after, in the order it happened. */
  then?: string[];
}

/**
 * Reviews as rounds: a review after a new head commit starts a new round. From observed events only (#51).
 * #117: made per change, so a new head of one change ends no round of another.
 */
export function rounds(all: LedgerEvent[], acting: Map<string, Acting> = new Map()): Round[] {
  const events = all.filter(observed);
  // An event that names no change belongs to the one change there is, when there is only one.
  const named = new Set(events.flatMap((e) => (e.change === undefined ? [] : [e.change])));
  const only = named.size === 1 ? [...named][0] : undefined;
  const groups = new Map<string, LedgerEvent[]>();
  for (const e of events) {
    const key = e.change ?? only ?? "";
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const found: Round[] = [];
  for (const [change, own] of groups) found.push(...roundsOf(own, acting, change === "" ? undefined : change));
  return found;
}

function roundsOf(events: LedgerEvent[], acting: Map<string, Acting>, change: string | undefined): Round[] {
  const found: Round[] = [];
  let current: Round | null = null;
  let newHead = false;
  let lastReview = -1;
  const entries = new Map<string, Round["reviews"][number]>();
  for (const [i, e] of events.entries()) {
    if (isReview(e)) {
      if (current === null || newHead) {
        current = defined({ change, reviews: [], followedBy: null });
        found.push(current);
        newHead = false;
      }
      const entry = defined({ time: e.time, actor: e.actor, outcome: e.type.slice("review.".length), by: acting.get(e.id)?.agent });
      current.reviews.push(entry);
      const key = reviewIdOf(e);
      if (key !== undefined) entries.set(key, entry);
      lastReview = i;
    } else if (e.type === "change.updated" && current !== null) {
      newHead = true;
    }
    if (current && i > lastReview && current.followedBy === null && /^change\.(updated|merged|closed)$/.test(e.type)) {
      current.followedBy = e.type;
      if (e.type === "change.closed") {
        const after = events.slice(i + 1).filter((x) => /^change\.(reopened|closed|merged)$/.test(x.type));
        if (after.length > 0) current.then = after.map((x) => x.type);
      }
    }
  }
  // #45: a review that was dismissed is a review that happened, marked with when and by whom. The first dismissal counts.
  for (const e of events) {
    const id = e.type === "review.dismissed" ? (e.data as { review?: unknown } | undefined)?.review : undefined;
    const entry = typeof id === "string" ? entries.get(id) : undefined;
    if (entry !== undefined && entry.dismissed === undefined) entry.dismissed = defined({ time: e.time, actor: e.actor });
  }
  return found;
}

/** The host's id of a review, from the id of its event: `github:1:review:77` is 77. Not of a comment (`review:c5`) or a dismissal (`review:dismissed:5`). */
export function reviewIdOf(e: LedgerEvent): string | undefined {
  return /(?:^|:)review:([^:]+)$/.exec(e.id)?.[1];
}

function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
