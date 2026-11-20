// A session names its harness and the revision it runs under: the tests of issue #129 that name the field.
// @code_class tests
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { curlHookLine } from "../src/hook/line.ts";
import { openLedger, type LedgerEvent } from "../src/ledger/ledger.ts";
import { eventFaults } from "../src/ledger/schema.ts";
import { readFilters } from "../src/read/filter.ts";
import { event, folder, howl, inboxEvents, inboxFiles, lines, PROJECT, rawLines, workspace, type Workspace } from "./helpers.ts";
import { ledgerEvents } from "./story.ts";
import { up, until, type Up } from "./up-helpers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HARNESS = "example-harness";
const REVISION = "1.4.2 3f9a0c51d7e8";
const NAMES = { HOWL_HARNESS: HARNESS, HOWL_HARNESS_REVISION: REVISION };

type Json = Record<string, any>;

function hookJson(ws: Workspace, name: string, extra: Json = {}, session = "s1"): Json {
  return { session_id: session, cwd: ws.root, hook_event_name: name, ...extra };
}

/** Every kind of hook, in one session. */
const SESSION = (ws: Workspace, id = "s1"): Json[] => [
  hookJson(ws, "SessionStart", { source: "startup" }, id),
  hookJson(ws, "PostToolUse", { tool_name: "Bash", tool_input: { command: "gh pr view" } }, id),
  hookJson(ws, "Stop", {}, id),
  hookJson(ws, "SessionEnd", { reason: "other" }, id),
];

