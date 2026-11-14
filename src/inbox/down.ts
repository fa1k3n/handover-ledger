// A service the hook asks (keyd, the writer's server) that did not answer is
// not asked again for a while, so that a dead one never slows a session. The
// time of the failure is kept in a file beside the ledger.
// @code_class recording
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Whether the service failed to answer within the last `pauseMs`; a file that cannot be read is no failure. */
export function recentlyDown(file: string, pauseMs: number): boolean {
  try {
    const at = Date.parse(readFileSync(file, "utf8").trim());
    return Number.isFinite(at) && Date.now() - at < pauseMs;
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
