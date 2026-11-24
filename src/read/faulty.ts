// A line of the ledger that the readers leave out (#200): a line that is no JSON, holds no event, or whose
// event the event schema refuses. It is named where a reader reports, and never thrown: an assessor needs the
// rest of a ledger that was changed in this way, and `howl verify` stops at the line.
// @code_class reading

/** A line of the ledger that is left out of what is derived, and why. */
export interface FaultyLine {
  /** Its number in the file, counted over every line. */
  line: number;
  reason: string;
  /** In an answer over several projects: the project whose ledger the line is in. */
  project?: string;
}

/** How many reasons of one line are given: a line may be refused for a great many fields. */
const REASONS = 5;
/** How many lines an answer names; the rest are counted. */
export const FAULTY_SHOWN = 100;

/** The reason a line is left out, from what the schema says: at most five, then how many more. */
export function reasonOf(faults: string[]): string {
  if (faults.length <= REASONS) return faults.join("; ");
  return `${faults.slice(0, REASONS).join("; ")}; and ${faults.length - REASONS} more`;
}

/** What an answer adds when lines were left out: the first hundred, and how many more. Nothing when none were. */
export function faultyAnswer(faulty: FaultyLine[]): { faulty?: FaultyLine[]; faultyMore?: number } {
  if (faulty.length === 0) return {};
  const shown = { faulty: faulty.slice(0, FAULTY_SHOWN) };
  return faulty.length > FAULTY_SHOWN ? { ...shown, faultyMore: faulty.length - FAULTY_SHOWN } : shown;
}

/** What a command says on standard error when it left lines out, one note to a line: the first ten, then how many more. */
export function faultyNotes(faulty: FaultyLine[]): string[] {
  const notes = faulty.slice(0, 10).map((f) => `line ${f.line} is left out: ${f.reason}`);
  if (faulty.length > 10) notes.push(`${faulty.length - 10} more lines are left out: run \`howl verify\``);
  return notes;
}
