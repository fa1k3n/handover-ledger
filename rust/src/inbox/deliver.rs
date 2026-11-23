// How an event leaves a hook or a script (#64): to the writer's server when one runs for the project, else into the
// inbox. The twin of `src/inbox/deliver.ts` (#142).
//
// The server says where it is in `server.json` in the project's folder, with a token: whoever can read that file may
// send, as whoever can write the inbox may leave a file. Only an address of this machine is used, and only while the
// process that wrote the file is alive: a file left by a server that did not stop cleanly never sends an event to
// whatever took its port. Anything but a 200 leaves the event in the inbox, and a server that does not answer is not
// asked again for a minute.
//
// The client is HTTP/1.1 over a socket, as much of it as the answer of `howl up` needs. Never more than 500 ms in all.
// @code_class recording
use crate::howl::path::join;
use crate::howl::project::js_trim;
use crate::inbox::down::{mark_down, recently_down};
use crate::inbox::inbox::{leave, LeaveError};
use crate::ledger::fixed::fixed_form;
use crate::ledger::json::parse_json;
use crate::ledger::place::{inbox_path, project_dir, server_path, Env};
use serde_json::Value;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

/// How long a sender waits for the server: well within a tool call.
pub const SERVER_TIMEOUT_MS: u64 = 500;
/// After the server failed to answer, how long it is not asked again.
pub const SERVER_PAUSE_MS: i64 = 60_000;

/// The most of `server.json` that is read.
const SERVER_FILE_MOST: u64 = 64 * 1024;
/// The most of an answer's head that is read.
const HEAD_MOST: usize = 64 * 1024;
/// The most characters of an answer's body that count: more is not howl's.
const BODY_MOST: usize = 1024;

/// What `server.json` says, when it names a server on this machine, a token and a process that is alive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerFile {
    pub url: String,
    pub token: String,
    /// The process of the server.
    pub pid: i64,
}

/// What came of asking the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    /// 200 and `{"ok": true}`.
    Taken,
    /// Any other answer.
    Refused,
    /// No answer in time.
    Silent,
}

extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

/// Whether a process with this id runs. One of another user counts: it is there. An id beyond what the system
/// knows is no process, as Node's `process.kill` refuses it.
fn alive(pid: i64) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 sends nothing; the call only asks whether the process is there and may be signalled.
    if unsafe { kill(pid, 0) } == 0 {
        return true;
    }
    // EPERM: it is there, and another user's.
    std::io::Error::last_os_error().raw_os_error() == Some(1)
}

