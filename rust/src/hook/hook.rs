// `howl hook`: turns the JSON of a Claude Code hook into an event, the twin of `eventOfHook` in src/hook/hook.ts (#141).
//
// Only an agent's session is recorded. A tool call keeps the tool, the target and the outcome: never the input, the
// answer or a message, and no hash of the input either (#50). The rest of the input is dropped in this process.
// @code_class recording
use crate::hook::input::{Json, Members};
use crate::howl::git::{git, origin_url, repo_name};
use crate::howl::path::{basename, is_absolute, relative, resolve};
use crate::howl::project::{
    find_actor, find_project, js_trim, setting_pattern, task_of_branch, Project,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// The notifications that mean the agent waits, and what for in howl's words (#29).
const WAITS: [(&str, &str); 5] = [
    ("permission_prompt", "person"),
    ("idle_prompt", "instructions"),
    ("elicitation_dialog", "person"),
    ("elicitation_url_dialog", "person"),
    ("agent_needs_input", "person"),
];

/// The largest role prompt that is hashed.
const MAX_PROMPT: u64 = 1024 * 1024;

/// Deeper than this a command is not followed: it gives no target.
const MAX_NESTING: usize = 100;

/// What the session names in its environment, as it stands there.
#[derive(Debug, Clone, Default)]
pub struct HookEnv {
    pub actor: Option<String>,
    pub task: Option<String>,
    pub change: Option<String>,
    pub role: Option<String>,
    pub role_prompt: Option<String>,
    pub harness: Option<String>,
    pub harness_revision: Option<String>,
}

impl HookEnv {
    /// The variables of this process.
    pub fn of_process() -> HookEnv {
        let var = |name: &str| std::env::var_os(name).map(|v| v.to_string_lossy().into_owned());
        HookEnv {
            actor: var("HOWL_ACTOR"),
            task: var("HOWL_TASK"),
            change: var("HOWL_CHANGE"),
            role: var("HOWL_ROLE"),
            role_prompt: var("HOWL_ROLE_PROMPT"),
            harness: var("HOWL_HARNESS"),
            harness_revision: var("HOWL_HARNESS_REVISION"),
        }
    }
}

/// Why no event is made, when the TypeScript would make none either: the input is not one howl records, or a text it
/// would keep holds a lone surrogate, which has no fixed form.
pub struct Nothing;

/// A value from the environment, trimmed; none when empty.
pub fn named(value: Option<&str>) -> Option<String> {
    value
        .map(js_trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

/// A text that is not empty, with whether it held a lone surrogate.
fn text_of(value: Option<&Json>) -> Option<(&str, bool)> {
    match value {
        Some(Json::Text(text, lone)) if !text.is_empty() => Some((text, *lone)),
        _ => None,
    }
}

/// A text that goes into the event: a lone surrogate in it means no event, as the fixed form refuses it.
fn kept(value: Option<&Json>) -> Result<Option<String>, Nothing> {
    match text_of(value) {
        Some((_, true)) => Err(Nothing),
        Some((text, false)) => Ok(Some(text.to_string())),
        None => Ok(None),
    }
}

/// An object of the members given, without the empty ones; none when none is left.
fn only(members: Vec<(&str, Option<String>)>) -> Option<Value> {
    let kept: Map<String, Value> = members
        .into_iter()
        .filter_map(|(k, v)| v.map(|v| (k.to_string(), Value::String(v))))
        .collect();
    (!kept.is_empty()).then_some(Value::Object(kept))
}

/// The event for a hook's JSON, with its `id` and `time`, and the project it belongs to. Ok(None) when nothing is
/// recorded: no `.howl/howl.yml` above the folder, no agent, a hook howl does not record, or a `task_from_branch` that
/// is no regular expression.
pub fn event_of_hook(
    hook: &Members,
    env: &HookEnv,
    dir: &str,
    adapter: &str,
    id: String,
    time: String,
) -> Result<Option<(Project, Value)>, Nothing> {
    let Some(project) = find_project(dir) else {
        return Ok(None);
    };
    let Some(actor) = find_actor(&project.root, env.actor.as_deref()) else {
        return Ok(None);
    };
    let Some((kind, data)) = describe(hook, &project.root)? else {
        return Ok(None);
    };
    // #41: a task_from_branch that is no regular expression records nothing, and says nothing.
    let pattern = match project.task_from_branch.as_deref().map(setting_pattern) {
        Some(Err(_)) => return Ok(None),
        Some(Ok(pattern)) => Some(pattern),
        None => None,
    };
    let place = checkout(dir)?;
    let from_env = named(env.task.as_deref());
    let task = from_env
        .clone()
        .or_else(|| task_of_branch(place.branch.as_deref(), pattern.as_ref()));
    let task_from = task.as_ref().map(|_| if from_env.is_some() { "env" } else { "branch" });

    let mut event = Map::new();
    event.insert("v".into(), json!(0));
    event.insert("id".into(), json!(id));
    event.insert("time".into(), json!(time));
    event.insert("type".into(), json!(kind));
    event.insert("source".into(), json!({"adapter": adapter, "kind": "claimed"}));
    event.insert("project".into(), json!(project.project));
    event.insert("actor".into(), json!({"kind": "agent", "id": actor}));
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            event.insert(key.into(), value);
        }
    };
    put("session", kept(hook.get("session_id"))?.map(Value::String));
    put("model", kept(hook.get("model"))?.map(Value::String));
    put("effort", effort(hook.get("effort"))?.map(Value::String));
    put("repo", place.repo.map(Value::String));
    put("branch", place.branch.map(Value::String));
    put("sha", place.sha.map(Value::String));
    put("change", named(env.change.as_deref()).map(Value::String));
    put("task", task.map(Value::String));
    put("task_from", task_from.map(|t| json!(t)));
    put("role", named(env.role.as_deref()).map(Value::String));
    put("prompt", role_prompt(env.role_prompt.as_deref(), &project.root));
    put("harness", harness(env));
    put("data", data);
    Ok(Some((project, Value::Object(event))))
}

/// #129: the harness and its revision, as the session claims them: both, or neither.
fn harness(env: &HookEnv) -> Option<Value> {
    let name = named(env.harness.as_deref())?;
    let revision = named(env.harness_revision.as_deref())?;
    Some(json!({"name": name, "revision": revision}))
}

/// The role prompt by its file within the repository and the SHA-256 of its content; none when it cannot be read there.
fn role_prompt(path: Option<&str>, root: &str) -> Option<Value> {
    let path = named(path)?;
    let full = resolve(root, &path);
    let within = relative(root, &full);
    if within.is_empty() || within.starts_with("..") || is_absolute(&within) {
        return None;
    }
    // A plain file of a prompt's size only: a pipe in its place would hold the reader up.
    let meta = std::fs::metadata(&full).ok()?;
    if !meta.is_file() || meta.len() > MAX_PROMPT {
        return None;
    }
    let content = std::fs::read(&full).ok()?;
    let digest = Sha256::digest(&content);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    Some(json!({"file": within, "sha256": hex}))
}

/// The type of event for a hook and its data, or none for a hook howl does not record.
type Described = Option<(&'static str, Option<Value>)>;

fn describe(hook: &Members, root: &str) -> Result<Described, Nothing> {
    let Some(Json::Text(name, _)) = hook.get("hook_event_name") else {
        return Ok(None);
    };
    Ok(Some(match name.as_str() {
        "SessionStart" => {
            let source = kept(hook.get("source"))?;
            ("session.started", only(vec![("source", source)]))
        }
        "PostToolUse" => ("tool.used", tool_call(hook, root, "succeeded")?),
        "PostToolUseFailure" => ("tool.used", tool_call(hook, root, "failed")?),
        "Notification" => {
            let kind = text_of(hook.get("notification_type")).map(|(k, _)| k);
            let Some((kind, waits)) = WAITS.iter().find(|(k, _)| Some(*k) == kind) else {
                return Ok(None);
            };
            let data = json!({"notification_type": kind, "waits_for": waits});
            ("agent.waiting", Some(data))
        }
        "Stop" => ("session.stopped", None),
        "SessionEnd" => {
            let reason = kept(hook.get("reason"))?;
            ("session.ended", only(vec![("reason", reason)]))
        }
        _ => return Ok(None),
    }))
}

fn tool_call(hook: &Members, root: &str, outcome: &str) -> Result<Option<Value>, Nothing> {
    let tool = kept(hook.get("tool_name"))?.unwrap_or_else(|| "unknown".to_string());
    let empty = Members::default();
    let input = match hook.get("tool_input") {
        Some(Json::Object(members)) => members,
        _ => &empty,
    };
    let target = target(&tool, input, root)?;
    let members = vec![
        ("tool", Some(tool)),
        ("target", target),
        ("outcome", Some(outcome.to_string())),
    ];
    Ok(only(members))
}

/// What a tool call worked on: a path within the repository, or the name of a program. Never content.
fn target(tool: &str, input: &Members, root: &str) -> Result<Option<String>, Nothing> {
    if tool == "Bash" {
        return Ok(text_of(input.get("command")).and_then(|(c, _)| program(c)));
    }
    let path = text_of(input.get("file_path"))
        .or_else(|| text_of(input.get("notebook_path")))
        .or_else(|| text_of(input.get("path")));
    let Some((path, lone)) = path else {
        return Ok(None);
    };
    if !is_absolute(path) {
        return Ok(None);
    }
    let within = relative(root, path);
    let target = if within.is_empty() {
        ".".to_string()
    } else if within.starts_with("..") || is_absolute(&within) {
        return Ok(None);
    } else {
        within
    };
    // The path would be kept with its lone surrogate, which has no fixed form.
    if lone {
        return Err(Nothing);
    }
    Ok(Some(target))
}

fn effort(value: Option<&Json>) -> Result<Option<String>, Nothing> {
    match value {
        Some(Json::Object(members)) => kept(members.get("level")),
        other => kept(other),
    }
}

/// The repository's name, branch and head commit, when the folder is a git checkout.
#[derive(Debug, Default)]
struct Place {
    repo: Option<String>,
    branch: Option<String>,
    sha: Option<String>,
}

fn checkout(dir: &str) -> Result<Place, Nothing> {
    // Node refuses to start a process in a folder whose name holds a NUL, and the hook then records nothing.
    if dir.contains('\0') {
        return Err(Nothing);
    }
    // One call for the root, the head commit and the branch; a repository with no commit yet has no head, and then
    // only the root is asked for.
    let asked = ["rev-parse", "--show-toplevel", "HEAD", "--abbrev-ref", "HEAD"];
    let all: Option<Vec<String>> =
        git(dir, &asked).map(|out| out.split('\n').map(str::to_string).collect());
    let top = match &all {
        Some(lines) => Some(lines[0].clone()),
        None => git(dir, &["rev-parse", "--show-toplevel"]),
    };
    let Some(top) = top.filter(|t| !t.is_empty()) else {
        return Ok(Place::default());
    };
    let mut place = Place {
        repo: Some(repo_name(origin_url(dir).as_deref()).unwrap_or_else(|| basename(&top))),
        ..Place::default()
    };
    if let Some(lines) = all.filter(|l| l.len() == 3) {
        let hex = |s: &str| s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        if (lines[1].len() == 40 || lines[1].len() == 64) && hex(&lines[1]) {
            place.sha = Some(lines[1].clone());
        }
        if lines[2] != "HEAD" {
            place.branch = Some(lines[2].clone());
        }
    }
    Ok(place)
}

/// A time as `Date.prototype.toISOString` writes it, from milliseconds since 1970: `2026-01-01T00:00:00.000Z`.
pub fn iso_time(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000);
    // The civil date of a day count (Howard Hinnant's days_from_civil, turned round).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let (h, m, s, milli) = (
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000,
    );
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{milli:03}Z")
}

