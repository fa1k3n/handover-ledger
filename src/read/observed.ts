// What counts as seen at the code host. An event an adapter read from the
// team's tools is observed; an event a session or a script sent about itself
// is a claim. What the code host owns (a task opened, given and closed; the
// opening, the heads, the comments, the reviews, the merge and the closing of
// a change) is read from observed events only: a claim of it is shown as a
// claim and counts for nothing.
// No Node, so the page can use it.
// @code_class reading
import type { LedgerEvent } from "../ledger/schema.ts";

/** Read by an adapter from the team's tools, not sent by a session or a script. */
export function observed(event: LedgerEvent): boolean {
  return event.source.kind === "observed";
}

/** A claim of what only the code host shows: an event of a task, a change or a review that no adapter read. */
export function claimOfHost(event: LedgerEvent): boolean {
  return !observed(event) && /^(task|change|review|trace)\./.test(event.type);
}

/** A review that was handed in: not the dismissal of one (`review.dismissed`, #45), which is no review. */
export function isReview(event: { type: string }): boolean {
  return event.type.startsWith("review.") && event.type !== "review.dismissed";
}
