// Values read as the TypeScript reads them in `checkSignatures` (#140): strict equality, truthiness, String(), a Map's
// keys, base64 as Node decodes it, and Date.parse of the ISO forms.
// @code_class evidence
use serde_json::Value;

/// JavaScript's `===` on two values that may be undefined (None). Objects and arrays are never the same here: each
/// comes from a line of its own, and JavaScript compares them by reference.
pub fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::Object(_) | Value::Array(_)), _) | (_, Some(Value::Object(_) | Value::Array(_))) => false,
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// Whether a value is truthy in JavaScript.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// A value as JavaScript's String() writes it, as in a template: `undefined`, `null`, a number as ECMAScript writes it,
/// an array joined by commas (null inside as nothing), an object as `[object Object]`.
pub fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => {
            let mut buffer = ryu_js::Buffer::new();
            buffer.format_finite(n.as_f64().unwrap_or_default()).to_string()
        }
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(Some(item)) })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// A key of a JavaScript Map, as SameValueZero tells keys apart. An object or an array is no key: no lookup finds it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Key {
    Null,
    Bool(bool),
    /// The bits of the number, with -0 as 0.
    Number(u64),
    String(String),
}

impl Key {
    pub fn of(value: Option<&Value>) -> Option<Key> {
        Some(match value? {
            Value::Null => Key::Null,
            Value::Bool(b) => Key::Bool(*b),
            Value::Number(n) => {
                let n = n.as_f64()?;
                Key::Number(if n == 0.0 { 0 } else { n.to_bits() })
            }
            Value::String(s) => Key::String(s.clone()),
            Value::Array(_) | Value::Object(_) => return None,
        })
    }
}

/// Base64 as Node's Buffer.from decodes it: both alphabets, any other character passed over, an end at the first `=`.
/// Bits left over that make no whole byte are dropped.
pub fn base64_decode(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut bits: u32 = 0;
    let mut count = 0;
    for b in text.bytes() {
        let six = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(six);
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    out
}

/// Date.parse of the ISO forms, as V8 reads them: `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (or a signed year of six digits),
/// then optionally `THH:mm`, `:ss` and a fraction of any length (its first three digits count), then `Z` or `±HH:mm`.
/// A date alone is UTC. A day up to 31 is rolled into the next month, and `24:00` is the end of the day. A date and
/// time without a zone is local time in V8, and its other forms are V8's own: here they are no time (None).
pub fn date_parse(text: &str) -> Option<f64> {
    let b = text.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize, len: usize| -> Option<i64> {
        let part = b.get(*i..*i + len)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        *i += len;
        Some(part.iter().fold(0, |n, d| n * 10 + i64::from(d - b'0')))
    };
    let year = match b.first()? {
        sign @ (b'+' | b'-') => {
            i = 1;
            let y = digits(&mut i, 6)?;
            if *sign == b'-' && y == 0 {
                return None;
            }
            if *sign == b'-' {
                -y
            } else {
                y
            }
        }
        _ => digits(&mut i, 4)?,
    };
    let (mut month, mut day) = (1, 1);
    if b.get(i) == Some(&b'-') {
        i += 1;
        month = digits(&mut i, 2)?;
        if b.get(i) == Some(&b'-') {
            i += 1;
            day = digits(&mut i, 2)?;
        }
    }
    let (mut hour, mut minute, mut second, mut ms) = (0, 0, 0, 0);
    let mut offset = 0;
    if b.get(i) == Some(&b'T') {
        i += 1;
        hour = digits(&mut i, 2)?;
        if b.get(i) != Some(&b':') {
            return None;
        }
        i += 1;
        minute = digits(&mut i, 2)?;
        if b.get(i) == Some(&b':') {
            i += 1;
            second = digits(&mut i, 2)?;
            if b.get(i) == Some(&b'.') {
                i += 1;
                let len = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
                if len == 0 {
                    return None;
                }
                let kept = len.min(3);
                ms = digits(&mut i, kept)? * 10_i64.pow(3 - kept as u32);
                i += len - kept;
            }
        }
        match b.get(i) {
            Some(b'Z') => i += 1,
            Some(&sign @ (b'+' | b'-')) => {
                i += 1;
                let hours = digits(&mut i, 2)?;
                if b.get(i) != Some(&b':') {
                    return None;
                }
                i += 1;
                let minutes = digits(&mut i, 2)?;
                if hours > 23 || minutes > 59 {
                    return None;
                }
                offset = (hours * 60 + minutes) * 60_000 * if sign == b'-' { -1 } else { 1 };
            }
            // Local time: V8 needs the zone, which howl does not read here.
            _ => return None,
        }
    }
    if i != b.len() {
        return None;
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let end_of_day = hour == 24 && minute == 0 && second == 0 && ms == 0;
    if (hour > 23 && !end_of_day) || minute > 59 || second > 59 {
        return None;
    }
    let days = days_from_civil(year, month, 1) + day - 1;
    let time = days * 86_400_000 + ((hour * 60 + minute) * 60 + second) * 1000 + ms - offset;
    if time.abs() > 8_640_000_000_000_000 {
        return None;
    }
    Some(time as f64)
}

/// Days from 1970-01-01 to the first of a month of the proleptic Gregorian calendar.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
