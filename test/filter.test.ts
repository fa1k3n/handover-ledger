// #82: a filter is a CEL expression over `event`, or `field=value` pairs as before.
// @code_class tests
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_FILTER, filterTexts, filterWith } from "../src/dashboard/format.ts";
import { isPair } from "../src/read/filter-text.ts";
import { readFilters, wantsActivity } from "../src/read/filter.ts";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { startServer } from "../src/serve/server.ts";
import { event, folder, howl } from "./helpers.ts";
import { writeStory } from "./story.ts";

const review = event({ project: "brake-controller", type: "review.approved", change: "30", time: "2026-11-14T14:05:00Z", actor: { kind: "person", id: "person-0a0a0a0a" } });
const other = event({ project: "body", type: "review.changes_requested", change: "31", time: "2026-11-14T13:00:00Z", actor: { kind: "person", id: "person-0b0b0b0b" } });
const tool = event({
  project: "brake-controller",
  type: "tool.used",
  time: "2026-11-14T14:10:00Z",
  source: { adapter: "claude-code-hook", kind: "claimed" },
  actor: { kind: "agent", id: "agent-1" },
  data: { tool: "Bash", target: "make", n: 3 },
});
const toolOfTwo = { ...tool, id: "tool-2", actor: { kind: "agent", id: "agent-2" } } as LedgerEvent;
const failed = event({ project: "body", type: "checks.failed", change: "31", time: "2026-11-14T15:00:00Z", source: { adapter: "github", kind: "observed" } });
// No change, no actor, no data.
const started = { ...event({ project: "body", type: "observe.started", time: "2026-11-14T12:00:00Z" }), task: undefined } as LedgerEvent;
delete (started as { task?: string }).task;
const all = [review, other, tool, toolOfTwo, failed, started];

/** The types of the events a filter keeps, with what it could not work out. */
function kept(text: string | string[], events = all) {
  const filters = readFilters(typeof text === "string" ? [text] : text);
  return { types: events.filter((e) => filters.test(e)).map((e) => e.type), failed: filters.failed() };
}

test("#82: the examples of the README match the events they say", () => {
  assert.deepEqual(kept('event.project == "brake-controller" && event.type.startsWith("review.")').types, ["review.approved"]);
  assert.deepEqual(kept('event.type == "tool.used" && event.data.tool == "Bash" && event.actor.id != "agent-1"').types, ["tool.used"]);
  assert.equal(readFilters(['event.type == "tool.used" && event.data.tool == "Bash" && event.actor.id != "agent-1"']).test(tool), false);
  assert.deepEqual(kept('has(event.change) && (event.source.kind == "claimed" || event.type == "checks.failed")').types, ["checks.failed"]);
});

test("#82: and, or, not, parentheses, in with a list, and the tests on text", () => {
  // && binds before ||.
  assert.deepEqual(kept('event.type == "checks.failed" || event.type == "tool.used" && event.project == "none"').types, ["checks.failed"]);
  assert.deepEqual(kept('(event.type == "checks.failed" || event.type == "tool.used") && event.project == "none"').types, []);
  assert.deepEqual(kept('!(event.project == "body")').types, ["review.approved", "tool.used", "tool.used"]);
  assert.deepEqual(kept('event.project in ["body", "nothing"] && event.type != "observe.started"').types, ["review.changes_requested", "checks.failed"]);
  assert.deepEqual(kept('event.type.endsWith(".failed")').types, ["checks.failed"]);
  assert.deepEqual(kept('event.type.contains("view.")').types, ["review.approved", "review.changes_requested"]);
});

test("#82: a member of data, a number, and a time compared as text", () => {
  assert.deepEqual(kept('has(event.data) && event.data.target == "make"').types, ["tool.used", "tool.used"]);
  assert.deepEqual(kept("has(event.data) && event.data.n > 2").types, ["tool.used", "tool.used"]);
  assert.deepEqual(kept('event.time >= "2026-11-14T14:00"').types, ["review.approved", "tool.used", "tool.used", "checks.failed"]);
  assert.deepEqual(kept('event.time < "2026-11-14T13"').types, ["observe.started"]);
});

