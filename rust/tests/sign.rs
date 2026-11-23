// Signing the events of a session, and asking keyd to: the twins of `src/keys/keys.ts` and the client of
// `src/keys/keyd.ts` (#142). The signatures are held against what the TypeScript made.
// @code_class tests
use howl::keys::keyd::{parse_keyd_key, request, Answer};
use howl::keys::sign::{public_of, read_key, sign_event};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn fixture(name: &str) -> String {
    let root = env!("CARGO_MANIFEST_DIR");
    format!("{root}/../test/fixtures/signing/{name}")
}

fn json_fixture(name: &str) -> Value {
    let text = fs::read_to_string(fixture(name)).unwrap();
    serde_json::from_str(&text).unwrap()
}

/// A folder of its own for one test, short enough for the path of a socket.
fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("howl-sign-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn the_signature_is_the_one_the_typescript_makes_byte_for_byte() {
    let expected = json_fixture("expected.json");
    let event = json_fixture("event.json");
    let key = read_key(&fixture("key.pem")).unwrap();
    let (id, public) = public_of(&key);
    assert_eq!(id, expected["key"].as_str().unwrap());
    assert_eq!(public, expected["public"].as_str().unwrap());
    let signed = sign_event(&event, &key);
    assert_eq!(signed["sig"], expected["sig"]);
    // The rest of the event stands as it was.
    let mut rest = signed.clone();
    rest.as_object_mut().unwrap().remove("sig");
    assert_eq!(rest, event);
}

#[test]
fn a_signature_the_event_already_has_is_not_part_of_what_is_signed() {
    let expected = json_fixture("expected.json");
    let mut event = json_fixture("event.json");
    event["sig"] = json!({"key": "x", "value": "y"});
    let key = read_key(&fixture("key.pem")).unwrap();
    assert_eq!(sign_event(&event, &key)["sig"], expected["sig"]);
}

#[test]
fn a_key_with_its_public_key_after_the_seed_is_read_too() {
    let expected = json_fixture("expected.json");
    let key = read_key(&fixture("key-v2.pem")).unwrap();
    assert_eq!(public_of(&key).0, expected["key"].as_str().unwrap());
}

#[test]
fn a_pem_is_read_as_openssl_reads_it() {
    let dir = folder("pem");
    let pem = fs::read_to_string(fixture("key.pem")).unwrap();
    let id = json_fixture("expected.json")["key"].as_str().unwrap().to_string();
    let body: String = pem.lines().nth(1).unwrap().to_string();
    let cases = [
        ("crlf", pem.replace('\n', "\r\n")),
        ("text before it", format!("a note\n{pem}")),
        ("no end of line", pem.trim_end().to_string()),
        ("two keys, the first counts", format!("{pem}{pem}")),
        ("blank line", pem.replacen('\n', "\n\n", 1)),
        ("a space in the base64", pem.replacen(&body, &format!("{} {}", &body[..20], &body[20..]), 1)),
        ("no padding", pem.replace("=", "")),
    ];
    for (label, text) in cases {
        let path = dir.join("k.pem");
        fs::write(&path, text).unwrap();
        let key = read_key(path.to_str().unwrap()).unwrap_or_else(|e| panic!("{label}: {e}"));
        assert_eq!(public_of(&key).0, id, "{label}");
    }
}

