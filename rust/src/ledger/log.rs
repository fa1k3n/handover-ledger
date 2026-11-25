// The log that follows the repository (#27, #216), the twin of `src/ledger/log.ts`: the branch howl/log of the observed
// repository. Its tree holds only `events/<aa>/<hash>.json`, a file per event: the event in its fixed form, `<hash>` the
// SHA-256 of that form in lowercase hex, `<aa>` its first two digits. The branch is read with git's plumbing and never
// checked out: the working tree, the index and HEAD are never touched. This module only reads.
// @code_class evidence
use crate::ledger::fixed::fixed_form;
use crate::ledger::json::{check_depth, parse_json, MAX_DEPTH};
use crate::ledger::line::hex;
use crate::ledger::schema::event_faults;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::process::{Command, Stdio};

/// The branch, and its full reference.
pub const LOG_BRANCH: &str = "howl/log";
pub const LOG_REF: &str = "refs/heads/howl/log";

/// The faults of a file, in the words of both versions.
pub const NOT_FILE: &str = "not a file: only files belong on the log";
pub const PLACE: &str = "only events/<aa>/<hash>.json belongs on the log";
pub const NAME: &str = "the name is not the hash of the content";
pub const NOT_JSON: &str = "the content is not JSON";
pub const NOT_FIXED: &str = "the content is not the fixed form of its event";

/// A file of the log's tree, as git gives it.
pub struct LogFile {
    pub path: String,
    /// Whether it is a plain file (a blob, not a link): only then is `bytes` read.
    pub plain: bool,
    pub bytes: Vec<u8>,
}

/// What a file of the log holds, and what is wrong with it.
pub struct LogEntry {
    pub path: String,
    /// The event it holds, when it holds one the event schema accepts.
    pub event: Option<Value>,
    /// The SHA-256 of the file's content.
    pub hash: String,
    pub faults: Vec<String>,
}

/// The verdict on the log: a line for each fault, and how many files were checked.
pub struct LogVerdict {
    pub head: String,
    pub files: usize,
    pub faults: Vec<String>,
}

/// Runs git in `repo`; its output, or none when git fails or is not there. Standard error is dropped.
fn run(repo: &str, args: &[&str], input: Option<&[u8]>) -> Option<Vec<u8>> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(repo)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    if let Some(input) = input {
        let mut stdin = child.stdin.take()?;
        let input = input.to_vec();
        // Written beside the read, so that a long answer never holds git up.
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
        let out = child.wait_with_output().ok()?;
        let _ = writer.join();
        return out.status.success().then_some(out.stdout);
    }
    let out = child.wait_with_output().ok()?;
    out.status.success().then_some(out.stdout)
}

/// The commit at the head of howl/log in `repo`, or none when there is no such branch or no repository.
pub fn log_head(repo: &str) -> Option<String> {
    let name = format!("{LOG_REF}^{{commit}}");
    let out = run(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &name,
        ],
        None,
    )?;
    let head = String::from_utf8_lossy(&out).trim().to_string();
    let hex = (40..=64).contains(&head.len())
        && head.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    hex.then_some(head)
}

/// Every file of the tree of `commit`, in git's order, with its content when it is a plain file.
pub fn log_files(repo: &str, commit: &str) -> Result<Vec<LogFile>, String> {
    let listed = run(repo, &["ls-tree", "-r", "-z", "--full-tree", commit], None)
        .ok_or_else(|| format!("git cannot read the tree of {LOG_BRANCH} at {commit}"))?;
    let mut entries = Vec::new();
    for entry in listed.split(|&b| b == 0).filter(|e| !e.is_empty()) {
        let entry = String::from_utf8_lossy(entry);
        let Some((head, path)) = entry.split_once('\t') else {
            continue;
        };
        let parts: Vec<&str> = head.split(' ').collect();
        let [mode, kind, object] = parts[..] else {
            continue;
        };
        entries.push((
            path.to_string(),
            kind == "blob" && mode != "120000",
            object.to_string(),
        ));
    }
    let asked: String = entries
        .iter()
        .filter(|e| e.1)
        .map(|e| format!("{}\n", e.2))
        .collect();
    let mut contents = std::collections::HashMap::new();
    if !asked.is_empty() {
        let out = run(repo, &["cat-file", "--batch"], Some(asked.as_bytes()))
            .ok_or_else(|| format!("git cannot read the files of {LOG_BRANCH} at {commit}"))?;
        let mut at = 0;
        for entry in entries.iter().filter(|e| e.1) {
            let end = at + out[at..].iter().position(|&b| b == b'\n').unwrap_or(0);
            let header = String::from_utf8_lossy(&out[at..end]).into_owned();
            let size: usize = header
                .split(' ')
                .nth(2)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let bytes = out.get(end + 1..end + 1 + size).unwrap_or(&[]).to_vec();
            contents.insert(entry.2.clone(), bytes);
            at = end + 1 + size + 1;
        }
    }
    Ok(entries
        .into_iter()
        .map(|(path, plain, object)| LogFile {
            bytes: if plain {
                contents.get(&object).cloned().unwrap_or_default()
            } else {
                Vec::new()
            },
            path,
            plain,
        })
        .collect())
}

