// The schema check, the check of a ledger and of its signatures, and the place of the ledger (#140).
// The conformance of the whole text of `howl verify` with the TypeScript is test/verify-faults.test.ts.
// @code_class tests
use ed25519_dalek::SigningKey;
use howl::cli::args::parse_args;
use howl::keys::sign::{public_of, sign_event};
use howl::keys::{base64_decode, check_signatures, date_parse, public_key_fault};
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
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../test/fixtures")
        .join(name)
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
        (
            json!({"properties": {"a": {"type": "array", "items": true}}}),
            "items",
        ),
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
    let time =
        Pattern::new("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$")
            .unwrap();
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
    let bounded = Pattern::new("^(?:ab|a){0,3}x$").unwrap();
    assert!(bounded.is_match("abaabx"));
    assert!(!bounded.is_match("ababaabx"));
}

#[test]
fn an_unbounded_repeat_of_a_group_is_refused() {
    // Each turn of it would go one level deeper; the schema needs none.
    for source in ["^(?:ab|a)*x$", "(ab)+", "(?:a){2,}", "^(x|y)*$"] {
        let refused = Pattern::new(source).unwrap_err();
        assert!(refused.contains("group"), "{source}: {refused}");
    }
    assert!(Pattern::new("(ab)?").is_ok());
    assert!(Pattern::new("(ab){1,9}").is_ok());
    assert!(Pattern::new("[ab]*").is_ok());
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
    let want = [
        "to: only on task.assigned and task.unassigned",
        "to: must be object",
    ];
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
    let keys: Vec<&str> = faults
        .iter()
        .map(|f| f.split(':').next().unwrap())
        .collect();
    // Array indices (below 2^32 - 1) first, in numeric order; then the rest as they came.
    assert_eq!(
        keys,
        ["2", "10", "4294967294", "zz", "b", "4294967295", "01"]
    );
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
    for time in [
        "2024-02-29T00:00:00Z",
        "2000-02-29T00:00:00Z",
        "2026-12-31T23:59:59Z",
        "0001-01-01T00:00:00Z",
    ] {
        assert!(is_real_time(time), "{time}");
    }
    for time in [
        "2026-02-29T00:00:00Z",
        "2100-02-29T00:00:00Z",
        "2026-04-31T12:00:00Z",
        "2026-13-01T00:00:00Z",
        "2026-01-01T24:00:00Z",
        "2026-01-01T23:59:60.5Z",
    ] {
        assert!(!is_real_time(time), "{time}");
    }
    // A text that does not fit the pattern is the schema's to refuse.
    assert!(is_real_time("yesterday"));
}

