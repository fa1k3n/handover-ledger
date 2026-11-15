// What is said of a project that is not being written (#102). Apart from
// `writing.ts`, which reads the files: the page loads this and must not load
// what reads a disk.
// @code_class reading

export interface Writing {
  /** A process holds the ledger's lock. */
  writer: boolean;
  /** The events in the inbox. */
  waiting: number;
  /** When the oldest of them was left, in milliseconds; null when none waits or none tells. */
  oldest: number | null;
  /** The lock is one left by a process that no longer runs: a new writer is refused until it is removed. */
  left?: true;
}

/**
 * With a writer, events that have waited this long are said. `howl up` takes
 * an event in at once; `howl observe` at its next round, a minute by default,
 * so the limit is well over a round.
 */
export const SLOW_MS = 5 * 60_000;

/**
 * What the page and the commands say of a project, or null when there is
 * nothing to say: no event waits, or a writer has had them for less than `SLOW_MS`.
 */
export function writingLine(project: string, w: Writing, now: number): string | null {
  if (w.waiting === 0) return null;
  const events = w.waiting === 1 ? "1 event" : `${w.waiting} events`;
  if (!w.writer) {
    const waits = `${project}: ${events} ${w.waiting === 1 ? "waits" : "wait"} and nothing writes ${w.waiting === 1 ? "it" : "them"}.`;
    // A new writer is refused while the old lock lies there: say what helps, not what fails.
    return w.left ? `${waits} Its lock was left by a process that no longer runs: run howl verify there, then remove the lock.` : `${waits} Start howl up in its repository.`;
  }
  if (w.oldest === null || now - w.oldest < SLOW_MS) return null;
  return `${project}: ${events} ${w.waiting === 1 ? "has" : "have"} waited for the writer for ${Math.floor((now - w.oldest) / 60_000)} min.`;
}
