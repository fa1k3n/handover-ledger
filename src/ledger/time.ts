// A time that is a real time, and the forms a person may write one in. No Node, so the page can use it.
// @code_class evidence

/** The time of an event, as the schema's pattern has it. */
const EVENT_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

/** A date a person writes: `2026-01-01`, then optionally a space or `T`, `HH:MM`, optionally `:SS` and a fraction, optionally `Z`. */
const NAMED = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z)?)?$/;

const isLeap = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

/** Whether the day is on the calendar: no 30 February, no 29 February but in a leap year, no month 13. */
export function isDay(year: number, month: number, day: number): boolean {
  const days = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

/**
 * Whether the time of an event that fits the schema's pattern is a real time: a day on the calendar, hour 00 to 23,
 * minute and second 00 to 59. `Date.parse` rolls `2026-02-30` into March and reads no `24:00:00`: neither is a time.
 * A text that does not fit the pattern is not told apart here: the schema says that.
 */
export function isRealTime(text: string): boolean {
  const m = EVENT_TIME.exec(text);
  if (m === null) return true;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  return isDay(year, month, day) && hour <= 23 && minute <= 59 && second <= 59;
}

/** What a refusal says the forms are. */
export const WHEN_FORMS = "give a date (2026-11-01), a date and a time (2026-11-01 09:55 or 2026-11-01T09:55:30, local time) or the same ending in Z (UTC)";

export interface WhenOptions {
  /** What a date alone means: midnight in the local zone or in UTC. Each command says which it has always meant. */
  date: "local" | "utc";
  /** The time `now` means, for a command that takes the word; without it `now` is no time. */
  now?: number;
}

/**
 * The time a person wrote, in milliseconds since 1970; NaN for anything but the named forms. The forms: `YYYY-MM-DD`;
 * a date with `T` or a space and `HH:MM` or `HH:MM:SS` (a fraction of a second may follow), in local time; the same
 * ending in `Z`, in UTC; and `now` where the command takes it. The day and the time must be real. A local time that
 * does not exist, in the hour the clocks go forward, is no time; one that occurs twice takes the earlier.
 */
export function parseWhen(text: string, options: WhenOptions): number {
  if (text === "now") return options.now ?? Number.NaN;
  const m = NAMED.exec(text);
  if (m === null) return Number.NaN;
  const [year, month, day] = m.slice(1, 4).map(Number) as [number, number, number];
  const [hour, minute, second] = [m[4], m[5], m[6]].map((x) => (x === undefined ? 0 : Number(x))) as [number, number, number];
  const ms = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, "0"));
  if (!isDay(year, month, day) || hour > 23 || minute > 59 || second > 59) return Number.NaN;
  const utc = m[8] !== undefined || (m[4] === undefined && options.date === "utc");
  // `Date.UTC` and the constructor read the years 0 to 99 as 1900 to 1999: the year is set on its own.
  const at = new Date(0);
  if (utc) {
    at.setUTCFullYear(year, month - 1, day);
    at.setUTCHours(hour, minute, second, ms);
  } else {
    at.setFullYear(year, month - 1, day);
    at.setHours(hour, minute, second, ms);
    // A local time in the hour the clocks go forward does not exist: it is not moved to the hour after, it is no time.
    // One that occurs twice, as the clocks go back, is the earlier of the two, which is what `setHours` gives.
    if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day || at.getHours() !== hour || at.getMinutes() !== minute) return Number.NaN;
  }
  return at.getTime();
}