/// What `server.json` says, when it names a server on this machine, a token and a process that is alive; else none.
pub fn read_server_file(path: &str) -> Option<ServerFile> {
    // A plain, small file only: a pipe or a device in its place would hold the hook up. Looked at before it is opened.
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > SERVER_FILE_MOST {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(SERVER_FILE_MOST + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    let value = parse_json(&String::from_utf8_lossy(&bytes)).ok()?;
    let url = value.get("url")?.as_str()?;
    let token = value.get("token")?.as_str()?;
    // A token that cannot stand in a header is no token.
    if token.is_empty() || !token.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return None;
    }
    let pid = whole(value.get("pid")?)?;
    if pid <= 0 || !alive(pid) {
        return None;
    }
    address(url)?;
    Some(ServerFile {
        url: url.to_string(),
        token: token.to_string(),
        pid,
    })
}

/// A JSON number that is a whole number, as `Number.isInteger` has it.
fn whole(value: &Value) -> Option<i64> {
    let n = value.as_f64()?;
    (n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0).then_some(n as i64)
}

/// Where a server is: the addresses to try, the port and the host as the `Host` header gives it.
struct Address {
    addresses: Vec<SocketAddr>,
    host: String,
}

/// The address a `http:` URL on this machine names, in the forms `howl up` writes: `http://127.0.0.1:4317`, with
/// `localhost` or `[::1]` for the host, a port or none, and a path that is not used. The host is never looked up: a
/// name that is not one of the three is no address of this machine.
fn address(url: &str) -> Option<Address> {
    let rest = url.get(..7).filter(|s| s.eq_ignore_ascii_case("http://"))?;
    let rest = &url[rest.len()..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let (host, port) = if let Some(after) = authority.strip_prefix('[') {
        let (inside, after) = after.split_once(']')?;
        if inside != "::1" {
            return None;
        }
        (
            "[::1]".to_string(),
            after.strip_prefix(':').or(after.is_empty().then_some("")),
        )
    } else {
        match authority.split_once(':') {
            Some((host, port)) => (host.to_ascii_lowercase(), Some(port)),
            None => (authority.to_ascii_lowercase(), Some("")),
        }
    };
    let port = port?;
    if !port.bytes().all(|b| b.is_ascii_digit()) || port.len() > 5 {
        return None;
    }
    let number: u16 = if port.is_empty() {
        80
    } else {
        port.parse().ok()?
    };
    let loopback = match host.as_str() {
        "127.0.0.1" => vec![SocketAddr::from((Ipv4Addr::LOCALHOST, number))],
        "[::1]" => vec![SocketAddr::from((Ipv6Addr::LOCALHOST, number))],
        // Tried one after the other, without the resolver, so that the time holds.
        "localhost" => vec![
            SocketAddr::from((Ipv4Addr::LOCALHOST, number)),
            SocketAddr::from((Ipv6Addr::LOCALHOST, number)),
        ],
        _ => return None,
    };
    // The port stands in the `Host` header unless it is the one of the scheme.
    let host = if port.is_empty() || number == 80 {
        host
    } else {
        format!("{host}:{number}")
    };
    Some(Address {
        addresses: loopback,
        host,
    })
}

/// Hands the event to the writer's server, or leaves it in the inbox. Gives none when the server took it, else the
/// path of the file in the inbox.
pub fn deliver(project: &str, event: &Value, env: &Env) -> Result<Option<String>, LeaveError> {
    let inbox = inbox_path(project, env).map_err(LeaveError::other)?;
    let folder = project_dir(project, env).map_err(LeaveError::other)?;
    let Some(server) = read_server_file(&server_path(project, env).map_err(LeaveError::other)?)
    else {
        return leave(&inbox, event).map(Some);
    };
    let down = join(&[&folder, "server.down"]);
    if recently_down(&down, SERVER_PAUSE_MS) {
        return leave(&inbox, event).map(Some);
    }
    // Whatever goes wrong in asking, the event is not lost.
    let body = fixed_form(event);
    let answer = std::panic::catch_unwind(|| post(&server, &body, SERVER_TIMEOUT_MS))
        .unwrap_or(Answer::Refused);
    match answer {
        Answer::Taken => return Ok(None),
        Answer::Silent => mark_down(&down),
        Answer::Refused => {}
    }
    leave(&inbox, event).map(Some)
}

/// The time left until `deadline`, or none when it is past.
fn left(deadline: Instant) -> Option<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
}

/// Posts the body to `<url>/api/events` with the token, and says what came of it. All of it, the connection and the
/// whole answer, is within `timeout_ms`.
pub fn post(server: &ServerFile, body: &[u8], timeout_ms: u64) -> Answer {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let Some(target) = address(&server.url) else {
        return Answer::Refused;
    };
    let Some(mut stream) = connect(&target, deadline) else {
        return Answer::Silent;
    };
    let head = format!(
        "POST /api/events HTTP/1.1\r\nHost: {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nauthorization: Bearer {}\r\nconnection: close\r\n\r\n",
        target.host,
        body.len(),
        server.token
    );
    let mut request = head.into_bytes();
    request.extend_from_slice(body);
    let Some(wait) = left(deadline) else {
        return Answer::Silent;
    };
    if stream.set_write_timeout(Some(wait)).is_err() || stream.write_all(&request).is_err() {
        return Answer::Silent;
    }
    read_answer(&mut stream, deadline)
}

/// A connection to the first of the addresses that takes it, within the time.
fn connect(target: &Address, deadline: Instant) -> Option<TcpStream> {
    for address in &target.addresses {
        let wait = left(deadline)?;
        if let Ok(stream) = TcpStream::connect_timeout(address, wait) {
            return Some(stream);
        }
    }
    None
}

/// What one read of an answer found out.
enum Got {
    Bytes(usize),
    /// The other end closed.
    End,
    /// The time ran out, or the connection failed.
    Failed,
    TimedOut,
}

fn read_some(stream: &mut TcpStream, into: &mut [u8], deadline: Instant) -> Got {
    let Some(wait) = left(deadline) else {
        return Got::TimedOut;
    };
    if stream.set_read_timeout(Some(wait)).is_err() {
        return Got::Failed;
    }
    match stream.read(into) {
        Ok(0) => Got::End,
        Ok(n) => Got::Bytes(n),
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) =>
        {
            Got::TimedOut
        }
        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => Got::Bytes(0),
        Err(_) => Got::Failed,
    }
}