/// The name of the program a shell command starts, past any variables set before it and any redirection, as
/// `program` in hook.ts reads it: word by word, as a shell does (#74). None when the name cannot be told safely.
///
/// It reads bytes where the TypeScript reads UTF-16 code units: every sign it looks for is ASCII, and neither a byte
/// of a UTF-8 sequence nor a code unit of a character above ASCII is ever one of them.
pub fn program(command: &str) -> Option<String> {
    let s = command.as_bytes();
    let mut at = 0;
    loop {
        // Past the blanks, and the signs between statements and around groups.
        while at < s.len() && b" \t\n;&|(){}".contains(&s[at]) {
            at += 1;
        }
        if at >= s.len() {
            return None;
        }
        // A comment runs to the end of its line.
        if s[at] == b'#' {
            at = find(s, b'\n', at)?;
            continue;
        }
        let word = shell_word(s, at)?;
        at = word.end;
        let text = &s[word.start..word.end];
        // A redirection before the program (`2>/dev/null`, `> file`, `2>&1`): its file is no program.
        if let Some((op, rest)) = redirect(text) {
            // A here-document: its lines follow, and they are content.
            if op == b"<<" {
                return None;
            }
            if rest.is_empty() {
                while at < s.len() && b" \t&".contains(&s[at]) {
                    at += 1;
                }
                at = shell_word(s, at)?.end;
            }
            continue;
        }
        // A word that sets a variable, whatever its value holds.
        if let Some(length) = sets(text) {
            // An array, `NAME=(a b c)`: the word ends at the `(`, and its elements are values, never the program.
            if length == text.len() && s.get(at) == Some(&b'(') {
                at = group(s, at + 1, b'(', b')', 0)?;
            }
            continue;
        }
        // The program: what stands after the last `/` of the word itself, when that is a plain name.
        let after = word.slash.map_or(0, |slash| slash + 1);
        let name: Vec<u8> = text[after..]
            .iter()
            .copied()
            .filter(|b| *b != b'"' && *b != b'\'')
            .collect();
        let plain = |b: &u8| b.is_ascii_alphanumeric() || b"._+-".contains(b);
        return (!name.is_empty() && name.iter().all(plain))
            .then(|| String::from_utf8(name).expect("ASCII"));
    }
}

