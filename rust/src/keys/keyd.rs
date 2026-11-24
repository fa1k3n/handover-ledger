// The client of `howl keyd` (#24), as `request` and `parseKeydKey` of src/keys/keyd.ts do it (#142): one JSON line on
// the Unix socket, one JSON line back, all within the time given. Whatever goes wrong, the answer is `Unreachable`:
// keyd gave no answer, as against a refusal, which is an answer. The service itself stays the TypeScript.
// @code_class evidence
use serde_json::Value;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The most of an answer that is read before its line ends: more is not keyd's.
const MOST: usize = 1024 * 1024;

/// `keyd:<socket>#<key id>:<token>`, the HOWL_KEY of a session that signs through keyd.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeydKey {
    pub socket: String,
    pub key: String,
    pub token: String,
}

/// `/^keyd:(.+)#([0-9a-f]{64}):([0-9a-f]{64})$/`: the socket is one or more signs that are no line break, as `.` is.
pub fn parse_keyd_key(value: &str) -> Option<KeydKey> {
    let rest = value.strip_prefix("keyd:")?;
    // `#`, 64 digits, `:` and 64 digits are 130 bytes of ASCII at the end.
    let at = rest.len().checked_sub(130)?;
    let (socket, tail) = (rest.get(..at)?, rest.get(at..)?);
    let tail = tail.strip_prefix('#')?;
    let (key, token) = (tail.get(..64)?, tail.get(65..)?);
    if tail.get(64..65)? != ":" {
        return None;
    }
    let hex = |s: &str| s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let line_break = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    if socket.is_empty() || socket.chars().any(line_break) || !hex(key) || !hex(token) {
        return None;
    }
    Some(KeydKey {
        socket: socket.to_string(),
        key: key.to_string(),
        token: token.to_string(),
    })
}

/// What keyd said, or that it said nothing.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    /// A line of JSON came back: a signature, or a refusal.
    Reply(Value),
    /// No socket, no answer in time, or an answer that is not JSON; the words say which.
    Unreachable(String),
}

/// One request to keyd and its answer. The connection and the answer are within `timeout_ms` in all.
pub fn request(socket: &str, req: &Value, timeout_ms: u64) -> Answer {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let (send, receive) = mpsc::channel();
    let (socket, line) = (socket.to_string(), format!("{req}\n"));
    // A connection to a Unix socket has no time of its own: it is made beside the wait, which gives up at the time.
    std::thread::spawn(move || {
        let _ = send.send(exchange(&socket, &line, deadline));
    });
    let wait = deadline.saturating_duration_since(Instant::now());
    match receive.recv_timeout(wait) {
        Ok(answer) => answer,
        Err(_) => Answer::Unreachable("keyd did not answer".to_string()),
    }
}

fn exchange(socket: &str, line: &str, deadline: Instant) -> Answer {
    let unreachable = |e: std::io::Error| Answer::Unreachable(format!("keyd: {e}"));
    let mut stream = match UnixStream::connect(socket) {
        Ok(stream) => stream,
        Err(e) => return unreachable(e),
    };
    if let Err(e) = stream.write_all(line.as_bytes()) {
        return unreachable(e);
    }
    let mut data: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(at) = data.iter().position(|b| *b == b'\n') {
            let text = String::from_utf8_lossy(&data[..at]);
            return match serde_json::from_str::<Value>(&text) {
                Ok(value) => Answer::Reply(value),
                Err(_) => Answer::Unreachable("keyd's answer is not JSON".to_string()),
            };
        }
        if data.len() > MOST {
            return Answer::Unreachable("keyd's answer is not JSON".to_string());
        }
        let Some(wait) = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
        else {
            return Answer::Unreachable("keyd did not answer".to_string());
        };
        if let Err(e) = stream.set_read_timeout(Some(wait)) {
            return unreachable(e);
        }
        match stream.read(&mut chunk) {
            // Closed before the line ended: no answer comes.
            Ok(0) => return Answer::Unreachable("keyd did not answer".to_string()),
            Ok(n) => data.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return unreachable(e),
        }
    }
}
