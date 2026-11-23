// Signing an event with the key of an assignment: the twin of `signEvent`, `publicOf` and `readKey` in src/keys/keys.ts
// (#142). Ed25519 over the fixed form of the event without its `sig`; `sig = {key, value}`, the key's id (the SHA-256
// of its raw public key, in hex) and the signature in base64url, without padding.
//
// A key that cannot be read is an error, never a different signature: the caller leaves the event unsigned.
// @code_class evidence
use crate::ledger::fixed::fixed_form;
use crate::ledger::line::hex;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;

/// The most of a key file that is read: an Ed25519 key in PEM is a hundred bytes or so.
const MOST: u64 = 64 * 1024;

/// The prefix of an Ed25519 private key in PKCS#8, version 0: the seed of 32 bytes follows.
const PKCS8_V0: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];
/// The same in version 1, with the public key after the seed: the seed follows this prefix.
const PKCS8_V1: [u8; 16] = [
    0x30, 0x51, 0x02, 0x01, 0x01, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];
/// What follows the seed in version 1: the public key as a context-specific bit string of 33 bytes.
const PUBLIC_TAG: [u8; 3] = [0x81, 0x21, 0x00];

/// A private key in PEM, from a file: an Ed25519 key in PKCS#8, as `createPrivateKey` reads it.
pub fn read_key(path: &str) -> Result<SigningKey, String> {
    // A plain file of a key's size: a pipe in its place would hold the hook up. Looked at before it is opened.
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MOST {
        return Err("not a plain file of a key's size".to_string());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|f| f.take(MOST + 1).read_to_end(&mut bytes))
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    let der = pem_body(&text).ok_or("no private key in PEM")?;
    let seed = seed_of(&der).ok_or("not an Ed25519 key in PKCS#8")?;
    Ok(SigningKey::from_bytes(&seed))
}

/// The bytes of the first PEM block labelled `PRIVATE KEY`: text before it is passed over, as OpenSSL passes it over.
fn pem_body(text: &str) -> Option<Vec<u8>> {
    let mut lines = text.lines();
    lines.find(|l| l.trim_end() == "-----BEGIN PRIVATE KEY-----")?;
    let mut base64 = String::new();
    for line in lines {
        if line.trim_end() == "-----END PRIVATE KEY-----" {
            return decode(&base64);
        }
        base64.push_str(line);
    }
    None
}

/// Base64 of the standard alphabet, white space passed over, the padding optional; any other sign is a fault.
fn decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let (mut bits, mut count) = (0u32, 0);
    let mut padding = 0;
    for b in text.bytes().filter(|b| !b.is_ascii_whitespace()) {
        let six = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => {
                padding += 1;
                continue;
            }
            _ => return None,
        };
        // Nothing after the padding.
        if padding > 0 {
            return None;
        }
        bits = (bits << 6) | u32::from(six);
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    Some(out)
}

/// The seed of an Ed25519 key in PKCS#8: version 0 (the prefix and 32 bytes), or version 1 (the prefix, 32 bytes, the
/// public key). What follows the key, as OpenSSL passes it over, is passed over.
fn seed_of(der: &[u8]) -> Option<[u8; 32]> {
    let seed = |tail: &[u8]| -> Option<[u8; 32]> { tail.get(..32)?.try_into().ok() };
    if der.starts_with(&PKCS8_V0) {
        return seed(&der[PKCS8_V0.len()..]);
    }
    if der.starts_with(&PKCS8_V1) {
        let tail = &der[PKCS8_V1.len()..];
        let key = seed(tail)?;
        return (tail.get(32..35)? == PUBLIC_TAG && tail.len() >= 35 + 32).then_some(key);
    }
    None
}

/// The id of a key (the SHA-256 of its raw public key, in hex) and its public key in base64url.
pub fn public_of(key: &SigningKey) -> (String, String) {
    let raw = key.verifying_key().to_bytes();
    (hex(&Sha256::digest(raw)), base64url(&raw))
}

/// Base64url without padding, as Node's `toString("base64url")`.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let n = group.iter().enumerate().fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        let signs = group.len() + 1;
        for i in 0..signs {
            out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

/// What is signed: the event as the ledger keeps it, without its signature.
fn payload(event: &Value) -> Vec<u8> {
    let mut rest = event.clone();
    if let Some(members) = rest.as_object_mut() {
        members.remove("sig");
    }
    fixed_form(&rest)
}

/// The event with its signature by `key`.
pub fn sign_event(event: &Value, key: &SigningKey) -> Value {
    let (id, _) = public_of(key);
    let value = base64url(&key.sign(&payload(event)).to_bytes());
    let mut signed = event.clone();
    if let Some(members) = signed.as_object_mut() {
        members.insert("sig".to_string(), json!({"key": id, "value": value}));
    }
    signed
}