/// The place of the first `byte` at or after `from`.
fn find(s: &[u8], byte: u8, from: usize) -> Option<usize> {
    s.get(from..)?
        .iter()
        .position(|b| *b == byte)
        .map(|p| p + from)
}

/// `^\d*(<<|<|>>|>)([^]*)$`: the sign of a redirection and what follows it in the word.
fn redirect(text: &[u8]) -> Option<(&[u8], &[u8])> {
    let digits = text.iter().take_while(|b| b.is_ascii_digit()).count();
    let rest = &text[digits..];
    for op in [&b"<<"[..], b"<", b">>", b">"] {
        if let Some(after) = rest.strip_prefix(op) {
            return Some((op, after));
        }
    }
    None
}

/// `^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=`: the length of the part of the word that sets a variable.
fn sets(text: &[u8]) -> Option<usize> {
    let first = text.first()?;
    if !(first.is_ascii_alphabetic() || *first == b'_') {
        return None;
    }
    let name = 1 + text[1..]
        .iter()
        .take_while(|b| b.is_ascii_alphanumeric() || **b == b'_')
        .count();
    let equals = |at: usize| {
        let at = if text.get(at) == Some(&b'+') { at + 1 } else { at };
        (text.get(at) == Some(&b'=')).then_some(at + 1)
    };
    if text.get(name) == Some(&b'[') {
        if let Some(close) = find(text, b']', name + 1) {
            if let Some(length) = equals(close + 1) {
                return Some(length);
            }
        }
    }
    equals(name)
}

