// #102: the dashboard and howl status say when a project has no writer and
// events waiting in its inbox.
// @code_class tests
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { leave } from "../src/inbox/inbox.ts";
import { openLedger } from "../src/ledger/ledger.ts";
import { writingLine, writingOf } from "../src/read/writing.ts";
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
  assert.deepEqual({ writer: none.writer, waiting: none.waiting }, { writer: false, waiting: 3 });
  assert.ok(none.oldest !== null && Date.now() - none.oldest < 60_000, "the oldest is told by its name's time");

  writeFileSync(`${ledger}.lock`, `${process.pid}\n`);
  assert.equal(writingOf(ledger).writer, true);
  writeFileSync(`${ledger}.lock`, `${gone()}\n`);
  assert.equal(writingOf(ledger).writer, false, "left by a process that no longer runs");
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
  assert.equal(writingLine("example", { writer: true, waiting: 4, oldest: now - 3 * 60_000 }, now), "example: 4 events have waited for the writer for 3 min.");
  assert.equal(writingLine("example", { writer: true, waiting: 4, oldest: now - 20_000 }, now), null, "a writer takes them in a moment");
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

test("#102: asking takes no lock and changes no file", async () => {
  const home = folder();
  const ledger = project(home, "a", 2);
  const listing = () => readdirSync(home, { recursive: true }).sort().join("\n");
  const before = listing();
  writingOf(ledger);
  const server = await startServer({ home, port: 0, root: folder() });
  try {
    await (await fetch(`${server.url}/api/projects`)).json();
  } finally {
    await server.close();
  }
  assert.equal(listing(), before);
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
  const run = await up(setup);
  try {
    // The lines come right after the line of its start, a moment after its server file is there.
    await until(() => /^other: /m.test(run.output()), 10_000, "the line of the other project");
    assert.match(run.output(), /^other: 1 event waits and nothing writes it\. Start howl up in its repository\.$/m);
    assert.doesNotMatch(run.output(), /^quiet:/m);
    assert.doesNotMatch(run.output(), new RegExp(`^${PROJECT}: .*wait`, "m"), "its own project is its own to write");
  } finally {
    await run.stop();
  }
});
