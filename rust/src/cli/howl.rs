// The command `howl`. While the move to Rust goes on, a command this side does not do yet
// is handed to the TypeScript: the process becomes node (decision of #135, issue #137).
// @code_class recording
use std::ffi::OsString;
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;

use crate::cli::{hook, verify};

/// The usage text, kept once in src/cli/usage.txt, which the TypeScript reads too.
pub const USAGE: &str = include_str!("../../../src/cli/usage.txt");

/// The commands of `howl`. The ones this side does not do yet go to the TypeScript.
const COMMANDS: [&str; 16] = [
    "verify", "key", "keyd", "anchor", "export", "hook", "emit", "ingest", "observe", "up",
    "classes", "watch", "show", "status", "serve", "trace",
];

/// The commands this side does.
const PORTED: [&str; 2] = ["verify", "hook"];

/// What `howl` does with its arguments, chosen before anything else happens.
#[derive(Debug, PartialEq, Eq)]
pub enum Choice {
    /// Print the usage text: `help`, `-h`, `--help`.
    Help,
    /// A command this side does, by its name.
    Ported(String),
    /// A usage error: the message, then the usage text, and 2.
    Usage(String),
    /// Become `node <entry> <args…>`: node, then the entry.
    Fallback(OsString, OsString),
    /// A command that is not built yet, with no fallback: 2.
    NotBuilt(String),
    /// A fallback that cannot be used: the message, and 2.
    Refused(String),
}

/// The choice for `args` (without the name of the program), HOWL_FALLBACK and HOWL_NODE.
/// An empty variable is not set.
pub fn choose(args: &[OsString], entry: Option<OsString>, node: Option<OsString>) -> Choice {
    let Some(command) = args.first() else {
        return Choice::Usage("no command".to_string());
    };
    let name = command.to_string_lossy();
    if name == "help" || name == "-h" || name == "--help" {
        return Choice::Help;
    }
    if !COMMANDS.contains(&name.as_ref()) {
        return Choice::Usage(format!("no command {name}"));
    }
    if PORTED.contains(&name.as_ref()) {
        return Choice::Ported(name.into_owned());
    }
    fallback(name.into_owned(), entry, node)
}

/// The fallback to the TypeScript for `command`, with HOWL_FALLBACK and HOWL_NODE.
pub(crate) fn fallback(name: String, entry: Option<OsString>, node: Option<OsString>) -> Choice {
    let entry = match entry {
        Some(entry) if !entry.is_empty() => entry,
        _ => return Choice::NotBuilt(name),
    };
    if !Path::new(&entry).is_absolute() {
        let shown = entry.to_string_lossy();
        let message = format!("HOWL_FALLBACK must be an absolute path: {shown}");
        return Choice::Refused(message);
    }
    let node = match node {
        Some(node) if !node.is_empty() => node,
        _ => OsString::from("node"),
    };
    Choice::Fallback(node, entry)
}

/// Runs `howl` and gives its status. The fallback does not return: the process becomes node.
pub fn run() -> i32 {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let entry = std::env::var_os("HOWL_FALLBACK");
    let node = std::env::var_os("HOWL_NODE");
    match choose(&args, entry, node) {
        // The hook first: whatever happens, it prints nothing and ends with 0.
        Choice::Ported(name) if name == "hook" => hook::run(&args),
        Choice::Ported(_) => verify::run(&args[1..], fallback_to_node(&args)),
        Choice::Help => {
            // A closed standard output is not an error of howl's.
            let _ = std::io::stdout().write_all(USAGE.as_bytes());
            0
        }
        Choice::Usage(message) => fail(&format!("howl: {message}\n\n{USAGE}")),
        Choice::NotBuilt(command) => fail(&format!("howl: {command} is not built yet\n")),
        Choice::Refused(message) => fail(&format!("howl: {message}\n")),
        Choice::Fallback(node, entry) => exec_node(&node, &entry, &args),
    }
}

/// For a command this side does only in part: becomes node when HOWL_FALLBACK is set, else says what is not built.
/// `what` names the part, as `verify --checkpoint`.
fn fallback_to_node(args: &[OsString]) -> impl FnOnce(&str) -> i32 + '_ {
    move |what| {
        let entry = std::env::var_os("HOWL_FALLBACK");
        let node = std::env::var_os("HOWL_NODE");
        match fallback(what.to_string(), entry, node) {
            Choice::Fallback(node, entry) => exec_node(&node, &entry, args),
            Choice::Refused(message) => fail(&format!("howl: {message}\n")),
            _ => fail(&format!("howl: {what} is not built yet\n")),
        }
    }
}

/// Becomes `node <entry> <args…>`; returns only when node cannot be started.
fn exec_node(node: &OsString, entry: &OsString, args: &[OsString]) -> i32 {
    let error = Command::new(node).arg(entry).args(args).exec();
    let node = node.to_string_lossy();
    fail(&format!("howl: cannot start {node}: {error}\n"))
}

/// Says `text` on standard error and gives 2.
pub(crate) fn fail(text: &str) -> i32 {
    let _ = std::io::stderr().write_all(text.as_bytes());
    2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    fn some(text: &str) -> Option<OsString> {
        Some(OsString::from(text))
    }

    #[test]
    fn help_is_chosen_whatever_the_fallback_says() {
        for arg in ["help", "-h", "--help"] {
            let choice = choose(&args(&[arg]), some("/x"), None);
            assert_eq!(choice, Choice::Help);
        }
    }

    #[test]
    fn a_command_that_is_not_there_is_a_usage_error() {
        let none = choose(&args(&[]), None, None);
        assert_eq!(none, Choice::Usage("no command".into()));
        let nonsense = choose(&args(&["nonsense"]), some("/x"), None);
        assert_eq!(nonsense, Choice::Usage("no command nonsense".into()));
    }

    #[test]
    fn a_command_not_built_yet_goes_to_the_fallback_or_is_refused() {
        let show = args(&["show", "1"]);
        let alone = choose(&show, None, None);
        assert_eq!(alone, Choice::NotBuilt("show".into()));
        let empty = choose(&show, some(""), None);
        assert_eq!(empty, Choice::NotBuilt("show".into()));
        let path = choose(&show, some("/x"), None);
        assert_eq!(path, Choice::Fallback("node".into(), "/x".into()));
        let named = choose(&show, some("/x"), some("/usr/bin/node"));
        let node = OsString::from("/usr/bin/node");
        assert_eq!(named, Choice::Fallback(node, "/x".into()));
        let relative = choose(&show, some("x/howl.ts"), None);
        let message = "HOWL_FALLBACK must be an absolute path: x/howl.ts";
        assert_eq!(relative, Choice::Refused(message.into()));
    }
}
