// The check of a ledger file: the twin of `verify` in src/ledger/verify.ts (#140). For every line, from the first: it
// is JSON, it follows the line schema, its event follows the event schema, `hash` is the hash of the event, and `prev`
// is the hash of the line before. It stops at the first line that fails. It writes nothing and takes no lock.
//
// What the check cannot show: lines cut off the end. The head it reports has to be compared with one kept elsewhere.
// @code_class evidence
use crate::ledger::fixed::event_hash;
use crate::ledger::json::{parse_json, JsonError};
use crate::ledger::line::hash_line;
use crate::ledger::schema::{event_faults, line_faults};
use serde_json::Value;
use std::fs::File;
use std::io::{ErrorKind, Read};
use std::path::Path;

/// What the check of a ledger comes to.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// Every line holds. `events` holds the events of the lines in order when `verify` gave it; `verify_each` hands
    /// them over one by one instead and leaves it empty.
    Holds { lines: usize, head: String, trial: bool, events: Vec<Value> },
    /// Line `line` does not hold, after `lines` that do.
    Fails { lines: usize, line: usize, faults: Vec<String> },
}

/// Checks the ledger at `path`, keeping its events. Err is a file that cannot be read, in Node's words.
pub fn verify(path: &Path) -> Result<Verdict, String> {
    let mut events = Vec::new();
    let verdict = verify_each(path, |_, event| events.push(event.clone()))?;
    Ok(match verdict {
        Verdict::Holds { lines, head, trial, .. } => Verdict::Holds { lines, head, trial, events },
        fails => fails,
    })
}

/// Checks the ledger at `path`, handing each event of a line that holds to `each` with the number of its line.
pub fn verify_each(path: &Path, mut each: impl FnMut(usize, &Value)) -> Result<Verdict, String> {
    let shown = path.to_string_lossy();
    let mut file = File::open(path).map_err(|e| node_error(&e, &format!("open '{shown}'")))?;
    let mut lines = 0;
    let mut head: Option<String> = None;
    let mut trial = false;
    let mut pending: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = match file.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(node_error(&e, "read")),
        };
        let mut from = 0;
        while let Some(i) = chunk[from..n].iter().position(|&b| b == b'\n') {
            let end = from + i;
            let line: &[u8] = if pending.is_empty() {
                &chunk[from..end]
            } else {
                pending.extend_from_slice(&chunk[from..end]);
                &pending
            };
            lines += 1;
            let expected = head.replace(hash_line(line));
            let faults = check(line, lines, expected.as_deref(), &mut trial, &mut each);
            if !faults.is_empty() {
                return Ok(Verdict::Fails { lines: lines - 1, line: lines, faults });
            }
            pending.clear();
            from = end + 1;
        }
        pending.extend_from_slice(&chunk[from..n]);
    }
    if !pending.is_empty() {
        let faults = vec!["the line is cut off: it does not end with a line break".to_string()];
        return Ok(Verdict::Fails { lines, line: lines + 1, faults });
    }
    match head {
        None => {
            let faults = vec!["the ledger is empty: it has no first line".to_string()];
            Ok(Verdict::Fails { lines: 0, line: 1, faults })
        }
        Some(head) => Ok(Verdict::Holds { lines, head, trial, events: Vec::new() }),
    }
}

/// The faults of line `n`; empty when it holds, and then its event goes to `each`.
fn check(
    bytes: &[u8],
    n: usize,
    expected: Option<&str>,
    trial: &mut bool,
    each: &mut impl FnMut(usize, &Value),
) -> Vec<String> {
    // 1. JSON, in strict UTF-8; a byte order mark at the start is passed over, as TextDecoder does.
    if bytes.is_empty() {
        return vec!["the line is empty".to_string()];
    }
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let Ok(text) = std::str::from_utf8(bytes) else {
        return vec!["the line is not JSON".to_string()];
    };
    let value = match parse_json(text) {
        Ok(value) => value,
        Err(e @ JsonError::LoneSurrogate) => return vec![format!("the line: {e}")],
        Err(e) => return vec![format!("the line is {e}")],
    };

    // 2. The line schema. Without it the other checks have nothing to stand on.
    let mut faults: Vec<String> = line_faults(&value).into_iter().map(|f| format!("line: {f}")).collect();
    if !faults.is_empty() {
        return faults;
    }
    let event = &value["event"];

    // 3. The event schema, and the rules of the first line.
    faults.extend(event_faults(event).into_iter().map(|f| format!("event: {f}")));
    let created = event.get("type").and_then(Value::as_str) == Some("ledger.created");
    if n == 1 {
        if !created {
            faults.push("event: type: the first line must be ledger.created".to_string());
        }
        let mode = event.get("data").filter(|d| d.is_object()).and_then(|d| d.get("mode"));
        *trial = mode.and_then(Value::as_str) == Some("trial");
    } else if created {
        faults.push("event: type: only the first line can be ledger.created".to_string());
    }

    // 4. hash. A value parse_json read always has a fixed form.
    if Some(event_hash(event).as_str()) != value["hash"].as_str() {
        faults.push("hash: is not the hash of the event: the event was changed".to_string());
    }

    // 5. prev
    if value["prev"].as_str() != expected {
        faults.push(if n == 1 {
            "prev: is not null, so this is not the first line of a ledger: lines before it were removed".to_string()
        } else {
            let before = n - 1;
            format!(
                "prev: is not the hash of line {before}: line {before} was changed, or lines were removed or added between the two"
            )
        });
    }
    if faults.is_empty() {
        each(n, event);
    }
    faults
}

/// An error of the file as Node words it: `ENOENT: no such file or directory, open '<path>'`. Another error is said
/// as Rust says it.
fn node_error(error: &std::io::Error, call: &str) -> String {
    let (code, words) = match error.raw_os_error() {
        Some(2) => ("ENOENT", "no such file or directory"),
        Some(13) => ("EACCES", "permission denied"),
        Some(20) => ("ENOTDIR", "not a directory"),
        Some(21) => ("EISDIR", "illegal operation on a directory"),
        _ => return error.to_string(),
    };
    format!("{code}: {words}, {call}")
}
