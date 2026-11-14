// A service the hook asks (keyd, the writer's server) that did not answer is
// not asked again for a while, so that a dead one never slows a session. The
// time of the failure is kept in a file beside the ledger.
// @code_class recording
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Whether the service failed to answer within the last `pauseMs`; a file that cannot be read is no failure. */
export function recentlyDown(file: string, pauseMs: number): boolean {
  try {
    const since = Date.now() - Date.parse(readFileSync(file, "utf8").trim());
    // A time to come is no failure: the clock was wrong, or the file is not ours.
    return Number.isFinite(since) && since >= 0 && since < pauseMs;
  } catch {
    return false;
  }
}

export function markDown(file: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${new Date().toISOString()}\n`);
  } catch {
    // The caller never fails over this: the service is asked again the next time.
  }
}
