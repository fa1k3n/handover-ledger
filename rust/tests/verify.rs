// The schema check, the check of a ledger and of its signatures, and the place of the ledger (#140).
// The conformance of the whole text of `howl verify` with the TypeScript is test/verify-faults.test.ts.
// @code_class tests
use howl::cli::args::parse_args;
use howl::keys::{base64_decode, check_signatures, date_parse};
use howl::ledger::json::parse_json;
use howl::ledger::pattern::Pattern;
use howl::ledger::place::{ledger_path, Env};
use howl::ledger::schema::{event_faults, line_faults, Schema};
use howl::ledger::time::is_real_time;
use howl::ledger::verify::{verify, Verdict};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const EVENT_SCHEMA: &str = include_str!("../../schema/event.v0.schema.json");
const LINE_SCHEMA: &str = include_str!("../../schema/line.v0.schema.json");

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures").join(name)
}

/// A folder of its own for one test.
fn folder(name: &str) -> PathBuf {
    let name = format!("howl-rust-verify-{}-{name}", std::process::id());
    let dir = std::env::temp_dir().join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn base() -> Value {
    json!({
        "v": 0, "id": "e1", "time": "2026-01-02T03:04:05Z", "type": "task.assigned",
        "source": {"adapter": "test", "kind": "observed"}, "project": "example", "task": "1"
    })
}

fn with(over: Value) -> Value {
    let mut event = base();
    for (k, v) in over.as_object().unwrap() {
        if v.is_null() {
            event.as_object_mut().unwrap().remove(k);
        } else {
            event[k] = v.clone();
        }
    }
    event
}

#[test]
fn both_schemas_compile_and_every_keyword_in_them_is_known() {
    let event: Value = serde_json::from_str(EVENT_SCHEMA).unwrap();
    let line: Value = serde_json::from_str(LINE_SCHEMA).unwrap();
    Schema::compile(&event).unwrap();
    Schema::compile(&line).unwrap();
}

#[test]
fn a_keyword_the_walker_does_not_know_fails_to_compile() {
    for (schema, word) in [
        (json!({"type": "number", "minimum": 1}), "minimum"),
        (json!({"properties": {"a": {"type": "array", "items": true}}}), "items"),
        (json!({"anyOf": [true]}), "anyOf"),
        (json!({"$ref": "https://example.invalid/x"}), "$ref"),
        (json!({"type": "decimal"}), "decimal"),
        (json!({"pattern": "^a.b$"}), "."),
        (json!({"pattern": "\\d"}), "\\d"),
    ] {
        match Schema::compile(&schema) {
            Ok(_) => panic!("{schema} compiled"),
            Err(e) => assert!(e.contains(word), "{schema}: {e}"),
        }
    }
}

#[test]
fn the_patterns_of_the_schema_match_as_javascript_with_the_u_flag() {
    let time = Pattern::new("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$").unwrap();
    assert!(time.is_match("2026-01-02T03:04:05Z"));
    assert!(time.is_match("2026-01-02T03:04:05.123456789Z"));
    assert!(!time.is_match("2026-01-02T03:04:05.1234567890Z"));
    assert!(!time.is_match("2026-01-02T03:04:05.Z"));
    assert!(!time.is_match("2026-01-02T03:04:05Z\n"));
    assert!(!time.is_match("x2026-01-02T03:04:05Z"));
    let sha = Pattern::new("^([0-9a-f]{40}|[0-9a-f]{64})$").unwrap();
    assert!(sha.is_match(&"a".repeat(40)));
    assert!(sha.is_match(&"b".repeat(64)));
    assert!(!sha.is_match(&"a".repeat(41)));
    assert!(!sha.is_match(&"A".repeat(40)));
    let plain = Pattern::new("^[^\\u0000-\\u001f\\u007f]*$").unwrap();
    assert!(plain.is_match(""));
    assert!(plain.is_match("a \u{1F600} \u{fffd} é"));
    assert!(!plain.is_match("a\u{7f}"));
    assert!(!plain.is_match("\u{0}"));
    assert!(!plain.is_match("a\nb"));
    // Without anchors a pattern is looked for anywhere, as RegExp.test does.
    let inside = Pattern::new("b+c?").unwrap();
    assert!(inside.is_match("abbbd"));
    assert!(!inside.is_match("acd"));
    let any = Pattern::new("^(?:ab|a)*x$").unwrap();
    assert!(any.is_match("abaabx"));
}

#[test]
fn an_event_and_a_line_that_hold_have_no_faults() {
    assert!(event_faults(&base()).is_empty());
    let line = json!({"prev": null, "hash": "a".repeat(64), "event": {}});
    assert!(line_faults(&line).is_empty());
}

#[test]
fn the_faults_of_an_event_in_the_order_the_typescript_gives_them() {
    let event = with(json!({
        "colour": "red", "v": 1, "id": "", "type": "ledger.created", "time": "2026-02-30T03:04:05Z",
        "project": null, "source": {"kind": "heard", "q": 1}, "to": {"kind": "team", "id": 3},
        "task": null, "task_from": "env", "sig": {"key": "x", "value": ""}
    }));
    let want = [
        "to: only on task.assigned and task.unassigned",
        "data: missing",
        "project: missing",
        "colour: not a field of an event",
        "v: must be equal to constant",
        "id: must NOT have fewer than 1 characters",
        "source.adapter: missing",
        "source.q: not a field of an event",
        "source.kind: must be one of observed, claimed",
        "to.kind: must be one of person, agent",
        "to.id: must be string",
        "sig.key: must match pattern \"^[0-9a-f]{64}$\"",
        "sig.value: must NOT have fewer than 1 characters",
        "an event: must have property task when property task_from is present",
        "time: not a real time",
    ];
    assert_eq!(event_faults(&event), want);
}

#[test]
fn a_wrong_type_a_union_and_a_fault_said_twice() {
    assert_eq!(event_faults(&json!(5)), ["an event: must be object"]);
    assert_eq!(event_faults(&json!([])), ["an event: must be object"]);
    let created = with(json!({"type": "ledger.created", "data": 5}));
    assert_eq!(event_faults(&created), ["data: must be object"]);
    let to = with(json!({"type": "task.opened", "to": "a"}));
    let want = ["to: only on task.assigned and task.unassigned", "to: must be object"];
    assert_eq!(event_faults(&to), want);
    let line = json!({"prev": 3, "event": [], "q": 1});
    let want = [
        "hash: missing",
        "q: not a field of a line",
        "prev: must be string,null",
        "event: must be object",
    ];
    assert_eq!(line_faults(&line), want);
    assert_eq!(line_faults(&json!("x")), ["a line: must be object"]);
}

#[test]
fn extra_fields_come_in_javascript_s_order_of_keys() {
    let text = r#"{"zz":1,"10":1,"2":1,"b":1,"4294967295":1,"4294967294":1,"01":1}"#;
    let mut event = parse_json(text).unwrap();
    for (k, v) in base().as_object().unwrap() {
        event[k] = v.clone();
    }
    let faults: Vec<String> = event_faults(&event);
    let keys: Vec<&str> = faults.iter().map(|f| f.split(':').next().unwrap()).collect();
    // Array indices (below 2^32 - 1) first, in numeric order; then the rest as they came.
    assert_eq!(keys, ["2", "10", "4294967294", "zz", "b", "4294967295", "01"]);
}

#[test]
fn length_is_counted_in_code_points() {
    let long = with(json!({"harness": {"name": "a", "revision": "\u{1F600}".repeat(256)}}));
    assert!(event_faults(&long).is_empty());
    let longer = with(json!({"harness": {"name": "a", "revision": "\u{1F600}".repeat(257)}}));
    let want = ["harness.revision: must NOT have more than 256 characters"];
    assert_eq!(event_faults(&longer), want);
}

#[test]
fn a_real_time_is_on_the_calendar_and_the_clock() {
    for time in ["2024-02-29T00:00:00Z", "2000-02-29T00:00:00Z", "2026-12-31T23:59:59Z", "0001-01-01T00:00:00Z"] {
        assert!(is_real_time(time), "{time}");
    }
    for time in ["2026-02-29T00:00:00Z", "2100-02-29T00:00:00Z", "2026-04-31T12:00:00Z", "2026-13-01T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T23:59:60.5Z"] {
        assert!(!is_real_time(time), "{time}");
    }
    // A text that does not fit the pattern is the schema's to refuse.
    assert!(is_real_time("yesterday"));
}

#[test]
fn a_ledger_the_typescript_wrote_holds_and_its_signatures_hold() {
    let Verdict::Holds { lines, head, trial, events } = verify(&fixture("ledger-signed.jsonl")).unwrap() else {
        panic!("it does not hold");
    };
    assert_eq!(lines, 5);
    assert_eq!(head, "577e4393e26dfa94efdb71353364501c777f2e44d4785ed611fcbb3f10dd1bd1");
    assert!(trial);
    let numbered: Vec<(usize, &Value)> = events.iter().enumerate().map(|(i, e)| (i + 1, e)).collect();
    let check = check_signatures(&numbered, None);
    assert_eq!((check.signed, check.unsigned), (2, 1));
    assert!(check.faults.is_empty(), "{:?}", check.faults);
    let issuer = "57dee94ab5fa8b0af3b365496f1f491236317de76867398da40ad065cbfa1445";
    assert_eq!(check.issuer.as_deref(), Some(issuer));
    let pinned = check_signatures(&numbered, Some(&"f".repeat(64)));
    let want = vec![
        (2, "key 72e2d85be672: not issued by the ledger's issuer".to_string()),
        (3, "signed by key 72e2d85be672, which has no valid issue on a line before".to_string()),
        (4, "signed by key 72e2d85be672, which has no valid issue on a line before".to_string()),
    ];
    assert_eq!(pinned.faults, want);
}

#[test]
fn a_signed_event_changed_or_out_of_its_key_fails() {
    let Verdict::Holds { events, .. } = verify(&fixture("ledger-signed.jsonl")).unwrap() else {
        panic!("it does not hold");
    };
    let mut events = events;
    events[2]["actor"]["id"] = json!("agent-9");
    events[3]["time"] = json!("2020-01-01T00:00:00Z");
    let numbered: Vec<(usize, &Value)> = events.iter().enumerate().map(|(i, e)| (i + 1, e)).collect();
    let check = check_signatures(&numbered, None);
    let want = vec![
        (3, "the signature does not hold: the event was changed after it was signed".to_string()),
        (4, "the signature does not hold: the event was changed after it was signed".to_string()),
    ];
    assert_eq!(check.faults, want);
}

#[test]
fn a_ledger_that_does_not_hold_names_the_first_line_that_fails() {
    let dir = folder("fails");
    let source = std::fs::read_to_string(fixture("ledger-signed.jsonl")).unwrap();
    let path = dir.join("ledger.jsonl");
    let mut lines: Vec<&str> = source.lines().collect();
    lines.swap(2, 3);
    std::fs::write(&path, lines.join("\n") + "\n").unwrap();
    let Verdict::Fails { lines, line, faults } = verify(&path).unwrap() else {
        panic!("it holds");
    };
    assert_eq!((lines, line), (2, 3));
    assert_eq!(faults, ["prev: is not the hash of line 2: line 2 was changed, or lines were removed or added between the two"]);
    std::fs::write(&path, "").unwrap();
    let Verdict::Fails { lines, line, faults } = verify(&path).unwrap() else {
        panic!("it holds");
    };
    assert_eq!((lines, line), (0, 1));
    assert_eq!(faults, ["the ledger is empty: it has no first line"]);
    let missing = verify(&dir.join("none")).unwrap_err();
    let shown = dir.join("none");
    assert_eq!(missing, format!("ENOENT: no such file or directory, open '{}'", shown.display()));
    assert_eq!(verify(&dir).unwrap_err(), "EISDIR: illegal operation on a directory, read");
}

#[test]
fn the_place_of_the_ledger() {
    let env = |howl: Option<&str>, xdg: Option<&str>, home: Option<&str>| Env {
        howl_home: howl.map(String::from),
        xdg_state_home: xdg.map(String::from),
        home: home.map(String::from),
    };
    let at = |e: Env| ledger_path("example", &e);
    assert_eq!(at(env(Some("/h"), Some("/x"), Some("/u"))).unwrap(), "/h/example/ledger.jsonl");
    assert_eq!(at(env(Some("/a//b/./c/../"), None, None)).unwrap(), "/a/b/example/ledger.jsonl");
    assert_eq!(at(env(Some(""), Some("/x/"), Some("/u"))).unwrap(), "/x/howl/example/ledger.jsonl");
    assert_eq!(at(env(None, Some("rel"), Some("/u"))).unwrap(), "/u/.local/state/howl/example/ledger.jsonl");
    assert_eq!(at(env(None, None, Some("/../u"))).unwrap(), "/u/.local/state/howl/example/ledger.jsonl");
    let relative = at(env(Some("rel"), None, None)).unwrap_err();
    assert_eq!(relative, "HOWL_HOME must be an absolute path, not \"rel\"");
    let no_home = at(env(None, None, Some(""))).unwrap_err();
    assert_eq!(no_home, "no home folder to keep the ledger in: set HOWL_HOME");
    let name = ledger_path("a/\"b", &env(Some("/h"), None, None)).unwrap_err();
    let want = "\"a/\\\"b\" is not a project name: use letters, digits, '.', '_' and '-', starting with a letter or digit";
    assert_eq!(name, want);
    assert!(ledger_path("a..b", &env(Some("/h"), None, None)).is_err());
    assert!(ledger_path(".a", &env(Some("/h"), None, None)).is_err());
    assert!(ledger_path("A1._-", &env(Some("/h"), None, None)).is_ok());
}

#[test]
fn times_are_read_as_date_parse_reads_the_iso_forms() {
    let cases: [(&str, Option<f64>); 17] = [
        ("2026-01-01T08:00:00Z", Some(1767254400000.0)),
        ("2026-01-01T08:00:00.123456789Z", Some(1767254400123.0)),
        ("2026-01-01T08:00:00.1Z", Some(1767254400100.0)),
        ("2026-01-01T08:00Z", Some(1767254400000.0)),
        ("2026-01-01", Some(1767225600000.0)),
        ("2026-01", Some(1767225600000.0)),
        ("2026", Some(1767225600000.0)),
        ("2026-02-30T00:00:00Z", Some(1772409600000.0)),
        ("2026-02-31T00:00:00Z", Some(1772496000000.0)),
        ("2026-02-32T00:00:00Z", None),
        ("2026-01-01T24:00:00Z", Some(1767312000000.0)),
        ("2026-01-01T24:00:01Z", None),
        ("2026-01-01T23:60:00Z", None),
        ("2026-01-01T08:00:00+01:00", Some(1767250800000.0)),
        ("2026-13-01T00:00:00Z", None),
        ("2026-01-01T08:00:00.Z", None),
        ("", None),
    ];
    for (text, want) in cases {
        assert_eq!(date_parse(text), want, "{text}");
    }
}

#[test]
fn base64_is_read_as_node_reads_it() {
    let cases: [(&str, &[u8]); 10] = [
        ("AAAA", &[0, 0, 0]),
        ("AA==", &[0]),
        ("AA", &[0]),
        ("A", &[]),
        ("AB$CD", &[0x00, 0x10, 0x83]),
        ("AB CD", &[0x00, 0x10, 0x83]),
        ("ab+/", &[0x69, 0xbf, 0xbf]),
        ("ab-_", &[0x69, 0xbf, 0xbf]),
        ("a=b", &[]),
        ("AAAA=AAA", &[0, 0, 0]),
    ];
    for (text, want) in cases {
        assert_eq!(base64_decode(text), want, "{text}");
    }
}

#[test]
fn the_arguments_are_read_as_node_s_parse_args_reads_them() {
    let names = ["project", "ledger", "issuer"];
    let args = |list: &[&str]| -> Vec<String> { list.iter().map(|s| s.to_string()).collect() };
    let ok = parse_args(&args(&["--ledger", "a", "--project=b", "--ledger", "c", "--", "-x"]), &names).unwrap();
    assert_eq!(ok.value("ledger"), Some("c"));
    assert_eq!(ok.value("project"), Some("b"));
    assert_eq!(ok.value("issuer"), None);
    assert_eq!(ok.positionals, ["-x"]);
    let unknown = "Unknown option '-a'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"-a\"";
    assert_eq!(parse_args(&args(&["-ab"]), &names).unwrap_err(), unknown);
    let missing = "Option '--issuer <value>' argument missing";
    assert_eq!(parse_args(&args(&["--issuer"]), &names).unwrap_err(), missing);
    let ambiguous = "Option '--ledger' argument is ambiguous.\nDid you forget to specify the option argument for '--ledger'?\nTo specify an option argument starting with a dash use '--ledger=-XYZ'.";
    assert_eq!(parse_args(&args(&["--ledger", "-x", "--nope"]), &names).unwrap_err(), ambiguous);
    let dash = parse_args(&args(&["--ledger", "-", "-"]), &names).unwrap();
    assert_eq!((dash.value("ledger"), dash.positionals.as_slice()), (Some("-"), ["-".to_string()].as_slice()));
}
