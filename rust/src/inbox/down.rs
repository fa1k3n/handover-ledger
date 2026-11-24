// A service the hook asks (keyd, the writer's server) that did not answer is not asked again for a while, so that a
// dead one never slows a session. The time of the failure is kept in a file beside the ledger: the twin of
// `src/inbox/down.ts` (#142).
// @code_class recording
use crate::hook::hook::iso_time;
use crate::howl::path::dirname;
use crate::howl::project::js_trim;
use crate::inbox::inbox::now_ms;
use crate::keys::date_parse;
use std::fs::{DirBuilder, File};
use std::io::Read;

/// The most a time of failure is read from: a time is 24 characters, and a file of more says nothing.
const MOST: u64 = 4096;

/// Whether the service failed to answer within the last `pause_ms`. A file that cannot be read, or says no time, or a
/// time to come (the clock was wrong, or the file is not ours), is no failure.
pub fn recently_down(file: &str, pause_ms: i64) -> bool {
    let Some(text) = read(file) else {
        return false;
    };
    // Only the ISO forms howl writes are read; `Date.parse` of the TypeScript knows more.
    let Some(at) = date_parse(js_trim(&text)) else {
        return false;
    };
    let since = now_ms() as f64 - at;
    since.is_finite() && since >= 0.0 && since < pause_ms as f64
}

/// A plain file of a few bytes: a pipe in its place would hold the hook up.
fn read(file: &str) -> Option<String> {
    // Looked at before it is opened: opening a pipe would wait for the other end.
    if !std::fs::metadata(file).ok()?.is_file() {
        return None;
    }
    let handle = File::open(file).ok()?;
    let mut bytes = Vec::new();
    handle.take(MOST).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Notes that the service did not answer now. The caller never fails over this: it is asked again the next time.
pub fn mark_down(file: &str) {
    let _ = DirBuilder::new().recursive(true).create(dirname(file));
    let _ = std::fs::write(file, format!("{}\n", iso_time(now_ms())));
}
