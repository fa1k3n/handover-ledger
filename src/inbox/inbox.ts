// The inbox: one file per event, left by hooks and scripts, taken in by the one writer.
//
// A file is written under a temporary name that starts with a dot, and then
// renamed. The writer only takes names that end in `.json`, so it never sees a
// file that is half written. Names sort by the time they were left; two left
// in the same millisecond sort by chance.
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fixedForm } from "../ledger/fixed.ts";
import type { LedgerEvent } from "../ledger/schema.ts";

/** Leaves an event in the inbox, in its fixed form. Returns the path of the file. */
export function leave(inbox: string, event: LedgerEvent): string {
  const bytes = fixedForm(event);
  mkdirSync(inbox, { recursive: true, mode: 0o700 });
  const name = `${String(Date.now()).padStart(15, "0")}-${randomUUID()}.json`;
  const temporary = join(inbox, `.${name}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    unlinkSync(temporary);
    throw e;
  }
  closeSync(fd);
  const path = join(inbox, name);
  renameSync(temporary, path);
  return path;
}

/** Whether a name in the inbox is an event that is ready to be taken in. */
export function isReady(name: string): boolean {
  return name.endsWith(".json") && !name.startsWith(".");
}
