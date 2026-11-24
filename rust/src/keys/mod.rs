// Signed claims with a key per assignment: the check of `howl verify`, the twin of `checkSignatures` in
// src/keys/keys.ts (#23, #140), and the signing of the hook (#142). Issuing keys stays in the TypeScript until its piece.
// @code_class evidence
pub mod js;
pub mod keyd;
pub mod sign;

pub use js::{base64_decode, date_parse, js_string};

use crate::ledger::fixed::fixed_form;
use crate::ledger::line::hex;
use crate::ledger::time::is_day;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use js::{same, truthy, Key};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

/// What the signatures of a ledger come to.
#[derive(Debug, Clone, PartialEq)]
pub struct SignatureCheck {
    pub signed: usize,
    /// Claimed events without a signature.
    pub unsigned: usize,
    /// Per line, what does not hold, in the order of the lines.
    pub faults: Vec<(usize, String)>,
    /// The issuer the keys are held to, as `howl verify` writes it: the pinned one, else the first that issued a key.
    pub issuer: Option<String>,
    /// Whether the issuer was pinned (`howl verify --issuer`), rather than taken from the ledger.
    pub pinned: bool,
    /// Signatures by a key whose issue was refused because its issuer does not match: the pin, the ledger's issuer, or
    /// the hash of its issuer key.
    pub unmatched: usize,
}

/// The issuer the keys are held to, compared as JavaScript's `!==` compares it.
#[derive(Debug, Clone)]
enum Issuer {
    Null,
    /// A string, a number or a boolean, compared by value.
    Plain(Value),
    /// An object or an array: the same only on the line it came from, as JavaScript compares by reference.
    Reference {
        line: usize,
        text: String,
    },
}

impl Issuer {
    fn is(&self, value: Option<&Value>, line: usize) -> bool {
        match (self, value) {
            (_, None) => false,
            (Issuer::Null, Some(v)) => v.is_null(),
            (Issuer::Plain(p), Some(v)) => same(Some(p), Some(v)),
            (Issuer::Reference { line: from, .. }, Some(v)) => {
                *from == line && (v.is_object() || v.is_array())
            }
        }
    }

    fn of(value: Option<&Value>, line: usize) -> Issuer {
        match value {
            None | Some(Value::Null) => Issuer::Null,
            Some(v @ (Value::Object(_) | Value::Array(_))) => Issuer::Reference {
                line,
                text: js_string(Some(v)),
            },
            Some(v) => Issuer::Plain(v.clone()),
        }
    }

    /// As `howl verify` writes it after `issuer `, when it is truthy.
    fn shown(&self) -> Option<String> {
        match self {
            Issuer::Null => None,
            Issuer::Plain(v) => truthy(Some(v)).then(|| js_string(Some(v))),
            Issuer::Reference { text, .. } => Some(text.clone()),
        }
    }
}

/// A key issued on an earlier line: the data of its key.issued, and when it was revoked.
struct Issued {
    data: Map<String, Value>,
    /// The line it was issued on.
    line: usize,
    /// The time of its earliest revocation.
    revoked_at: Option<f64>,
}

/// The check, line by line, so that a ledger is read once.
pub struct Signatures {
    keys: HashMap<Key, Issued>,
    /// The line of each event id seen (#199, after the review): a copied line is refused.
    ids: HashMap<String, usize>,
    /// The keys whose issue was refused because its issuer does not match.
    unmatched: HashSet<Key>,
    issuer: Issuer,
    check: SignatureCheck,
}

impl Signatures {
    /// A check, with the issuer pinned when `pin` is given.
    pub fn new(pin: Option<&str>) -> Signatures {
        let issuer = pin.map_or(Issuer::Null, |p| {
            Issuer::Plain(Value::String(p.to_string()))
        });
        let check = SignatureCheck {
            signed: 0,
            unsigned: 0,
            faults: Vec::new(),
            issuer: None,
            pinned: pin.is_some(),
            unmatched: 0,
        };
        Signatures {
            keys: HashMap::new(),
            ids: HashMap::new(),
            unmatched: HashSet::new(),
            issuer,
            check,
        }
    }

