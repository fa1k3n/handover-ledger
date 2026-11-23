// The fixed form of an event: the JSON Canonicalization Scheme, RFC 8785, the twin of `src/ledger/fixed.ts` (#139).
// The same event gives the same bytes, and the same hash, wherever it is written, by either version of howl.
//
// Keys are sorted by their UTF-16 code units, as JavaScript's default sort compares them. Numbers are written as
// ECMAScript writes them (Number::toString), and strings with the escapes of JSON.stringify, as RFC 8785 prescribes.
// Only `fixed_form` and `event_hash` make it.
// @code_class evidence
use crate::ledger::line::hex;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;

/// Without arbitrary precision, serde_json holds every number as something an f64 can be had from.
const DOUBLE: &str = "a JSON number without arbitrary precision is a double";

/// The fixed form of a JSON value, in UTF-8.
///
/// A value read by `parse_json` always has one: no number is infinite or NaN, and no string holds a lone surrogate.
pub fn fixed_form(value: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    write(value, &mut out);
    out
}

/// The SHA-256, in lowercase hex, of the fixed form of an event.
pub fn event_hash(event: &Value) -> String {
    hex(&Sha256::digest(fixed_form(event)))
}

fn write(value: &Value, out: &mut Vec<u8>) {
    match value {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(true) => out.extend_from_slice(b"true"),
        Value::Bool(false) => out.extend_from_slice(b"false"),
        Value::Number(n) => {
            let double = n.as_f64().expect(DOUBLE);
            // A serde_json number is finite; minus zero is written as 0.
            let mut buffer = ryu_js::Buffer::new();
            out.extend_from_slice(buffer.format_finite(double).as_bytes());
        }
        Value::String(s) => string(s, out),
        Value::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write(item, out);
            }
            out.push(b']');
        }
        Value::Object(members) => object(members, out),
    }
}

fn object(members: &Map<String, Value>, out: &mut Vec<u8>) {
    let mut keys: Vec<&String> = members.keys().collect();
    keys.sort_by(|a, b| utf16_order(a, b));
    out.push(b'{');
    for (i, key) in keys.into_iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        string(key, out);
        out.push(b':');
        write(&members[key.as_str()], out);
    }
    out.push(b'}');
}

/// The order of two strings by their UTF-16 code units, not by bytes or characters:
/// a character above U+FFFF (a surrogate pair, D800–DBFF first) sorts before one in E000–FFFF.
fn utf16_order(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// A string as JSON.stringify writes it: `\b \f \n \r \t \" \\`, other characters below U+0020 as `\u00xx` in
/// lowercase hex, nothing else escaped.
fn string(s: &str, out: &mut Vec<u8>) {
    out.push(b'"');
    let mut buf = [0u8; 4];
    for c in s.chars() {
        match c {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\u{08}' => out.extend_from_slice(b"\\b"),
            '\u{0c}' => out.extend_from_slice(b"\\f"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\r' => out.extend_from_slice(b"\\r"),
            '\t' => out.extend_from_slice(b"\\t"),
            c if (c as u32) < 0x20 => {
                let escaped = format!("\\u{:04x}", c as u32);
                out.extend_from_slice(escaped.as_bytes());
            }
            c => out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes()),
        }
    }
    out.push(b'"');
}
