// Paths as Node's `node:path` (posix) makes them, for the paths the hook joins and compares (#141). Lexical only: no
// link is followed and nothing is asked of the file system, as in Node.
// @code_class recording

/// Whether a path is absolute.
pub fn is_absolute(path: &str) -> bool {
    path.starts_with('/')
}

/// The folder of a path, as `path.dirname`: lexical, so `/a/b/..` gives `/a/b`.
pub fn dirname(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.is_empty() {
        return ".".to_string();
    }
    let has_root = bytes[0] == b'/';
    let mut end = None;
    let mut matched_slash = true;
    for i in (1..bytes.len()).rev() {
        if bytes[i] == b'/' {
            if !matched_slash {
                end = Some(i);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end {
        None if has_root => "/".to_string(),
        None => ".".to_string(),
        Some(1) if has_root => "//".to_string(),
        Some(end) => path[..end].to_string(),
    }
}

/// The last part of a path, as `path.basename` with no extension given.
pub fn basename(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut start = 0;
    let mut end = None;
    for i in (0..bytes.len()).rev() {
        if bytes[i] == b'/' {
            if end.is_some() {
                start = i + 1;
                break;
            }
        } else if end.is_none() {
            end = Some(i + 1);
        }
    }
    end.map_or(String::new(), |end| path[start..end].to_string())
}

/// The parts of a path without `.` and empty parts, each `..` taking the part before it. Above the start, a `..` is
/// kept when `above` allows it, else dropped.
fn parts(path: &str, above: bool) -> Vec<&str> {
    let mut kept: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if kept.last().is_some_and(|last| *last != "..") {
                    kept.pop();
                } else if above {
                    kept.push("..");
                }
            }
            other => kept.push(other),
        }
    }
    kept
}

/// A path made normal, as `path.normalize`: a trailing `/` is kept.
pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let absolute = is_absolute(path);
    let mut text = parts(path, !absolute).join("/");
    if text.is_empty() && !absolute {
        text = ".".to_string();
    }
    if !text.is_empty() && path.ends_with('/') {
        text.push('/');
    }
    if absolute {
        format!("/{text}")
    } else {
        text
    }
}

/// Parts joined and made normal, as `path.join`.
pub fn join(paths: &[&str]) -> String {
    let joined: Vec<&str> = paths.iter().copied().filter(|p| !p.is_empty()).collect();
    if joined.is_empty() {
        return ".".to_string();
    }
    normalize(&joined.join("/"))
}

/// `path` taken from the absolute folder `from`, as `path.resolve(from, path)`: absolute, normal, no trailing `/`.
pub fn resolve(from: &str, path: &str) -> String {
    let whole = if is_absolute(path) {
        path.to_string()
    } else {
        format!("{from}/{path}")
    };
    format!("/{}", parts(&whole, false).join("/"))
}

/// The way from the absolute path `from` to the absolute path `to`, as `path.relative`: empty when they are the same.
pub fn relative(from: &str, to: &str) -> String {
    let from = resolve("/", from);
    let to = resolve("/", to);
    let from: Vec<&str> = parts(&from, false);
    let to: Vec<&str> = parts(&to, false);
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut way: Vec<&str> = vec![".."; from.len() - common];
    way.extend(&to[common..]);
    way.join("/")
}
