// `howl hook` in Rust: its parts, each as its twin in the TypeScript does it (#141).
// The conformance of the whole event with the TypeScript is test/hook-rust.test.ts and the hook tests run through HOWL_BIN.
// @code_class tests
use howl::hook::hook::{iso_time, program};
use howl::hook::input::{read_input, Json};
use howl::howl::git::{run_limited, repo_name};
use howl::howl::path::{basename, dirname, join, relative, resolve};
use howl::howl::project::{
    find_actor, find_project, js_trim, plain, setting_pattern, task_of_branch, top_level, Setting,
};
use howl::inbox::inbox::{inbox_name, leave, random_uuid};
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_howl");

/// A folder of its own for one test.
fn folder(name: &str) -> PathBuf {
    let name = format!("howl-rust-hook-{}-{name}", std::process::id());
    let dir = std::env::temp_dir().join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn s(path: &std::path::Path) -> String {
    path.to_str().unwrap().to_string()
}

#[test]
fn trim_is_javascript_s_with_its_white_space() {
    assert_eq!(js_trim("\u{feff}\u{a0}\u{2028} a b\u{3000}\t\u{b}\u{c}\r\n"), "a b");
    // U+0085 is white space to Rust, not to JavaScript.
    assert_eq!(js_trim("\u{85}a\u{85}"), "\u{85}a\u{85}");
    assert_eq!(js_trim("\u{1680}\u{2000}\u{200a}\u{202f}\u{205f}x\u{2029}"), "x");
}

#[test]
fn the_settings_reader_reads_top_level_keys_as_project_ts_does() {
    let text = "# a comment\nproject: 'example'  # the project\nproject: other\nlist: [a, \"b\", , c]\nitems:\n  - one\n  - 'two' # a comment\n\t- three\nnested:\n  key: value\nempty:\nhash: a#b\n";
    let settings = top_level(text);
    assert_eq!(settings.get("project"), Some(&Setting::Text("example".into())));
    let list = |items: &[&str]| Setting::List(items.iter().map(|i| i.to_string()).collect());
    assert_eq!(settings.get("list"), Some(&list(&["a", "b", "c"])));
    assert_eq!(settings.get("items"), Some(&list(&["one", "two", "three"])));
    // A key with nothing after it and no list below it has no value; nested keys are passed over.
    assert_eq!(settings.get("nested"), None);
    assert_eq!(settings.get("empty"), None);
    assert_eq!(settings.get("key"), None);
    // A `#` starts a comment only at the start or after white space.
    assert_eq!(settings.get("hash"), Some(&Setting::Text("a#b".into())));
    // Lines end at \n or \r\n; a lone \r is part of the line, and `.` does not cross it.
    let crlf = top_level("project: a\r\nother: b\r\n");
    assert_eq!(crlf.get("project"), Some(&Setting::Text("a".into())));
    assert_eq!(crlf.get("other"), Some(&Setting::Text("b".into())));
    assert_eq!(top_level("project: a\rb\n").get("project"), None);
    assert_eq!(plain("  \"x y\"  "), "x y");
    assert_eq!(plain("'x"), "'x");
    assert_eq!(plain("\"\""), "");
}

#[test]
fn the_nearest_howl_yml_names_the_project_and_one_without_a_project_stops_the_search() {
    let root = folder("project");
    let below = root.join("a").join("b");
    fs::create_dir_all(&below).unwrap();
    fs::create_dir_all(root.join(".howl")).unwrap();
    fs::write(
        root.join(".howl/howl.yml"),
        "project: example\ntask_from_branch: '^issue-([0-9]+)'\n",
    )
    .unwrap();
    let found = find_project(&s(&below)).unwrap();
    assert_eq!(found.root, s(&root));
    assert_eq!(found.project, "example");
    assert_eq!(found.task_from_branch.as_deref(), Some("^issue-([0-9]+)"));
    // A howl.yml nearer the folder with no project gives none, though one further up has one.
    fs::create_dir_all(root.join("a/.howl")).unwrap();
    fs::write(root.join("a/.howl/howl.yml"), "activity_days: 3\n").unwrap();
    assert!(find_project(&s(&below)).is_none());
    // A project name that is no plain folder name, or activity_days that is no number, gives none.
    for yml in [
        "project: a/b\n",
        "project: [a]\n",
        "project: x\nactivity_days: 0\n",
        "project: x\nactivity_days: [1]\n",
    ] {
        fs::write(root.join("a/.howl/howl.yml"), yml).unwrap();
        assert!(find_project(&s(&below)).is_none(), "{yml}");
    }
    fs::write(root.join("a/.howl/howl.yml"), "project: x\nactivity_days: 12\n").unwrap();
    assert_eq!(find_project(&s(&below)).unwrap().project, "x");
    // `..` in the folder is taken as Node's dirname takes it: lexically.
    let odd = format!("{}/a/b/..", s(&root));
    assert_eq!(find_project(&odd).unwrap().root, format!("{}/a", s(&root)));
}

#[test]
fn the_actor_is_howl_actor_else_the_first_line_of_howl_actor() {
    let root = folder("actor");
    fs::create_dir_all(root.join(".howl")).unwrap();
    assert_eq!(find_actor(&s(&root), Some(" a ")), Some("a".into()));
    assert_eq!(find_actor(&s(&root), Some(" ")), None);
    fs::write(root.join(".howl/actor"), "\r\n  \n agent-2 \r\nagent-3\n").unwrap();
    assert_eq!(find_actor(&s(&root), None), Some("agent-2".into()));
    assert_eq!(find_actor(&s(&root), Some("\u{feff}")), Some("agent-2".into()));
}

#[test]
fn a_task_comes_from_the_branch_by_its_first_group_else_the_whole_match() {
    let pattern = setting_pattern("^task-([0-9]+)").unwrap();
    assert_eq!(task_of_branch(Some("task-12-x"), Some(&pattern)), Some("12".into()));
    assert_eq!(task_of_branch(Some("main"), Some(&pattern)), None);
    assert_eq!(task_of_branch(None, Some(&pattern)), None);
    let whole = setting_pattern("[0-9]+").unwrap();
    assert_eq!(task_of_branch(Some("x-34-y"), Some(&whole)), Some("34".into()));
    let optional = setting_pattern("^x(-y)?").unwrap();
    assert_eq!(task_of_branch(Some("x"), Some(&optional)), Some("x".into()));
    let unicode = setting_pattern("^(\\p{L}+)-").unwrap();
    assert_eq!(task_of_branch(Some("åsa-12"), Some(&unicode)), Some("åsa".into()));
    // Compiled with the u flag: an escape of nothing is refused, as is what is no pattern at all.
    for bad in ["^task\\_([0-9]+)", "^task\\-([0-9]+)", "(", "[b-a]"] {
        assert!(setting_pattern(bad).is_err(), "{bad}");
    }
}

#[test]
fn the_program_of_a_shell_command_is_read_as_hook_ts_reads_it() {
    let cases: &[(&str, Option<&str>)] = &[
        ("ls", Some("ls")),
        ("make check", Some("make")),
        ("./scripts/build.sh --fast", Some("build.sh")),
        ("\"/usr/local/bin/my-tool\" run", Some("my-tool")),
        ("'/opt/x/tool' run", Some("tool")),
        ("(cd sub && make)", Some("cd")),
        ("  \n  git status", Some("git")),
        ("A=1; B=2 make check", Some("make")),
        ("H=/tmp/x/y\nmkdir -p \"$H\"", Some("mkdir")),
        ("cat a.txt | grep b", Some("cat")),
        ("A=1 B=2", None),
        ("\"$H\"/run.sh", Some("run.sh")),
        ("$(which make) check", None),
        ("AUTH=\"Bearer x\" curl https://example.invalid", Some("curl")),
        ("X='single quoted' ./run.sh", Some("run.sh")),
        ("X=\"with \\\"inside\\\" it\" make", Some("make")),
        ("X=$(printf '%s' \"a\") make", Some("make")),
        ("X=`echo b` make", Some("make")),
        ("X=one\\ two make", Some("make")),
        ("export A=\"x\" && make", Some("export")),
        ("TOKENS=(123 other); make", Some("make")),
        ("ARGS+=(\"a\" 'b c') make", Some("make")),
        ("A=$'x\\' y \\'' ls", Some("ls")),
        ("X=a\u{a0}b make", Some("make")),
        ("X=$[ 1 + 1 ] make", Some("make")),
        ("2>/dev/null make", Some("make")),
        ("> /tmp/x 2>&1 make", Some("make")),
        ("< \"/tmp/in x\" make", Some("make")),
        ("X=$(case y in a) b;; esac) make", None),
        ("<<EOF cat\nx\nEOF", None),
        ("X=\"never closed curl", None),
        ("X='never closed curl", None),
        ("\"$PROGRAM\" --flag", None),
        ("`which make` x", None),
        ("A=(x other)", None),
        ("A=(x other", None),
        ("# a comment\nmake", Some("make")),
        ("# only a comment", None),
        ("x/ä", None),
        ("", None),
    ];
    for (command, expected) in cases {
        assert_eq!(program(command).as_deref(), *expected, "{command:?}");
    }
    // Deeper than a reader should follow: no target.
    let deep = format!("{}x{} make", "X=\"$(".repeat(5000), ")\"".repeat(5000));
    assert_eq!(program(&deep), None);
    // A very long command is read in time.
    let long = format!("X={} make", "'a/b'".repeat(40_000));
    let started = Instant::now();
    assert_eq!(program(&long).as_deref(), Some("make"));
    assert!(started.elapsed() < Duration::from_millis(500));
}

#[test]
fn the_name_of_a_repository_is_owner_and_name_never_a_path() {
    let cases: &[(Option<&str>, Option<&str>)] = &[
        (Some("git@example.invalid:team/product.git"), Some("team/product")),
        (Some("https://example.invalid/team/product.git"), Some("team/product")),
        (Some("https://example.invalid/team/product/"), Some("team/product")),
        (Some("https://example.invalid/team/product.git/"), Some("team/product")),
        (Some("https://example.invalid/team/.git"), Some("team/.git")),
        (Some("ssh://example.invalid/a/b/c"), Some("b/c")),
        (Some("https://example.invalid/team/product//"), None),
        (Some("/srv/git/team/product.git"), None),
        (Some("file:///srv/git/team/product.git"), None),
        (Some("product"), None),
        (Some(""), None),
        (None, None),
    ];
    for (url, expected) in cases {
        assert_eq!(repo_name(*url).as_deref(), *expected, "{url:?}");
    }
}

#[test]
fn paths_are_joined_and_compared_as_node_s_posix_path_does() {
    assert_eq!(dirname("/a/b/c"), "/a/b");
    assert_eq!(dirname("/a/b/"), "/a");
    assert_eq!(dirname("/a"), "/");
    assert_eq!(dirname("/"), "/");
    assert_eq!(dirname("/a/b/.."), "/a/b");
    assert_eq!(join(&["/a/b/..", ".howl", "howl.yml"]), "/a/.howl/howl.yml");
    assert_eq!(join(&["/a//b/./", "c"]), "/a/b/c");
    assert_eq!(resolve("/r", "x/../y"), "/r/y");
    assert_eq!(resolve("/r", "/abs/"), "/abs");
    assert_eq!(resolve("/r", "../../.."), "/");
    assert_eq!(relative("/r", "/r/src/main.c"), "src/main.c");
    assert_eq!(relative("/r", "/r"), "");
    assert_eq!(relative("/r/", "/r/./a/"), "a");
    assert_eq!(relative("/r/a", "/r/b"), "../b");
    assert_eq!(relative("/r", "/rx"), "../rx");
    assert_eq!(relative("/", "/a/b"), "a/b");
    assert_eq!(basename("/a/b"), "b");
    assert_eq!(basename("/a/b/"), "b");
    assert_eq!(basename("/"), "");
}

#[test]
fn the_input_is_read_as_json_parse_reads_it_and_only_what_is_used_is_kept() {
    let Some(Json::Object(top)) = read_input("{\"a\":\"x\",\"a\":\"y\\u00e5\",\"b\":{\"c\":\"d\"},\"n\":[1,-2.5e3,true,false,null]}") else {
        panic!("an object is read");
    };
    assert_eq!(top.get("a"), Some(&Json::Text("yå".into(), false)));
    let Some(Json::Object(b)) = top.get("b") else { panic!("b is an object") };
    assert_eq!(b.get("c"), Some(&Json::Text("d".into(), false)));
    assert_eq!(top.get("n"), Some(&Json::Other));
    // Any depth, as V8's JSON.parse reads it.
    let deep = format!("{{\"x\":{}{}}}", "[".repeat(100_000), "]".repeat(100_000));
    assert!(read_input(&deep).is_some());
    // A lone surrogate is read, and marked.
    let Some(Json::Object(lone)) = read_input("{\"s\":\"a\\ud800\",\"p\":\"\\ud83d\\ude00\"}") else {
        panic!("read")
    };
    assert_eq!(lone.get("s"), Some(&Json::Text("a\u{fffd}".into(), true)));
    assert_eq!(lone.get("p"), Some(&Json::Text("\u{1f600}".into(), false)));
    for bad in [
        "", " ", "{", "{\"a\":1,}", "[1,]", "{\"a\" 1}", "01", "1.", ".5", "1e", "-", "\"\t\"",
        "\"\\x\"", "\"\\u12g4\"", "tru", "nul", "{} {}", "\u{feff}{}", "{'a':1}", "[1 2]",
        "{\"a\":1 \"b\":2}", "\"a", "{\"a\":}", "[",
    ] {
        assert!(read_input(bad).is_none(), "{bad:?}");
    }
    for good in ["{}", " \t\r\n{} \n", "[]", "1", "-0.5E+2", "\"\\/\\b\\f\\n\\r\\t\\\"\\\\\"", "null"] {
        assert!(read_input(good).is_some(), "{good:?}");
    }
}

#[test]
fn an_id_is_a_lowercase_v4_uuid_and_a_time_has_milliseconds() {
    let a = random_uuid();
    let b = random_uuid();
    assert_ne!(a, b);
    for id in [&a, &b] {
        let chars: Vec<char> = id.chars().collect();
        assert_eq!(chars.len(), 36, "{id}");
        for (i, c) in chars.iter().enumerate() {
            match i {
                8 | 13 | 18 | 23 => assert_eq!(*c, '-'),
                14 => assert_eq!(*c, '4'),
                19 => assert!("89ab".contains(*c), "{id}"),
                _ => assert!(c.is_ascii_hexdigit() && !c.is_ascii_uppercase(), "{id}"),
            }
        }
    }
    assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_time(1_767_225_600_999), "2026-01-01T00:00:00.999Z");
    assert_eq!(iso_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
    assert_eq!(iso_time(4_102_444_799_001), "2099-12-31T23:59:59.001Z");
    assert_eq!(inbox_name(1_767_225_600_999, "x"), "001767225600999-x.json");
}

#[test]
fn an_event_is_left_in_its_fixed_form_with_mode_0600_and_no_temporary_file() {
    let dir = folder("leave");
    let inbox = dir.join("a/inbox");
    let event = serde_json::json!({"z": 1, "a": "å", "m": {"b": null, "a": [1.5]}});
    let path = leave(&s(&inbox), &event).unwrap();
    let names: Vec<String> = fs::read_dir(&inbox)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names.len(), 1);
    assert_eq!(path, s(&inbox.join(&names[0])));
    assert!(names[0].ends_with(".json") && names[0].len() == 15 + 1 + 36 + 5);
    let bytes = fs::read(&path).unwrap();
    assert_eq!(bytes, "{\"a\":\"å\",\"m\":{\"a\":[1.5],\"b\":null},\"z\":1}".as_bytes());
    let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode & 0o077, 0, "{mode:o}");
    assert_eq!(fs::metadata(&inbox).unwrap().permissions().mode() & 0o077, 0);
}