#[test]
fn a_ledger_the_typescript_wrote_holds_and_its_signatures_hold() {
    let Verdict::Holds {
        lines,
        head,
        trial,
        events,
    } = verify(&fixture("ledger-signed.jsonl")).unwrap()
    else {
        panic!("it does not hold");
    };
    assert_eq!(lines, 5);
    assert_eq!(
        head,
        "577e4393e26dfa94efdb71353364501c777f2e44d4785ed611fcbb3f10dd1bd1"
    );
    assert!(trial);
    let numbered: Vec<(usize, &Value)> =
        events.iter().enumerate().map(|(i, e)| (i + 1, e)).collect();
    let check = check_signatures(&numbered, None);
    assert_eq!((check.signed, check.unsigned), (2, 1));
    assert!(check.faults.is_empty(), "{:?}", check.faults);
    let issuer = "57dee94ab5fa8b0af3b365496f1f491236317de76867398da40ad065cbfa1445";
    assert_eq!(check.issuer.as_deref(), Some(issuer));
    let pinned = check_signatures(&numbered, Some(&"f".repeat(64)));
    let want = vec![
        (
            2,
            "key 72e2d85be672: not issued by the ledger's issuer".to_string(),
        ),
        (
            3,
            "signed by key 72e2d85be672, which has no valid issue on a line before".to_string(),
        ),
        (
            4,
            "signed by key 72e2d85be672, which has no valid issue on a line before".to_string(),
        ),
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
    let numbered: Vec<(usize, &Value)> =
        events.iter().enumerate().map(|(i, e)| (i + 1, e)).collect();
    let check = check_signatures(&numbered, None);
    let want = vec![
        (
            3,
            "the signature does not hold: the event was changed after it was signed".to_string(),
        ),
        (
            4,
            "the signature does not hold: the event was changed after it was signed".to_string(),
        ),
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
    let Verdict::Fails {
        lines,
        line,
        faults,
    } = verify(&path).unwrap()
    else {
        panic!("it holds");
    };
    assert_eq!((lines, line), (2, 3));
    assert_eq!(faults, ["prev: is not the hash of line 2: line 2 was changed, or lines were removed or added between the two"]);
    std::fs::write(&path, "").unwrap();
    let Verdict::Fails {
        lines,
        line,
        faults,
    } = verify(&path).unwrap()
    else {
        panic!("it holds");
    };
    assert_eq!((lines, line), (0, 1));
    assert_eq!(faults, ["the ledger is empty: it has no first line"]);
    let missing = verify(&dir.join("none")).unwrap_err();
    let shown = dir.join("none");
    assert_eq!(
        missing,
        format!(
            "ENOENT: no such file or directory, open '{}'",
            shown.display()
        )
    );
    assert_eq!(
        verify(&dir).unwrap_err(),
        "EISDIR: illegal operation on a directory, read"
    );
}

#[test]
fn the_place_of_the_ledger() {
    let env = |howl: Option<&str>, xdg: Option<&str>, home: Option<&str>| Env {
        howl_home: howl.map(String::from),
        xdg_state_home: xdg.map(String::from),
        home: home.map(String::from),
    };
    let at = |e: Env| ledger_path("example", &e);
    assert_eq!(
        at(env(Some("/h"), Some("/x"), Some("/u"))).unwrap(),
        "/h/example/ledger.jsonl"
    );
    assert_eq!(
        at(env(Some("/a//b/./c/../"), None, None)).unwrap(),
        "/a/b/example/ledger.jsonl"
    );
    assert_eq!(
        at(env(Some(""), Some("/x/"), Some("/u"))).unwrap(),
        "/x/howl/example/ledger.jsonl"
    );
    assert_eq!(
        at(env(None, Some("rel"), Some("/u"))).unwrap(),
        "/u/.local/state/howl/example/ledger.jsonl"
    );
    assert_eq!(
        at(env(None, None, Some("/../u"))).unwrap(),
        "/u/.local/state/howl/example/ledger.jsonl"
    );
    let relative = at(env(Some("rel"), None, None)).unwrap_err();
    assert_eq!(relative, "HOWL_HOME must be an absolute path, not \"rel\"");
    let no_home = at(env(None, None, Some(""))).unwrap_err();
    assert_eq!(
        no_home,
        "no home folder to keep the ledger in: set HOWL_HOME"
    );
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
    let cases: [(&str, &[u8]); 13] = [
        // The low byte of each UTF-16 code unit: U+0151 is read as Q, and so on.
        ("\u{151}\u{155}\u{14a}\u{144}", b"ABC"),
        // The high surrogate of an emoji, D83D, has the low byte of `=`: the end.
        ("QU\u{1F600}JD", b"A"),
        ("QUJD\u{100}", b"ABC"),
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
    let ok = parse_args(
        &args(&["--ledger", "a", "--project=b", "--ledger", "c", "--", "-x"]),
        &names,
    )
    .unwrap();
    assert_eq!(ok.value("ledger"), Some("c"));
    assert_eq!(ok.value("project"), Some("b"));
    assert_eq!(ok.value("issuer"), None);
    assert_eq!(ok.positionals, ["-x"]);
    let unknown = "Unknown option '-a'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"-a\"";
    assert_eq!(parse_args(&args(&["-ab"]), &names).unwrap_err(), unknown);
    let missing = "Option '--issuer <value>' argument missing";
    assert_eq!(
        parse_args(&args(&["--issuer"]), &names).unwrap_err(),
        missing
    );
    let ambiguous = "Option '--ledger' argument is ambiguous.\nDid you forget to specify the option argument for '--ledger'?\nTo specify an option argument starting with a dash use '--ledger=-XYZ'.";
    assert_eq!(
        parse_args(&args(&["--ledger", "-x", "--nope"]), &names).unwrap_err(),
        ambiguous
    );
    let dash = parse_args(&args(&["--ledger", "-", "-"]), &names).unwrap();
    assert_eq!(
        (dash.value("ledger"), dash.positionals.as_slice()),
        (Some("-"), ["-".to_string()].as_slice())
    );
}

#[test]
fn ed25519_at_its_edges_small_order_and_non_canonical_keys_are_refused() {
    // #199: a small-order or non-canonical key is refused by howl's own check, before dalek's verify sees it, so the
    // verdict is the one the TypeScript gives on every Node build.
    let cases: [(&str, &[(usize, &str)]); 6] = [
        (
            "small-order",
            &[(2, "key k1: the issuer key is refused: of small order")],
        ),
        (
            "noncanon-A",
            &[(
                2,
                "key k2: the issuer key is refused: not in its canonical form",
            )],
        ),
        (
            "negzero-A",
            &[(
                2,
                "key k2: the issuer key is refused: not in its canonical form",
            )],
        ),
        (
            "noncanon-R",
            &[(2, "key k1: the issuer key is refused: of small order")],
        ),
        (
            "R-small",
            &[(
                3,
                "the signature does not hold: the event was changed after it was signed",
            )],
        ),
        (
            "s-plus-L",
            &[(
                3,
                "the signature does not hold: the event was changed after it was signed",
            )],
        ),
    ];
    for (name, want) in cases {
        let path = fixture(&format!("ed25519-edges/{name}.jsonl"));
        let Verdict::Holds { events, .. } = verify(&path).unwrap() else {
            panic!("{name} does not hold");
        };
        let numbered: Vec<(usize, &Value)> =
            events.iter().enumerate().map(|(i, e)| (i + 1, e)).collect();
        let faults = check_signatures(&numbered, None).faults;
        let want: Vec<(usize, String)> = want.iter().map(|&(n, r)| (n, r.to_string())).collect();
        assert_eq!(faults, want, "{name}");
    }
}

/// Bytes from hex.
fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn a_public_key_is_refused_when_not_32_bytes_not_a_point_not_canonical_or_of_small_order() {
    let vectors: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("ed25519-keys.json")).unwrap())
            .unwrap();
    for v in vectors.as_array().unwrap() {
        let raw = unhex(v["hex"].as_str().unwrap());
        assert_eq!(
            public_key_fault(&raw),
            v["refused"].as_str(),
            "{}",
            v["what"]
        );
    }
}

const ISSUER: &str = "57dee94ab5fa8b0af3b365496f1f491236317de76867398da40ad065cbfa1445";

/// The events of test/fixtures/ledger-signed.jsonl.
fn signed_events() -> Vec<Value> {
    let Verdict::Holds { events, .. } = verify(&fixture("ledger-signed.jsonl")).unwrap() else {
        panic!("it does not hold");
    };
    events
}

fn numbered(events: &[Value]) -> Vec<(usize, &Value)> {
    events.iter().enumerate().map(|(i, e)| (i + 1, e)).collect()
}

#[test]
fn a_forged_issuer_key_under_the_pinned_id_is_refused() {
    let forger = SigningKey::from_bytes(&[7; 32]);
    let mut events = signed_events();
    events[1]["data"]["issuer_public"] = json!(public_of(&forger).1);
    let mut forged = sign_event(&events[1], &forger);
    forged["sig"]["key"] = json!(ISSUER);
    events[1] = forged;
    let want = vec![
        (
            2,
            "key 72e2d85be672: the issuer key does not hash to the issuer it names".to_string(),
        ),
        (
            3,
            "signed by key 72e2d85be672, which has no valid issue on a line before".to_string(),
        ),
        (
            4,
            "signed by key 72e2d85be672, which has no valid issue on a line before".to_string(),
        ),
    ];
    let pinned = check_signatures(&numbered(&events), Some(ISSUER));
    assert_eq!(pinned.faults, want);
    assert_eq!(
        (pinned.signed, pinned.unmatched, pinned.pinned),
        (2, 2, true)
    );
    assert_eq!(pinned.issuer.as_deref(), Some(ISSUER));
    let free = check_signatures(&numbered(&events), None);
    assert_eq!(free.faults, want);
    assert_eq!((free.unmatched, free.pinned), (2, false));
}

#[test]
fn a_ledger_whose_issuer_matches_the_pin_holds() {
    let events = signed_events();
    let pinned = check_signatures(&numbered(&events), Some(ISSUER));
    assert!(pinned.faults.is_empty(), "{:?}", pinned.faults);
    assert_eq!(
        (pinned.signed, pinned.unmatched, pinned.pinned),
        (2, 0, true)
    );
    let free = check_signatures(&numbered(&events), None);
    assert!(free.faults.is_empty(), "{:?}", free.faults);
    assert!(!free.pinned);
}

#[test]
fn a_key_whose_window_cannot_be_read_is_refused() {
    let issuer = SigningKey::from_bytes(&[9; 32]);
    let (id, public) = public_of(&issuer);
    let cases = [
        (
            "from",
            json!("2026-11-23T14:00:29"),
            "from 2026-11-23T14:00:29",
        ),
        ("from", json!("2026-11-23"), "from 2026-11-23"),
        ("until", json!("Jan 1 2030"), "until Jan 1 2030"),
        (
            "until",
            json!("2026-02-30T00:00:00Z"),
            "until 2026-02-30T00:00:00Z",
        ),
        ("until", json!(1795000000000_u64), "until 1795000000000"),
    ];
    for (field, value, named) in cases {
        let mut events = signed_events();
        let data = &mut events[1]["data"];
        data["issuer"] = json!(id);
        data["issuer_public"] = json!(public);
        data[field] = value;
        events[1] = sign_event(&events[1], &issuer);
        let check = check_signatures(&numbered(&events), None);
        let want = vec![
            (
                2,
                format!("key 72e2d85be672: its window cannot be read: {named} is not an ISO time with a zone"),
            ),
            (
                3,
                "signed by key 72e2d85be672, which has no valid issue on a line before".to_string(),
            ),
            (
                4,
                "signed by key 72e2d85be672, which has no valid issue on a line before".to_string(),
            ),
        ];
        assert_eq!(check.faults, want, "{named}");
    }
    // Without the field at all.
    let mut events = signed_events();
    let data = events[1]["data"].as_object_mut().unwrap();
    data.remove("until");
    data.insert("issuer".to_string(), json!(id));
    data.insert("issuer_public".to_string(), json!(public));
    events[1] = sign_event(&events[1], &issuer);
    let check = check_signatures(&numbered(&events), None);
    assert_eq!(
        check.faults[0].1,
        "key 72e2d85be672: its window cannot be read: until undefined is not an ISO time with a zone"
    );
    // An offset for the zone, and a fraction of nine digits, are read.
    let mut events = signed_events();
    let data = &mut events[1]["data"];
    data["issuer"] = json!(id);
    data["issuer_public"] = json!(public);
    data["from"] = json!("2026-11-23T15:00:00+01:00");
    data["until"] = json!("2026-11-23T22:00:00.123456789-02:30");
    events[1] = sign_event(&events[1], &issuer);
    let check = check_signatures(&numbered(&events), None);
    assert!(check.faults.is_empty(), "{:?}", check.faults);
}
