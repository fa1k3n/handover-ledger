// `howl verify` on a ledger: the text and the status of `verifyCommand` in src/cli/howl.ts (#140).
// With --checkpoint, --signers or --bundle it is handed to the TypeScript, until their pieces.
// @code_class recording
use crate::cli::args::parse_args;
use crate::cli::howl::{fail, USAGE};
use crate::keys::Signatures;
use crate::ledger::place::{ledger_path, Env};
use crate::ledger::verify::{verify_each, Verdict};
use std::ffi::OsString;
use std::io::{BufWriter, Write};
use std::path::Path;

const OPTIONS: [&str; 6] = [
    "project",
    "ledger",
    "issuer",
    "checkpoint",
    "signers",
    "bundle",
];

/// Runs `howl verify` with its arguments (after `verify`); `fallback` takes what is not built here, as `verify --bundle`.
pub fn run(args: &[OsString], fallback: impl FnOnce(&str) -> i32) -> i32 {
    let args: Vec<String> = args
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let parsed = match parse_args(&args, &OPTIONS) {
        Ok(parsed) => parsed,
        Err(message) => return usage(&message),
    };
    if !parsed.positionals.is_empty() {
        return usage(&format!(
            "too many arguments: {}",
            parsed.positionals.join(" ")
        ));
    }
    let later = ["checkpoint", "signers", "bundle"];
    if let Some((name, _)) = parsed
        .values
        .iter()
        .find(|(name, _)| later.contains(&name.as_str()))
    {
        return fallback(&format!("verify --{name}"));
    }
    let path = match (parsed.value("ledger"), parsed.value("project")) {
        (Some(ledger), _) => ledger.to_string(),
        (None, Some(project)) => match ledger_path(project, &Env::of_process()) {
            Ok(path) => path,
            Err(message) => return fail(&format!("howl: {message}\n")),
        },
        (None, None) => return usage("verify needs --project or --ledger"),
    };
    let issuer = parsed.value("issuer");
    let pin_ok = issuer.is_none_or(is_key_id);
    let mut signatures = Signatures::new(issuer.filter(|_| pin_ok));
    let verdict = match verify_each(Path::new(&path), |n, event| signatures.add(n, event)) {
        Ok(verdict) => verdict,
        Err(message) => return fail(&format!("howl: {message}\n")),
    };
    let mut out = BufWriter::new(std::io::stdout().lock());
    // A closed standard output is not an error of howl's.
    let _ = writeln!(out, "{path}");
    let (lines, head, trial) = match verdict {
        Verdict::Fails {
            lines,
            line,
            faults,
        } => {
            let _ = writeln!(out, "line {line}: {}", faults.join("; "));
            let _ = writeln!(
                out,
                "failed at line {line}, after {} that hold",
                count(lines, "line")
            );
            let _ = out.flush();
            return 1;
        }
        Verdict::Holds {
            lines, head, trial, ..
        } => (lines, head, trial),
    };
    let _ = writeln!(out, "ok: {} checked, head {head}", count(lines, "line"));
    if trial {
        let _ = writeln!(out, "a trial: it does not count as evidence");
    }
    if !pin_ok {
        let _ = out.flush();
        return usage("--issuer must be a key id: 64 hex digits");
    }
    // #23: the signed claims, held to the keys issued for them.
    let check = signatures.finish();
    let by = check
        .issuer
        .map(|i| format!(", issuer {i}"))
        .unwrap_or_default();
    let _ = writeln!(
        out,
        "signatures: {} signed, {} unsigned claimed{by}",
        check.signed, check.unsigned
    );
    for (line, reason) in &check.faults {
        let _ = writeln!(out, "line {line}: {reason}");
    }
    let _ = out.flush();
    if check.faults.is_empty() {
        0
    } else {
        1
    }
}

/// A usage error: the message, the usage text, and 2.
fn usage(message: &str) -> i32 {
    fail(&format!("howl: {message}\n\n{USAGE}"))
}

/// A key id: 64 hex digits, in lowercase.
fn is_key_id(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `1 line`, `2 lines`.
fn count(n: usize, noun: &str) -> String {
    format!("{n} {noun}{}", if n == 1 { "" } else { "s" })
}