test("#82: has() tests for a field; without it a field the event does not have is an error: the row is left out, counted, and the reason given once", () => {
  assert.deepEqual(kept("has(event.change)").types, ["review.approved", "review.changes_requested", "checks.failed"]);
  assert.equal(kept("has(event.change)").failed, null);

  const result = kept('event.change == "30"');
  assert.deepEqual(result.types, ["review.approved"]);
  assert.equal(result.failed?.events, 3, "the two tool calls and the start have no change");
  assert.match(result.failed!.reason, /No such key: change/);
  assert.match(result.failed!.reason, /has\(event\.change\)/, "it says what to write");

  // An error is taken in by && and || as CEL has it.
  assert.equal(kept('has(event.change) && event.change == "30"').failed, null);
  assert.deepEqual(kept('event.change == "30" || event.type == "tool.used"').types, ["review.approved", "tool.used", "tool.used"]);
});

test("#82: a wrong expression is refused before any event is read, with its place", () => {
  const refused = (text: string) => {
    try {
      readFilters([text]);
    } catch (e) {
      return (e as Error).message;
    }
    return null;
  };
  assert.match(refused('event.type == "review')!, /^filter at 15: Unterminated string/);
  assert.match(refused("event.type ==")!, /^filter at 14: /);
  assert.match(refused('event.type == "a" &&& event.project == "b"')!, /^filter at 21: /);
  assert.match(refused('nope(event.type) == "a"')!, /^filter/);
  assert.match(refused("nonsense")!, /Unknown variable: nonsense/);
  assert.match(refused("1 + 2")!, /true or false/, "an expression that gives a number is no filter");
  assert.equal(refused('event.type == "review.approved"'), null);
});

test("#82: a bare name is refused, and the message names event", () => {
  for (const text of ['type == "review.approved"', 'project == "body"']) {
    assert.throws(() => readFilters([text]), /event\.type/, text);
  }
});

test("#82: an expression that gives no true or false for an event is counted, not shown", () => {
  const result = kept("event.type");
  assert.deepEqual(result.types, []);
  assert.equal(result.failed?.events, all.length);
  assert.match(result.failed!.reason, /true or false/);
});

test("#82: a text of one pair is read as a pair, as before; several texts must all hold, pairs and expressions alike", () => {
  assert.equal(isPair("type=review.*"), true);
  assert.equal(isPair("actor=agent-1"), true);
  assert.equal(isPair("branch=a branch with spaces"), true, "a pair's value may hold spaces, as before");
  assert.equal(isPair('event.type == "x"'), false);
  assert.equal(isPair('event.type=="x"'), false);
  assert.equal(isPair("nonsense"), false);
  assert.equal(isPair("true"), false);

  assert.deepEqual(kept("type=review.*").types, ["review.approved", "review.changes_requested"]);
  assert.deepEqual(kept("actor=agent-1").types, ["tool.used"]);
  assert.deepEqual(kept("kind=claimed").types, ["tool.used", "tool.used"]);
  assert.deepEqual(kept(["type=review.*", 'event.project == "body"']).types, ["review.changes_requested"]);
  assert.deepEqual(kept(['event.type.startsWith("review.")', 'event.change == "30"']).types, ["review.approved"]);
});

test("#82: a filter never sees a person's pseudonym: no expression tells two people apart", () => {
  assert.deepEqual(kept('has(event.actor) && event.actor.id == "person-0a0a0a0a"').types, []);
  assert.deepEqual(kept('has(event.actor) && event.actor.id == "a person"').types, ["review.approved", "review.changes_requested"]);
  assert.deepEqual(kept('has(event.actor) && event.actor.kind == "person"').types, ["review.approved", "review.changes_requested"]);
  // Leaving out one person by name leaves out nobody: both read the same.
  assert.deepEqual(kept('has(event.actor) && event.actor.kind == "person" && event.actor.id != "person-0a0a0a0a"').types, ["review.approved", "review.changes_requested"]);
  assert.deepEqual(kept('has(event.actor) && event.actor.id.endsWith("0a")').types, []);
  // An agent is named as before, and the event itself is not changed.
  assert.deepEqual(kept('has(event.actor) && event.actor.id == "agent-2"').types, ["tool.used"]);
  assert.equal(review.actor!.id, "person-0a0a0a0a");
});

test("#82: a filter that names tool calls reads the activity file, as type=tool.used does", () => {
  assert.equal(wantsActivity(["type=tool.used"]), true);
  assert.equal(wantsActivity(["type=tool.*"]), true);
  assert.equal(wantsActivity(["type=review.*"]), false);
  assert.equal(wantsActivity(['event.type == "tool.used"']), true);
  assert.equal(wantsActivity(['event.type != "tool.used"']), true, "it says tool.used: whether it keeps them is the expression's to say");
  assert.equal(wantsActivity(['event.type == "review.approved"']), false);
});

