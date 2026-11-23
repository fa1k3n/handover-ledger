// `howl emit`: an event from a script, delivered as a hook delivers one: to the writer's server when one runs, else
// into the inbox (#64). The twin of `src/howl/emit.ts` and `emitCommand` in src/cli/howl.ts (#142).
// Unlike the hook it says what is wrong and ends with 1: a script wants to know.
// @code_class recording
use crate::cli::args::parse_args;
use crate::cli::howl::{fail, USAGE};
use crate::hook::hook::iso_time;
use crate::howl::project::{find_actor, find_project};
use crate::inbox::deliver::deliver;
use crate::inbox::inbox::{now_ms, random_uuid, LeaveError};
use crate::ledger::fixed::fixed_form;
use crate::ledger::json::{check_event_depth, parse_json, JsonError};
use crate::ledger::place::Env;
use crate::ledger::schema::event_faults;
use serde_json::{json, Map, Value};
use std::ffi::OsString;

/// The options of `howl emit`.
#[derive(Debug, Clone, Default)]
pub struct EmitOptions {
    pub kind: String,
    pub task: Option<String>,
    pub change: Option<String>,
    pub data: Option<String>,
}

/// Why no event was delivered.
#[derive(Debug, PartialEq)]
pub enum EmitError {
    /// A wrong event: its words, and 1.
    Wrong(String),
    /// The inbox could not be written: Node's words for the call, which end with 2 for four codes and 1 otherwise.
    Inbox(LeaveError),
}

/// Delivers the event. Gives the path of its file when it is left in the inbox, none when the server took it or
/// outside a repository with `.howl/howl.yml`.
pub fn emit(options: &EmitOptions, actor: Option<&str>, cwd: &str, env: &Env) -> Result<Option<String>, EmitError> {
    let Some(project) = find_project(cwd) else {
        return Ok(None);
    };
    let wrong = EmitError::Wrong;
    let mut data = None;
    if let Some(text) = &options.data {
        let value = match parse_json(text) {
            Ok(value) => value,
            // Only `not JSON` says its words; a lone surrogate is `not JSON` here, as in the TypeScript.
            Err(e @ (JsonError::NotJson | JsonError::TooDeep)) => return Err(wrong(format!("--data is {e}"))),
            Err(JsonError::LoneSurrogate) => return Err(wrong("--data is not JSON".to_string())),
        };
        if !value.is_object() {
            return Err(wrong("--data must be a JSON object".to_string()));
        }
        data = Some(value);
    }
    if options.kind == "ledger.created" {
        return Err(wrong("type: ledger.created is written by the ledger itself".to_string()));
    }

    let actor = find_actor(&project.root, actor);
    let id = random_uuid().map_err(|e| EmitError::Inbox(LeaveError::other(e.to_string())))?;
    let mut event = Map::new();
    event.insert("v".into(), json!(0));
    event.insert("id".into(), json!(id));
    event.insert("time".into(), json!(iso_time(now_ms())));
    event.insert("type".into(), json!(options.kind));
    event.insert("source".into(), json!({"adapter": "emit", "kind": "claimed"}));
    event.insert("project".into(), json!(project.project));
    if let Some(actor) = actor {
        event.insert("actor".into(), json!({"kind": "agent", "id": actor}));
    }
    if let Some(task) = &options.task {
        event.insert("task".into(), json!(task));
    }
    if let Some(change) = &options.change {
        event.insert("change".into(), json!(change));
    }
    if let Some(data) = data {
        event.insert("data".into(), data);
    }
    let event = Value::Object(event);
    let faults = event_faults(&event);
    if !faults.is_empty() {
        return Err(wrong(format!("not a valid event: {}", faults.join("; "))));
    }
    // As the writer would refuse it, said here and not by the inbox, a file later.
    check_event_depth(&fixed_form(&event)).map_err(|e| wrong(e.to_string()))?;
    deliver(&project.project, &event, env).map_err(EmitError::Inbox)
}

/// Runs `howl emit` with its arguments (after `emit`): the status, and the words on standard error.
pub fn run(args: &[OsString]) -> i32 {
    let args: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
    let parsed = match parse_args(&args, &["task", "change", "data"]) {
        Ok(parsed) => parsed,
        Err(message) => return usage(&message),
    };
    if parsed.positionals.len() > 1 {
        return usage(&format!("too many arguments: {}", parsed.positionals[1..].join(" ")));
    }
    let Some(kind) = parsed.positionals.first() else {
        let _ = fail(&format!("howl: emit needs a type\n\n{USAGE}"));
        return 1;
    };
    let options = EmitOptions {
        kind: kind.clone(),
        task: parsed.value("task").map(str::to_string),
        change: parsed.value("change").map(str::to_string),
        data: parsed.value("data").map(str::to_string),
    };
    let Ok(cwd) = std::env::current_dir() else {
        return fail("howl: the working directory cannot be read\n");
    };
    let actor = std::env::var_os("HOWL_ACTOR").map(|v| v.to_string_lossy().into_owned());
    match emit(&options, actor.as_deref(), &cwd.to_string_lossy(), &Env::of_process()) {
        Ok(_) => 0,
        Err(EmitError::Wrong(message)) => {
            let _ = fail(&format!("howl: {message}\n"));
            1
        }
        Err(EmitError::Inbox(error)) => {
            let said = fail(&format!("howl: {error}\n"));
            // Four codes end the TypeScript with 2 (its main knows them); any other error ends it with a stack and 1.
            if ["ENOENT", "EACCES", "EISDIR", "ENOTDIR"].contains(&error.code.as_str()) {
                said
            } else {
                1
            }
        }
    }
}

/// A usage error: the message, the usage text, and 2.
fn usage(message: &str) -> i32 {
    fail(&format!("howl: {message}\n\n{USAGE}"))
}
