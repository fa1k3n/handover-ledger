// The fixed form of an event (JCS, RFC 8785), the hash of an event and of a line, and JSON read as JSON.parse reads it (#139).
// @code_class tests
use howl::ledger::fixed::{event_hash, fixed_form};
use howl::ledger::json::parse_json;
use howl::ledger::line::hash_line;
use serde_json::Value;

/// A file of `test/fixtures/`, the vectors both versions of howl read.
fn fixture(name: &str) -> String {
    let path = format!("{}/../test/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// The fixed form of JSON text, as text.
fn text(json: &str) -> String {
    let value = parse_json(json).unwrap_or_else(|e| panic!("{json}: {e}"));
    String::from_utf8(fixed_form(&value)).expect("the fixed form is UTF-8")
}

/// The message with which JSON text is refused.
fn refused(json: &str) -> String {
    match parse_json(json) {
        Ok(value) => panic!("{json} was read as {value}"),
        Err(e) => e.to_string(),
    }
}

#[test]
fn numbers_strings_and_literals_the_example_of_rfc_8785() {
    assert_eq!(text(&fixture("rfc8785-values.json")), fixture("rfc8785-values.fixed"));
}

#[test]
fn keys_are_sorted_by_utf16_code_units_the_sorting_example_of_rfc_8785() {
    let written = text(&fixture("rfc8785-sorting.json"));
    // The values in the order the keys were written. An emoji (D83D DE00) comes
    // before FB33, which it would not if keys were sorted by code point or by byte.
    let value: Value = serde_json::from_str(&written).unwrap();
    let order: Vec<&str> = value.as_object().unwrap().values().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(
        order,
        [
            "Carriage Return",
            "One",
            "Control",
            "Latin Small Letter O With Diaeresis",
            "Euro Sign",
            "Emoji: Grinning Face",
            "Hebrew Letter Dalet With Dagesh",
        ]
    );
}

#[test]
fn numbers_above_2_53_and_at_the_edges_of_the_notation_the_fixture_both_versions_read() {
    assert_eq!(text(&fixture("fixed-numbers.json")), fixture("fixed-numbers.fixed"));
}

#[test]
fn every_line_of_an_observed_ledger_is_its_own_fixed_form() {
    let lines = fixture("observe-before-lasting-ids.jsonl");
    let mut count = 0;
    for line in lines.lines() {
        assert_eq!(text(line), line);
        count += 1;
    }
    assert!(count > 0);
}

#[test]
fn minus_zero_is_written_as_0() {
    assert_eq!(text(r#"{"n":-0}"#), r#"{"n":0}"#);
    assert_eq!(text(r#"[-0.0,-0e5]"#), "[0,0]");
}

#[test]
fn keys_that_look_like_numbers_are_sorted_as_text() {
    assert_eq!(text(r#"{"2":0,"10":0,"a":0,"1":0}"#), r#"{"1":0,"10":0,"2":0,"a":0}"#);
}

#[test]
fn keys_are_sorted_at_every_depth_with_no_white_space() {
    assert_eq!(
        text(r#"{ "b": [ { "d": 1, "c": 2 } ], "a": { "f": null, "e": "x" } }"#),
        r#"{"a":{"e":"x","f":null},"b":[{"c":2,"d":1}]}"#
    );
}

#[test]
fn a_key_given_twice_keeps_its_last_value_as_json_parse_does() {
    assert_eq!(text(r#"{"a":1,"b":2,"a":3}"#), r#"{"a":3,"b":2}"#);
}

#[test]
fn the_fixed_form_is_utf8() {
    let value = parse_json(r#""ö""#).unwrap();
    assert_eq!(fixed_form(&value), [0x22, 0xc3, 0xb6, 0x22]);
}

#[test]
fn strings_have_the_escapes_of_json_stringify_and_no_others() {
    for c in 0u32..0x20 {
        let json = format!(r#""\u{c:04x}""#);
        let expected = match c {
            0x08 => r#""\b""#.to_string(),
            0x09 => r#""\t""#.to_string(),
            0x0a => r#""\n""#.to_string(),
            0x0c => r#""\f""#.to_string(),
            0x0d => r#""\r""#.to_string(),
            _ => format!(r#""\u{c:04x}""#),
        };
        assert_eq!(text(&json), expected, "U+{c:04X}");
    }
    assert_eq!(text(r#""\u000A\u001F""#), r#""\n\u001f""#);
    assert_eq!(text(r#""\"\\\/""#), r#""\"\\/""#);
    // DEL, a character past Latin-1, the line separators and an emoji stand as they are.
    assert_eq!(text(r#""\u007fé  😀""#), "\"\u{7f}é\u{2028}\u{2029}😀\"");
}

#[test]
fn a_string_with_a_lone_surrogate_is_refused() {
    const WORDS: &str = "a string with a lone surrogate has no fixed form";
    for json in [
        r#"{"s":"\ud800"}"#,
        r#"{"s":"\udc00"}"#,
        r#"{"\udc00":1}"#,
        r#"["\ude00\ud83d"]"#,
        r#"["\ud800x"]"#,
        r#"["\uD800A"]"#,
        r#"["\ud800\ud800"]"#,
    ] {
        assert!(refused(json).contains(WORDS), "{json}: {}", refused(json));
    }
    // A pair is one character.
    assert_eq!(text(r#"["😀"]"#), "[\"😀\"]");
    // A text that is not JSON is not JSON, a lone surrogate in it or not, as JSON.parse says first.
    assert_eq!(refused(r#"{"s":"\ud800""#), "not JSON");
}

#[test]
fn json_nested_128_deep_is_read_and_129_deep_refused() {
    let nested = |depth: usize| format!("{}{}", "[".repeat(depth), "]".repeat(depth));
    assert!(parse_json(&nested(128)).is_ok());
    assert_eq!(refused(&nested(129)), "not JSON: nested more than 128 deep");
    let objects = |depth: usize| format!("{}1{}", r#"{"a":"#.repeat(depth), "}".repeat(depth));
    assert!(parse_json(&objects(128)).is_ok());
    assert_eq!(refused(&objects(129)), "not JSON: nested more than 128 deep");
    // Brackets inside a string do not count, an escaped quote does not end it.
    let in_string = format!(r#"["\"{}"]"#, "[".repeat(200));
    assert!(parse_json(&in_string).is_ok());
}

#[test]
fn what_is_not_json_is_refused() {
    for json in ["", " ", "{", "[1,]", "{\"a\":1}x", "'a'", "NaN", "\u{feff}{}", "01"] {
        assert_eq!(refused(json), "not JSON", "{json:?}");
    }
}

#[test]
fn a_number_too_large_for_a_double_is_refused_at_parse_time() {
    // JSON.parse gives Infinity, which the TypeScript fixed form refuses; here no non-finite number is ever read.
    assert_eq!(refused("1e400"), "not JSON");
    assert_eq!(refused("[-1e400]"), "not JSON");
}

#[test]
fn the_hash_of_an_event_and_of_a_line_agree_with_a_ledger_the_typescript_wrote() {
    let ledger = fixture("ledger-before-harness.jsonl");
    let mut prev: Option<String> = None;
    let mut count = 0;
    for line in ledger.lines() {
        let read = parse_json(line).unwrap();
        assert_eq!(read["prev"].as_str().map(str::to_string), prev, "the prev of line {}", count + 1);
        assert_eq!(read["hash"].as_str().unwrap(), event_hash(&read["event"]), "the hash of line {}", count + 1);
        prev = Some(hash_line(line.as_bytes()));
        count += 1;
    }
    assert!(count > 1);
}

#[test]
fn the_hash_of_an_event_is_the_sha256_of_its_fixed_form_in_lowercase_hex() {
    let value = parse_json(r#"{"b":1,"a":"x"}"#).unwrap();
    // sha256 of {"a":"x","b":1}
    assert_eq!(event_hash(&value), hash_line(br#"{"a":"x","b":1}"#));
    assert_eq!(hash_line(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
}
