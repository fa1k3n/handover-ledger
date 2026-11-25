// The one order of events: by time. No Node, so the page and the pure readers can use it.
// @code_class reading

/**
 * The order of two texts by their UTF-16 code units, as `<` has it: never by the locale, which orders `a` before `B`.
 *
 * For the Rust twin: `str`'s `Ord` compares UTF-8 bytes, which is the order of code points, and differs from this
 * between a character above U+FFFF and one in U+E000 to U+FFFF. Rust compares `encode_utf16()`.
 */
export function byUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorts by the time of the event; events of the same time keep the order they came in. */
export function byTime<T extends { event: { time: string } }>(items: T[]): T[] {
  return items
    .map((item, i) => ({ item, i, t: Date.parse(item.event.time) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.item);
}

/**
 * #216: sorts by the time of the event, then by its hash, as the union of the log and the ledger is read: line numbers
 * do not hold across machines. An item with no hash (a tool call) comes first among those of its time; items of the
 * same time and hash keep the order they came in.
 */
export function byTimeAndHash<T extends { event: { time: string }; hash?: string }>(items: T[]): T[] {
  return items
    .map((item, i) => ({ item, i, t: Date.parse(item.event.time) }))
    .sort((a, b) => a.t - b.t || byUnits(a.item.hash ?? "", b.item.hash ?? "") || a.i - b.i)
    .map((x) => x.item);
}
