// The present time of a reader: HOWL_NOW when it is set, else the clock (#137).
// The one place a reader takes "now" from, so that the two versions of howl agree when compared.
// @code_class reading
use std::time::{SystemTime, UNIX_EPOCH};

/// What HOWL_NOW must be.
const GIVE: &str = "give an ISO time with Z or an offset, as 2026-11-23T10:00:00Z";

/// Now, for a reader: HOWL_NOW when it is set and not empty, else the clock.
/// A HOWL_NOW that is not a time is refused.
pub fn present_time() -> Result<i64, String> {
    let value = std::env::var("HOWL_NOW").ok();
    present_time_of(value.as_deref())
}

/// As `present_time`, with the value of HOWL_NOW given.
pub fn present_time_of(howl_now: Option<&str>) -> Result<i64, String> {
    let text = match howl_now {
        None | Some("") => return Ok(clock()),
        Some(text) => text,
    };
    match parse_now(text) {
        Some(time) => Ok(time),
        None => Err(format!("HOWL_NOW {text}: {GIVE}")),
    }
}

/// The clock, in milliseconds since 1970.
fn clock() -> i64 {
    let since = SystemTime::now().duration_since(UNIX_EPOCH);
    since.map_or(0, |d| d.as_millis() as i64)
}

/// An ISO time in UTC or with an offset, as milliseconds since 1970; None for anything else.
/// Digits past the millisecond are cut. The same rules as `parseNow` in src/read/now.ts.
pub fn parse_now(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    let marks = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':')];
    if marks.iter().any(|&(i, c)| b.get(i) != Some(&c)) {
        return None;
    }
    let year = number(b, 0, 4)?;
    let month = number(b, 5, 2)?;
    let day = number(b, 8, 2)?;
    let hour = number(b, 11, 2)?;
    let minute = number(b, 14, 2)?;
    let mut second = 0;
    let mut ms = 0;
    let mut i = 16;
    if b.get(i) == Some(&b':') {
        second = number(b, i + 1, 2)?;
        i += 3;
        if b.get(i) == Some(&b'.') {
            let rest = &b[i + 1..];
            let len = rest.iter().take_while(|c| c.is_ascii_digit()).count();
            if len == 0 {
                return None;
            }
            let kept = len.min(3);
            ms = number(b, i + 1, kept)? * 10_i64.pow(3 - kept as u32);
            i += 1 + len;
        }
    }
    let offset = match b.get(i..)? {
        b"Z" => 0,
        [sign @ (b'+' | b'-'), _, _, b':', _, _] => {
            let hours = number(b, i + 1, 2)?;
            let minutes = number(b, i + 4, 2)?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            let sign = if *sign == b'-' { -1 } else { 1 };
            sign * (hours * 60 + minutes) * 60_000
        }
        _ => return None,
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let february = if leap { 29 } else { 28 };
    let days = [31, february, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1..=12).contains(&month) || day < 1 || day > days[month as usize - 1] {
        return None;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let time = ((hour * 60 + minute) * 60 + second) * 1000 + ms;
    let date = days_from_civil(year, month, day) * 86_400_000;
    Some(date + time - offset)
}

/// The `len` digits of `text` from `at`, as a number; None if one is not a digit.
fn number(text: &[u8], at: usize, len: usize) -> Option<i64> {
    let part = text.get(at..at + len)?;
    if !part.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(part.iter().fold(0, |n, d| n * 10 + i64::from(d - b'0')))
}

/// Days from 1970-01-01 to a date of the proleptic Gregorian calendar.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_iso_time_in_utc_or_with_an_offset() {
        let t = 1_767_254_400_000;
        let cases = [
            ("1970-01-01T00:00:00Z", 0),
            ("2026-01-01T08:00:00Z", t),
            ("2026-01-01T08:00Z", t),
            ("2026-01-01T08:00:00.123Z", t + 123),
            ("2026-01-01T08:00:00.1239Z", t + 123),
            ("2026-01-01T08:00:00.5Z", t + 500),
            ("2026-01-01T09:30:00+01:30", t),
            ("2026-01-01T06:00:00-02:00", t),
            ("2024-02-29T00:00:00Z", 1_709_164_800_000),
        ];
        for (text, time) in cases {
            assert_eq!(parse_now(text), Some(time), "{text}");
        }
    }

    #[test]
    fn anything_else_is_not_taken() {
        let cases = [
            "",
            "yesterday",
            "2026-01-01",
            "2026-01-01T10:00:00",
            "2026-02-30T00:00:00Z",
            "2025-02-29T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-00-01T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T10:60:00Z",
            "2026-01-01T10:00:60Z",
            "2026-01-01T10:00:00.Z",
            "2026-01-01T10:00:00+0100",
            "2026-01-01T10:00:00+24:00",
            "2026-01-01 10:00:00Z",
            "+2026-01-01T10:00:00Z",
            "2026-01-01T10:00:00Zx",
        ];
        for text in cases {
            assert_eq!(parse_now(text), None, "{text}");
        }
    }

    #[test]
    fn the_present_time_is_howl_now_when_it_is_set() {
        let set = present_time_of(Some("2026-01-01T08:00:00Z"));
        assert_eq!(set, Ok(1_767_254_400_000));
        let refused = present_time_of(Some("yesterday"));
        assert_eq!(refused, Err(format!("HOWL_NOW yesterday: {GIVE}")));
        let before = clock();
        let now = present_time_of(None).unwrap();
        assert!(now >= before && now - before < 60_000);
        assert!(present_time_of(Some("")).unwrap() >= before);
    }
}
