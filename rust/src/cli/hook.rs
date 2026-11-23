// The command `howl hook`: the event of a Claude Code hook, left in the inbox (#141).
//
// It never disturbs the session: it prints nothing and ends with 0 in every case. A panic is caught, an error is
// swallowed, and each call to git ends after a second. What this side does not do yet (signing with HOWL_KEY, and
// delivery to the writer's server) goes to the TypeScript, decided before a byte of standard input is read.
// @code_class recording
use crate::cli::howl::{fallback, Choice};
use crate::hook::hook::{event_of_hook, iso_time, named, HookEnv};
use crate::hook::input::{read_input, Json};
use crate::howl::path::{is_absolute, join};
use crate::howl::project::find_project;
use crate::inbox::inbox::{leave, now_ms, random_uuid};
use crate::ledger::place::{inbox_path, project_dir, Env};
use std::ffi::OsString;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::Command;

/// The adapter of the events the hook makes.
const ADAPTER: &str = "claude-code-hook";

/// Runs `howl hook` with `args` (the command first): always 0, and nothing printed.
pub fn run(args: &[OsString]) -> i32 {
    // A panic says nothing: the message would reach the session.
    std::panic::set_hook(Box::new(|_| {}));
    let _ = std::panic::catch_unwind(|| hook(args));
    0
}

fn hook(args: &[OsString]) {
    if goes_to_node() {
        let entry = std::env::var_os("HOWL_FALLBACK");
        let node = std::env::var_os("HOWL_NODE");
        if let Choice::Fallback(node, entry) = fallback("hook".to_string(), entry, node) {
            // Returns only when node cannot be started: then this side leaves the event, unsigned, in the inbox.
            let _ = Command::new(node).arg(entry).args(args).exec();
        }
    }
    let mut bytes = Vec::new();
    if std::io::stdin().read_to_end(&mut bytes).is_err() {
        return;
    }
    // A test-only switch: a panic here must still leave the session undisturbed.
    if std::env::var_os("HOWL_TEST_PANIC").is_some_and(|v| !v.is_empty()) {
        panic!("HOWL_TEST_PANIC");
    }
    let Ok(cwd) = std::env::current_dir() else {
        return;
    };
    let cwd = cwd.to_string_lossy().into_owned();
    let Some(Json::Object(input)) = read_input(&String::from_utf8_lossy(&bytes)) else {
        return;
    };
    let dir = match input.get("cwd") {
        Some(Json::Text(dir, _)) if is_absolute(dir) => dir.clone(),
        _ => cwd,
    };
    let Ok(id) = random_uuid() else {
        return;
    };
    let time = iso_time(now_ms());
    let env = HookEnv::of_process();
    let Ok(Some((project, event))) = event_of_hook(&input, &env, &dir, ADAPTER, id, time) else {
        return;
    };
    if let Ok(inbox) = inbox_path(&project.project, &Env::of_process()) {
        let _ = leave(&inbox, &event);
    }
}

/// Whether the TypeScript must make the event: HOWL_KEY names a key to sign with, or a `server.json` stands in the
/// folder of the project of the working directory. Decided from the environment and the files alone.
fn goes_to_node() -> bool {
    let key = std::env::var_os("HOWL_KEY").map(|k| k.to_string_lossy().into_owned());
    if named(key.as_deref()).is_some() {
        return true;
    }
    let Ok(cwd) = std::env::current_dir() else {
        return false;
    };
    let Some(project) = find_project(&cwd.to_string_lossy()) else {
        return false;
    };
    let Ok(folder) = project_dir(&project.project, &Env::of_process()) else {
        return false;
    };
    std::fs::symlink_metadata(join(&[&folder, "server.json"])).is_ok()
}