#[test]
fn a_child_that_does_not_end_is_ended_after_its_time() {
    let dir = folder("limit");
    let started = Instant::now();
    let out = run_limited("sleep", &["5"], &s(&dir), Duration::from_millis(300));
    assert_eq!(out, None);
    assert!(started.elapsed() < Duration::from_secs(2));
    let echo = run_limited("echo", &[" a b \n"], &s(&dir), Duration::from_secs(1));
    assert_eq!(echo.as_deref(), Some("a b"));
    assert_eq!(run_limited("false", &[], &s(&dir), Duration::from_secs(1)), None);
    assert_eq!(run_limited("echo", &["x"], "/no/such/folder", Duration::from_secs(1)), None);
}

/// `howl hook` from the binary with no environment but PATH and `env`.
fn hook(env: &[(&str, &str)], cwd: &std::path::Path, input: &str) -> std::process::Output {
    let mut child = Command::new(BIN)
        .arg("hook")
        .current_dir(cwd)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let _ = stdin.write_all(input.as_bytes());
    drop(stdin);
    child.wait_with_output().unwrap()
}

#[test]
fn the_hook_is_silent_with_status_0_a_panic_included() {
    let root = folder("silent");
    let home = folder("silent-home");
    fs::create_dir_all(root.join(".howl")).unwrap();
    fs::write(root.join(".howl/howl.yml"), "project: example\n").unwrap();
    let input = format!("{{\"hook_event_name\":\"Stop\",\"cwd\":\"{}\"}}", s(&root));
    let env = [("HOWL_HOME", home.to_str().unwrap()), ("HOWL_ACTOR", "a")];
    let panics = [env[0], env[1], ("HOWL_TEST_PANIC", "1")];
    for (env, input) in [
        (&env[..], "not json"),
        (&env[..], ""),
        (&panics[..], input.as_str()),
    ] {
        let out = hook(env, &root, input);
        assert_eq!(out.status.code(), Some(0));
        assert_eq!(out.stdout, b"");
        assert_eq!(out.stderr, b"");
    }
    assert!(!home.join("example").exists());
    let out = hook(&env, &root, &input);
    assert_eq!((out.status.code(), out.stdout.len(), out.stderr.len()), (Some(0), 0, 0));
    assert_eq!(fs::read_dir(home.join("example/inbox")).unwrap().count(), 1);
}
