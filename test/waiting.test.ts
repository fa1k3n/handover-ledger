// #102: the dashboard and howl status say when a project has no writer and
// events waiting in its inbox.
// @code_class tests
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { leave } from "../src/inbox/inbox.ts";
import { openLedger } from "../src/ledger/ledger.ts";
import { writingLines } from "../src/dashboard/format.ts";
import { projectsWriting, writingLine, writingOf } from "../src/read/writing.ts";
import { startServer } from "../src/serve/server.ts";
import { event, folder, howl, PROJECT, workspace } from "./helpers.ts";
import { observed, until, up } from "./up-helpers.ts";

/** A project folder in `home` with a ledger of one line and `waiting` events in its inbox. Returns the ledger's path. */
function project(home: string, name: string, waiting: number): string {
  mkdirSync(join(home, name), { recursive: true });
  const ledger = join(home, name, "ledger.jsonl");
  openLedger(ledger, { project: name }).close();
  for (let i = 0; i < waiting; i++) leave(join(home, name, "inbox"), event({ project: name }));
  return ledger;
}

/** The pid of a process that has ended. */
const gone = () => spawnSync(process.execPath, ["-e", "0"]).pid!;

test("#102: a project with events in its inbox and no lock has no writer; a lock of a running process is one; a lock left behind is none", () => {
  const home = folder();
  const ledger = project(home, "a", 3);
  const none = writingOf(ledger);
  assert.deepEqual({ writer: none.writer, waiting: none.waiting, left: none.left }, { writer: false, waiting: 3, left: undefined });
  assert.ok(none.oldest !== null && Date.now() - none.oldest < 60_000, "the oldest is told by its name's time");

  writeFileSync(`${ledger}.lock`, `${process.pid}\n`);
  assert.equal(writingOf(ledger).writer, true);
  writeFileSync(`${ledger}.lock`, `${gone()}\n`);
  assert.deepEqual([writingOf(ledger).writer, writingOf(ledger).left], [false, true], "left by a process that no longer runs");
  writeFileSync(`${ledger}.lock`, "");
  assert.equal(writingOf(ledger).writer, true, "a lock being taken, with no number yet, is a writer");
});

test("#102: an empty inbox, no inbox, a half-written file and the rejected folder are nothing waiting", () => {
  const home = folder();
  const ledger = project(home, "a", 0);
  assert.deepEqual(writingOf(ledger), { writer: false, waiting: 0, oldest: null }, "no inbox folder");
  mkdirSync(join(home, "a", "inbox", "rejected"), { recursive: true });
  writeFileSync(join(home, "a", "inbox", ".000001794000000000-x.json.tmp"), "{");
  writeFileSync(join(home, "a", "inbox", "rejected", "000001794000000000-y.json"), "{}");
  assert.deepEqual(writingOf(ledger), { writer: false, waiting: 0, oldest: null });
});

test("#102: the line names the project and the number, and is said only when events wait", () => {
  const now = Date.UTC(2026, 0, 1, 8, 0, 0);
  assert.equal(writingLine("example", { writer: false, waiting: 57, oldest: now - 5000 }, now), "example: 57 events wait and nothing writes them. Start howl up in its repository.");
  assert.equal(writingLine("example", { writer: false, waiting: 1, oldest: now }, now), "example: 1 event waits and nothing writes it. Start howl up in its repository.");
  assert.equal(writingLine("example", { writer: true, waiting: 4, oldest: now - 7 * 60_000 }, now), "example: 4 events have waited for the writer for 7 min.");
  assert.equal(writingLine("example", { writer: true, waiting: 4, oldest: now - 20_000 }, now), null, "a writer takes them in a moment");
  assert.equal(writingLine("example", { writer: true, waiting: 4, oldest: now - 2 * 60_000 }, now), null, "howl observe takes them at its next round, a minute by default: no alarm for that");
  assert.equal(
    writingLine("example", { writer: false, waiting: 2, oldest: now, left: true }, now),
    "example: 2 events wait and nothing writes them. Its lock was left by a process that no longer runs: run howl verify there, then remove the lock.",
    "a new writer would be refused: the line does not advise to start one",
  );
  assert.equal(writingLine("example", { writer: false, waiting: 0, oldest: null }, now), null);
  assert.equal(writingLine("example", { writer: true, waiting: 0, oldest: null }, now), null);
});

test("#102: /api/projects gives writer and waiting for each project, and a server of one ledger file answers as before", async () => {
  const home = folder();
  const a = project(home, "a", 2);
  project(home, "b", 0);
  writeFileSync(`${join(home, "b", "ledger.jsonl")}.lock`, `${process.pid}\n`);
  const all = await startServer({ home, port: 0, root: folder() });
  try {
    const body = (await (await fetch(`${all.url}/api/projects`)).json()) as { now: number; projects: Record<string, unknown>[] };
    assert.ok(Math.abs(body.now - Date.now()) < 5000);
    assert.deepEqual(
      body.projects.map((p) => [p.name, p.writer, p.waiting, typeof p.oldest === "number"]),
      [
        ["a", false, 2, true],
        ["b", true, 0, false],
      ],
    );
  } finally {
    await all.close();
  }
  const one = await startServer({ ledger: a, port: 0, root: folder() });
  try {
    const body = (await (await fetch(`${one.url}/api/projects`)).json()) as { projects: Record<string, unknown>[] };
    assert.deepEqual(Object.keys(body.projects[0]!).sort(), ["lines", "name"]);
  } finally {
    await one.close();
  }
});