test("#82: howl watch and the server give the same lines for an expression, and say what they could not work out", async () => {
  const ledger = writeStory();
  const text = 'event.type.startsWith("review.") || (event.type == "tool.used" && event.data.tool == "Edit")';
  const watched = howl(["watch", "--ledger", ledger, "--no-follow", "--json", "--filter", text]);
  assert.equal(watched.status, 0, watched.stderr);
  const lines = watched.stdout.split("\n").filter(Boolean);
  assert.ok(lines.length > 2, "the story has reviews and edits");

  const server = await startServer({ ledger, port: 0, root: folder() });
  try {
    const body = (await (await fetch(`${server.url}/api/events?limit=5000&filter=${encodeURIComponent(text)}`)).json()) as { events: { raw: string }[]; failed?: unknown };
    assert.deepEqual(body.events.map((e) => e.raw).sort(), [...lines].sort());
    assert.equal(body.failed, undefined, "nothing failed: the answer says nothing of it");

    const missing = (await (await fetch(`${server.url}/api/events?limit=5000&filter=${encodeURIComponent('event.change == "30"')}`)).json()) as {
      events: unknown[];
      failed?: { events: number; reason: string };
    };
    assert.ok(missing.failed!.events > 0);
    assert.match(missing.failed!.reason, /No such key: change/);

    const wrong = await fetch(`${server.url}/api/events?filter=${encodeURIComponent('event.type == "x')}`);
    assert.equal(wrong.status, 400);
    assert.match(((await wrong.json()) as { error: string }).error, /^filter at 15/);
  } finally {
    await server.close();
  }

  const told = howl(["watch", "--ledger", ledger, "--no-follow", "--filter", 'event.change == "30"']);
  assert.equal(told.status, 0);
  assert.match(told.stderr, /No such key: change/);
  const refused = howl(["watch", "--ledger", ledger, "--no-follow", "--filter", 'event.type == "x']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /filter at 15/);
});

test("#82: the page sends pairs one by one as before, and an expression whole", () => {
  assert.deepEqual(filterTexts("  actor=agent-1   type=review.* "), ["actor=agent-1", "type=review.*"]);
  assert.deepEqual(filterTexts(""), []);
  assert.deepEqual(filterTexts(' event.type == "tool.used" && event.data.tool == "Bash" '), ['event.type == "tool.used" && event.data.tool == "Bash"']);
  assert.deepEqual(filterTexts('event.type=="x"'), ['event.type=="x"']);
});

test("#82: the event log starts with the tool calls filtered out, said in the filter line; a click on a value adds to an expression", () => {
  assert.equal(DEFAULT_FILTER, 'event.type != "tool.used"');
  assert.deepEqual(kept(DEFAULT_FILTER).types, ["review.approved", "review.changes_requested", "checks.failed", "observe.started"]);
  assert.equal(filterWith(DEFAULT_FILTER, "project", "body"), '(event.type != "tool.used") && event.project == "body"');
  assert.equal(filterWith('(event.type != "tool.used") && event.project == "body"', "project", "body"), '(event.type != "tool.used") && event.project == "body"', "not twice");
  assert.equal(filterWith('event.project == "a"', "repo", "x/y"), '(event.project == "a") && has(event.repo) && event.repo == "x/y"', "not every event has a repository");
  assert.deepEqual(kept(filterWith(DEFAULT_FILTER, "project", "body")).types, ["review.changes_requested", "checks.failed", "observe.started"]);
  // On pairs, and on nothing, it stays a pair, as before.
  assert.equal(filterWith("actor=agent-1", "project", "a"), "actor=agent-1 project=a");
  assert.equal(filterWith("", "project", "a"), "project=a");
});

test("#82: the library is howl's second runtime dependency, at an exact version, and the page does not load it", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
  assert.match(pkg.dependencies["@marcbachmann/cel-js"]!, /^\d+\.\d+\.\d+$/);
  const dir = new URL("../src/dashboard/", import.meta.url).pathname;
  for (const name of readdirSync(dir).filter((f) => /\.tsx?$/.test(f))) {
    const source = readFileSync(join(dir, name), "utf8");
    assert.ok(!/cel-js|read\/filter\.ts/.test(source), `${name} must not load the library: the filter runs at the server`);
  }
});
