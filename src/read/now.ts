// The present time of a reader: HOWL_NOW when it is set, else the clock (#137).
// The one place a reader takes "now" from, so that the two versions of howl agree when compared.
// @code_class reading
import { LedgerError } from "../ledger/errors.ts";

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** An ISO time in UTC or with an offset, as milliseconds since 1970; null for anything else. Digits past the millisecond are cut. */
export function parseNow(text: string): number | null {
  const m = ISO.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, "0"));
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || hour > 23 || minute > 59 || second > 59) return null;
  let offset = 0;
  if (m[8] !== undefined) {
    const [oh, om] = [Number(m[9]), Number(m[10])];
    if (oh > 23 || om > 59) return null;
    offset = (m[8] === "-" ? -1 : 1) * (oh * 60 + om) * 60_000;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  return date.getTime() - offset;
}

/** Now, for a reader: HOWL_NOW when it is set and not empty, else the clock. A HOWL_NOW that is not a time is refused. */
export function presentTime(env: NodeJS.ProcessEnv = process.env): number {
  const text = env.HOWL_NOW;
  if (text === undefined || text === "") return Date.now();
  const time = parseNow(text);
  if (time === null) throw new LedgerError(`HOWL_NOW ${text}: give an ISO time with Z or an offset, as 2026-11-23T10:00:00Z`);
  return time;
}
