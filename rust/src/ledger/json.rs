// The one way howl reads JSON it did not write, as `src/ledger/json.ts`: a line of a ledger, a file of the inbox, the body of a request (#139).
// @code_class evidence
use serde::Deserialize;
use serde_json::{Number, Value};
use std::fmt;

/// The deepest nesting of arrays and objects that is read. The same in both versions of howl.
pub const MAX_DEPTH: usize = 128;

/// Why a text was not read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonError {
    /// It is not JSON.
    NotJson,
    /// Arrays and objects inside each other more than `MAX_DEPTH` deep.
    TooDeep,
    /// A `\u` escape of half a surrogate pair stands alone: JSON.parse reads it, but no fixed form can hold it.
    LoneSurrogate,
}

impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JsonError::NotJson => f.write_str("not JSON"),
            JsonError::TooDeep => {
                write!(f, "not JSON: nested more than {MAX_DEPTH} deep")
            }
            JsonError::LoneSurrogate => {
                f.write_str("a string with a lone surrogate has no fixed form")
            }
        }
    }
}

impl std::error::Error for JsonError {}

/// Reads JSON as JSON.parse does: every number an f64, the last value of a key given twice.
///
/// First counts how deep it is nested without reading it, as the TypeScript does: brackets inside a string do not count.
/// A text JSON.parse would read but whose strings hold a lone surrogate is refused with the words of the fixed form;
/// a text JSON.parse would not read is `not JSON`, a lone surrogate in it or not.
pub fn parse_json(text: &str) -> Result<Value, JsonError> {
    let lone = scan(text.as_bytes())?;
    if lone.is_empty() {
        return read(text);
    }
    // Read it again with U+FFFD in place of each lone half, to learn whether JSON.parse would have read it.
    let mut patched = text.as_bytes().to_vec();
    for at in lone {
        patched[at..at + 4].copy_from_slice(b"fffd");
    }
    let patched = String::from_utf8(patched).expect("only hex digits were replaced");
    read(&patched)?;
    Err(JsonError::LoneSurrogate)
}

/// The nesting check, and where the hex digits of each lone surrogate escape start.
fn scan(bytes: &[u8]) -> Result<Vec<usize>, JsonError> {
    // Signed, as in the TypeScript: a closing bracket too many lets as many more opening ones in.
    let mut depth: i64 = 0;
    let mut in_string = false;
    let mut lone = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            if c == b'\\' {
                if let Some(unit) = escape(bytes, i) {
                    if (0xd800..0xdc00).contains(&unit) {
                        match escape(bytes, i + 6) {
                            Some(low) if (0xdc00..0xe000).contains(&low) => i += 6,
                            _ => lone.push(i + 2),
                        }
                    } else if (0xdc00..0xe000).contains(&unit) {
                        lone.push(i + 2);
                    }
                    i += 5;
                } else {
                    i += 1;
                }
            } else if c == b'"' {
                in_string = false;
            }
        } else if c == b'"' {
            in_string = true;
        } else if c == b'[' || c == b'{' {
            depth += 1;
            if depth > MAX_DEPTH as i64 {
                return Err(JsonError::TooDeep);
            }
        } else if c == b']' || c == b'}' {
            depth -= 1;
        }
        i += 1;
    }
    Ok(lone)
}

/// The code unit of a `\uXXXX` escape at `at`, when there is one.
fn escape(bytes: &[u8], at: usize) -> Option<u32> {
    let digits = bytes.get(at..at + 6)?;
    if digits[0] != b'\\' || digits[1] != b'u' {
        return None;
    }
    let hex = std::str::from_utf8(&digits[2..]).ok()?;
    if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(hex, 16).ok()
}

/// serde_json, with its own limit of depth lifted: `scan` has bounded it already, at one more than serde_json's own.
fn read(text: &str) -> Result<Value, JsonError> {
    let mut de = serde_json::Deserializer::from_str(text);
    de.disable_recursion_limit();
    let not_json = |_| JsonError::NotJson;
    let mut value = Value::deserialize(&mut de).map_err(not_json)?;
    de.end().map_err(not_json)?;
    as_doubles(&mut value);
    Ok(value)
}

/// Every number an f64, as JSON.parse makes it: an integer above 2^53 is rounded to the nearest double.
fn as_doubles(value: &mut Value) {
    match value {
        Value::Number(n) if !n.is_f64() => {
            let double = n.as_f64().expect("without arbitrary precision, a double");
            *n = Number::from_f64(double).expect("an integer is finite");
        }
        Value::Array(items) => items.iter_mut().for_each(as_doubles),
        Value::Object(members) => members.values_mut().for_each(as_doubles),
        _ => {}
    }
}
