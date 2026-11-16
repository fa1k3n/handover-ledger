// The order in which the events of a round are written (#112). The code host
// gives times to the second, and what happens together comes in one second: a
// task opened with someone already set on it, a change merged as it is
// approved. By the time first; at the same time by what can happen first, so
// that a task is never given away before it exists; then by the id, so that
// the order is the same in every round.
//
// It orders one round. An event that a later round finds, as the checks of a
// commit that had not finished, is written after what is already there: the
// ledger is append-only.
// @code_class recording

/**
 * What can happen in one moment, in the order it happens in; the types of one
 * line share a place. A type that is not here comes after these.
 */
const ORDER: string[][] = [
  ["task.opened"],
  // Given and taken back share a place: which comes first is told by `givingFirst`.
  ["task.assigned", "task.unassigned"],
  ["change.opened"],
  ["change.updated"],
  // What a head holds is told with the head, before what is done to it.
  ["config.changed"],
  // What the tests of a head name is told with the head, before its checks.
  ["trace.read"],
  // A commit has one of the two.
  ["checks.passed", "checks.failed"],
  ["change.commented"],
  // The reviews of one moment come by the host's own ids, whatever their outcome: the host numbered them as they came.
  ["review.commented", "review.changes_requested", "review.approved"],
  // A review is dismissed after it was handed in.
  ["review.dismissed"],
  ["change.merged"],
  ["change.closed"],
  // Opened again after it was closed.
  ["change.reopened"],
  ["task.closed"],
  ["task.reopened"],
];

function place(type: string): number {
  const at = ORDER.findIndex((types) => types.includes(type));
  return at < 0 ? ORDER.length : at;
}

/** The instant a time means, so that `…:10Z`, `…:10.000Z` and `…:10+00:00` are one; a text that is no time is compared as text. */
function instants(a: string, b: string): number {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a.localeCompare(b) : x - y;
}

/** Ids as text, with a number in them read as a number: `review:9` before `review:10`. */
function byId(a: string, b: string): number {
  const parts = (s: string) => s.match(/\d+|\D+/g) ?? [];
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i]!;
    const q = y[i]!;
    if (p === q) continue;
    const numbers = /^\d+$/.test(p) && /^\d+$/.test(q);
    // Numbers of the same value and another writing (`07`, `7`) fall to the text, so no two ids are equal.
    const d = numbers ? Number(p) - Number(q) || p.localeCompare(q) : p < q ? -1 : 1;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** `<start>:assigned:<host id>` or `…:unassigned:<host id>`: the thing a giving or a taking back is of, and the host's own id of it. */
function giving(e: { type: string; id: string }): { of: string; host: string } | null {
  const found = /^(.*):(?:un)?assigned:([^:]+)$/.exec(e.id);
  return (e.type === "task.assigned" || e.type === "task.unassigned") && found ? { of: found[1]!, host: found[2]! } : null;
}

/**
 * Of a giving and a taking back at one moment, which comes first (#45). The host's own order when it has one: its ids
 * are numbers and it numbered them as they happened (GitHub). Without one, the taking back first: it can only take
 * back what was given before, and a task taken back and given again in one second must end with the one who holds it.
 */
function givingFirst(a: { type: string; id: string }, b: { type: string; id: string }): number {
  if (a.type === b.type) return 0;
  const x = giving(a);
  const y = giving(b);
  if (x === null || y === null || x.of !== y.of) return 0;
  if (/^\d+$/.test(x.host) && /^\d+$/.test(y.host)) return Number(x.host) - Number(y.host) || 0;
  return a.type === "task.unassigned" ? -1 : 1;
}

/** For `sort`: negative when `a` is written before `b`. */
export function happensBefore(a: { time: string; type: string; id: string }, b: { time: string; type: string; id: string }): number {
  return instants(a.time, b.time) || place(a.type) - place(b.type) || givingFirst(a, b) || byId(a.id, b.id);
}