#[test]
fn a_key_that_cannot_be_read_is_an_error_not_a_key() {
    let dir = folder("bad");
    let pem = fs::read_to_string(fixture("key.pem")).unwrap();
    let good = pem.lines().nth(1).unwrap().to_string();
    let wrapped = |body: &str, label: &str| format!("-----BEGIN {label}-----\n{body}\n-----END {label}-----\n");
    let cases = [
        ("empty", String::new()),
        ("not a key", "hello\n".to_string()),
        ("raw DER", "0.\u{2}\u{1}".to_string()),
        ("another label", wrapped(&good, "ED25519 PRIVATE KEY")),
        ("not base64", wrapped("!!!!", "PRIVATE KEY")),
        ("cut short", wrapped(&good[..40], "PRIVATE KEY")),
        ("the public key", wrapped("MCowBQYDK2VwAyEAT8uA7J4XaFYzdT4GKeq4LXklgM2Prc1su51xOqxVXsk=", "PUBLIC KEY")),
        ("no end line", pem.lines().take(2).collect::<Vec<_>>().join("\n")),
    ];
    for (label, text) in cases {
        let path = dir.join("k.pem");
        fs::write(&path, text).unwrap();
        assert!(read_key(path.to_str().unwrap()).is_err(), "{label}");
    }
    // Keys of other kinds: no signature of theirs is one howl verify accepts.
    for other in ["ec.pem", "rsa.pem"] {
        assert!(read_key(&fixture(other)).is_err(), "{other}");
    }
    assert!(read_key(dir.join("missing.pem").to_str().unwrap()).is_err());
    assert!(read_key(dir.to_str().unwrap()).is_err(), "a folder");
}

#[test]
fn a_file_that_is_too_large_or_no_plain_file_is_not_read() {
    let dir = folder("size");
    let big = dir.join("big.pem");
    let mut text = fs::read_to_string(fixture("key.pem")).unwrap();
    text.push_str(&"# padding\n".repeat(8000));
    fs::write(&big, text).unwrap();
    assert!(read_key(big.to_str().unwrap()).is_err());
    let pipe = dir.join("pipe.pem");
    assert!(std::process::Command::new("mkfifo").arg(&pipe).status().unwrap().success());
    let started = Instant::now();
    assert!(read_key(pipe.to_str().unwrap()).is_err());
    assert!(started.elapsed() < Duration::from_secs(2), "a pipe does not hold it up");
}

const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TOKEN: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

#[test]
fn a_keyd_key_is_socket_hash_key_colon_token() {
    let ok = format!("keyd:/run/keyd.sock#{KEY}:{TOKEN}");
    let parsed = parse_keyd_key(&ok).unwrap();
    assert_eq!((parsed.socket.as_str(), parsed.key.as_str(), parsed.token.as_str()), ("/run/keyd.sock", KEY, TOKEN));
    // A `#` in the socket's path stays in it: the last one parts the key.
    let hash = parse_keyd_key(&format!("keyd:/a#b/s.sock#{KEY}:{TOKEN}")).unwrap();
    assert_eq!(hash.socket, "/a#b/s.sock");
    for (label, text) in [
        ("no socket", format!("keyd:#{KEY}:{TOKEN}")),
        ("upper case", format!("keyd:/s#{}:{TOKEN}", KEY.to_uppercase())),
        ("a short key", format!("keyd:/s#{}:{TOKEN}", &KEY[1..])),
        ("a long token", format!("keyd:/s#{KEY}:{TOKEN}0")),
        ("a line break in the socket", format!("keyd:/a\nb#{KEY}:{TOKEN}")),
        ("a return in the socket", format!("keyd:/a\rb#{KEY}:{TOKEN}")),
        ("U+2028 in the socket", format!("keyd:/a\u{2028}b#{KEY}:{TOKEN}")),
        ("a file name", "/nowhere/key.pem".to_string()),
        ("another scheme", format!("keyx:/s#{KEY}:{TOKEN}")),
        ("trailing", format!("keyd:/s#{KEY}:{TOKEN} ")),
    ] {
        assert!(parse_keyd_key(&text).is_none(), "{label}");
    }
}

