// What is said of a project that is not being written (#102). Apart from
// `writing.ts`, which reads the files: the page loads this and must not load
// what reads a disk.
// @code_class reading

export interface Writing {
  /** A process holds the ledger's lock. */
  writer: boolean;
  /** The events in the inbox. */
  waiting: number;
  /** When the oldest of them was left, in milliseconds; null when none waits. */
  oldest: number | null;
}

/** With a writer, events that have waited this long are said: it takes them in at once when all is well. */
export const SLOW_MS = 60_000;

/**
 * What the page and the commands say of a project, or null when there is
 * nothing to say: no event waits, or a writer has had them for under a minute.
 */
export function writingLine(project: string, w: Writing, now: number): string | null {
  if (w.waiting === 0) return null;
  const events = w.waiting === 1 ? "1 event" : `${w.waiting} events`;
  if (!w.writer) {
    return `${project}: ${events} ${w.waiting === 1 ? "waits" : "wait"} and nothing writes ${w.waiting === 1 ? "it" : "them"}. Start howl up in its repository.`;
  }
  if (w.oldest === null || now - w.oldest < SLOW_MS) return null;
  return `${project}: ${events} ${w.waiting === 1 ? "has" : "have"} waited for the writer for ${Math.floor((now - w.oldest) / 60_000)} min.`;
}
