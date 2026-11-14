// #79: the event log is one list of every project the server serves, with the
// project and the repository as fields like the others.
// @code_class tests
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decodedFields, filterWith, itemKey, streamColumns } from "../src/dashboard/format.ts";
import { openLedger } from "../src/ledger/ledger.ts";
import { ACTIVITY_FILE } from "../src/ledger/names.ts";
import { startServer, type Item } from "../src/serve/server.ts";
import { event, folder } from "./helpers.ts";

const at = (minute: number) => `2026-01-02T08:${String(minute).padStart(2, "0")}:00Z`;

/**
 * A howl home with two projects. `a` has lines at 08:00 and 08:20 in one
 * repository; `b` has lines at 08:10 and 08:20 in two. Each has one tool call
 * in its activity file.
 */
function home(): string {
  const dir = folder();
  const write = (project: string, lines: [number, string][], toolAt: number) => {
    mkdirSync(join(dir, project));
    const w = openLedger(join(dir, project, "ledger.jsonl"), { project });
    for (const [minute, repo] of lines) w.append(event({ project, repo, time: at(minute), type: "change.opened", change: String(minute) }));
    w.close();
    const tool = event({ project, time: at(toolAt), type: "tool.used", source: { adapter: "test", kind: "claimed" }, data: { tool: "Read" } });
    appendFileSync(join(dir, project, ACTIVITY_FILE), `${JSON.stringify(tool)}\n`);
  };
  write("a", [[0, "brake"], [20, "brake"]], 5);
  write("b", [[10, "body"], [20, "body-tools"]], 15);
  return dir;
}

async function serve(options: { home?: string; ledger?: string }, run: (url: string) => Promise<void>) {
  const server = await startServer({ ...options, port: 0, root: folder() });
  try {
    await run(server.url);
  } finally {
    await server.close();
  }
}

const events = async (url: string, query = "") => ((await (await fetch(`${url}/api/events${query}`)).json()) as { events: Item[] }).events;
/** Each item as `project:line`, or `project:tool` for a line of the activity file. */
const places = (items: Item[]) => items.map((i) => `${i.project}:${i.from === "ledger" ? i.n : "tool"}`);

test("#79: with no project named, the events of every served project come as one list in the order of time, each with its project and its line", async () => {
  await serve({ home: home() }, async (url) => {
    assert.deepEqual(places(await events(url)), ["a:2", "b:2", "a:3", "b:3"]);
    assert.deepEqual(places(await events(url, "?project=a")), ["a:2", "a:3"]);
    assert.deepEqual(places(await events(url, "?project=b")), ["b:2", "b:3"]);
  });
});

test("#79: project and repo narrow the list as any field does, also with a * at the end", async () => {
  await serve({ home: home() }, async (url) => {
    const filtered = (pair: string) => events(url, `?filter=${encodeURIComponent(pair)}`).then(places);
    assert.deepEqual(await filtered("project=a"), ["a:2", "a:3"]);
    assert.deepEqual(await filtered("repo=brake"), ["a:2", "a:3"]);
    assert.deepEqual(await filtered("repo=body"), ["b:2"]);
    assert.deepEqual(await filtered("repo=body*"), ["b:2", "b:3"]);
    assert.deepEqual(await filtered("repo=b*"), ["a:2", "b:2", "a:3", "b:3"]);
    assert.deepEqual(await filtered("project=nothing"), []);
  });
});

test("#79: two events of the same time come by the project's name, then by the line, the same every time", async () => {
  await serve({ home: home() }, async (url) => {
    for (let i = 0; i < 3; i++) assert.deepEqual(places(await events(url)).slice(2), ["a:3", "b:3"]);
  });
});

test("#79: a line appended to the second ledger is in the next answer, once", async () => {
  const dir = home();
  await serve({ home: dir }, async (url) => {
    assert.equal((await events(url)).length, 4);
    const w = openLedger(join(dir, "b", "ledger.jsonl"), { project: "b" });
    const added = event({ project: "b", time: at(30) });
    w.append(added);
    w.close();
    const after = await events(url);
    assert.deepEqual(places(after), ["a:2", "b:2", "a:3", "b:3", "b:4"]);
    assert.equal(after.filter((i) => i.event.id === added.id).length, 1);
  });
});

