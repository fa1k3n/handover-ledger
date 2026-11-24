// The inbox: one file per event, left by hooks and scripts, taken in by the one writer. The twin of `leave` in
// src/inbox/inbox.ts (#141).
//
// A file is written under a temporary name that starts with a dot, and then renamed. The writer only takes names that
// end in `.json`, so it never sees a file that is half written. Names sort by the time they were left.
// @code_class recording
use crate::howl::path::join;
use crate::ledger::fixed::fixed_form;
use serde_json::Value;
use std::fs::{DirBuilder, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since 1970, as `Date.now()`.
pub fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(after) => after.as_millis() as i64,
        Err(before) => -(before.duration().as_millis() as i64),
    }
}

/// A random UUID of version 4, in lowercase, as `crypto.randomUUID()` gives it.
pub fn random_uuid() -> std::io::Result<String> {
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// The name of an inbox file: the time in milliseconds to 15 digits, a dash, a UUID, `.json`.
pub fn inbox_name(ms: i64, uuid: &str) -> String {
    format!("{ms:015}-{uuid}.json")
}

/// Why an event could not be left: the words of Node's error for the call that failed (`ENOTDIR: not a directory,
/// mkdir '/x/inbox'`), as the TypeScript's `howl emit` ends with them, and the code at their start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaveError {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for LeaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for LeaveError {}

impl LeaveError {
    /// A fault that is no failure of a call: its words, with no code.
    pub fn other(message: String) -> LeaveError {
        LeaveError {
            code: String::new(),
            message,
        }
    }

    /// The error of a call of `syscall`, on `what` (a path, or `'a' -> 'b'`, or nothing), in Node's words.
    fn of(error: &std::io::Error, syscall: &str, what: &str) -> LeaveError {
        let (code, words) = match error.raw_os_error() {
            Some(1) => ("EPERM", "operation not permitted"),
            Some(2) => ("ENOENT", "no such file or directory"),
            Some(5) => ("EIO", "i/o error"),
            Some(13) => ("EACCES", "permission denied"),
            Some(17) => ("EEXIST", "file already exists"),
            Some(20) => ("ENOTDIR", "not a directory"),
            Some(21) => ("EISDIR", "illegal operation on a directory"),
            Some(24) => ("EMFILE", "too many open files"),
            Some(28) => ("ENOSPC", "no space left on device"),
            Some(30) => ("EROFS", "read-only file system"),
            Some(36) => ("ENAMETOOLONG", "name too long"),
            _ => ("", ""),
        };
        let place = if what.is_empty() {
            String::new()
        } else {
            format!(" {what}")
        };
        let message = if code.is_empty() {
            format!("{error}, {syscall}{place}")
        } else {
            format!("{code}: {words}, {syscall}{place}")
        };
        LeaveError {
            code: code.to_string(),
            message,
        }
    }
}

/// Leaves an event in the inbox, in its fixed form. Gives the path of the file.
pub fn leave(inbox: &str, event: &Value) -> Result<String, LeaveError> {
    let bytes = fixed_form(event);
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(inbox)
        .map_err(|e| LeaveError::of(&e, "mkdir", &format!("'{inbox}'")))?;
    let name = inbox_name(
        now_ms(),
        &random_uuid().map_err(|e| LeaveError::of(&e, "open", "'/dev/urandom'"))?,
    );
    let temporary = join(&[inbox, &format!(".{name}.tmp")]);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|e| LeaveError::of(&e, "open", &format!("'{temporary}'")))?;
    if let Err(e) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&temporary);
        return Err(LeaveError::of(&e, "write", ""));
    }
    drop(file);
    let path = join(&[inbox, &name]);
    std::fs::rename(&temporary, &path)
        .map_err(|e| LeaveError::of(&e, "rename", &format!("'{temporary}' -> '{path}'")))?;
    Ok(path)
}