/// Whether `path` is `events/<aa>/<hash>.json` with `<aa>` the first two digits of `<hash>`; its hash when it is.
fn named_hash(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("events/")?;
    let (folder, file) = rest.split_once('/')?;
    let hash = file.strip_suffix(".json")?;
    let lower_hex = |s: &str| s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let ok = folder.len() == 2
        && hash.len() == 64
        && lower_hex(folder)
        && lower_hex(hash)
        && hash.starts_with(folder);
    ok.then_some(hash)
}

/// What one file of the log holds, and its faults: its place, its name, its content.
pub fn examine(file: &LogFile) -> LogEntry {
    let hash = hex(&Sha256::digest(&file.bytes));
    let entry = |event: Option<Value>, faults: Vec<String>| LogEntry {
        path: file.path.clone(),
        event,
        hash: hash.clone(),
        faults,
    };
    if !file.plain {
        return entry(None, vec![NOT_FILE.to_string()]);
    }
    let mut faults = Vec::new();
    match named_hash(&file.path) {
        None => faults.push(PLACE.to_string()),
        Some(named) if named != hash => faults.push(NAME.to_string()),
        Some(_) => {}
    }
    // An event stands one level down in a line of the ledger: it is held to the depth an event may have there.
    let value = std::str::from_utf8(&file.bytes)
        .ok()
        .filter(|_| check_depth(&file.bytes, MAX_DEPTH - 1).is_ok())
        .and_then(|text| parse_json(text).ok());
    let Some(value) = value else {
        faults.push(NOT_JSON.to_string());
        return entry(None, faults);
    };
    let refused = event_faults(&value);
    if !refused.is_empty() {
        faults.extend(refused.into_iter().map(|f| format!("event: {f}")));
        return entry(None, faults);
    }
    if fixed_form(&value) != file.bytes {
        faults.push(NOT_FIXED.to_string());
    }
    entry(Some(value), faults)
}

/// The commit that last wrote `path` on the log up to `head`: the one that holds the file as it stands. `head` when
/// git cannot say.
pub fn commit_of_file(repo: &str, head: &str, path: &str) -> String {
    let out = run(
        repo,
        &[
            "--literal-pathspecs",
            "log",
            "-1",
            "--format=%H",
            head,
            "--",
            path,
        ],
        None,
    );
    let commit = out
        .map(|o| String::from_utf8_lossy(&o).trim().to_string())
        .unwrap_or_default();
    if commit.is_empty() {
        head.to_string()
    } else {
        commit
    }
}

/// The check of the log of `repo`, for `howl verify`, as `verifyLog` in src/ledger/log.ts: each file is named by the
/// hash of its content, stands in `events/<aa>/`, and holds the fixed form of an event the schema accepts; a fault
/// names the file and the commit that holds it. Two files with one id and different content are a fault naming the id
/// (#199). None when there is no branch howl/log.
pub fn verify_log(repo: &str) -> Result<Option<LogVerdict>, String> {
    let Some(head) = log_head(repo) else {
        return Ok(None);
    };
    let entries: Vec<LogEntry> = log_files(repo, &head)?.iter().map(examine).collect();
    let mut faults = Vec::new();
    for entry in entries.iter().filter(|e| !e.faults.is_empty()) {
        faults.push(format!(
            "{}, commit {}: {}",
            entry.path,
            commit_of_file(repo, &head, &entry.path),
            entry.faults.join("; ")
        ));
    }
    // The ids in the order they are first met, each with its hashes and the first file of each.
    let mut ids: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for entry in &entries {
        let Some(id) = entry
            .event
            .as_ref()
            .and_then(|e| e.get("id"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let at = match ids.iter().position(|(known, _)| known == id) {
            Some(at) => at,
            None => {
                ids.push((id.to_string(), Vec::new()));
                ids.len() - 1
            }
        };
        let held = &mut ids[at].1;
        if !held.iter().any(|(hash, _)| hash == &entry.hash) {
            held.push((entry.hash.clone(), entry.path.clone()));
        }
    }
    for (id, held) in ids.iter().filter(|(_, held)| held.len() > 1) {
        let paths: Vec<&str> = held.iter().map(|(_, path)| path.as_str()).collect();
        faults.push(format!(
            "id {id} is in more than one file, with different content: {}",
            paths.join(", ")
        ));
    }
    Ok(Some(LogVerdict {
        head,
        files: entries.len(),
        faults,
    }))
}
