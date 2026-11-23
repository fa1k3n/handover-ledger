// The hash of a line of the ledger, which the next line holds as its `prev` (#139).
// @code_class evidence
use sha2::{Digest, Sha256};

/// The SHA-256, in lowercase hex, of a line's bytes without its `\n`, as `hashLine` in `src/ledger/ledger.ts`.
pub fn hash_line(line: &[u8]) -> String {
    hex(&Sha256::digest(line))
}

/// Bytes in lowercase hex.
pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 0x0f)] as char);
    }
    out
}
