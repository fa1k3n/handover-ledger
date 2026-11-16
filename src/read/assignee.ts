// Who a task was given to, from an event (#45). `actor` is the one who acted; on a giving that is the giver, and the
// receiver is `to`. A giving written before `to` existed has the receiver as its `actor`, and is read as it was. Every
// reader of who got a task asks here, so none names the giver as the receiver.
// No Node, so the page can use it.
// @code_class reading
import type { LedgerEvent } from "../ledger/schema.ts";

type Member = NonNullable<LedgerEvent["actor"]>;

const gone = (event: LedgerEvent) => (event.data as { account_removed?: unknown } | undefined)?.account_removed === true;

/**
 * The team member a giving is of: `to`; else, for a `task.assigned` written before `to`, its `actor`. On a
 * `task.unassigned` it is the one the task was taken from. None when that account no longer exists (#48): it has no
 * `to` and the event says `account_removed`, and the actor, if there is one, is the giver. A giving written before
 * `to` has an actor only when its receiver is there, and then it does not say `account_removed`. None for any other event.
 */
export function assignee(event: LedgerEvent): Member | undefined {
  if (event.to !== undefined) return event.to;
  if (event.type !== "task.assigned" || gone(event)) return undefined;
  return event.actor;
}

/** The one who gave the task, when the event says: its actor, where the event has a `to` or says its receiver is gone. */
export function giver(event: LedgerEvent): Member | undefined {
  if (event.type !== "task.assigned") return undefined;
  return event.to !== undefined || gone(event) ? event.actor : undefined;
}
