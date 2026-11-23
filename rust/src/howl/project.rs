// The project of a working directory, from the nearest .howl/howl.yml above it, and the agent a session runs for: the
// twin of the parts of `src/howl/project.ts` the hook needs (#141).
//
// howl.yml is read with the same small reader, not a YAML library: only top-level keys, with a plain value or a list of
// plain values. Its regular expressions are copied as JavaScript runs them: `\s` and `trim` take JavaScript's white
// space, `.` stops at a line terminator, and `$` is the end of the line read.
// @code_class recording
use crate::howl::path::{dirname, join};
use crate::ledger::place::is_project_name;

/// What a project of the hook is: the folder that holds `.howl/`, its name, and the pattern of `task_from_branch`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    pub root: String,
    pub project: String,
    pub task_from_branch: Option<String>,
}

/// White space as JavaScript's `\s` and `String.prototype.trim` know it.
pub fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// A text without JavaScript's white space at either end, as `trim()`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

/// A line terminator: what `.` in a JavaScript pattern does not match.
fn line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// Whether `text` holds no line terminator, so that `.*$` matches all of it.
fn one_line(text: &str) -> bool {
    !text.chars().any(line_terminator)
}

/// The lines of a text as `split(/\r?\n/)` gives them.
fn lines(text: &str) -> Vec<&str> {
    let pieces: Vec<&str> = text.split('\n').collect();
    let last = pieces.len() - 1;
    pieces
        .iter()
        .enumerate()
        .map(|(i, piece)| match piece.strip_suffix('\r') {
            Some(cut) if i < last => cut,
            _ => piece,
        })
        .collect()
}

/// A line without its comment, as `replace(/(^|\s)#.*$/, "")`.
fn without_comment(line: &str) -> &str {
    let chars: Vec<(usize, char)> = line.char_indices().collect();
    for (k, &(at, c)) in chars.iter().enumerate() {
        // `^#` at the start, else `\s#`: the comment runs to the end, and `.*$` may not cross a line terminator.
        if k == 0 && c == '#' && one_line(&line[at + 1..]) {
            return "";
        }
        if js_space(c) {
            if let Some(&(next, '#')) = chars.get(k + 1) {
                if one_line(&line[next + 1..]) {
                    return &line[..at];
                }
            }
        }
    }
    line
}

/// A plain value: trimmed, and without the quotes that enclose it, as `plain` in project.ts.
pub fn plain(value: &str) -> String {
    let v = js_trim(value);
    for quote in ['"', '\''] {
        if v.len() >= 2 && v.starts_with(quote) && v.ends_with(quote) {
            let inner = &v[1..v.len() - 1];
            if one_line(inner) {
                return inner.to_string();
            }
        }
    }
    v.to_string()
}

/// The value of a top-level key: a plain value, or a list of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Setting {
    Text(String),
    List(Vec<String>),
}

/// The top-level keys of a YAML file, in the order they first appear.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Settings(Vec<(String, Setting)>);

impl Settings {
    pub fn get(&self, key: &str) -> Option<&Setting> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    fn text(&self, key: &str) -> Option<&str> {
        match self.get(key) {
            Some(Setting::Text(text)) => Some(text),
            _ => None,
        }
    }
}

/// `^\s+-\s+(.*)$`: the value of an item of a list.
fn item(line: &str) -> Option<&str> {
    let rest = line.trim_start_matches(js_space);
    if rest.len() == line.len() {
        return None;
    }
    let after = rest.strip_prefix('-')?;
    let value = after.trim_start_matches(js_space);
    (value.len() < after.len() && one_line(value)).then_some(value)
}

/// `^([A-Za-z_][A-Za-z0-9_]*):(.*)$`: a key and what follows its colon.
fn key(line: &str) -> Option<(&str, &str)> {
    let bytes = line.as_bytes();
    let first = bytes.first()?;
    if !(first.is_ascii_alphabetic() || *first == b'_') {
        return None;
    }
    let end = bytes
        .iter()
        .position(|b| !(b.is_ascii_alphanumeric() || *b == b'_'))?;
    if bytes[end] != b':' || !one_line(&line[end + 1..]) {
        return None;
    }
    Some((&line[..end], &line[end + 1..]))
}

