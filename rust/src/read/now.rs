// The present time of a reader: HOWL_NOW when it is set, else the clock (#137).
// The one place a reader takes "now" from, so that the two versions of howl agree when compared.
// @code_class reading
use std::ffi::OsString;
use std::time::{SystemTime, UNIX_EPOCH};

/// What HOWL_NOW must be.
const GIVE: &str = "give an ISO time with Z or an offset, as 2026-11-23T10:00:00Z";

/// Now, for a reader: HOWL_NOW when it is set and not empty, else the clock.
/// A HOWL_NOW that is not a time is refused.
pub fn present_time() -> Result<i64, String> {
    present_time_from(std::env::var_os("HOWL_NOW"))
}

/// As `present_time`, with HOWL_NOW as the environment holds it.
/// A value that is not UTF-8 is refused, as any other that is not a time.
pub fn present_time_from(howl_now: Option<OsString>) -> Result<i64, String> {
    let Some(value) = howl_now else {
        return present_time_of(None);
    };
    match value.to_str() {
        Some(text) => present_time_of(Some(text)),
        None => {
            let shown = value.to_string_lossy();
            Err(format!("HOWL_NOW {shown}: {GIVE}"))
        }
    }
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

    /// The values both versions are tested with, as src/read/now.ts is.
    const CASES: &str = include_str!("../../../test/fixtures/howl-now.tsv");

    #[test]
    fn the_values_of_the_shared_fixture_are_taken_or_refused() {
        let lines = CASES.lines().filter(|l| !l.is_empty());
        let cases: Vec<&str> = lines.filter(|l| !l.starts_with('#')).collect();
        assert!(cases.len() > 20);
        for line in cases {
            let (text, want) = line.split_once('\t').unwrap();
            assert_eq!(parse_now(text), want.parse().ok(), "{text}");
        }
        assert_eq!(parse_now(""), None);
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

    #[test]
    fn a_howl_now_that_is_not_utf_8_is_refused() {
        use std::os::unix::ffi::OsStringExt;
        let value = OsString::from_vec(vec![b'2', 0xff]);
        let refused = present_time_from(Some(value));
        assert_eq!(refused, Err(format!("HOWL_NOW 2\u{fffd}: {GIVE}")));
        let set = OsString::from("2026-01-01T08:00:00Z");
        assert_eq!(present_time_from(Some(set)), Ok(1_767_254_400_000));
        assert!(present_time_from(None).is_ok());
    }
}
