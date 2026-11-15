// Reading the tests of a commit for the observer (#38), in a process of its own
// with a time limit. The settings and the files are the commit's, and a pull
// request's author writes them: a pattern that never ends, or a file that
// overflows the stack, must stop that one reading and nothing else. The
// observer holds the writer while it reads.
// @code_class recording
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TraceReport, TraceSummary } from "./trace.ts";
import { summaryOf } from "./trace.ts";

/**
 * `read`: the summary. `later`: the commit is not on this machine, which a
 * fetch may mend: ask again. `never`: nothing can be read of it (no settings
 * at that commit, tables that cannot be read, a reading that failed or took
 * too long): ask no more.
 */
export type TraceResult = { state: "read"; summary: TraceSummary } | { state: "later" } | { state: "never"; why: string; quiet: boolean };

/** How long one commit may take. */
export const READ_MS = 20_000;

const CLI = fileURLToPath(new URL("../cli/howl.ts", import.meta.url));

/** Reads a commit with `howl trace --at <sha> --json` in a process that is killed at the limit. Only reads. */
export function readTrace(root: string, sha: string, limitMs: number = Number(process.env.HOWL_TRACE_LIMIT_MS) || READ_MS): TraceResult {
  const run = spawnSync(process.execPath, [CLI, "trace", "--at", sha, "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: limitMs,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (run.error !== undefined) {
    const timedOut = (run.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return { state: "never", why: timedOut ? `took more than ${Math.round(limitMs / 1000)} s` : run.error.message, quiet: false };
  }
  if (run.status === 0) {
    try {
      return { state: "read", summary: summaryOf(JSON.parse(run.stdout) as TraceReport) };
    } catch {
      return { state: "never", why: "its answer could not be read", quiet: false };
    }
  }
  if (/^howl: no commit /m.test(run.stderr)) return { state: "later" };
  // The line that says what went wrong: a crash prints the file and the place first, then the error.
  const rows = run.stderr.split("\n").filter((l) => l.trim() !== "");
  const first = rows.find((l) => /Error\b/.test(l)) ?? rows[0] ?? `ended with ${run.status ?? run.signal}`;
  // A commit from before the settings were there is no fault: it is passed over without a word.
  return { state: "never", why: first.replace(/^howl: /, "").slice(0, 160), quiet: /no requirements_in/.test(run.stderr) };
}
