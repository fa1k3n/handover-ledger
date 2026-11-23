// The command `howl hook`: the event of a Claude Code hook, signed when the session has a key, and handed to the
// writer's server or left in the inbox (#141, #142).
//
// It never disturbs the session: it prints nothing and ends with 0 in every case. A panic is caught, an error is
// swallowed, each call to git ends after a second, keyd and the server are given half a second each, and an event is
// never lost to a failure of either: it is left in the inbox. Nothing of the hook goes to the TypeScript any more.
// @code_class recording
use crate::hook::hook::{event_of_hook, iso_time, named, HookEnv};
use crate::hook::input::{read_input, Json};
use crate::howl::path::{is_absolute, join};
use crate::howl::project::Project;
use crate::inbox::deliver::deliver;
use crate::inbox::down::{mark_down, recently_down};
use crate::inbox::inbox::{leave, now_ms, random_uuid};
use crate::keys::js::truthy;
use crate::keys::keyd::{parse_keyd_key, request, Answer};
use crate::keys::sign::{read_key, sign_event};
use crate::ledger::place::{inbox_path, project_dir, Env};
use serde_json::{json, Value};
use std::io::Read;
use std::panic::{catch_unwind, AssertUnwindSafe};

/// How long the hook waits for keyd: well within a tool call.
pub const KEYD_TIMEOUT_MS: u64 = 500;
/// After keyd failed to answer, how long the hook does not ask it again.
pub const KEYD_PAUSE_MS: i64 = 60_000;

/// The adapter of the events the hook makes.
const ADAPTER: &str = "claude-code-hook";

/// Runs `howl hook`: always 0, and nothing printed.
pub fn run() -> i32 {
    // A panic says nothing: the message would reach the session.
    std::panic::set_hook(Box::new(|_| {}));
    let _ = catch_unwind(hook);
    0
}

fn hook() {
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
    let places = Env::of_process();
    // #23: signed with the key of the assignment, when the session has one. A key that cannot be read, or a fault of
    // any kind in signing, never stops the hook: the event goes unsigned.
    let out = match named(
        std::env::var_os("HOWL_KEY")
            .map(|k| k.to_string_lossy().into_owned())
            .as_deref(),
    ) {
        Some(key) => catch_unwind(AssertUnwindSafe(|| sign(&key, &project, &event, &places)))
            .ok()
            .flatten()
            .unwrap_or_else(|| event.clone()),
        None => event.clone(),
    };
    // Whatever goes wrong in delivering, the event is not lost: it is left in the inbox.
    let delivered = catch_unwind(AssertUnwindSafe(|| {
        deliver(&project.project, &out, &places)
    }));
    if !matches!(delivered, Ok(Ok(_))) {
        if let Ok(inbox) = inbox_path(&project.project, &places) {
            let _ = leave(&inbox, &out);
        }
    }
}

/// The event signed by the key `key` names, or none when it cannot be: keyd that does not answer, a key that cannot be
/// read, an answer that is no signature.
fn sign(key: &str, project: &Project, event: &Value, places: &Env) -> Option<Value> {
    // #24: through keyd, which holds the key, when HOWL_KEY names it; else from a key file.
    let Some(keyd) = parse_keyd_key(key) else {
        return Some(sign_event(event, &read_key(key).ok()?));
    };
    // #30: a keyd that hangs or is gone never slows a session: after a failure it is not asked for a while.
    let down = join(&[&project_dir(&project.project, places).ok()?, "keyd.down"]);
    if recently_down(&down, KEYD_PAUSE_MS) {
        return None;
    }
    let req = json!({"op": "sign", "key": keyd.key, "token": keyd.token, "event": event});
    match request(&keyd.socket, &req, KEYD_TIMEOUT_MS) {
        Answer::Unreachable(_) => {
            mark_down(&down);
            None
        }
        Answer::Reply(Value::Object(answer)) => {
            if truthy(answer.get("ok")) {
                // Only a signature in form is taken: the key's id and the signature, both text.
                let sig = answer.get("sig")?.as_object()?;
                let both = sig.get("key")?.is_string() && sig.get("value")?.is_string();
                let mut signed = event.clone();
                signed
                    .as_object_mut()?
                    .insert("sig".to_string(), Value::Object(sig.clone()));
                both.then_some(signed)
            } else {
                // keyd's own words say it is not there, as `request` of the TypeScript does when it gives up.
                if truthy(answer.get("unreachable")) {
                    mark_down(&down);
                }
                None
            }
        }
        // An answer that is no object is no signature, and no sign that keyd is gone.
        Answer::Reply(_) => None,
    }
}
