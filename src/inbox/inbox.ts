// The inbox: one file per event, left by hooks and scripts, taken in by the one writer.
//
// A file is written under a temporary name that starts with a dot, and then
// renamed. The writer only takes names that end in `.json`, so it never sees a
// file that is half written. Names sort by the time they were left; two left
// in the same millisecond sort by chance.
// @code_class recording
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
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

/**
 * How many events wait in an inbox, and when the oldest was left, by its
 * name (#102). Only reads. No inbox is nothing waiting.
 */
export function waitingIn(inbox: string): { waiting: number; oldest: number | null } {
  let names: string[];
  try {
    names = readdirSync(inbox);
  } catch {
    return { waiting: 0, oldest: null };
  }
  const ready = names.filter(isReady).sort();
  const left = Number(/^(\d{15})-/.exec(ready[0] ?? "")?.[1]);
  return { waiting: ready.length, oldest: ready.length > 0 && Number.isFinite(left) ? left : null };
}

/** Whether a name in the inbox is an event that is ready to be taken in. */
export function isReady(name: string): boolean {
  return name.endsWith(".json") && !name.startsWith(".");
}