    /// Takes the event of line `n`, in the order of the lines.
    pub fn add(&mut self, n: usize, event: &Value) {
        let empty = Map::new();
        let d = event
            .get("data")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let field = |name: &str| event.get(name);
        let kind = field("type").and_then(Value::as_str).unwrap_or_default();
        if let Some(id) = field("id").and_then(Value::as_str) {
            if let Some(seen) = self.ids.get(id) {
                let reason = format!("the event {id} is already on line {seen}");
                // #200 (second look): a revocation still revokes when its id is taken, or a line that took the id first would keep the
                // key from being revoked. Revoking is the safe direction, and its line carries the fault.
                if kind == "key.revoked" {
                    self.revoke(n, event, d);
                }
                self.fault(n, reason);
                return;
            }
            self.ids.insert(id.to_string(), n);
        }
        let sig = field("sig").filter(|s| truthy(Some(s)));
        if kind == "key.issued" || kind == "key.revoked" {
            // An issuer's own act: signed by the issuer it names.
            if kind == "key.issued" {
                if matches!(self.issuer, Issuer::Null) {
                    self.issuer = Issuer::of(d.get("issuer"), n);
                }
                let named = short(d.get("key"));
                if !self.issuer.is(d.get("issuer"), n) {
                    self.unmatched.extend(Key::of(d.get("key")));
                    self.fault(n, format!("key {named}: not issued by the ledger's issuer"));
                    return;
                }
                let by = d.get("issuer_public");
                if let Some(weak) = key_fault(by) {
                    // A weak key that does not hash to the issuer named does not match it either.
                    if by
                        .and_then(Value::as_str)
                        .is_none_or(|text| !same(Some(&id_of(text)), d.get("issuer")))
                    {
                        self.unmatched.extend(Key::of(d.get("key")));
                    }
                    self.fault(n, format!("key {named}: the issuer key is refused: {weak}"));
                    return;
                }
                // The pin is the SHA-256 of the issuer's raw public key, in hex, as `howl key issue` prints it.
                let hash = id_of(by.and_then(Value::as_str).unwrap_or_default());
                if !same(Some(&hash), d.get("issuer")) {
                    self.unmatched.extend(Key::of(d.get("key")));
                    let reason =
                        format!("key {named}: the issuer key does not hash to the issuer it names");
                    self.fault(n, reason);
                    return;
                }
                let signer = sig.and_then(|s| s.get("key"));
                if !signature_holds(event, by) || !same(signer, d.get("issuer")) {
                    self.fault(
                        n,
                        format!("key {named}: the issuer's signature does not hold"),
                    );
                    return;
                }
                if let Some(weak) = key_fault(d.get("public")) {
                    self.fault(n, format!("key {named}: its public key is refused: {weak}"));
                    return;
                }
                // The key's id is the SHA-256 of its raw public key, as `issueKey` makes it.
                let id = id_of(d.get("public").and_then(Value::as_str).unwrap_or_default());
                if !same(Some(&id), d.get("key")) {
                    self.fault(
                        n,
                        format!("key {named}: its public key does not hash to its id"),
                    );
                    return;
                }
                if let Some(end) = ["from", "until"]
                    .into_iter()
                    .find(|end| window_time(d.get(*end)).is_none())
                {
                    let written = js_string(d.get(end));
                    let reason = format!(
                        "key {named}: its window cannot be read: {end} {written} is not an ISO time with a zone"
                    );
                    self.fault(n, reason);
                    return;
                }
                // A key keeps its first issue and its revocation.
                if let Some(key) = Key::of(d.get("key")) {
                    if let Some(first) = self.keys.get(&key) {
                        let reason = format!(
                            "key {named}: the key is already issued on line {}",
                            first.line
                        );
                        self.fault(n, reason);
                        return;
                    }
                    self.keys.insert(
                        key,
                        Issued {
                            data: d.clone(),
                            line: n,
                            revoked_at: None,
                        },
                    );
                }
            } else if let Some(reason) = self.revoke(n, event, d) {
                self.fault(n, reason);
            }
            return;
        }

        let Some(sig) = sig else {
            if field("source")
                .and_then(|s| s.get("kind"))
                .and_then(Value::as_str)
                == Some("claimed")
            {
                self.check.unsigned += 1;
            }
            return;
        };
        self.check.signed += 1;
        let signer = sig.get("key");
        let Some(key) = Key::of(signer).and_then(|k| self.keys.get(&k)) else {
            if Key::of(signer).is_some_and(|k| self.unmatched.contains(&k)) {
                self.check.unmatched += 1;
            }
            let reason = format!(
                "signed by key {}, which has no valid issue on a line before",
                short(signer)
            );
            self.fault(n, reason);
            return;
        };
        let d2 = &key.data;
        let reason = if !signature_holds(event, d2.get("public")) {
            Some(
                "the signature does not hold: the event was changed after it was signed"
                    .to_string(),
            )
        } else {
            let t = time_of(field("time"));
            let revoked = key.revoked_at;
            let actor = field("actor").and_then(|a| a.get("id"));
            let (change, task) = (field("change"), field("task"));
            if t < time_of(d2.get("from")) || t > time_of(d2.get("until")) {
                let (from, until) = (js_string(d2.get("from")), js_string(d2.get("until")));
                Some(format!(
                    "signed outside the key's window ({from} to {until})"
                ))
            } else if revoked.is_some_and(|r| t > r) {
                Some("signed after the key was revoked".to_string())
            } else if !same(actor, d2.get("actor")) {
                let who = actor
                    .filter(|a| !a.is_null())
                    .map_or("no one".to_string(), |a| js_string(Some(a)));
                Some(format!(
                    "{who} is not the key's agent ({})",
                    js_string(d2.get("actor"))
                ))
            } else if d2.get("change").is_some()
                && change.is_some()
                && !same(change, d2.get("change"))
            {
                let (ours, theirs) = (js_string(change), js_string(d2.get("change")));
                Some(format!("change {ours} is not the key's change ({theirs})"))
            } else if d2.get("task").is_some() && task.is_some() && !same(task, d2.get("task")) {
                let (ours, theirs) = (js_string(task), js_string(d2.get("task")));
                Some(format!("task {ours} is not the key's task ({theirs})"))
            } else {
                None
            }
        };
        if let Some(reason) = reason {
            self.fault(n, reason);
        }
    }

