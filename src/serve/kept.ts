// What the server made of a file, kept until the file changes (#85). The page
// asks every two seconds, and a ledger seldom changes between two polls: the
// lines are read, matched and checked once for each state of the file.
//
// A file is taken as unchanged while its size, its time of change and its
// inode are the same. A ledger only grows, so its size tells; an activity file
// is replaced when old lines expire, so its inode tells.
// @code_class reading
import { statSync } from "node:fs";

export class Kept<T> {
  private readonly values = new Map<string, { state: string; value: T }>();

  /** What `make` gave for the file as it stands; made again when the file changed. A file that is not there is not kept. */
  of(file: string, make: () => T): T {
    let state: string;
    try {
      const s = statSync(file);
      state = `${s.size}:${s.mtimeMs}:${s.ino}`;
    } catch {
      this.values.delete(file);
      return make();
    }
    const kept = this.values.get(file);
    if (kept !== undefined && kept.state === state) return kept.value;
    const value = make();
    this.values.set(file, { state, value });
    return value;
  }
}
