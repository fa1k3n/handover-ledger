// `howl verify` names every fault of an event, in the order the schema check finds them: the tests of issue #140.
// Under HOWL_COMPARE the Rust and the TypeScript must give the same bytes for each.
// @code_class tests
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { eventHash, fixedForm } from "../src/ledger/fixed.ts";
import { parseJson } from "../src/ledger/json.ts";
import { hashLine, openLedger } from "../src/ledger/ledger.ts";
import { event, folder, howl, PROJECT, rawLines } from "./helpers.ts";

/** A ledger of its first line and `line` as line 2, written as it stands. */
function ledgerOf(line: string): string {
  const path = join(folder(), "ledger.jsonl");
  openLedger(path, { project: PROJECT }).close();
  writeFileSync(path, readFileSync(path, "utf8") + line + "\n");
  return path;
}

/** `value` as line 2 of a ledger, with `prev` and `hash` right. */
function ledgerWithEvent(value: unknown): string {
  const path = ledgerOf("");
  const prev = hashLine(Buffer.from(rawLines(path)[0]!));
  return rewrite(path, `{"prev":"${prev}","hash":"${eventHash(value as never)}","event":${fixedForm(value).toString("utf8")}}`);
}

/** The ledger at `path` with its first line and `line` as line 2. */
function rewrite(path: string, line: string): string {
  writeFileSync(path, `${rawLines(path)[0]!}\n${line}\n`);
  return path;
}

/** The line of `howl verify` that names line 2, without `line 2: `; and the status. */
function faultsOf(path: string): { faults: string; status: number | null; out: string } {
  const r = howl(["verify", "--ledger", path]);
  const named = r.stdout.split("\n").find((l) => l.startsWith("line 2: "));
  return { faults: named?.slice("line 2: ".length) ?? "", status: r.status, out: r.stdout + r.stderr };
}

const TYPES =
  "ledger.created, task.assigned, task.unassigned, task.reopened, change.opened, change.updated, change.merged, checks.passed, checks.failed, checks.none, checks.unfinished, review.approved, review.changes_requested, session.started, tool.used, agent.waiting, session.stopped, session.ended, task.opened, task.closed, change.closed, change.reopened, change.commented, review.commented, review.dismissed, key.issued, key.revoked, observe.started, config.changed, trace.read";
const SHA = "^[0-9a-f]{64}$";
const TIME = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$";
const PLAIN = "^[^\\u0000-\\u001f\\u007f]*$";