    /// A key.revoked's effect, and why it has none: the key must be issued, the issuer must be the ledger's and its signature must hold,
    /// and the time must be readable. The earliest revocation stands. A revocation that has its effect is a fault still when its
    /// sig.key is not the issuer it names (#207): the signed payload leaves out the sig, so nothing else holds it, and revoking is
    /// the safe direction.
    fn revoke(&mut self, n: usize, event: &Value, d: &Map<String, Value>) -> Option<String> {
        let key = Key::of(Some(
            d.get("key")
                .filter(|k| !k.is_null())
                .unwrap_or(&Value::String(String::new())),
        ));
        let issuer = &self.issuer;
        let known = key.and_then(|k| self.keys.get_mut(&k));
        let holds = known.as_ref().is_some_and(|known| {
            let public = known.data.get("issuer_public");
            issuer.is(d.get("issuer"), n) && truthy(public) && signature_holds(event, public)
        });
        let at = d.get("at").filter(|a| !a.is_null()).or(event.get("time"));
        match known {
            Some(known) if holds => match window_time(at) {
                Some(t) => {
                    known.revoked_at = Some(known.revoked_at.map_or(t, |r| r.min(t)));
                    let signer = event.get("sig").and_then(|s| s.get("key"));
                    (!same(signer, d.get("issuer"))).then(|| {
                        format!(
                            "revocation of key {}: the revocation is not signed by the issuer it names; the key is revoked all the same",
                            short(d.get("key"))
                        )
                    })
                }
                None => Some(format!(
                    "revocation of key {}: its time cannot be read: at {} is not an ISO time with a zone",
                    short(d.get("key")),
                    js_string(at)
                )),
            },
            _ => Some(format!(
                "revocation of key {}: the issuer's signature does not hold",
                short(d.get("key"))
            )),
        }
    }

    fn fault(&mut self, n: usize, reason: String) {
        self.check.faults.push((n, reason));
    }

    /// What the signatures come to.
    pub fn finish(self) -> SignatureCheck {
        let mut check = self.check;
        check.issuer = self.issuer.shown();
        check
    }
}

/// Checks the signatures of the events of a ledger, given with the numbers of their lines, in order.
pub fn check_signatures(lines: &[(usize, &Value)], pin: Option<&str>) -> SignatureCheck {
    let mut signatures = Signatures::new(pin);
    for &(n, event) in lines {
        signatures.add(n, event);
    }
    signatures.finish()
}

