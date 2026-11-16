// Who a task was given to, from an event (#45). `actor` is the one who acted; on a giving that is the giver, and the
// receiver is `to`. A giving written before `to` existed has the receiver as its `actor`, and is read as it was. Every
// reader of who got a task asks here, so none names the giver as the receiver.
// No Node, so the page can use it.
// @code_class reading
import type { LedgerEvent } from "../ledger/schema.ts";

type Member = NonNullable<LedgerEvent["actor"]>;

const said = (event: LedgerEvent, flag: "account_removed" | "to_account_removed") => (event.data as Record<string, unknown> | undefined)?.[flag] === true;

/** Whether the event is of the form of this step: it has a `to`, or says that the account of its `to` is gone. */
const written = (event: LedgerEvent) => event.to !== undefined || said(event, "to_account_removed");

/**
 * The team member a giving is of: `to`; else, for a `task.assigned` written before `to`, its `actor`. On a
 * `task.unassigned` it is the one the task was taken from. None when that account no longer exists (#48), and for any
 * other event. A giving written before `to` has an actor only when its receiver is there; with no actor it says
 * `account_removed`, and that is the receiver.
 */
export function assignee(event: LedgerEvent): Member | undefined {
  if (event.to !== undefined) return event.to;
  if (event.type !== "task.assigned" || said(event, "to_account_removed") || said(event, "account_removed")) return undefined;
  return event.actor;
}

/** The one who gave the task, when the event says: its actor, where the event is of the form of this step. */
export function giver(event: LedgerEvent): Member | undefined {
  return event.type === "task.assigned" && written(event) ? event.actor : undefined;
}

/**
 * Which account of a giving or a taking back no longer exists (#48): `to` is the one who got it (or had it), `by` the one
 * who gave it (or took it back). `data.account_removed` is of the actor and `data.to_account_removed` of the one in `to`;
 * an event written before this step has no `to` and says `account_removed` of its receiver.
 */
export function accountsGone(event: LedgerEvent): { to: boolean; by: boolean } {
  if (event.type !== "task.assigned" && event.type !== "task.unassigned") return { to: false, by: false };
  if (written(event)) return { to: event.to === undefined, by: said(event, "account_removed") };
  return { to: event.type === "task.assigned" && said(event, "account_removed"), by: false };
}