/** Events that break the schema, each with what `howl verify` says of it. */
const CASES: [string, Record<string, unknown>, string][] = [
  ["a field the schema does not name", { colour: "red" }, "event: colour: not a field of an event"],
  ["a field of source it does not name", { source: { adapter: "test", kind: "observed", colour: "red" } }, "event: source.colour: not a field of an event"],
  ["a field of actor it does not name", { actor: { kind: "agent", id: "a", colour: "red" } }, "event: actor.colour: not a field of an event"],
  ["a field of prompt it does not name", { prompt: { file: "p", sha256: "a".repeat(64), x: 1 } }, "event: prompt.x: not a field of an event"],
  ["a field of sig it does not name", { sig: { key: "a".repeat(64), value: "x", x: 1 } }, "event: sig.x: not a field of an event"],
  ["a field missing", { v: undefined }, "event: v: missing"],
  ["a field of source missing", { source: { adapter: "test" } }, "event: source.kind: missing"],
  ["a field of the wrong type", { id: 5 }, "event: id: must be string"],
  ["an object of the wrong type", { source: "test" }, "event: source: must be object"],
  ["data that is not an object", { data: [1] }, "event: data: must be object"],
  ["a constant that is not", { v: 1 }, "event: v: must be equal to constant"],
  ["a type that is not on the list", { type: "task.lost" }, `event: type: must be one of ${TYPES}`],
  ["a kind that is not on the list", { source: { adapter: "test", kind: "heard" } }, "event: source.kind: must be one of observed, claimed"],
  ["an empty name", { id: "" }, "event: id: must NOT have fewer than 1 characters"],
  ["a time that does not fit the pattern", { time: "2026-01-02 03:04:05Z" }, `event: time: must match pattern "${TIME}"`],
  ["a time that is not on the calendar", { time: "2026-02-30T03:04:05Z" }, "event: time: not a real time"],
  ["an hour that is not on the clock", { time: "2026-01-02T24:00:00Z" }, "event: time: not a real time"],
  ["a sha that is not one", { sha: "abc" }, 'event: sha: must match pattern "^([0-9a-f]{40}|[0-9a-f]{64})$"'],
  ["a harness name with a control character", { harness: { name: "a\u0007", revision: "1" } }, `event: harness.name: must match pattern "${PLAIN}"`],
  ["a harness revision too long", { harness: { name: "a", revision: "r".repeat(257) } }, "event: harness.revision: must NOT have more than 256 characters"],
  ["a revision of 256 characters, each above U+FFFF", { harness: { name: "a", revision: "\u{1F600}".repeat(256) } }, ""],
  ["a sig key that is not a key id", { sig: { key: "A".repeat(64), value: "x" } }, `event: sig.key: must match pattern "${SHA}"`],
  ["an empty sig value", { sig: { key: "a".repeat(64), value: "" } }, "event: sig.value: must NOT have fewer than 1 characters"],
  ["to on a type that is not a task given or taken back", { type: "task.opened", to: { kind: "agent", id: "a" } }, "event: to: only on task.assigned and task.unassigned"],
  ["to of the wrong type, on the wrong type", { type: "task.opened", to: "a" }, "event: to: only on task.assigned and task.unassigned; event: to: must be object"],
  ["to of the wrong type", { to: 5 }, "event: to: must be object"],
  ["to with a kind that is not on the list", { to: { kind: "team", id: "a" } }, "event: to.kind: must be one of person, agent"],
  ["ledger.created on line 2, without data.mode", { type: "ledger.created", task: undefined }, "event: data: missing; event: type: only the first line can be ledger.created"],
  ["ledger.created with data but no mode", { type: "ledger.created", data: {} }, "event: data.mode: missing; event: type: only the first line can be ledger.created"],
  ["ledger.created with a mode that is not trial", { type: "ledger.created", data: { mode: "real" } }, "event: data.mode: must be one of trial; event: type: only the first line can be ledger.created"],
  ["ledger.created with data that is not an object, said once", { type: "ledger.created", data: 5 }, "event: data: must be object; event: type: only the first line can be ledger.created"],
  ["task_from without task", { task: undefined, task_from: "env" }, "event: an event: must have property task when property task_from is present"],
  ["fields that look like numbers first, in numeric order", { zz: 1, "10": 1, "2": 1, b: 1 }, "event: 2: not a field of an event; event: 10: not a field of an event; event: b: not a field of an event; event: zz: not a field of an event"],
  [
    "several faults in one event, in the order the check finds them",
    {
      colour: "red",
      v: 1,
      id: "",
      type: "ledger.created",
      time: "2026-02-30T03:04:05Z",
      project: undefined,
      source: { kind: "heard", q: 1 },
      to: { kind: "team", id: 3 },
      task: undefined,
      task_from: "env",
      sig: { key: "x", value: "" },
    },
    [
      "to: only on task.assigned and task.unassigned",
      "data: missing",
      "project: missing",
      "colour: not a field of an event",
      "v: must be equal to constant",
      "id: must NOT have fewer than 1 characters",
      "source.adapter: missing",
      "source.q: not a field of an event",
      "source.kind: must be one of observed, claimed",
      "to.kind: must be one of person, agent",
      "to.id: must be string",
      'sig.key: must match pattern "^[0-9a-f]{64}$"',
      "sig.value: must NOT have fewer than 1 characters",
      "an event: must have property task when property task_from is present",
      "time: not a real time",
    ]
      .map((f) => `event: ${f}`)
      .join("; ") + "; event: type: only the first line can be ledger.created",
  ],
];