/// #199: why a raw public key is refused, or None when it is a key: not 32 bytes; not a point of the curve; not in its
/// canonical form (y not below p, or x zero with its sign set); of small order. Checked here, before any signature is
/// checked against the key, so that the verdict on a weak key is the TypeScript's `publicKeyFault`, whatever the
/// library's verify would say.
pub fn public_key_fault(raw: &[u8]) -> Option<&'static str> {
    let Ok(bytes) = <[u8; 32]>::try_from(raw) else {
        return Some("not 32 bytes");
    };
    let Ok(key) = VerifyingKey::from_bytes(&bytes) else {
        return Some("not a point of the curve");
    };
    if key.to_edwards().compress().to_bytes() != bytes {
        return Some("not in its canonical form");
    }
    if key.is_weak() {
        return Some("of small order");
    }
    None
}

/// The SHA-256 of a key in base64url, read as Node reads it, in hex: a key's id.
fn id_of(text: &str) -> Value {
    Value::String(hex(&Sha256::digest(base64_decode(text))))
}

/// Why a public key as a ledger line gives it (base64url, read as Node reads it) is refused, or None.
fn key_fault(value: Option<&Value>) -> Option<&'static str> {
    match value.and_then(Value::as_str) {
        None => Some("not a text in base64url"),
        Some(text) => public_key_fault(&base64_decode(text)),
    }
}

/// #199: the time of one end of a key's window, the twin of `windowTime`: an ISO time with a zone (a date, `T`, a time
/// with seconds, a fraction of up to nine digits, then `Z` or an offset), a real day and time; None for anything else.
pub fn window_time(value: Option<&Value>) -> Option<f64> {
    let text = value?.as_str()?;
    let b = text.as_bytes();
    let marks = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')];
    if b.len() < 20 || marks.iter().any(|&(i, c)| b[i] != c) {
        return None;
    }
    let number = |at: usize, len: usize| -> Option<u32> {
        let part = b.get(at..at + len)?;
        part.iter()
            .all(u8::is_ascii_digit)
            .then(|| part.iter().fold(0, |n, d| n * 10 + u32::from(d - b'0')))
    };
    let [year, month, day, hour, minute, second] = [
        number(0, 4)?,
        number(5, 2)?,
        number(8, 2)?,
        number(11, 2)?,
        number(14, 2)?,
        number(17, 2)?,
    ];
    let mut i = 19;
    if b.get(i) == Some(&b'.') {
        let digits = b[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        if !(1..=9).contains(&digits) {
            return None;
        }
        i += 1 + digits;
    }
    let zone_fits = match &b[i..] {
        [b'Z'] => true,
        [b'+' | b'-', _, _, b':', _, _] => {
            matches!((number(i + 1, 2), number(i + 4, 2)), (Some(h), Some(m)) if h <= 23 && m <= 59)
        }
        _ => false,
    };
    if !zone_fits || !is_day(year, month, day) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    date_parse(text)
}

/// Date.parse of a value, as a number of milliseconds; NaN when it is no time.
fn time_of(value: Option<&Value>) -> f64 {
    date_parse(&js_string(value)).unwrap_or(f64::NAN)
}

/// The first 12 code units of a key's id, `?` when there is none.
fn short(id: Option<&Value>) -> String {
    let text = match id {
        None | Some(Value::Null) => return "?".to_string(),
        Some(Value::Array(items)) => {
            return js_string(Some(&Value::Array(
                items.iter().take(12).cloned().collect(),
            )))
        }
        Some(other) => js_string(Some(other)),
    };
    let units: Vec<u16> = text.encode_utf16().take(12).collect();
    String::from_utf16_lossy(&units)
}

/// Whether the event's signature holds for the raw public key `public`, base64url: Ed25519 over the fixed form of the
/// event without its `sig`. Anything that is not a key or a signature does not hold.
fn signature_holds(event: &Value, public: Option<&Value>) -> bool {
    let Some(value) = event
        .get("sig")
        .and_then(|s| s.get("value"))
        .and_then(Value::as_str)
    else {
        return false;
    };
    let Some(public) = public.and_then(Value::as_str) else {
        return false;
    };
    let Ok(raw) = <[u8; 32]>::try_from(base64_decode(public)) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&raw) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(&base64_decode(value)) else {
        return false;
    };
    let mut unsigned = event.clone();
    if let Some(members) = unsigned.as_object_mut() {
        members.remove("sig");
    }
    key.verify(&fixed_form(&unsigned), &signature).is_ok()
}
