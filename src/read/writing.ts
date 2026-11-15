// Whether a project is being written, and what waits for its writer (#102).
// `howl up` writes one project and shows every project of howl's home: a page
// that shows a ledger nobody writes looks alive and is not. Only reads.
// @code_class reading
import { dirname, join } from "node:path";
import { waitingIn } from "../inbox/inbox.ts";
import { hasWriter } from "../ledger/ledger.ts";
import type { Writing } from "./writing-text.ts";

export { writingLine, type Writing } from "./writing-text.ts";

/** The inbox beside a ledger: `<project folder>/inbox`. */
export const inboxBeside = (ledger: string): string => join(dirname(ledger), "inbox");

/** Whether the ledger has a writer, and what waits in the inbox beside it. Takes no lock and changes nothing. */
export function writingOf(ledger: string): Writing {
  return { writer: hasWriter(ledger), ...waitingIn(inboxBeside(ledger)) };
}