/// A keyd that answers `reply` to the first connection and gives what it was asked.
fn keyd_answering(reply: Vec<&'static [u8]>, pause_between: Duration) -> (String, mpsc::Receiver<String>) {
    let socket = folder("keyd").join("k.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let (send, got) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut conn, _) = listener.accept().unwrap();
        let mut asked = Vec::new();
        let mut byte = [0u8; 1];
        while conn.read_exact(&mut byte).is_ok() {
            asked.push(byte[0]);
            if byte[0] == b'\n' {
                break;
            }
        }
        send.send(String::from_utf8(asked).unwrap()).unwrap();
        for part in reply {
            std::thread::sleep(pause_between);
            let _ = conn.write_all(part);
        }
        // Held open: a keyd that has answered is not gone.
        std::thread::sleep(Duration::from_secs(2));
    });
    (socket.to_str().unwrap().to_string(), got)
}

#[test]
fn keyd_is_asked_for_a_signature_in_one_line_and_its_answer_is_taken() {
    let (socket, got) = keyd_answering(vec![b"{\"ok\":true,\"sig\":{\"key\":\"k\",\"value\":\"v\"}}\n"], Duration::ZERO);
    let event = json!({"v": 0, "id": "x", "type": "session.started"});
    let req = json!({"op": "sign", "key": KEY, "token": TOKEN, "event": event});
    match request(&socket, &req, 500) {
        Answer::Reply(answer) => {
            assert_eq!(answer["ok"], json!(true));
            assert_eq!(answer["sig"], json!({"key": "k", "value": "v"}));
        }
        other => panic!("{other:?}"),
    }
    let asked = got.recv().unwrap();
    assert!(asked.ends_with('\n') && asked.matches('\n').count() == 1, "one line: {asked:?}");
    let parsed: Value = serde_json::from_str(&asked).unwrap();
    assert_eq!(parsed, req);
}

#[test]
fn an_answer_in_pieces_is_put_together() {
    let (socket, _) = keyd_answering(vec![b"{\"ok\":fal", b"se,\"error\":\"outside the key's window\"}", b"\n"], Duration::from_millis(30));
    match request(&socket, &json!({"op": "sign"}), 500) {
        Answer::Reply(answer) => assert_eq!(answer["error"], json!("outside the key's window")),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_keyd_that_is_gone_or_silent_or_answers_no_json_is_unreachable_within_the_time() {
    let dir = folder("unreachable");
    let started = Instant::now();
    let gone = request(dir.join("gone.sock").to_str().unwrap(), &json!({}), 500);
    assert!(matches!(gone, Answer::Unreachable(_)), "{gone:?}");
    assert!(started.elapsed() < Duration::from_millis(400));

    // A socket that takes the connection and never answers: the time is up at 500 ms, not before and not long after.
    let silent = dir.join("silent.sock");
    let listener = UnixListener::bind(&silent).unwrap();
    let hold = std::thread::spawn(move || {
        let held = listener.accept();
        std::thread::sleep(Duration::from_secs(2));
        drop(held);
    });
    let started = Instant::now();
    let answer = request(silent.to_str().unwrap(), &json!({}), 500);
    let took = started.elapsed();
    assert!(matches!(answer, Answer::Unreachable(_)), "{answer:?}");
    assert!(took >= Duration::from_millis(450) && took < Duration::from_millis(900), "{took:?}");
    drop(hold);

    let (not_json, _) = keyd_answering(vec![b"hello\n"], Duration::ZERO);
    assert!(matches!(request(&not_json, &json!({}), 500), Answer::Unreachable(_)));
    // Closed before the line ends.
    let (cut, _) = keyd_answering(vec![b"{\"ok\":true"], Duration::ZERO);
    assert!(matches!(request(&cut, &json!({}), 500), Answer::Unreachable(_)));
}

#[test]
fn an_answer_that_never_ends_its_line_is_not_read_without_end() {
    let (socket, _) = keyd_answering(vec![Box::leak(vec![b'x'; 2 * 1024 * 1024].into_boxed_slice())], Duration::ZERO);
    let started = Instant::now();
    assert!(matches!(request(&socket, &json!({}), 500), Answer::Unreachable(_)));
    assert!(started.elapsed() < Duration::from_millis(900));
}