/// The top-level keys of a YAML file, each with a plain value or a list of plain values, as `topLevel`.
pub fn top_level(text: &str) -> Settings {
    let mut settings: Vec<(String, Setting)> = Vec::new();
    // The list that items go into: the place of its key.
    let mut list: Option<usize> = None;
    for raw in lines(text) {
        let line = without_comment(raw);
        if let (Some(value), Some(at)) = (item(line), list) {
            let v = plain(value);
            if let Setting::List(items) = &mut settings[at].1 {
                if !v.is_empty() {
                    items.push(v);
                }
            }
            continue;
        }
        let Some((name, rest)) = key(line) else {
            if !js_trim(line).is_empty() && !line.starts_with(js_space) {
                list = None;
            }
            continue;
        };
        list = None;
        if settings.iter().any(|(k, _)| k == name) {
            continue;
        }
        let value = js_trim(rest);
        let setting = if value.is_empty() {
            list = Some(settings.len());
            Setting::List(Vec::new())
        } else if value.len() >= 2 && value.starts_with('[') && value.ends_with(']') {
            let inner = &value[1..value.len() - 1];
            Setting::List(
                inner
                    .split(',')
                    .map(plain)
                    .filter(|v| !v.is_empty())
                    .collect(),
            )
        } else {
            Setting::Text(plain(value))
        };
        settings.push((name.to_string(), setting));
    }
    // A key with nothing after it and no list below it has no value.
    settings.retain(|(_, v)| !matches!(v, Setting::List(items) if items.is_empty()));
    Settings(settings)
}

/// A file read as Node's readFileSync(path, "utf8") reads it: bytes that are no UTF-8 become U+FFFD.
fn read_text(path: &str) -> Option<String> {
    std::fs::read(path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// The project of a howl.yml: none when it names no project, or `activity_days` is no whole number above 0.
fn read(root: &str, text: &str) -> Option<Project> {
    let settings = top_level(text);
    let project = settings.text("project")?;
    if !is_project_name(project) {
        return None;
    }
    if let Some(days) = settings.get("activity_days") {
        let Setting::Text(days) = days else {
            return None;
        };
        let mut digits = days.bytes();
        let first = digits.next().is_some_and(|d| (b'1'..=b'9').contains(&d));
        if !first || !digits.all(|d| d.is_ascii_digit()) {
            return None;
        }
    }
    Some(Project {
        root: root.to_string(),
        project: project.to_string(),
        task_from_branch: settings.text("task_from_branch").map(str::to_string),
    })
}

/// The nearest `.howl/howl.yml` at or above `dir`, or none when there is none or the nearest names no project.
pub fn find_project(dir: &str) -> Option<Project> {
    let mut at = dir.to_string();
    loop {
        if let Some(text) = read_text(&join(&[&at, ".howl", "howl.yml"])) {
            return read(&at, &text);
        }
        let up = dirname(&at);
        if up == at {
            return None;
        }
        at = up;
    }
}

/// The agent a session runs for: `$HOWL_ACTOR` trimmed, else the first line of `.howl/actor` that is not blank.
pub fn find_actor(root: &str, from_env: Option<&str>) -> Option<String> {
    if let Some(actor) = from_env.map(js_trim).filter(|a| !a.is_empty()) {
        return Some(actor.to_string());
    }
    let text = read_text(&join(&[root, ".howl", "actor"]))?;
    lines(&text)
        .into_iter()
        .map(js_trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

/// A pattern of the project, compiled as `new RegExp(source, "u")` compiles it; the reason when it is none.
pub fn setting_pattern(source: &str) -> Result<regress::Regex, String> {
    regress::Regex::with_flags(source, "u").map_err(|e| e.to_string())
}

/// The task a branch name gives by a `task_from_branch` pattern: its first group, else the whole match.
pub fn task_of_branch(branch: Option<&str>, pattern: Option<&regress::Regex>) -> Option<String> {
    let (branch, pattern) = (branch?, pattern?);
    let found = pattern.find(branch)?;
    let range = match found.captures.first() {
        Some(Some(group)) => group.clone(),
        _ => found.range(),
    };
    Some(branch[range].to_string())
}