/// How the body of an answer ends.
enum Framing {
    Length(usize),
    Chunked,
    Close,
}

fn read_answer(stream: &mut TcpStream, deadline: Instant) -> Answer {
    // The head: up to the empty line.
    let mut data: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        if let Some(at) = find(&data, b"\r\n\r\n") {
            break at;
        }
        if data.len() > HEAD_MOST {
            return Answer::Silent;
        }
        match read_some(stream, &mut chunk, deadline) {
            Got::Bytes(n) => data.extend_from_slice(&chunk[..n]),
            // A connection that closes before the head is there, or a failed one: the server did not answer.
            Got::End | Got::Failed | Got::TimedOut => return Answer::Silent,
        }
    };
    let head = String::from_utf8_lossy(&data[..end]).into_owned();
    let mut lines = head.split("\r\n");
    let Some(status) = status_of(lines.next().unwrap_or_default()) else {
        // No HTTP: Node's parser stops with an error, and the server is as good as silent.
        return Answer::Silent;
    };
    let mut framing = Framing::Close;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Answer::Silent;
        };
        let (name, value) = (name.to_ascii_lowercase(), js_trim(value));
        if name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked") {
            framing = Framing::Chunked;
        } else if name == "content-length" && !matches!(framing, Framing::Chunked) {
            match value.parse::<usize>() {
                Ok(n) => framing = Framing::Length(n),
                Err(_) => return Answer::Silent,
            }
        }
    }
    // Only a 200 is read further; anything else is refused at once.
    if status != 200 {
        return Answer::Refused;
    }
    let mut body = data[end + 4..].to_vec();
    let complete = match framing {
        Framing::Length(n) => read_length(stream, &mut body, n, deadline).map(|()| body),
        Framing::Chunked => read_chunked(stream, body, deadline),
        Framing::Close => read_to_close(stream, &mut body, deadline).map(|()| body),
    };
    match complete {
        Ok(body) => taken(&body),
        Err(Stop::Silent) => Answer::Silent,
        Err(Stop::Refused) => Answer::Refused,
    }
}

enum Stop {
    /// The time ran out, or the framing was no HTTP.
    Silent,
    /// The answer is not howl's, or ended too soon.
    Refused,
}

/// Only howl's own answer counts: another program on the port may say 200 to anything.
fn taken(body: &[u8]) -> Answer {
    let text = String::from_utf8_lossy(body);
    if text.encode_utf16().count() > BODY_MOST {
        return Answer::Refused;
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(value) if value.get("ok") == Some(&Value::Bool(true)) => Answer::Taken,
        _ => Answer::Refused,
    }
}

