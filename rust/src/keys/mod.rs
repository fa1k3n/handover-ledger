// Signed claims with a key per assignment: the check of `howl verify`, the twin of `checkSignatures` in
// src/keys/keys.ts (#23, #140). Issuing keys and signing stay in the TypeScript until their piece.
// @code_class evidence
pub mod js;

pub use js::{base64_decode, date_parse, js_string};

use crate::ledger::fixed::fixed_form;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use js::{same, truthy, Key};
use serde_json::{Map, Value};
use std::collections::HashMap;

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
    /// The time of its revocation, NaN when Date.parse finds none.
    revoked_at: Option<f64>,
}

/// The check, line by line, so that a ledger is read once.
pub struct Signatures {
    keys: HashMap<Key, Issued>,
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
        };
        Signatures {
            keys: HashMap::new(),
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
        let sig = field("sig").filter(|s| truthy(Some(s)));
        if kind == "key.issued" || kind == "key.revoked" {
            // An issuer's own act: signed by the issuer it names.
            if kind == "key.issued" {
                if matches!(self.issuer, Issuer::Null) {
                    self.issuer = Issuer::of(d.get("issuer"), n);
                }
                if !self.issuer.is(d.get("issuer"), n) {
                    self.fault(
                        n,
                        format!(
                            "key {}: not issued by the ledger's issuer",
                            short(d.get("key"))
                        ),
                    );
                    return;
                }
                let by = d.get("issuer_public");
                let signer = sig.and_then(|s| s.get("key"));
                if !truthy(by) || !signature_holds(event, by) || !same(signer, d.get("issuer")) {
                    self.fault(
                        n,
                        format!(
                            "key {}: the issuer's signature does not hold",
                            short(d.get("key"))
                        ),
                    );
                    return;
                }
                if let Some(key) = Key::of(d.get("key")) {
                    self.keys.insert(
                        key,
                        Issued {
                            data: d.clone(),
                            revoked_at: None,
                        },
                    );
                }
            } else {
                let key = Key::of(Some(
                    d.get("key")
                        .filter(|k| !k.is_null())
                        .unwrap_or(&Value::String(String::new())),
                ));
                let issuer = &self.issuer;
                let known = key.and_then(|k| self.keys.get_mut(&k));
                let holds = known.as_ref().is_some_and(|known| {
                    let public = known.data.get("issuer_public");
                    issuer.is(d.get("issuer"), n)
                        && truthy(public)
                        && signature_holds(event, public)
                });
                match known {
                    Some(known) if holds => {
                        let at = d.get("at").filter(|a| !a.is_null()).or(field("time"));
                        known.revoked_at = Some(time_of(at));
                    }
                    _ => {
                        let reason = format!(
                            "revocation of key {}: the issuer's signature does not hold",
                            short(d.get("key"))
                        );
                        self.fault(n, reason);
                    }
                }
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
