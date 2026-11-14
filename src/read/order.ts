// The one order of events: by time. No Node, so the page and the pure readers can use it.
// @code_class reading

/** Sorts by the time of the event; events of the same time keep the order they came in. */
export function byTime<T extends { event: { time: string } }>(items: T[]): T[] {
  return items
    .map((item, i) => ({ item, i, t: Date.parse(item.event.time) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.item);
}
