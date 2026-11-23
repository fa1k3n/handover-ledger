// Where the ledger of a project lies: the twin of `ledgerPath` in src/ledger/place.ts (#140). Never inside a
// repository: the place depends on the user's environment, never on the working directory.
// @code_class evidence
use crate::ledger::fixed::fixed_form;
use serde_json::Value;

/// The variables the place is taken from. An empty one counts as unset, as in the TypeScript.
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub howl_home: Option<String>,
    pub xdg_state_home: Option<String>,
    /// The home folder, as Node's homedir() gives it: HOME when it is set, even empty, else the user's entry.
    pub home: Option<String>,
}

impl Env {
    /// The variables of this process.
    pub fn of_process() -> Env {
        let var = |name: &str| std::env::var_os(name).map(|v| v.to_string_lossy().into_owned());
        #[allow(deprecated)]
        let home =
            var("HOME").or_else(|| std::env::home_dir().map(|h| h.to_string_lossy().into_owned()));
        Env {
            howl_home: var("HOWL_HOME"),
            xdg_state_home: var("XDG_STATE_HOME"),
            home,
        }
    }
}

/// Whether a name can be a project's: one plain folder name.
pub fn is_project_name(name: &str) -> bool {
    let mut chars = name.chars();
    let first = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    let rest = chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    first && rest && !name.contains("..")
}

/// The folder of a project: `$HOWL_HOME`, else `$XDG_STATE_HOME/howl`, else `~/.local/state/howl`; in it
/// `<project>`, joined and made normal as Node's path.join makes it (`projectDir`).
pub fn project_dir(project: &str, env: &Env) -> Result<String, String> {
    if !is_project_name(project) {
        return Err(format!(
            "{} is not a project name: use letters, digits, '.', '_' and '-', starting with a letter or digit",
            quoted(project)
        ));
    }
    let set = |v: &Option<String>| v.clone().filter(|v| !v.is_empty());
    let home = if let Some(howl) = set(&env.howl_home) {
        if !howl.starts_with('/') {
            return Err(format!(
                "HOWL_HOME must be an absolute path, not {}",
                quoted(&howl)
            ));
        }
        howl
    } else if let Some(xdg) = set(&env.xdg_state_home).filter(|x| x.starts_with('/')) {
        // The XDG specification says a relative path is to be ignored.
        join(&[&xdg, "howl"])
    } else {
        let home = env.home.clone().unwrap_or_default();
        if !home.starts_with('/') {
            return Err("no home folder to keep the ledger in: set HOWL_HOME".to_string());
        }
        join(&[&home, ".local", "state", "howl"])
    };
    Ok(join(&[&home, project]))
}

/// The ledger of a project: `<project folder>/ledger.jsonl`.
pub fn ledger_path(project: &str, env: &Env) -> Result<String, String> {
    Ok(join(&[&project_dir(project, env)?, "ledger.jsonl"]))
}

/// Where hooks and scripts leave events: `<project folder>/inbox` (#141).
pub fn inbox_path(project: &str, env: &Env) -> Result<String, String> {
    Ok(join(&[&project_dir(project, env)?, "inbox"]))
}

/// Where the writer's server says how to reach it while it runs: `<project folder>/server.json` (#141).
pub fn server_path(project: &str, env: &Env) -> Result<String, String> {
    Ok(join(&[&project_dir(project, env)?, "server.json"]))
}

/// A string as JSON.stringify writes it.
fn quoted(text: &str) -> String {
    String::from_utf8(fixed_form(&Value::String(text.to_string())))
        .expect("the fixed form is UTF-8")
}

/// Absolute paths joined and made normal as Node's path.join does it: no empty part, no `.`, `..` taking the part
/// before it, nothing above the root.
fn join(parts: &[&str]) -> String {
    let mut kept: Vec<&str> = Vec::new();
    for part in parts.iter().flat_map(|p| p.split('/')) {
        match part {
            "" | "." => {}
            ".." => {
                kept.pop();
            }
            other => kept.push(other),
        }
    }
    format!("/{}", kept.join("/"))
}