for (const [name, over, faults] of CASES) {
  test(`#140: howl verify names ${name}`, () => {
    const value = { ...event(), ...over };
    for (const key of Object.keys(value)) if ((value as Record<string, unknown>)[key] === undefined) delete (value as Record<string, unknown>)[key];
    const r = faultsOf(ledgerWithEvent(value));
    assert.equal(r.faults, faults, r.out);
    assert.equal(r.status, faults === "" ? 0 : 1, r.out);
  });
}

/** Lines that break the line schema, or are not JSON, each with what `howl verify` says of line 2. */
const LINES: [string, (prev: string) => string, string][] = [
  ["an event that is not an object", (prev) => `{"prev":"${prev}","hash":"${"a".repeat(64)}","event":[]}`, "line: event: must be object"],
  ["a line that is not an object", () => "[]", "line: a line: must be object"],
  ["a line with a field of its own, a prev of the wrong type and no hash", () => `{"prev":5,"event":{},"x":1}`, "line: hash: missing; line: x: not a field of a line; line: prev: must be string,null"],
  ["a prev that is not a hash", () => `{"prev":"abc","hash":"${"a".repeat(64)}","event":{}}`, `line: prev: must match pattern "${SHA}"`],
  [
    "fields of an event not in fixed form: those that look like numbers first, then the rest in their order",
    (prev) => {
      const text = `{"zz":1,"10":1,"2":1,"b":1,${fixedForm(event()).toString("utf8").slice(1)}`;
      return `{"prev":"${prev}","hash":"${eventHash(JSON.parse(text) as never)}","event":${text}}`;
    },
    "event: 2: not a field of an event; event: 10: not a field of an event; event: zz: not a field of an event; event: b: not a field of an event",
  ],
  ["a line that is not JSON", () => "{not json", "the line is not JSON"],
  ["an empty line", () => "", "the line is empty"],
  ["a line nested 129 deep", () => "[".repeat(129) + "]".repeat(129), "the line is not JSON: nested more than 128 deep"],
  ["a number beyond a double", (prev) => `{"prev":"${prev}","hash":"${"a".repeat(64)}","event":{"v":1e400}}`, "the line is not JSON"],
  ["a lone surrogate", (prev) => `{"prev":"${prev}","hash":"${"a".repeat(64)}","event":{"id":"\\ud800"}}`, "the line: a string with a lone surrogate has no fixed form"],
  ["a lone surrogate in a key", (prev) => `{"prev":"${prev}","hash":"${"a".repeat(64)}","event":{"\\udc00":1}}`, "the line: a string with a lone surrogate has no fixed form"],
  ["a lone surrogate and a number beyond a double", (prev) => `{"prev":"${prev}","hash":"${"a".repeat(64)}","event":{"id":"\\ud800","v":-1e400}}`, "the line is not JSON"],
  ["a lone surrogate in a text that is not JSON", () => `{"id":"\\ud800",}`, "the line is not JSON"],
];

for (const [name, line, faults] of LINES) {
  test(`#140: howl verify names ${name}`, () => {
    const path = ledgerOf("");
    const prev = hashLine(Buffer.from(rawLines(path)[0]!));
    const r = faultsOf(rewrite(path, line(prev)));
    assert.equal(r.faults, faults, r.out);
    assert.equal(r.status, 1, r.out);
  });
}

test("#140: a line that is not UTF-8 is not JSON", () => {
  const path = ledgerOf("");
  writeFileSync(path, Buffer.concat([Buffer.from(`${rawLines(path)[0]!}\n{"a":"`), Buffer.from([0xff]), Buffer.from('"}\n')]));
  assert.equal(faultsOf(path).faults, "the line is not JSON");
});

