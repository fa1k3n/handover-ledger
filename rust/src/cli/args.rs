// The arguments of a command, read as Node's util.parseArgs reads them in src/cli/howl.ts: strict, every option a
// string, positionals allowed and counted by the command (#140). Its refusals are Node's words.
// @code_class recording
use crate::ledger::fixed::fixed_form;
use serde_json::Value;

/// The options given, in their order, and the positionals.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Parsed {
    pub values: Vec<(String, String)>,
    pub positionals: Vec<String>,
}

impl Parsed {
    /// The value of an option: the last one given.
    pub fn value(&self, name: &str) -> Option<&str> {
        self.values
            .iter()
            .rev()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

/// Reads `args` against the options `names`, each of which takes a value.
pub fn parse_args(args: &[String], names: &[&str]) -> Result<Parsed, String> {
    let mut parsed = Parsed::default();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        i += 1;
        if arg == "--" {
            parsed.positionals.extend(args[i..].iter().cloned());
            break;
        }
        let mut chars = arg.chars();
        let (first, second) = (chars.next(), chars.next());
        if first != Some('-') || second.is_none() {
            parsed.positionals.push(arg.clone());
            continue;
        }
        if second != Some('-') {
            // A short option, alone or in a group: howl has none.
            return Err(unknown(&format!("-{}", second.unwrap_or_default())));
        }
        // A long option: `--name=value` when there is an `=` after its first character, else `--name`.
        let rest = &arg[2..];
        let inline = rest
            .char_indices()
            .skip(1)
            .find(|&(_, c)| c == '=')
            .map(|(at, _)| at);
        if let Some(at) = inline {
            let name = &rest[..at];
            if !names.contains(&name) {
                return Err(unknown(&format!("--{name}")));
            }
            parsed
                .values
                .push((name.to_string(), rest[at + 1..].to_string()));
            continue;
        }
        if !names.contains(&rest) {
            return Err(unknown(arg));
        }
        let Some(value) = args.get(i) else {
            return Err(format!("Option '{arg} <value>' argument missing"));
        };
        i += 1;
        if value.len() > 1 && value.starts_with('-') {
            return Err(format!(
                "Option '{arg}' argument is ambiguous.\nDid you forget to specify the option argument for '{arg}'?\nTo specify an option argument starting with a dash use '{arg}=-XYZ'."
            ));
        }
        parsed.values.push((rest.to_string(), value.clone()));
    }
    Ok(parsed)
}

fn unknown(option: &str) -> String {
    let quoted = String::from_utf8(fixed_form(&Value::String(option.to_string())))
        .expect("the fixed form is UTF-8");
    format!(
        "Unknown option '{option}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- {quoted}"
    )
}
