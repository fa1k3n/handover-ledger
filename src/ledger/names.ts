// The names of the two files of a project that hold events. No Node, so the page can use them.
// @code_class evidence

/** The ledger: one line per event, each holding the hash of the line before. */
export const LEDGER_FILE = "ledger.jsonl";

/** The activity (tool calls), with no chain. */
export const ACTIVITY_FILE = "activity.jsonl";