/// Whether the body so far is more than howl's answer can be.
fn too_much(body: &[u8]) -> bool {
    // At most three bytes make a unit of UTF-16, so more than this many bytes are more than the limit of units.
    body.len() > 3 * BODY_MOST || String::from_utf8_lossy(body).encode_utf16().count() > BODY_MOST
}

fn read_length(
    stream: &mut TcpStream,
    body: &mut Vec<u8>,
    length: usize,
    deadline: Instant,
) -> Result<(), Stop> {
    let mut chunk = [0u8; 4096];
    loop {
        if too_much(body) {
            return Err(Stop::Refused);
        }
        if body.len() >= length {
            body.truncate(length);
            return Ok(());
        }
        match read_some(stream, &mut chunk, deadline) {
            Got::Bytes(n) => body.extend_from_slice(&chunk[..n]),
            Got::TimedOut => return Err(Stop::Silent),
            // Closed before the whole body came: it is cut short.
            Got::End | Got::Failed => return Err(Stop::Refused),
        }
    }
}

fn read_to_close(
    stream: &mut TcpStream,
    body: &mut Vec<u8>,
    deadline: Instant,
) -> Result<(), Stop> {
    let mut chunk = [0u8; 4096];
    loop {
        if too_much(body) {
            return Err(Stop::Refused);
        }
        match read_some(stream, &mut chunk, deadline) {
            Got::Bytes(n) => body.extend_from_slice(&chunk[..n]),
            Got::End => return Ok(()),
            Got::TimedOut => return Err(Stop::Silent),
            Got::Failed => return Err(Stop::Refused),
        }
    }
}

/// A body in chunks: each a size in hex (and an extension after `;`), a line break, that many bytes, a line break.
fn read_chunked(
    stream: &mut TcpStream,
    mut raw: Vec<u8>,
    deadline: Instant,
) -> Result<Vec<u8>, Stop> {
    let mut body = Vec::new();
    let mut at = 0;
    let mut chunk = [0u8; 4096];
    loop {
        if too_much(&body) {
            return Err(Stop::Refused);
        }
        // The size line.
        let line_end = loop {
            if let Some(i) = find(&raw[at..], b"\r\n") {
                break at + i;
            }
            if raw.len() - at > 1024 {
                return Err(Stop::Silent);
            }
            match read_some(stream, &mut chunk, deadline) {
                Got::Bytes(n) => raw.extend_from_slice(&chunk[..n]),
                Got::TimedOut => return Err(Stop::Silent),
                Got::End | Got::Failed => return Err(Stop::Refused),
            }
        };
        let line = String::from_utf8_lossy(&raw[at..line_end]).into_owned();
        let size_text = line.split(';').next().unwrap_or_default().trim();
        // A size that is no hex number is no HTTP: Node's parser fails.
        let Ok(size) = usize::from_str_radix(size_text, 16) else {
            return Err(Stop::Silent);
        };
        at = line_end + 2;
        if size == 0 {
            return Ok(body);
        }
        if size > 3 * BODY_MOST + body.len() {
            return Err(Stop::Refused);
        }
        // The data, and the line break after it.
        while raw.len() < at + size + 2 {
            match read_some(stream, &mut chunk, deadline) {
                Got::Bytes(n) => raw.extend_from_slice(&chunk[..n]),
                Got::TimedOut => return Err(Stop::Silent),
                Got::End | Got::Failed => return Err(Stop::Refused),
            }
        }
        body.extend_from_slice(&raw[at..at + size]);
        at += size + 2;
    }
}

/// The status of a status line of HTTP/1.x: `HTTP/1.1 200 OK`.
fn status_of(line: &str) -> Option<u16> {
    let rest = line.strip_prefix("HTTP/1.")?;
    let mut parts = rest.splitn(2, ' ');
    let minor = parts.next()?;
    if minor.len() != 1 || !minor.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let code = parts.next()?.get(..3)?;
    if !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    code.parse().ok()
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}