/// One word of a shell command.
struct Word {
    start: usize,
    end: usize,
    /// The place of its last `/` outside a substitution, from its start.
    slash: Option<usize>,
}

/// One word of a shell command from `start`: it ends at a blank (a space, a tab, a line break) or at a sign that
/// stands outside quotes and substitutions. None when a quote or a substitution does not close.
fn shell_word(s: &[u8], start: usize) -> Option<Word> {
    let mut i = start;
    let mut slash = None;
    while i < s.len() {
        let c = s[i];
        if b" \t\n;&|()".contains(&c) {
            break;
        }
        if c == b'/' {
            slash = Some(i - start);
            i += 1;
        } else if c == b'\\' {
            i += 2;
        } else if c == b'\'' {
            let close = find(s, b'\'', i + 1)?;
            // Between single quotes every sign stands for itself. Only this span is searched.
            if let Some(k) = (i + 1..close).rev().find(|k| s[*k] == b'/') {
                slash = Some(k - start);
            }
            i = close + 1;
        } else if c == b'"' {
            i = double_quoted(s, i + 1, 0, &mut |at| slash = Some(at - start))?;
        } else {
            let close = substitution(s, i, 0)?;
            i = if close > i { close } else { i + 1 };
        }
    }
    Some(Word {
        start,
        end: i.min(s.len()),
        slash,
    })
}

