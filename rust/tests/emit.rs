// `howl emit` in Rust: an event from a script, delivered as the hook delivers one; the twin of `src/howl/emit.ts` (#142).
// The conformance with the TypeScript, word for word, is test/emit-rust.test.ts and the emit tests run through HOWL_BIN.
// @code_class tests
use howl::ledger::json::{check_event_depth, JsonError};
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_howl");
const USAGE: &str = include_str!("../../src/cli/usage.txt");

fn folder(name: &str) -> PathBuf {
    // One folder for each call: the tests of a file run at the same time.
    static COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("howl-emit-{}-{n}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A repository with `.howl/howl.yml` and a home for the ledger, and `howl emit` run in it.
fn emit(args: &[&str], name: &str) -> (Output, PathBuf) {
    let root = folder(name);
    fs::create_dir_all(root.join("repo").join(".howl")).unwrap();
    fs::write(root.join("repo").join(".howl").join("howl.yml"), "project: example\n").unwrap();
    fs::create_dir_all(root.join("home")).unwrap();
    let out = Command::new(BIN)
        .arg("emit")
        .args(args)
        .current_dir(root.join("repo"))
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOWL_HOME", root.join("home"))
        .env("HOWL_ACTOR", "agent-1")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    (out, root.join("home").join("example").join("inbox"))
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap()
}

#[test]
fn an_event_is_left_in_the_inbox_and_nothing_is_printed() {
    let (out, inbox) = emit(&["checks.passed", "--change", "123", "--task", "45", "--data", "{\"check\":\"static-analysis\"}"], "ok");
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    assert_eq!((text(&out.stdout), text(&out.stderr)), (String::new(), String::new()));
    let files: Vec<_> = fs::read_dir(&inbox).unwrap().map(|e| e.unwrap().path()).collect();
    assert_eq!(files.len(), 1);
    let event: serde_json::Value = serde_json::from_str(&fs::read_to_string(&files[0]).unwrap()).unwrap();
    assert_eq!(event["type"], "checks.passed");
    assert_eq!(event["change"], "123");
    assert_eq!(event["task"], "45");
    assert_eq!(event["data"], serde_json::json!({"check": "static-analysis"}));
    assert_eq!(event["source"], serde_json::json!({"adapter": "emit", "kind": "claimed"}));
    assert_eq!(event["actor"], serde_json::json!({"kind": "agent", "id": "agent-1"}));
}

#[test]
fn without_a_type_it_ends_with_1_and_the_usage_text() {
    let (out, inbox) = emit(&[], "no-type");
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(text(&out.stderr), format!("howl: emit needs a type\n\n{}", USAGE));
    assert!(!inbox.exists());
}

#[test]
fn a_wrong_use_is_a_usage_error_with_2() {
    let (out, _) = emit(&["a", "b"], "too-many");
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(text(&out.stderr), format!("howl: too many arguments: b\n\n{USAGE}"));
    let (out, _) = emit(&["a", "--nope"], "unknown");
    assert_eq!(out.status.code(), Some(2));
    assert!(text(&out.stderr).starts_with("howl: Unknown option '--nope'."), "{}", text(&out.stderr));
    let (out, _) = emit(&["a", "--data"], "missing");
    assert_eq!(out.status.code(), Some(2));
    assert!(text(&out.stderr).starts_with("howl: Option '--data <value>' argument missing"));
}

#[test]
fn a_bad_event_ends_with_1_says_what_is_wrong_and_writes_nothing() {
    let cases: [(&[&str], &str); 8] = [
        (&["checks.passed", "--data", "{not json"], "howl: --data is not JSON\n"),
        (&["checks.passed", "--data", "[1,2]"], "howl: --data must be a JSON object\n"),
        (&["checks.passed", "--data", "null"], "howl: --data must be a JSON object\n"),
        (&["checks.passed", "--data", "\"text\""], "howl: --data must be a JSON object\n"),
        (&["ledger.created"], "howl: type: ledger.created is written by the ledger itself\n"),
        (&["check.pased"], "howl: not a valid event: type: must be one of ledger.created, task.assigned, task.unassigned, task.reopened, change.opened, change.updated, change.merged, checks.passed, checks.failed, checks.none, checks.unfinished, review.approved, review.changes_requested, session.started, tool.used, agent.waiting, session.stopped, session.ended, task.opened, task.closed, change.closed, change.reopened, change.commented, review.commented, review.dismissed, key.issued, key.revoked, observe.started, config.changed, trace.read\n"),
        // A lone surrogate is `--data is not JSON`, as for the TypeScript: only `NotJson` gives its words.
        (&["checks.passed", "--data", "{\"a\":\"\\ud800\"}"], "howl: --data is not JSON\n"),
        (&["checks.passed", "--data", "1e400"], "howl: --data is not JSON\n"),
    ];
    for (n, (args, expected)) in cases.into_iter().enumerate() {
        let (out, inbox) = emit(args, &format!("bad{n}"));
        assert_eq!(out.status.code(), Some(1), "{args:?}");
        assert_eq!(text(&out.stdout), "");
        assert_eq!(text(&out.stderr), expected, "{args:?}");
        assert!(!inbox.exists(), "{args:?}");
    }
}

#[test]
fn an_event_nested_too_deep_is_refused_before_it_is_left() {
    // The event holds `data` one level down, and the event is one level down in its line: 127 at most.
    let deep = |n: usize| format!("{{\"d\":{}{}}}", "[".repeat(n), "]".repeat(n));
    // `data` is level 1 and the object `{"d":` level 2: n arrays reach level n + 2.
    let (out, inbox) = emit(&["checks.passed", "--data", &deep(125)], "deep-ok");
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    assert_eq!(fs::read_dir(&inbox).unwrap().count(), 1);
    let (out, inbox) = emit(&["checks.passed", "--data", &deep(126)], "deep-no");
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(text(&out.stderr), "howl: not JSON: nested more than 128 deep\n");
    assert!(!inbox.exists());
}

#[test]
fn the_check_of_an_event_is_127_deep() {
    let nested = |n: usize| format!("{}{}", "[".repeat(n), "]".repeat(n));
    assert_eq!(check_event_depth(nested(127).as_bytes()), Ok(()));
    assert_eq!(check_event_depth(nested(128).as_bytes()), Err(JsonError::TooDeep));
    // Brackets in a string do not count.
    let in_string = format!("{{\"a\":\"{}\"}}", "[".repeat(500));
    assert_eq!(check_event_depth(in_string.as_bytes()), Ok(()));
}

#[test]
fn outside_a_project_nothing_is_written_and_it_ends_with_0() {
    let root = folder("outside");
    let out = Command::new(BIN)
        .args(["emit", "checks.passed"])
        .current_dir(&root)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOWL_HOME", root.join("home"))
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!((text(&out.stdout), text(&out.stderr)), (String::new(), String::new()));
    assert!(!root.join("home").exists());
}

#[test]
fn an_inbox_that_cannot_be_written_ends_with_2_and_names_the_call() {
    let root = folder("blocked");
    fs::create_dir_all(root.join("repo").join(".howl")).unwrap();
    fs::write(root.join("repo").join(".howl").join("howl.yml"), "project: example\n").unwrap();
    // A file where the project's folder should be.
    fs::write(root.join("home"), "x").unwrap();
    let out = Command::new(BIN)
        .args(["emit", "checks.passed"])
        .current_dir(root.join("repo"))
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOWL_HOME", root.join("home"))
        .env("HOWL_ACTOR", "agent-1")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    let said = text(&out.stderr);
    let inbox = root.join("home").join("example").join("inbox");
    assert_eq!(said, format!("howl: ENOTDIR: not a directory, mkdir '{}'\n", inbox.display()));
}

#[test]
fn an_inbox_that_is_a_file_ends_with_1_as_the_typescript_ends_with_its_error() {
    let root = folder("is-a-file");
    fs::create_dir_all(root.join("repo").join(".howl")).unwrap();
    fs::write(root.join("repo").join(".howl").join("howl.yml"), "project: example\n").unwrap();
    fs::create_dir_all(root.join("home").join("example")).unwrap();
    fs::write(root.join("home").join("example").join("inbox"), "x").unwrap();
    let out = Command::new(BIN)
        .args(["emit", "checks.passed"])
        .current_dir(root.join("repo"))
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOWL_HOME", root.join("home"))
        .env("HOWL_ACTOR", "agent-1")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let inbox = root.join("home").join("example").join("inbox");
    assert_eq!(text(&out.stderr), format!("howl: EEXIST: file already exists, mkdir '{}'\n", inbox.display()));
}
