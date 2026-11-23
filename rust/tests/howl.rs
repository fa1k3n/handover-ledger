// `howl` as a process: help of its own, the refusal, and the fallback to the TypeScript (#137).
// @code_class tests
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const USAGE: &str = include_str!("../../src/cli/usage.txt");
const BIN: &str = env!("CARGO_BIN_EXE_howl");
/// A stand-in for node: prints its pid, its arguments and its standard input.
const NODE: &str = "#!/bin/sh\necho \"pid $$\"\necho \"args $*\"\necho \"in $(cat)\"\n";

/// `howl` with no environment but PATH and `env`, and its pid.
fn howl(args: &[&str], env: &[(&str, &str)], input: &str) -> (Output, u32) {
    let mut child = Command::new(BIN)
        .args(args)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let pid = child.id();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(input.as_bytes()).unwrap();
    drop(stdin);
    (child.wait_with_output().unwrap(), pid)
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap()
}

/// A folder of its own for one test.
fn folder(name: &str) -> PathBuf {
    let name = format!("howl-rust-test-{}-{name}", std::process::id());
    let dir = std::env::temp_dir().join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// HOWL_FALLBACK and HOWL_NODE.
fn fallback<'a>(entry: &'a str, node: &'a str) -> [(&'static str, &'a str); 2] {
    [("HOWL_FALLBACK", entry), ("HOWL_NODE", node)]
}

/// The stand-in for node, as `name` in `dir`.
fn fake_node(dir: &Path, name: &str) -> String {
    let path = dir.join(name);
    fs::write(&path, NODE).unwrap();
    let mode = fs::Permissions::from_mode(0o755);
    fs::set_permissions(&path, mode).unwrap();
    path.to_str().unwrap().to_string()
}

#[test]
fn help_and_its_flags_print_the_usage_text_byte_for_byte() {
    for arg in ["help", "-h", "--help"] {
        let (out, _) = howl(&[arg], &[], "");
        assert_eq!(out.status.code(), Some(0));
        assert_eq!(text(&out.stdout), USAGE);
        assert_eq!(text(&out.stderr), "");
    }
}

#[test]
fn a_command_that_is_not_there_ends_with_2_and_the_usage_text() {
    let (out, _) = howl(&["nonsense"], &[], "");
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(text(&out.stdout), "");
    let expected = format!("howl: no command nonsense\n\n{USAGE}");
    assert_eq!(text(&out.stderr), expected);
    let (none, _) = howl(&[], &[], "");
    assert_eq!(none.status.code(), Some(2));
    let expected = format!("howl: no command\n\n{USAGE}");
    assert_eq!(text(&none.stderr), expected);
}

#[test]
fn without_howl_fallback_a_command_not_built_yet_is_refused_with_2() {
    for command in ["show", "emit", "status", "up"] {
        let (out, _) = howl(&[command, "1"], &[], "");
        assert_eq!(out.status.code(), Some(2));
        assert_eq!(text(&out.stdout), "");
        let expected = format!("howl: {command} is not built yet\n");
        assert_eq!(text(&out.stderr), expected);
    }
}

#[test]
fn with_howl_fallback_it_becomes_node_in_the_same_process_with_the_same_input() {
    let dir = folder("fallback");
    let node = fake_node(&dir, "node-of-test");
    let entry = "/somewhere/src/cli/howl.ts";
    let env = fallback(entry, &node);
    let (out, pid) = howl(&["show", "1", "--json"], &env, "the input");
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    let args = format!("args {entry} show 1 --json");
    let expected = format!("pid {pid}\n{args}\nin the input\n");
    assert_eq!(text(&out.stdout), expected);
}

#[test]
fn without_howl_node_it_is_node_from_path() {
    let dir = folder("path");
    fake_node(&dir, "node");
    let old = std::env::var("PATH").unwrap_or_default();
    let path = format!("{}:{old}", dir.display());
    let env = [("PATH", path.as_str()), ("HOWL_FALLBACK", "/x/howl.ts")];
    let (out, _) = howl(&["status"], &env, "");
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    assert!(text(&out.stdout).contains("args /x/howl.ts status\n"));
}

#[test]
fn help_is_its_own_even_with_howl_fallback() {
    let dir = folder("help");
    let node = fake_node(&dir, "node-of-test");
    let env = fallback("/x/howl.ts", &node);
    let (out, _) = howl(&["help"], &env, "");
    assert_eq!(text(&out.stdout), USAGE);
}

#[test]
fn a_howl_fallback_that_is_not_an_absolute_path_is_refused_with_2() {
    let env = [("HOWL_FALLBACK", "src/cli/howl.ts")];
    let (out, _) = howl(&["show", "1"], &env, "");
    assert_eq!(out.status.code(), Some(2));
    let expected = "howl: HOWL_FALLBACK must be an absolute path: src/cli/howl.ts\n";
    assert_eq!(text(&out.stderr), expected);
}

#[test]
fn a_node_that_cannot_be_started_is_said_with_2() {
    let env = fallback("/x/howl.ts", "/no/such/node");
    let (out, _) = howl(&["show", "1"], &env, "");
    assert_eq!(out.status.code(), Some(2));
    let said = text(&out.stderr);
    let start = "howl: cannot start /no/such/node: ";
    assert!(said.starts_with(start), "{said}");
}
