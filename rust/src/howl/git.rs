// What howl reads from git, as `src/howl/git.ts`: never more than a few quick calls, each ended after a second, and
// never a path on the machine (#141).
// @code_class recording
use crate::howl::project::js_trim;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How long one call to git may take.
pub const GIT_LIMIT: Duration = Duration::from_secs(1);

/// Runs `program` in `dir` and gives its output trimmed, or none when it cannot start, fails, or takes longer than
/// `limit`: then it is killed. Standard input is empty, standard error is dropped.
pub fn run_limited(program: &str, args: &[&str], dir: &str, limit: Duration) -> Option<String> {
    let deadline = Instant::now() + limit;
    let mut child = Command::new(program)
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let (sender, receiver) = mpsc::channel();
    // The output is read beside the wait, so that a long answer never holds the child up.
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let read = out.read_to_end(&mut bytes);
        let _ = sender.send(read.map(|_| bytes));
    });
    let stop = |mut child: std::process::Child| {
        let _ = child.kill();
        let _ = child.wait();
        None
    };
    let bytes = match receiver.recv_timeout(limit) {
        Ok(Ok(bytes)) => bytes,
        _ => return stop(child),
    };
    // The output is closed: the child is ending. It is still held to the time left.
    let mut pause = Duration::from_micros(50);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(pause);
                pause = (pause * 2).min(Duration::from_millis(5));
            }
            _ => return stop(child),
        }
    };
    if !status.success() {
        return None;
    }
    Some(js_trim(&String::from_utf8_lossy(&bytes)).to_string())
}

/// Runs git in `dir`: its output without white space at either end, or none when git fails, is not there, or takes
/// more than a second.
pub fn git(dir: &str, args: &[&str]) -> Option<String> {
    run_limited("git", args, dir, GIT_LIMIT)
}

/// The URL of the remote `origin`, or none.
pub fn origin_url(dir: &str) -> Option<String> {
    git(dir, &["config", "--get", "remote.origin.url"])
}

/// `owner/name` from the URL of a remote, as `/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/` finds it, or none. Never a path on
/// the machine.
pub fn repo_name(url: Option<&str>) -> Option<String> {
    let url = url?;
    if url.is_empty() || url.starts_with('/') || url.starts_with("file:") {
        return None;
    }
    // The name holds no `/`, so it is the last part, with at most one `/` after it.
    let url = url.strip_suffix('/').unwrap_or(url);
    let slash = url.rfind('/')?;
    let last = &url[slash + 1..];
    if last.is_empty() {
        return None;
    }
    let before = &url[..slash];
    let owner = &before[before.rfind(['/', ':'])? + 1..];
    if owner.is_empty() {
        return None;
    }
    let name = match last.strip_suffix(".git") {
        Some(name) if !name.is_empty() => name,
        _ => last,
    };
    Some(format!("{owner}/{name}"))
}