function hook(ws: Workspace, json: Json, env: Record<string, string>): Json {
  const result = howl(["hook"], { cwd: ws.root, env: { ...ws.env, ...env }, input: JSON.stringify(json) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  return inboxEvents(ws.inbox).at(-1) as unknown as Json;
}

const stable = (e: Json): Json => {
  const { id: _id, time: _time, source: _source, ...rest } = e;
  return rest;
};

/** An event of an agent's session that the schema accepts, with `harness` as given. */
const claimed = (harness: unknown): Json => ({ ...event({ type: "session.started", source: { adapter: "claude-code-hook", kind: "claimed" }, actor: { kind: "agent", id: "agent-1" }, session: "s1" }), harness });

test("R129.1: with both names set, every event of the session holds `harness` with its `name` and `revision`, as a claim", () => {
  const ws = workspace();
  for (const json of SESSION(ws)) {
    const e = hook(ws, json, NAMES);
    assert.deepEqual(e.harness, { name: HARNESS, revision: REVISION }, String(e.type));
    assert.equal(e.source.kind, "claimed");
    assert.deepEqual(eventFaults(e), []);
  }
  assert.equal(inboxEvents(ws.inbox).length, 4);
});

test("R129.2: with only one of the two set, no event has the field `harness`", () => {
  const ws = workspace();
  for (const env of [{ HOWL_HARNESS: HARNESS }, { HOWL_HARNESS_REVISION: REVISION }]) {
    for (const json of SESSION(ws)) {
      const e = hook(ws, json, env);
      assert.ok(!("harness" in e), JSON.stringify(e));
    }
  }
});

test("R129.3: the schema takes `harness` with a name and a revision of 1 to 256 characters, and refuses the rest", () => {
  const ok = (h: unknown) => assert.deepEqual(eventFaults(claimed(h)), [], JSON.stringify(h));
  const refused = (h: unknown, why: string) => assert.notDeepEqual(eventFaults(claimed(h)), [], why);
  ok({ name: HARNESS, revision: REVISION });
  ok({ name: "a", revision: "b" });
  ok({ name: "å".repeat(256), revision: "é".repeat(256) });
  refused({ name: "a".repeat(257), revision: "b" }, "a name of 257");
  refused({ name: "a", revision: "b".repeat(257) }, "a revision of 257");
  refused({ name: "", revision: "b" }, "an empty name");
  refused({ name: "a", revision: "" }, "an empty revision");
  refused({ name: "a" }, "no revision");
  refused({ revision: "b" }, "no name");
  refused({ name: "a", revision: "b", extra: "c" }, "a third part");
  refused({ name: 1, revision: "b" }, "a number");
  refused("example-harness 1.4", "text in place of an object");
  for (const bad of ["\n", "\r", "\t", "\u0000", "\u001f", "\u007f"]) {
    refused({ name: `a${bad}b`, revision: "b" }, `a name with U+${bad.charCodeAt(0).toString(16)}`);
    refused({ name: "a", revision: `b${bad}c` }, `a revision with U+${bad.charCodeAt(0).toString(16)}`);
  }
  ok({ name: "a b", revision: "c\u0080d" });
});

test("R129.3: an event with a refused `harness` is moved to rejected/ at ingest and nothing is written to the ledger", () => {
  const ws = workspace();
  hook(ws, SESSION(ws)[0]!, NAMES);
  const [name] = inboxFiles(ws.inbox);
  const path = join(ws.inbox, name!);
  const e = JSON.parse(readFileSync(path, "utf8")) as Json;
  e.harness.revision = "line one\nline two";
  writeFileSync(path, JSON.stringify(e));
  const result = howl(["ingest"], { cwd: ws.root, env: ws.env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(inboxFiles(ws.inbox), []);
  assert.ok(readdirSync(join(ws.inbox, "rejected")).some((f) => f.endsWith(".json")), "the event is in rejected/");
  assert.ok(!existsSync(ws.ledger) || lines(ws.ledger).every((l) => !JSON.stringify(l.event).includes("line one")));
  assert.ok(!existsSync(ws.ledger) || rawLines(ws.ledger).length <= 1, "only the first line, if any");
});

test("R129.15: each name is trimmed, and a blank value counts as missing", () => {
  const ws = workspace();
  const json = SESSION(ws)[0]!;
  assert.deepEqual(hook(ws, json, { HOWL_HARNESS: `  ${HARNESS}\t`, HOWL_HARNESS_REVISION: ` ${REVISION}  ` }).harness, { name: HARNESS, revision: REVISION });
  for (const env of [
    { HOWL_HARNESS: "   ", HOWL_HARNESS_REVISION: REVISION },
    { HOWL_HARNESS: HARNESS, HOWL_HARNESS_REVISION: " \t " },
    { HOWL_HARNESS: "", HOWL_HARNESS_REVISION: REVISION },
    { HOWL_HARNESS: HARNESS, HOWL_HARNESS_REVISION: "" },
  ]) {
    assert.ok(!("harness" in hook(ws, json, env)), JSON.stringify(env));
  }
});

test("R129.9: a session with no harness named has events with the fields it had before", () => {
  const ws = workspace();
  for (const json of SESSION(ws)) {
    const e = hook(ws, json, { HOWL_ROLE: "review" });
    assert.ok(!("harness" in e));
    assert.ok(Object.keys(e).every((k) => ["v", "id", "time", "type", "source", "project", "actor", "session", "role", "data", "repo", "branch", "sha", "task", "task_from", "change", "model", "effort"].includes(k)), Object.keys(e).join());
  }
});

test("R129.13: a ledger written before the field was there verifies", () => {
  const fixture = join(ROOT, "test", "fixtures", "ledger-before-harness.jsonl");
  const rows = readFileSync(fixture, "utf8").split("\n").slice(0, -1);
  assert.ok(rows.length >= 3);
  assert.ok(rows.every((r) => !r.includes("harness")), "the fixture is from before the field");
  const result = howl(["verify", "--ledger", fixture]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`\\b${rows.length} lines\\b`));
});

test("R129.6: the harness is signed with the rest of the claim: a changed revision fails with the line named", () => {
  const ws = workspace();
  ws.env.HOWL_CONFIG = folder();
  const run = (args: string[]) => howl(args, { cwd: ws.root, env: ws.env });
  const issued = run(["key", "issue", "--actor", "agent-1"]);
  assert.equal(issued.status, 0, issued.stderr);
  const keyFile = /HOWL_KEY=(\S+)/.exec(issued.stdout)![1]!;
  const signed = hook(ws, SESSION(ws)[0]!, { ...NAMES, HOWL_KEY: keyFile });
  assert.ok(signed.sig, "signed");
  // Untouched, it verifies.
  assert.equal(run(["ingest"]).status, 0);
  const good = run(["verify", "--project", PROJECT]);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  // A second signed event, its revision changed before ingest.
  hook(ws, SESSION(ws, "s2")[0]!, { ...NAMES, HOWL_KEY: keyFile });
  const second = inboxFiles(ws.inbox).at(-1)!;
  const changed = JSON.parse(readFileSync(join(ws.inbox, second), "utf8")) as Json;
  assert.ok(changed.sig && changed.harness);
  changed.harness.revision = "9.9.9";
  writeFileSync(join(ws.inbox, second), JSON.stringify(changed));
  assert.equal(run(["ingest"]).status, 0);
  const bad = run(["verify", "--project", PROJECT]);
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stdout, /line \d+: .*signature does not hold/);
});

test("R129.11: the hook line carries the two headers, and the README names both variables", () => {
  const line = curlHookLine({ url: "http://127.0.0.1:4317", tokenFile: "/x/token" });
  assert.ok(line.includes('-H "X-Howl-Harness: $HOWL_HARNESS"'), line);
  assert.ok(line.includes('-H "X-Howl-Harness-Revision: $HOWL_HARNESS_REVISION"'), line);
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.ok(readme.includes("`HOWL_HARNESS`") && readme.includes("`HOWL_HARNESS_REVISION`"));
});

test("R129.12: docs/architecture.md names the field among the claims", () => {
  const text = readFileSync(join(ROOT, "docs", "architecture.md"), "utf8");
  const claims = text.split("\n").find((l) => l.includes("stay claims"));
  assert.ok(claims?.includes("`harness`"), claims);
});

test("R129.18: the table of fields of docs/architecture.md has a row for `harness`, and the row for `rules` says what became of it", () => {
  const rows = readFileSync(join(ROOT, "docs", "architecture.md"), "utf8").split("\n").filter((l) => l.startsWith("|"));
  assert.ok(rows.some((r) => r.startsWith("| `harness` |")));
  assert.match(rows.find((r) => r.startsWith("| `rules` |"))!, /harness/);
});

test("R129.17: the help of howl watch and the README name the pairs harness= and revision=", () => {
  const help = howl(["--help"]).stdout;
  assert.match(help, /harness=<name>/);
  assert.match(help, /revision=<revision>/);
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.ok(readme.includes("harness=<name>") && readme.includes("revision=<revision>"));
});

// ---- howl show and howl watch -------------------------------------------------------------

const A1 = { name: "harness-a", revision: "1.0" };
const A2 = { name: "harness-a", revision: "2.0" };
const B1 = { name: "harness-b", revision: "1.0" };

/** The story, with the sessions s1 and s2 of change 30 and s3 of change 31 naming a harness, and a task with a second change. */
function harnessLedger(harness: Record<string, { name: string; revision: string }>, more: LedgerEvent[] = []): string {
  const path = join(folder(), "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  const all = [...ledgerEvents(), ...more].map((e) => (e.session && harness[e.session] && e.source.kind === "claimed" ? { ...e, harness: harness[e.session]! } : e));
  for (const e of all.sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) writer.append(e);
  writer.close();
  return path;
}

const show = (ledger: string, ...args: string[]) => {
  const r = howl(["show", ...args, "--ledger", ledger, "--utc"]);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test("R129.7: howl show gives each session's line `harness <name> <revision>` after its role, and none for a session without", () => {
  const out = show(harnessLedger({ s1: A1, s2: A1 }), "12");
  const s1 = out.split("\n").find((l) => l.includes("session s1 "))!;
  assert.match(s1, /harness harness-a 1\.0 /);
  assert.ok(s1.indexOf("claimed") < s1.indexOf("harness harness-a"), s1);
  const none = show(harnessLedger({}), "12");
  assert.ok(!none.includes("harness "), "no session names one");
  const mixed = show(harnessLedger({ s1: A1 }), "12").split("\n");
  assert.ok(mixed.find((l) => l.includes("session s2 "))!.indexOf("harness") === -1);
  const json = JSON.parse(howl(["show", "12", "--ledger", harnessLedger({ s1: A1 }), "--json"]).stdout);
  assert.deepEqual(json.sessions.find((s: Json) => s.session === "s1").harness, A1);
});

test("R129.8: howl show says when the sessions of one change ran under different revisions, and not when they did not", () => {
  const differ = show(harnessLedger({ s1: A1, s2: A2 }), "12");
  assert.ok(differ.includes("the sessions of change 30 ran under different revisions: harness-a 1.0, harness-a 2.0"), differ);
  assert.ok(show(harnessLedger({ s1: A1, s2: B1 }), "12").includes("harness-a 1.0, harness-b 1.0"), "a different name differs too");
  for (const same of [{ s1: A1, s2: A1 }, { s1: A1 }, {}]) assert.ok(!show(harnessLedger(same), "12").includes("different revisions"), JSON.stringify(same));
  // The line is under Sessions, and in the view of the change as well.
  const change = show(harnessLedger({ s1: A1, s2: A2 }), "change:30");
  assert.ok(change.includes("different revisions"), change);
  // Another task's session s3 does not count in the comparison.
  assert.ok(!show(harnessLedger({ s1: A1, s2: A1, s3: B1 }), "12").includes("different revisions"));
});

test("R129.16: in the view of a task with several changes, a line for each change whose sessions differ, naming it", () => {
  const extra = (type: LedgerEvent["type"], minute: number, session: string | undefined, change: string): LedgerEvent => ({
    v: 0,
    id: `more-${type}-${session ?? "x"}-${change}`,
    time: new Date(Date.UTC(2026, 0, 1, 8, 0, 0) + minute * 60_000).toISOString(),
    type,
    source: session ? { adapter: "claude-code-hook", kind: "claimed" } : { adapter: "local", kind: "observed" },
    project: PROJECT,
    task: "12",
    change,
    branch: `task-12-${change}`,
    ...(session ? { actor: { kind: "agent" as const, id: "agent-1" }, session } : { data: { seen: "x" } }),
  });
  const more = [
    extra("change.opened", 62, undefined, "32"),
    extra("session.started", 63, "s4", "32"),
    extra("session.started", 64, "s5", "32"),
    extra("session.ended", 65, "s4", "32"),
    extra("session.ended", 66, "s5", "32"),
  ];
  const out = show(harnessLedger({ s1: A1, s2: A2, s4: B1, s5: B1 }, more), "12");
  const said = out.split("\n").filter((l) => l.includes("different revisions"));
  assert.equal(said.length, 1, out);
  assert.match(said[0]!, /change 30 /);
  const both = show(harnessLedger({ s1: A1, s2: A2, s4: B1, s5: A1 }, more), "12").split("\n").filter((l) => l.includes("different revisions"));
  assert.equal(both.length, 2);
  assert.match(both[0]! + both[1]!, /change 30 [^]*change 32 /);
});

test("R129.10: the filter pairs harness= and revision= pick the events of that harness, and a value ending in * matches a start", () => {
  const withHarness = (h?: { name: string; revision: string }) => ({ ...event(), ...(h ? { harness: h } : {}) }) as LedgerEvent;
  const events = [withHarness(A1), withHarness(A2), withHarness(B1), withHarness()];
  const names = (...texts: string[]) => {
    const f = readFilters(texts);
    assert.equal(f.failed(), null);
    return events.filter((e) => f.test(e)).map((e) => e.harness && `${e.harness.name} ${e.harness.revision}`);
  };
  assert.deepEqual(names("harness=harness-a"), ["harness-a 1.0", "harness-a 2.0"]);
  assert.deepEqual(names("revision=1.0"), ["harness-a 1.0", "harness-b 1.0"]);
  assert.deepEqual(names("harness=harness-*"), ["harness-a 1.0", "harness-a 2.0", "harness-b 1.0"]);
  assert.deepEqual(names("revision=2*"), ["harness-a 2.0"]);
  assert.deepEqual(names("harness=harness-a", "revision=2.0"), ["harness-a 2.0"]);
  assert.deepEqual(names("harness=none"), []);
  assert.deepEqual(names('event.harness.name == "harness-b" && event.harness.revision == "1.0"'), ["harness-b 1.0"]);
});

test("R129.10: howl watch --filter harness=<name> prints the matching events", () => {
  const ledger = harnessLedger({ s1: A1, s2: A2, s3: B1 });
  const lineCount = (...filters: string[]) =>
    howl(["watch", "--ledger", ledger, "--no-follow", ...filters.flatMap((f) => ["--filter", f])]).stdout.split("\n").filter((l) => /^\d{4}-/.test(l)).length;
  const s1 = ledgerEvents().filter((e) => e.session === "s1" && e.source.kind === "claimed").length;
  const s2 = ledgerEvents().filter((e) => e.session === "s2" && e.source.kind === "claimed").length;
  assert.equal(lineCount("harness=harness-a"), s1 + s2);
  assert.equal(lineCount("revision=2.0"), s2);
  assert.equal(lineCount("harness=harness-*", "revision=1*"), s1 + 1);
});

// ---- the header form ------------------------------------------------------------------------

let running: Up;
before(async () => {
  running = await up();
});
after(async () => {
  await running.stop();
});

const sendHook = (body: Json, headers: Record<string, string>) =>
  fetch(`${running.url}/api/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${running.token}`, "x-howl-actor": "agent-7", ...headers },
    body: JSON.stringify(body),
  });
const held = (): Json[] => [...lines(running.ws.ledger).map((l) => l.event as Json), ...(existsSync(running.ws.activity) ? rawLines(running.ws.activity).map((r) => JSON.parse(r) as Json) : [])];

test("R129.5: the headers give the event the environment gives, and a header that is blank or alone gives none", async () => {
  const cases: [string, Record<string, string>, Record<string, string>][] = [
    ["both", NAMES, { "x-howl-harness": HARNESS, "x-howl-harness-revision": REVISION }],
    ["trimmed", NAMES, { "x-howl-harness": `  ${HARNESS} `, "x-howl-harness-revision": ` ${REVISION}` }],
    ["name only", { HOWL_HARNESS: HARNESS }, { "x-howl-harness": HARNESS }],
    ["blank revision", { HOWL_HARNESS: HARNESS, HOWL_HARNESS_REVISION: " " }, { "x-howl-harness": HARNESS, "x-howl-harness-revision": " " }],
  ];
  for (const [what, env, headers] of cases) {
    const session = `hdr-${what.replace(/ /g, "-")}`;
    const json = hookJson(running.ws, "SessionStart", { source: "startup" }, session);
    const home = folder();
    const built = howl(["hook"], { cwd: running.ws.root, env: { HOWL_HOME: home, HOWL_ACTOR: "agent-7", ...env }, input: JSON.stringify(json) });
    assert.equal(built.status, 0, built.stderr);
    const [byHook] = inboxEvents(join(home, PROJECT, "inbox")) as unknown as Json[];
    const answer = await sendHook(json, headers);
    assert.equal(answer.status, 200);
    const byServer = await until(() => held().find((e) => e.session === session), 3000, what);
    assert.deepEqual(stable(byServer), stable(byHook!), what);
    assert.equal("harness" in byServer, what === "both" || what === "trimmed", what);
  }
});

// ---- Round 2, finding 1: the clauses of 129.6, 129.7 and 129.8 that no test held ------------

/** As `harnessLedger`, and the session start of each session in `roles` names that role. */
function roleLedger(harness: Record<string, { name: string; revision: string }>, roles: Record<string, string>): string {
  const path = join(folder(), "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  const all = ledgerEvents().map((e) => {
    const named = e.session && harness[e.session] && e.source.kind === "claimed" ? { ...e, harness: harness[e.session]! } : e;
    return e.session && roles[e.session] && e.source.kind === "claimed" ? { ...named, role: roles[e.session]! } : named;
  });
  for (const e of all.sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) writer.append(e);
  writer.close();
  return path;
}

test("R129.7: the harness stands after `role <role>` on the session's line", () => {
  const out = show(roleLedger({ s1: A1 }, { s1: "builder" }), "12");
  const s1 = out.split("\n").find((l) => l.includes("session s1 "))!;
  assert.match(s1, /role builder {2}harness harness-a 1\.0 {2}/, s1);
});

test("R129.7: the harness is named once on a session's line, on each session that has one", () => {
  const out = show(roleLedger({ s1: A1, s2: A1 }, {}), "12");
  for (const id of ["s1", "s2"]) {
    const line = out.split("\n").find((l) => l.includes(`session ${id} `))!;
    assert.equal(line.split("harness harness-a 1.0").length - 1, 1, line);
  }
});

test("R129.8: the line that the revisions differ stands under Sessions, before the next heading", () => {
  const out = show(harnessLedger({ s1: A1, s2: A2 }), "12").split("\n");
  const at = out.findIndex((l) => l.includes("ran under different revisions"));
  const sessions = out.indexOf("Sessions");
  assert.ok(sessions >= 0 && at > sessions, "after the Sessions heading");
  const next = out.findIndex((l, i) => i > sessions && /^\S/.test(l));
  assert.ok(next === -1 || at < next, "before the next heading");
  assert.ok(out.slice(sessions + 1, at).some((l) => l.includes("session s2 ")), "after the sessions' own lines");
  assert.ok(out.slice(at + 1).some((l) => l.trim() !== ""), "the summary comes after it, not before");
});

test("R129.6: a changed harness name fails verify as a changed revision does", () => {
  const ws = workspace();
  ws.env.HOWL_CONFIG = folder();
  const run = (args: string[]) => howl(args, { cwd: ws.root, env: ws.env });
  const keyFile = /HOWL_KEY=(\S+)/.exec(run(["key", "issue", "--actor", "agent-1"]).stdout)![1]!;
  hook(ws, SESSION(ws)[0]!, { ...NAMES, HOWL_KEY: keyFile });
  const file = inboxFiles(ws.inbox).at(-1)!;
  const changed = JSON.parse(readFileSync(join(ws.inbox, file), "utf8")) as Json;
  assert.ok(changed.sig && changed.harness);
  changed.harness.name = "other-harness";
  writeFileSync(join(ws.inbox, file), JSON.stringify(changed));
  assert.equal(run(["ingest"]).status, 0);
  const bad = run(["verify", "--project", PROJECT]);
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stdout, /line \d+: .*signature does not hold/);
});