test("#79: the newest lines are counted over the whole list, not per project", async () => {
  await serve({ home: home() }, async (url) => {
    assert.deepEqual(places(await events(url, "?limit=3")), ["b:2", "a:3", "b:3"]);
  });
});

test("#79: after is a line of one ledger: it is taken with a project named, and refused over several", async () => {
  await serve({ home: home() }, async (url) => {
    assert.deepEqual(places(await events(url, "?project=a&after=2")), ["a:3"]);
    const refused = await fetch(`${url}/api/events?after=2`);
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /name the project/);
  });
});

test("#79: a server of one ledger file gives that ledger's events as before, with no project on a row, and another project is refused though it has a ledger", async () => {
  const dir = home();
  await serve({ ledger: join(dir, "b", "ledger.jsonl") }, async (url) => {
    const lines = (items: Item[]) => items.map((i) => i.n);
    assert.deepEqual(lines(await events(url)), [2, 3]);
    assert.deepEqual(lines(await events(url, "?after=2")), [3]);
    assert.ok((await events(url, "?activity=1")).every((i) => !("project" in i)), "its answers are as they were");
    assert.equal((await fetch(`${url}/api/events?project=a`)).status, 400);
  });
});

test("#79: with the tool calls asked for, those of every project are in the list, in the order of time", async () => {
  await serve({ home: home() }, async (url) => {
    assert.deepEqual(places(await events(url, "?activity=1")), ["a:2", "a:tool", "b:2", "b:tool", "a:3", "b:3"]);
    assert.deepEqual(places(await events(url, "?filter=type%3Dtool.used")), ["a:tool", "b:tool"]);
    assert.deepEqual(places(await events(url, "?activity=1&project=b")), ["b:2", "b:tool", "b:3"]);
  });
});

const item = (project: string | undefined, repo: string | undefined, id = "e1"): Item =>
  ({ from: "ledger", n: 2, hash: "h", prev: "p", raw: "{}", project, event: { ...event({ repo }), id } }) as Item;

test("#79: the column Project shows with more than one project served; Repository when the rows hold more than one", () => {
  const oneRepo = [item("a", "brake"), item("a", "brake")];
  const twoRepos = [item("a", "brake"), item("b", "body")];
  assert.deepEqual(streamColumns(oneRepo, 1), { project: false, repo: false });
  assert.deepEqual(streamColumns(oneRepo, 2), { project: true, repo: false });
  assert.deepEqual(streamColumns(twoRepos, 1), { project: false, repo: true });
  assert.deepEqual(streamColumns([item("a", "brake"), item("a", undefined)], 1), { project: false, repo: false }, "an event with no repository is not a second one");
  assert.deepEqual(streamColumns([], 3), { project: true, repo: false });
});

test("#79: the decoded event names the project and the line; an item with no project is decoded as before", () => {
  const fields = decodedFields(item("a", "brake"), "UTC");
  assert.deepEqual(fields.slice(0, 2), [{ k: "Project", v: "a" }, { k: "Line", v: "2" }]);
  assert.deepEqual(fields.find((f) => f.k === "Repository"), { k: "Repository", v: "brake" });
  assert.equal(decodedFields(item(undefined, undefined), "UTC")[0]!.k, "Line");
  assert.equal(decodedFields(item(undefined, undefined), "UTC").some((f) => f.k === "Repository"), false);
});

test("#79: a row is told by its project and its event; a click on a project or a repository gives a filter text", () => {
  assert.notEqual(itemKey(item("a", "brake", "same")), itemKey(item("b", "brake", "same")));
  assert.equal(itemKey(item("a", "brake", "same")), itemKey(item("a", "body", "same")));
  assert.equal(filterWith("", "project", "a"), "project=a");
  assert.equal(filterWith("actor=agent-1", "project", "a"), "actor=agent-1 project=a");
  assert.equal(filterWith("actor=agent-1 project=a", "project", "a"), "actor=agent-1 project=a", "not twice");
  assert.equal(filterWith("project=a type=review.*", "project", "b"), "type=review.* project=b", "one project at a time: two could never both match");
  assert.equal(filterWith("project=a", "repo", "brake"), "project=a repo=brake");
});