test("#140: a byte order mark at the start of a line is passed over, and the line is hashed as it stands", () => {
  const path = ledgerOf("");
  const first = rawLines(path)[0]!;
  const e = event();
  const line = Buffer.from(`﻿{"prev":"${hashLine(Buffer.from(first))}","hash":"${eventHash(e)}","event":${fixedForm(e).toString("utf8")}}`);
  const e2 = event();
  const third = `{"prev":"${hashLine(line)}","hash":"${eventHash(e2)}","event":${fixedForm(e2).toString("utf8")}}`;
  writeFileSync(path, Buffer.concat([Buffer.from(`${first}\n`), line, Buffer.from(`\n${third}\n`)]));
  const r = howl(["verify", "--ledger", path]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ok: 3 lines checked/m);
});

test("#140: the first line must be ledger.created, and its prev null", () => {
  const path = join(folder(), "ledger.jsonl");
  const e = event();
  writeFileSync(path, `{"prev":"${"a".repeat(64)}","hash":"${eventHash(e)}","event":${fixedForm(e).toString("utf8")}}\n`);
  const r = howl(["verify", "--ledger", path]);
  assert.equal(r.status, 1);
  assert.equal(
    r.stdout,
    `${path}\nline 1: event: type: the first line must be ledger.created; prev: is not null, so this is not the first line of a ledger: lines before it were removed\nfailed at line 1, after 0 lines that hold\n`,
  );
});

test("#140: the whole text of a ledger that holds, and of one that does not", () => {
  const path = ledgerOf("");
  writeFileSync(path, `${rawLines(path)[0]!}\n`);
  const ok = howl(["verify", "--ledger", path]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, new RegExp(`^${path}\\nok: 1 line checked, head [0-9a-f]{64}\\na trial: it does not count as evidence\\nsignatures: 0 signed, 0 unsigned claimed\\n$`));
  const hash = hashLine(Buffer.from(rawLines(path)[0]!));
  assert.equal(ok.stdout.split("head ")[1]!.slice(0, 64), hash);
  writeFileSync(path, `${rawLines(path)[0]!}\n{}`);
  const cut = howl(["verify", "--ledger", path]);
  assert.equal(cut.status, 1);
  assert.equal(cut.stdout, `${path}\nline 2: the line is cut off: it does not end with a line break\nfailed at line 2, after 1 line that hold\n`);
});

test("#140: a trial ledger says so", () => {
  const path = join(folder(), "ledger.jsonl");
  const e = { ...event(), type: "ledger.created", data: { mode: "trial" } };
  delete (e as Record<string, unknown>).task;
  writeFileSync(path, `{"prev":null,"hash":"${eventHash(e as never)}","event":${fixedForm(e).toString("utf8")}}\n`);
  const r = howl(["verify", "--ledger", path]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\na trial: it does not count as evidence\nsignatures: /);
});

test("#140: what is wrong with the command line is said as Node's parseArgs says it, with 2", () => {
  const path = ledgerOf("");
  writeFileSync(path, `${rawLines(path)[0]!}\n`);
  const cases: [string[], string][] = [
    [[], "verify needs --project or --ledger"],
    [["--colour"], `Unknown option '--colour'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "--colour"`],
    [["--colour=red"], `Unknown option '--colour'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "--colour"`],
    [["-ab"], `Unknown option '-a'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "-a"`],
    [["--=x"], `Unknown option '--=x'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "--=x"`],
    [['--a"b'], `Unknown option '--a"b'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "--a\\"b"`],
    [["--ledger"], "Option '--ledger <value>' argument missing"],
    [["--ledger", path, "--issuer"], "Option '--issuer <value>' argument missing"],
    [["--ledger", "--project", "x"], "Option '--ledger' argument is ambiguous.\nDid you forget to specify the option argument for '--ledger'?\nTo specify an option argument starting with a dash use '--ledger=-XYZ'."],
    [["--ledger", path, "extra"], "too many arguments: extra"],
    [["--ledger", path, "--", "--ledger"], "too many arguments: --ledger"],
    [["--ledger", path, "-"], "too many arguments: -"],
  ];
  const usage = howl(["help"]).stdout;
  for (const [args, message] of cases) {
    const r = howl(["verify", ...args]);
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "", args.join(" "));
    assert.equal(r.stderr, `howl: ${message}\n\n${usage}`, args.join(" "));
  }
});

