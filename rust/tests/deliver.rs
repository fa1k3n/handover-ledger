// How an event leaves the hook: to the writer's server when one runs, else into the inbox; the twin of
// `src/inbox/deliver.ts` and `src/inbox/down.ts` (#142). The server here is a socket of the test's own.
// @code_class tests
use howl::inbox::deliver::{
    deliver, post, read_server_file, Answer, ServerFile, SERVER_PAUSE_MS, SERVER_TIMEOUT_MS,
};
use howl::inbox::down::{mark_down, recently_down};
use howl::inbox::inbox::now_ms;
use howl::ledger::fixed::fixed_form;
use howl::ledger::place::Env;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn folder(name: &str) -> PathBuf {
    // One folder for each call: the tests of a file run at the same time.
    static COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("howl-deliver-{}-{n}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn s(path: &std::path::Path) -> String {
    path.to_str().unwrap().to_string()
}

fn env_of(home: &std::path::Path) -> Env {
    Env {
        howl_home: Some(s(home)),
        xdg_state_home: None,
        home: Some("/nowhere".to_string()),
    }
}

fn event() -> Value {
    json!({"v": 0, "id": "e-1", "time": "2026-01-02T03:04:05.000Z", "type": "session.started",
        "source": {"adapter": "claude-code-hook", "kind": "claimed"}, "project": "example",
        "actor": {"kind": "agent", "id": "agent-å"}})
}

/// What a test server saw of a request.
#[derive(Debug, Clone, Default)]
struct Seen {
    head: String,
    body: Vec<u8>,
}

/// A server on 127.0.0.1 that answers each connection with the next of `replies` (the last again), and keeps what it saw.
struct Server {
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Server {
    fn start(replies: Vec<Reply>) -> Server {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        std::thread::spawn(move || {
            let mut n = 0;
            for conn in listener.incoming() {
                let Ok(mut conn) = conn else { break };
                let reply = replies[n.min(replies.len() - 1)].clone();
                n += 1;
                let log = Arc::clone(&log);
                std::thread::spawn(move || {
                    let request = read_request(&mut conn);
                    log.lock().unwrap().push(request);
                    match reply {
                        Reply::Bytes(bytes) => {
                            let _ = conn.write_all(&bytes);
                        }
                        Reply::Parts(parts, pause) => {
                            for part in parts {
                                let _ = conn.write_all(&part);
                                let _ = conn.flush();
                                std::thread::sleep(pause);
                            }
                        }
                        Reply::Silent => std::thread::sleep(Duration::from_secs(3)),
                        Reply::Close => {}
                    }
                });
            }
        });
        Server { port, seen }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn calls(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
}

#[derive(Clone)]
enum Reply {
    Bytes(Vec<u8>),
    Parts(Vec<Vec<u8>>, Duration),
    Silent,
    Close,
}

fn http(status: &str, headers: &[&str], body: &str) -> Reply {
    let mut text = format!("HTTP/1.1 {status}\r\n");
    for h in headers {
        text.push_str(h);
        text.push_str("\r\n");
    }
    text.push_str("\r\n");
    text.push_str(body);
    Reply::Bytes(text.into_bytes())
}

fn ok_json(status: u16, body: &str) -> Reply {
    let length = format!("content-length: {}", body.len());
    http(
        &format!("{status} X"),
        &["content-type: application/json", &length],
        body,
    )
}

fn read_request(conn: &mut TcpStream) -> Seen {
    conn.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut data = Vec::new();
    let mut byte = [0u8; 1];
    while !data.ends_with(b"\r\n\r\n") {
        if conn.read_exact(&mut byte).is_err() {
            break;
        }
        data.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&data).to_string();
    let length = head
        .lines()
        .find_map(|l| {
            l.to_lowercase()
                .strip_prefix("content-length:")
                .map(|v| v.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    let _ = conn.read_exact(&mut body);
    Seen { head, body }
}

fn server_file(url: &str, pid: u32) -> ServerFile {
    let text = json!({"url": url, "token": TOKEN, "pid": pid}).to_string();
    let dir = folder("file");
    let path = dir.join("server.json");
    fs::write(&path, text).unwrap();
    read_server_file(&s(&path)).expect("a server file that holds")
}

fn answer_of(server: &Server, body: &[u8]) -> Answer {
    post(
        &server_file(&server.url(), std::process::id()),
        body,
        SERVER_TIMEOUT_MS,
    )
}

// ----- the server file

fn read_text(text: &str) -> Option<ServerFile> {
    let dir = folder("read");
    let path = dir.join("server.json");
    fs::write(&path, text).unwrap();
    read_server_file(&s(&path))
}

#[test]
fn a_server_file_names_a_url_a_token_and_a_live_process() {
    let pid = std::process::id();
    let good = json!({"url": "http://127.0.0.1:4317", "token": TOKEN, "pid": pid}).to_string();
    let server = read_text(&good).unwrap();
    assert_eq!(
        (server.url.as_str(), server.token.as_str(), server.pid),
        ("http://127.0.0.1:4317", TOKEN, pid as i64)
    );
    // The three addresses of this machine, and a path after the port, which the post does not use.
    for url in [
        "http://localhost:4317",
        "http://LOCALHOST:1",
        "http://[::1]:4317",
        "http://127.0.0.1",
        "http://127.0.0.1:4317/base/",
    ] {
        let text = json!({"url": url, "token": TOKEN, "pid": pid}).to_string();
        assert!(read_text(&text).is_some(), "{url}");
    }
    // A number written as a float is a whole number to JavaScript.
    let float = format!("{{\"url\":\"http://127.0.0.1:1\",\"token\":\"t\",\"pid\":{pid}.0}}");
    assert!(read_text(&float).is_some());
}

#[test]
fn a_server_file_that_does_not_hold_is_passed_over() {
    let pid = std::process::id();
    let with = |url: Value, token: Value, pid: Value| {
        json!({"url": url, "token": token, "pid": pid}).to_string()
    };
    let good = |url: &str| with(json!(url), json!(TOKEN), json!(pid));
    let cases = [
        ("another machine", good("http://example.invalid:4317")),
        ("https", good("https://127.0.0.1:4317")),
        (
            "a name that starts as the address",
            good("http://127.0.0.1.evil.test:4317"),
        ),
        ("a user name", good("http://user@127.0.0.1:4317")),
        ("a short form of the address", good("http://127.1:4317")),
        (
            "the address of another machine of the net",
            good("http://10.0.0.1:4317"),
        ),
        ("not a url", good("127.0.0.1:4317")),
        ("a port too large", good("http://127.0.0.1:99999")),
        ("a port that is not a number", good("http://127.0.0.1:abc")),
        ("white space", good(" http://127.0.0.1:4317")),
        (
            "no token",
            json!({"url": "http://127.0.0.1:1", "pid": pid}).to_string(),
        ),
        (
            "an empty token",
            with(json!("http://127.0.0.1:1"), json!(""), json!(pid)),
        ),
        (
            "a token with a line break",
            with(json!("http://127.0.0.1:1"), json!("a\nb"), json!(pid)),
        ),
        (
            "a token with a space",
            with(json!("http://127.0.0.1:1"), json!("a b"), json!(pid)),
        ),
        (
            "a token beyond ASCII",
            with(
                json!("http://127.0.0.1:1"),
                json!("snow\u{2603}man"),
                json!(pid),
            ),
        ),
        (
            "a token that is a number",
            with(json!("http://127.0.0.1:1"), json!(5), json!(pid)),
        ),
        (
            "a pid that is no whole number",
            with(json!("http://127.0.0.1:1"), json!(TOKEN), json!(1.5)),
        ),
        (
            "pid 0",
            with(json!("http://127.0.0.1:1"), json!(TOKEN), json!(0)),
        ),
        (
            "a negative pid",
            with(json!("http://127.0.0.1:1"), json!(TOKEN), json!(-5)),
        ),
        (
            "a pid as text",
            with(
                json!("http://127.0.0.1:1"),
                json!(TOKEN),
                json!(pid.to_string()),
            ),
        ),
        (
            "a pid beyond 2^31",
            with(
                json!("http://127.0.0.1:1"),
                json!(TOKEN),
                json!(4_294_967_296u64),
            ),
        ),
        ("not JSON", "{not json".to_string()),
        ("an array", "[1]".to_string()),
        ("null", "null".to_string()),
        ("empty", String::new()),
    ];
    for (label, text) in cases {
        assert!(read_text(&text).is_none(), "{label}");
    }
}

#[test]
fn a_server_file_of_a_process_that_is_gone_is_passed_over() {
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    let text = json!({"url": "http://127.0.0.1:1", "token": TOKEN, "pid": pid}).to_string();
    assert!(read_text(&text).is_none());
    // Another user's process counts as there: init.
    let init = json!({"url": "http://127.0.0.1:1", "token": TOKEN, "pid": 1}).to_string();
    assert!(read_text(&init).is_some());
}

#[test]
fn a_server_file_that_is_large_or_no_plain_file_is_passed_over_and_does_not_hold_anything_up() {
    let dir = folder("kinds");
    let good = json!({"url": "http://127.0.0.1:1", "token": TOKEN, "pid": std::process::id(), "pad": "x".repeat(70_000)}).to_string();
    let big = dir.join("big.json");
    fs::write(&big, good).unwrap();
    assert!(read_server_file(&s(&big)).is_none(), "more than 64 KiB");
    let small = json!({"url": "http://127.0.0.1:1", "token": TOKEN, "pid": std::process::id(), "pad": "x".repeat(60_000)}).to_string();
    fs::write(&big, small).unwrap();
    assert!(read_server_file(&s(&big)).is_some(), "less than 64 KiB");
    let started = Instant::now();
    let pipe = dir.join("pipe.json");
    assert!(std::process::Command::new("mkfifo")
        .arg(&pipe)
        .status()
        .unwrap()
        .success());
    assert!(read_server_file(&s(&pipe)).is_none());
    assert!(read_server_file(&s(&dir)).is_none(), "a folder");
    assert!(read_server_file(&s(&dir.join("missing"))).is_none());
    assert!(started.elapsed() < Duration::from_secs(2));
}

// ----- server.down

#[test]
fn a_service_that_failed_is_not_asked_for_a_pause_and_a_file_that_says_nothing_is_no_failure() {
    let dir = folder("down");
    let file = s(&dir.join("sub").join("server.down"));
    assert!(!recently_down(&file, SERVER_PAUSE_MS), "no file");
    mark_down(&file);
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.ends_with("Z\n") && text.len() == 25, "{text:?}");
    assert!(recently_down(&file, SERVER_PAUSE_MS));
    assert!(!recently_down(&file, 0), "a pause of nothing");
    let at = |ms: i64| format!("{}\n", howl::hook::hook::iso_time(ms));
    fs::write(&file, at(now_ms() - 120_000)).unwrap();
    assert!(
        !recently_down(&file, SERVER_PAUSE_MS),
        "older than the pause"
    );
    fs::write(&file, at(now_ms() - 30_000)).unwrap();
    assert!(recently_down(&file, SERVER_PAUSE_MS), "within it");
    fs::write(&file, at(now_ms() + 365 * 86_400_000)).unwrap();
    assert!(!recently_down(&file, SERVER_PAUSE_MS), "a time to come");
    for text in ["garbage\n", "", "\n"] {
        fs::write(&file, text).unwrap();
        assert!(!recently_down(&file, SERVER_PAUSE_MS), "{text:?}");
    }
    // White space round the time is trimmed.
    fs::write(&file, format!("  {}  \n", at(now_ms() - 1000).trim())).unwrap();
    assert!(recently_down(&file, SERVER_PAUSE_MS));
}

// ----- the post

#[test]
fn the_request_is_a_post_of_the_body_with_its_headers() {
    let server = Server::start(vec![ok_json(200, "{\"ok\":true}")]);
    let body = fixed_form(&event());
    assert_eq!(answer_of(&server, &body), Answer::Taken);
    let seen = server.seen.lock().unwrap()[0].clone();
    let lines: Vec<&str> = seen.head.split("\r\n").collect();
    assert_eq!(lines[0], "POST /api/events HTTP/1.1");
    let header = |name: &str| {
        lines.iter().find_map(|l| {
            l.to_lowercase()
                .strip_prefix(&format!("{name}:"))
                .map(|v| v.trim().to_string())
        })
    };
    assert_eq!(header("host"), Some(format!("127.0.0.1:{}", server.port)));
    assert_eq!(header("authorization"), Some(format!("bearer {TOKEN}")));
    // The token is sent as it is written, not in lower case.
    assert!(seen.head.contains(&format!("Bearer {TOKEN}")));
    assert_eq!(header("content-type"), Some("application/json".to_string()));
    assert_eq!(header("content-length"), Some(body.len().to_string()));
    assert_eq!(header("connection"), Some("close".to_string()));
    assert_eq!(seen.body, body);
}

#[test]
fn only_a_200_with_ok_true_has_taken_the_event() {
    let cases: Vec<(&str, Reply, Answer)> = vec![
        ("ok", ok_json(200, "{\"ok\":true}"), Answer::Taken),
        (
            "ok with room and more",
            ok_json(200, " {\"id\":1, \"ok\" : true }\n"),
            Answer::Taken,
        ),
        (
            "ok given twice, the last holds",
            ok_json(200, "{\"ok\":false,\"ok\":true}"),
            Answer::Taken,
        ),
        ("ok false", ok_json(200, "{\"ok\":false}"), Answer::Refused),
        (
            "ok as text",
            ok_json(200, "{\"ok\":\"true\"}"),
            Answer::Refused,
        ),
        ("no ok", ok_json(200, "{}"), Answer::Refused),
        ("an array", ok_json(200, "[true]"), Answer::Refused),
        ("null", ok_json(200, "null"), Answer::Refused),
        ("html", ok_json(200, "<p>hello</p>"), Answer::Refused),
        ("empty", ok_json(200, ""), Answer::Refused),
        ("401", ok_json(401, "{\"error\":\"no\"}"), Answer::Refused),
        ("400", ok_json(400, "{\"error\":\"no\"}"), Answer::Refused),
        ("500", ok_json(500, "{\"error\":\"no\"}"), Answer::Refused),
        ("204", http("204 No Content", &[], ""), Answer::Refused),
        (
            "a redirect",
            http("302 Found", &["location: http://elsewhere.invalid/"], ""),
            Answer::Refused,
        ),
        (
            "HTTP/1.0",
            Reply::Bytes(b"HTTP/1.0 200 OK\r\n\r\n{\"ok\":true}".to_vec()),
            Answer::Taken,
        ),
        (
            "the body ends at the close",
            http("200 OK", &[], "{\"ok\":true}"),
            Answer::Taken,
        ),
        (
            "a chunked body",
            http(
                "200 OK",
                &["transfer-encoding: chunked"],
                "5\r\n{\"ok\"\r\n6\r\n:true}\r\n0\r\n\r\n",
            ),
            Answer::Taken,
        ),
        (
            "a chunked body with an extension",
            http(
                "200 OK",
                &["Transfer-Encoding: Chunked"],
                "b;x=y\r\n{\"ok\":true}\r\n0\r\n\r\n",
            ),
            Answer::Taken,
        ),
        (
            "a body cut short",
            http("200 OK", &["content-length: 50"], "{\"ok\":true"),
            Answer::Refused,
        ),
        (
            "a chunk cut short",
            http(
                "200 OK",
                &["transfer-encoding: chunked"],
                "20\r\n{\"ok\":true}",
            ),
            Answer::Refused,
        ),
        (
            "more than 1024 characters",
            ok_json(
                200,
                &format!("{{\"ok\":true,\"pad\":\"{}\"}}", "x".repeat(1100)),
            ),
            Answer::Refused,
        ),
        (
            "1024 characters",
            ok_json(
                200,
                &format!("{{\"ok\":true,\"pad\":\"{}\"}}", "x".repeat(1024 - 20)),
            ),
            Answer::Taken,
        ),
        (
            "1024 characters beyond ASCII, more bytes",
            ok_json(
                200,
                &format!("{{\"ok\":true,\"pad\":\"{}\"}}", "\u{e5}".repeat(1024 - 20)),
            ),
            Answer::Taken,
        ),
        (
            "1025 characters",
            ok_json(
                200,
                &format!("{{\"ok\":true,\"pad\":\"{}\"}}", "x".repeat(1025 - 20)),
            ),
            Answer::Refused,
        ),
    ];
    for (label, reply, expected) in cases {
        let server = Server::start(vec![reply]);
        assert_eq!(answer_of(&server, b"{}"), expected, "{label}");
    }
}

#[test]
fn a_reply_that_is_no_http_or_no_reply_at_all_is_silence() {
    let cases: Vec<(&str, Reply)> = vec![
        ("the connection closed", Reply::Close),
        (
            "a text that is no HTTP",
            Reply::Bytes(b"hello there\r\n\r\n".to_vec()),
        ),
        (
            "a status line cut short",
            Reply::Bytes(b"HTTP/1.1 20".to_vec()),
        ),
        (
            "headers cut short",
            Reply::Bytes(b"HTTP/1.1 200 OK\r\ncontent-le".to_vec()),
        ),
        (
            "another protocol",
            Reply::Bytes(b"SSH-2.0-OpenSSH_9.9\r\n".to_vec()),
        ),
    ];
    for (label, reply) in cases {
        let server = Server::start(vec![reply]);
        assert_eq!(answer_of(&server, b"{}"), Answer::Silent, "{label}");
    }
}

#[test]
fn a_server_that_never_answers_is_given_500_ms_in_all() {
    let server = Server::start(vec![Reply::Silent]);
    let started = Instant::now();
    assert_eq!(answer_of(&server, b"{}"), Answer::Silent);
    let took = started.elapsed();
    assert!(
        took >= Duration::from_millis(450) && took < Duration::from_millis(900),
        "{took:?}"
    );
}

#[test]
fn the_500_ms_is_for_the_whole_reply_a_body_that_trickles_in_is_cut_off() {
    let parts = vec![
        b"HTTP/1.1 200 OK\r\ncontent-length: 11\r\n\r\n".to_vec(),
        b"{\"ok\"".to_vec(),
        b":".to_vec(),
        b"true".to_vec(),
        b"}".to_vec(),
    ];
    let server = Server::start(vec![Reply::Parts(parts, Duration::from_millis(200))]);
    let started = Instant::now();
    assert_eq!(answer_of(&server, b"{}"), Answer::Silent);
    assert!(
        started.elapsed() < Duration::from_millis(900),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn a_non_200_is_refused_at_once_without_waiting_for_its_body() {
    let parts = vec![
        b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 100\r\n\r\n".to_vec(),
        b"{".to_vec(),
    ];
    let server = Server::start(vec![Reply::Parts(parts, Duration::from_secs(2))]);
    let started = Instant::now();
    assert_eq!(answer_of(&server, b"{}"), Answer::Refused);
    assert!(started.elapsed() < Duration::from_millis(400));
}

#[test]
fn a_port_nothing_listens_on_is_silence() {
    let port = {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.local_addr().unwrap().port()
    };
    let server = ServerFile {
        url: format!("http://127.0.0.1:{port}"),
        token: TOKEN.to_string(),
        pid: std::process::id() as i64,
    };
    assert_eq!(post(&server, b"{}", SERVER_TIMEOUT_MS), Answer::Silent);
}

#[test]
fn localhost_is_tried_as_the_ipv4_address_and_then_as_the_ipv6_one() {
    let server = Server::start(vec![ok_json(200, "{\"ok\":true}")]);
    let at = ServerFile {
        url: format!("http://localhost:{}", server.port),
        token: TOKEN.to_string(),
        pid: std::process::id() as i64,
    };
    assert_eq!(post(&at, b"{}", SERVER_TIMEOUT_MS), Answer::Taken);
    // A server on ::1 only.
    let Ok(listener) = TcpListener::bind("[::1]:0") else {
        return;
    };
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        if let Ok((mut conn, _)) = listener.accept() {
            read_request(&mut conn);
            let _ = conn.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 11\r\n\r\n{\"ok\":true}");
        }
    });
    let there = ServerFile {
        url: format!("http://[::1]:{port}"),
        token: TOKEN.to_string(),
        pid: std::process::id() as i64,
    };
    assert_eq!(post(&there, b"{}", SERVER_TIMEOUT_MS), Answer::Taken);
}

// ----- deliver

/// The project's folder in a home of its own, with a `server.json` for `url` and the pid of this process.
fn project_with(url: Option<&str>) -> (PathBuf, Env) {
    let home = folder("home");
    let dir = home.join("example");
    fs::create_dir_all(&dir).unwrap();
    if let Some(url) = url {
        let text = json!({"url": url, "token": TOKEN, "pid": std::process::id()}).to_string();
        fs::write(dir.join("server.json"), text).unwrap();
    }
    let env = env_of(&home);
    (home, env)
}

fn inbox_files(home: &std::path::Path) -> Vec<String> {
    let inbox = home.join("example").join("inbox");
    let Ok(read) = fs::read_dir(inbox) else {
        return Vec::new();
    };
    let mut names: Vec<String> = read
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    names
}

#[test]
fn without_a_server_file_the_event_is_left_in_the_inbox() {
    let (home, env) = project_with(None);
    let left = deliver("example", &event(), &env).unwrap();
    assert!(left.is_some());
    assert_eq!(inbox_files(&home).len(), 1);
    assert!(!home.join("example").join("server.down").exists());
}

#[test]
fn a_server_that_takes_the_event_leaves_nothing_in_the_inbox() {
    let server = Server::start(vec![ok_json(200, "{\"ok\":true}")]);
    let (home, env) = project_with(Some(&server.url()));
    assert_eq!(deliver("example", &event(), &env).unwrap(), None);
    assert_eq!(server.calls(), 1);
    assert!(inbox_files(&home).is_empty());
    assert!(!home.join("example").join("server.down").exists());
}

#[test]
fn a_server_that_answers_with_a_refusal_is_asked_again_the_next_time() {
    for status in [401, 400, 500] {
        let server = Server::start(vec![ok_json(status, "{\"error\":\"no\"}")]);
        let (home, env) = project_with(Some(&server.url()));
        assert!(deliver("example", &event(), &env).unwrap().is_some());
        assert!(deliver("example", &event(), &env).unwrap().is_some());
        assert_eq!(server.calls(), 2, "{status}");
        assert_eq!(inbox_files(&home).len(), 2);
        assert!(
            !home.join("example").join("server.down").exists(),
            "a server that answers is not down"
        );
    }
}

#[test]
fn a_server_that_is_gone_is_marked_down_and_not_asked_again_within_the_pause() {
    let gone = {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port())
    };
    let (home, env) = project_with(Some(&gone));
    assert!(deliver("example", &event(), &env).unwrap().is_some());
    let down = home.join("example").join("server.down");
    assert!(down.exists(), "server.down is written");
    assert_eq!(inbox_files(&home).len(), 1);

    // A server on the file again, yet within the pause: no call.
    let back = Server::start(vec![ok_json(200, "{\"ok\":true}")]);
    fs::write(
        home.join("example").join("server.json"),
        json!({"url": back.url(), "token": TOKEN, "pid": std::process::id()}).to_string(),
    )
    .unwrap();
    assert!(deliver("example", &event(), &env).unwrap().is_some());
    assert_eq!(back.calls(), 0);
    // After the pause it is asked again, and takes the event.
    fs::write(
        &down,
        format!(
            "{}\n",
            howl::hook::hook::iso_time(now_ms() - SERVER_PAUSE_MS - 1000)
        ),
    )
    .unwrap();
    assert_eq!(deliver("example", &event(), &env).unwrap(), None);
    assert_eq!(back.calls(), 1);
}

#[test]
fn a_server_that_takes_the_connection_and_never_answers_costs_500_ms_and_the_event_is_in_the_inbox()
{
    let server = Server::start(vec![Reply::Silent]);
    let (home, env) = project_with(Some(&server.url()));
    let started = Instant::now();
    assert!(deliver("example", &event(), &env).unwrap().is_some());
    assert!(started.elapsed() < Duration::from_millis(900));
    assert_eq!(inbox_files(&home).len(), 1);
    assert!(home.join("example").join("server.down").exists());
}

#[test]
fn a_server_file_that_holds_nothing_up_sends_nothing() {
    let server = Server::start(vec![ok_json(200, "{\"ok\":true}")]);
    let (home, env) = project_with(None);
    let dir = home.join("example");
    // A process that is gone.
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    fs::write(
        dir.join("server.json"),
        json!({"url": server.url(), "token": TOKEN, "pid": pid}).to_string(),
    )
    .unwrap();
    assert!(deliver("example", &event(), &env).unwrap().is_some());
    // Another machine.
    fs::write(
        dir.join("server.json"),
        json!({"url": "http://example.invalid:4317", "token": TOKEN, "pid": std::process::id()})
            .to_string(),
    )
    .unwrap();
    assert!(deliver("example", &event(), &env).unwrap().is_some());
    assert_eq!(server.calls(), 0);
    assert_eq!(inbox_files(&home).len(), 2);
    assert!(!dir.join("server.down").exists());
}

#[test]
fn a_hook_that_cannot_write_the_inbox_says_so_to_its_caller() {
    let (home, env) = project_with(None);
    fs::write(
        home.join("example").join("inbox"),
        "a file where the folder should be",
    )
    .unwrap();
    assert!(deliver("example", &event(), &env).is_err());
}

#[test]
fn the_pause_and_the_wait_are_those_of_the_typescript() {
    assert_eq!(SERVER_TIMEOUT_MS, 500);
    assert_eq!(SERVER_PAUSE_MS, 60_000);
}

#[test]
fn a_unix_socket_is_not_a_server() {
    // `server.json` names a url, never a path: a socket in its place is passed over like any other file that is no JSON.
    let dir = folder("unix");
    let socket = dir.join("server.json");
    let _listener = UnixListener::bind(&socket).unwrap();
    assert!(read_server_file(&s(&socket)).is_none());
}
