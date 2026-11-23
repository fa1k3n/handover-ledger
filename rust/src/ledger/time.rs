// A time that is a real time: the twin of `isRealTime` in src/ledger/time.ts (#138, #140).
// @code_class evidence

/// Whether the time of an event that fits the schema's pattern is a real time: a day on the calendar, hour 00 to 23,
/// minute and second 00 to 59. A text that does not fit the pattern is not told apart here: the schema says that.
pub fn is_real_time(text: &str) -> bool {
    let Some([year, month, day, hour, minute, second]) = event_time(text) else {
        return true;
    };
    is_day(year, month, day) && hour <= 23 && minute <= 59 && second <= 59
}

/// The parts of `YYYY-MM-DDTHH:MM:SS(.f{1,9})?Z`, the pattern of the event's time; None if it does not fit.
fn event_time(text: &str) -> Option<[u32; 6]> {
    let b = text.as_bytes();
    let marks = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')];
    if b.len() < 20 || marks.iter().any(|&(i, c)| b[i] != c) {
        return None;
    }
    let fits = match &b[19..] {
        [b'Z'] => true,
        [b'.', digits @ .., b'Z'] => {
            (1..=9).contains(&digits.len()) && digits.iter().all(u8::is_ascii_digit)
        }
        _ => false,
    };
    if !fits {
        return None;
    }
    let number = |at: usize, len: usize| -> Option<u32> {
        let part = &b[at..at + len];
        part.iter()
            .all(u8::is_ascii_digit)
            .then(|| part.iter().fold(0, |n, d| n * 10 + u32::from(d - b'0')))
    };
    Some([
        number(0, 4)?,
        number(5, 2)?,
        number(8, 2)?,
        number(11, 2)?,
        number(14, 2)?,
        number(17, 2)?,
    ])
}

/// Whether the day is on the calendar: no 30 February, no 29 February but in a leap year, no month 13.
pub(crate) fn is_day(year: u32, month: u32, day: u32) -> bool {
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    (1..=12).contains(&month) && day >= 1 && day <= days[month as usize - 1]
}