test("#140: a ledger that cannot be read, or a place that cannot be, ends with 2", () => {
  const dir = folder();
  const cases: [string[], Record<string, string>, string][] = [
    [["--ledger", join(dir, "none")], {}, `ENOENT: no such file or directory, open '${join(dir, "none")}'`],
    [["--ledger="], {}, "ENOENT: no such file or directory, open ''"],
    [["--ledger", dir], {}, "EISDIR: illegal operation on a directory, read"],
    [["--project", "a/b"], { HOWL_HOME: dir }, `"a/b" is not a project name: use letters, digits, '.', '_' and '-', starting with a letter or digit`],
    [["--project", PROJECT], { HOWL_HOME: "relative" }, 'HOWL_HOME must be an absolute path, not "relative"'],
    [["--project", PROJECT], { HOWL_HOME: "", XDG_STATE_HOME: "relative", HOME: `${dir}//x/../y` }, `ENOENT: no such file or directory, open '${dir}/y/.local/state/howl/${PROJECT}/ledger.jsonl'`],
    [["--project", PROJECT], { XDG_STATE_HOME: `${dir}/state/` }, `ENOENT: no such file or directory, open '${dir}/state/howl/${PROJECT}/ledger.jsonl'`],
    [["--project", PROJECT], { HOWL_HOME: `${dir}/./h//` }, `ENOENT: no such file or directory, open '${dir}/h/${PROJECT}/ledger.jsonl'`],
    [["--project", PROJECT], { HOME: "" }, "no home folder to keep the ledger in: set HOWL_HOME"],
  ];
  for (const [args, env, message] of cases) {
    const r = howl(["verify", ...args], { env });
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "", args.join(" "));
    assert.equal(r.stderr, `howl: ${message}\n`, args.join(" "));
  }
  mkdirSync(join(dir, "h", PROJECT), { recursive: true });
  const ledger = join(dir, "h", PROJECT, "ledger.jsonl");
  openLedger(ledger, { project: PROJECT }).close();
  const found = howl(["verify", "--project", PROJECT], { env: { HOWL_HOME: `${dir}/./h//` } });
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout.split("\n")[0], ledger);
});

test("#140: an issuer that is not a key id is a usage error, after the ledger was checked", () => {
  const path = ledgerOf("");
  writeFileSync(path, `${rawLines(path)[0]!}\n`);
  const r = howl(["verify", "--ledger", path, "--issuer", "abc"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^.*\nok: 1 line checked, head [0-9a-f]{64}\na trial: it does not count as evidence\n$/);
  assert.match(r.stderr, /^howl: --issuer must be a key id: 64 hex digits\n\nusage:/);
});

test("#140: parseJson refuses a number beyond a double, and a lone surrogate, with the words of the Rust", () => {
  assert.throws(() => parseJson("1e400"), { message: "not JSON" });
  assert.throws(() => parseJson('{"a":[-1e400]}'), { message: "not JSON" });
  assert.throws(() => parseJson('"\\ud800"'), { message: "a string with a lone surrogate has no fixed form" });
  assert.throws(() => parseJson('{"\\udc00":1}'), { message: "a string with a lone surrogate has no fixed form" });
  assert.throws(() => parseJson('["\\ud800", 1e400]'), { message: "not JSON" });
  assert.deepEqual(parseJson('["\\ud83d\\ude00", 1e308]'), ["\u{1F600}", 1e308]);
});