/// The place after the `"` that closes a text in double quotes that starts at `i`.
fn double_quoted(
    s: &[u8],
    mut i: usize,
    depth: usize,
    on_slash: &mut dyn FnMut(usize),
) -> Option<usize> {
    while i < s.len() {
        let c = s[i];
        if c == b'"' {
            return Some(i + 1);
        }
        if c == b'/' {
            on_slash(i);
        }
        if c == b'\\' {
            i += 2;
        } else {
            let close = substitution(s, i, depth)?;
            i = if close > i { close } else { i + 1 };
        }
    }
    None
}

/// The place after what starts at `i` when that is a substitution or a quote of the `$` kind: `$(…)`, `${…}`, `$[…]`,
/// `` `…` `` or `$'…'`. `i` itself when nothing of the kind starts there; none when it does not close or cannot be
/// followed.
fn substitution(s: &[u8], i: usize, depth: usize) -> Option<usize> {
    let c = s.get(i).copied();
    if c != Some(b'`') && c != Some(b'$') {
        return Some(i);
    }
    if depth > MAX_NESTING {
        return None;
    }
    // A backquote or `$'…'` ends at its like that no `\` stands before.
    if c == Some(b'`') || s.get(i + 1) == Some(&b'\'') {
        let (shut, mut k) = if c == Some(b'`') { (b'`', i + 1) } else { (b'\'', i + 2) };
        while k < s.len() {
            if s[k] == b'\\' {
                k += 1;
            } else if s[k] == shut {
                return Some(k + 1);
            }
            k += 1;
        }
        return None;
    }
    let next = s.get(i + 1).copied();
    let shut = match next {
        Some(b'(') => b')',
        Some(b'{') => b'}',
        Some(b'[') => b']',
        _ => return Some(i),
    };
    let open = next.expect("an opening sign");
    let close = group(s, i + 2, open, shut, depth + 1)?;
    // A `case` in a substitution has a `)` that closes nothing: not followed.
    if open == b'(' && holds_case(&s[i + 2..close]) {
        return None;
    }
    Some(close)
}

/// `/\bcase\b/`: the word `case`, with no letter, digit or `_` on either side.
fn holds_case(s: &[u8]) -> bool {
    let word = |b: Option<&u8>| b.is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_');
    (0..s.len().saturating_sub(3)).any(|at| {
        s[at..].starts_with(b"case")
            && !word(at.checked_sub(1).and_then(|p| s.get(p)))
            && !word(s.get(at + 4))
    })
}

/// The place after the `shut` that closes a group opened before `i`, quotes and substitutions inside it passed over.
fn group(s: &[u8], mut i: usize, open: u8, shut: u8, depth: usize) -> Option<usize> {
    let mut level = 1;
    while i < s.len() {
        let c = s[i];
        if c == b'\\' {
            i += 2;
        } else if c == b'\'' {
            i = find(s, b'\'', i + 1)? + 1;
        } else if c == b'"' {
            i = double_quoted(s, i + 1, depth, &mut |_| {})?;
        } else if c == b'`' || c == b'$' {
            let close = substitution(s, i, depth)?;
            i = if close > i { close } else { i + 1 };
        } else {
            if c == open {
                level += 1;
            } else if c == shut {
                level -= 1;
                if level == 0 {
                    return Some(i + 1);
                }
            }
            i += 1;
        }
    }
    None
}
