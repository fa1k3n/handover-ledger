// Whether a project is being written, and what waits for its writer (#102).
// `howl up` writes one project and shows every project of howl's home: a page
// that shows a ledger nobody writes looks alive and is not. Only reads.
// @code_class reading
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { waitingIn } from "../inbox/inbox.ts";
import { lockOf } from "../ledger/ledger.ts";
import { LEDGER_FILE } from "../ledger/names.ts";
import { isProjectName } from "../ledger/place.ts";
import type { Writing } from "./writing-text.ts";

export { writingLine, type Writing } from "./writing-text.ts";

/** The inbox beside a ledger: `<project folder>/inbox`. */
export const inboxBeside = (ledger: string): string => join(dirname(ledger), "inbox");

/** Whether the ledger has a writer, and what waits in the inbox beside it. Takes no lock and changes nothing. */
export function writingOf(ledger: string): Writing {
  const lock = lockOf(ledger);
  return { writer: lock === "held", ...waitingIn(inboxBeside(ledger)), ...(lock === "left" ? { left: true as const } : {}) };
}

/**
 * Every project of a howl home: those with a ledger, and those with events
 * waiting and no ledger yet, which no list of ledgers shows. A team's second
 * repository starts that way: its sessions leave events before anything
 * writes them.
 */
export function projectsWriting(home: string): ({ name: string; ledger: boolean } & Writing)[] {
  let names: string[];
  try {
    names = readdirSync(home).sort();
  } catch {
    return [];
  }
  return names.filter(isProjectName).flatMap((name) => {
    const ledger = join(home, name, LEDGER_FILE);
    const has = existsSync(ledger);
    const writing = writingOf(ledger);
    return has || writing.waiting > 0 ? [{ name, ledger: has, ...writing }] : [];
  });
}