test("#102: asking takes no lock and changes no file, with a lock there and without", async () => {
  const home = folder();
  const ledger = project(home, "a", 2);
  const held = project(home, "b", 1);
  writeFileSync(`${held}.lock`, `${process.pid}\n`);
  /** Every file with its content, and every folder. */
  const all = () =>
    (readdirSync(home, { recursive: true }) as string[])
      .sort()
      .map((name) => `${name} ${statSync(join(home, name)).isFile() ? readFileSync(join(home, name), "base64") : "/"}`)
      .join("\n");
  const before = all();
  writingOf(ledger);
  writingOf(held);
  projectsWriting(home);
  const server = await startServer({ home, port: 0, root: folder() });
  try {
    await (await fetch(`${server.url}/api/projects`)).json();
  } finally {
    await server.close();
  }
  assert.equal(all(), before, "no file made, none changed, the lock as it was");
});

test("#102: a project with events waiting and no ledger yet is said too, and is in no menu", async () => {
  const home = folder();
  project(home, "a", 0);
  leave(join(home, "new", "inbox"), event({ project: "new" }));
  mkdirSync(join(home, "empty", "inbox"), { recursive: true });
  assert.deepEqual(projectsWriting(home).map((p) => [p.name, p.ledger, p.waiting]), [["a", true, 0], ["new", false, 1]], "a folder with nothing waiting and no ledger is no project");
  const server = await startServer({ home, port: 0, root: folder() });
  try {
    const body = (await (await fetch(`${server.url}/api/projects`)).json()) as Parameters<typeof writingLines>[0] & { projects: { name: string }[]; unstarted: { name: string; waiting: number }[] };
    assert.deepEqual(body.projects.map((p) => p.name), ["a"], "the menu and the event log are of projects with a ledger");
    assert.deepEqual(body.unstarted.map((p) => [p.name, p.waiting]), [["new", 1]]);
    assert.deepEqual(writingLines(body).map((l) => [l.project, l.written, l.line]), [["new", false, "new: 1 event waits and nothing writes it. Start howl up in its repository."]]);
  } finally {
    await server.close();
  }
});

test("#102: the lines of the page: none for one ledger file, the server's time, and only a project nothing writes is marked", () => {
  const now = Date.UTC(2026, 0, 1, 8, 0, 0);
  assert.deepEqual(writingLines(null), []);
  assert.deepEqual(writingLines({ projects: [{ name: "ledger" }] }), [], "a server of one ledger file tells nothing of a writer");
  const lines = writingLines(
    {
      now,
      projects: [
        { name: "quiet", writer: true, waiting: 0, oldest: null },
        { name: "slow", writer: true, waiting: 3, oldest: now - 6 * 60_000 },
        { name: "stopped", writer: false, waiting: 2, oldest: now - 1000 },
      ],
    },
    now + 3_600_000, // the browser's clock an hour off: the server's time is the one used
  );
  assert.deepEqual(lines.map((l) => [l.project, l.written]), [["slow", true], ["stopped", false]]);
  assert.match(lines[0]!.line, /for 6 min\.$/);
});

test("#102: a name with no time and a folder in the inbox do not hide the age of the events", () => {
  const home = folder();
  const ledger = project(home, "a", 0);
  const inbox = join(home, "a", "inbox");
  mkdirSync(join(inbox, "dir.json"), { recursive: true });
  writeFileSync(join(inbox, "-junk.json"), "{}");
  const old = Date.now() - 10 * 60_000;
  writeFileSync(join(inbox, `${String(old).padStart(15, "0")}-x.json`), "{}");
  assert.deepEqual(writingOf(ledger), { writer: false, waiting: 2, oldest: old }, "the folder is no event; the name with no time is one, and tells no age");
});

test("#102: howl status prints the line for its project, and nothing more when nothing waits", () => {
  const ws = workspace();
  mkdirSync(join(ws.home, PROJECT), { recursive: true });
  openLedger(ws.ledger, { project: PROJECT }).close();
  const quiet = howl(["status"], { cwd: ws.root, env: ws.env });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stdout + quiet.stderr, /wait/);
  leave(ws.inbox, event());
  leave(ws.inbox, event());
  const said = howl(["status"], { cwd: ws.root, env: ws.env });
  assert.match(said.stdout, new RegExp(`^${PROJECT}: 2 events wait and nothing writes them\\. Start howl up in its repository\\.$`, "m"));
  const json = howl(["status", "--json"], { cwd: ws.root, env: ws.env });
  assert.doesNotMatch(json.stdout, /wait and nothing/, "--json is as it was");
});

test("#102: howl up says at its start which other project has events waiting, and names none that has not", async () => {
  const setup = observed();
  project(setup.ws.home, "other", 1);
  project(setup.ws.home, "quiet", 0);
  leave(join(setup.ws.home, "unstarted", "inbox"), event({ project: "unstarted" }));
  const run = await up(setup);
  try {
    // The lines come right after the line of its start, a moment after its server file is there.
    await until(() => /^other: /m.test(run.output()), 10_000, "the line of the other project");
    assert.match(run.output(), /^other: 1 event waits and nothing writes it\. Start howl up in its repository\.$/m);
    assert.match(run.output(), /^unstarted: 1 event waits and nothing writes it\./m, "also a project with no ledger yet");
    assert.doesNotMatch(run.output(), /^quiet:/m);
    assert.doesNotMatch(run.output(), new RegExp(`^${PROJECT}: .*wait`, "m"), "its own project is its own to write");
  } finally {
    await run.stop();
  }
});
