// #89: the event log has its checkbox "Show tool calls" again, and the filter
// line starts empty.
// @code_class tests
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { eventsQuery, filterTexts, STREAM_START } from "../src/dashboard/format.ts";
import { texts } from "../src/dashboard/texts.ts";
import { openLedger } from "../src/ledger/ledger.ts";
import { ACTIVITY_FILE } from "../src/ledger/names.ts";
import { startServer, type Item } from "../src/serve/server.ts";
import { event, folder } from "./helpers.ts";

const at = (minute: number) => `2026-01-02T08:${String(minute).padStart(2, "0")}:00Z`;

/** A howl home with one project: lines at 08:00 and 08:20, and a tool call at 08:10 in its activity file. */
function home(): string {
  const dir = folder();
  mkdirSync(join(dir, "a"));
  const w = openLedger(join(dir, "a", "ledger.jsonl"), { project: "a" });
  for (const minute of [0, 20]) w.append(event({ project: "a", time: at(minute), type: "change.opened", change: String(minute) }));
  w.close();
  const tool = event({ project: "a", time: at(10), type: "tool.used", source: { adapter: "test", kind: "claimed" }, data: { tool: "Read" } });
  appendFileSync(join(dir, "a", ACTIVITY_FILE), `${JSON.stringify(tool)}\n`);
  return dir;
}

/** The types the server answers with, to what the page asks for a filter text and the box. */
async function asked(url: string, filter: string, tools: boolean): Promise<string[]> {
  const body = (await (await fetch(`${url}/api/events?${eventsQuery(filterTexts(filter), tools)}`)).json()) as { events: Item[] };
  return body.events.map((i) => i.event.type);
}

test("#89: the event log starts with an empty filter line and the box not ticked", () => {
  assert.deepEqual(STREAM_START, { filter: "", tools: false });
  assert.deepEqual(filterTexts(STREAM_START.filter), [], "an empty line is no filter");
});

test("#89: the page asks for the tool calls only with the box ticked, and the server answers so", async () => {
  assert.equal(new URLSearchParams(eventsQuery([], false)).has("activity"), false);
  assert.equal(new URLSearchParams(eventsQuery([], true)).get("activity"), "1");
  assert.equal(new URLSearchParams(eventsQuery([], false)).get("limit"), "200");
  assert.deepEqual(new URLSearchParams(eventsQuery(["actor=agent-1", "type=review.*"], false, 50)).getAll("filter"), ["actor=agent-1", "type=review.*"]);
  assert.equal(new URLSearchParams(eventsQuery([], true, 50)).get("limit"), "50");

  const server = await startServer({ home: home(), port: 0, root: folder() });
  try {
    assert.deepEqual(await asked(server.url, STREAM_START.filter, STREAM_START.tools), ["change.opened", "change.opened"], "as the page opens: no tool call");
    assert.deepEqual(await asked(server.url, "", true), ["change.opened", "tool.used", "change.opened"], "ticked: the tool call among the lines, in the order of time");
    assert.deepEqual(await asked(server.url, 'event.project == "a"', false), ["change.opened", "change.opened"], "a filter typed from nothing brings no tool call");
    assert.deepEqual(await asked(server.url, 'event.project == "a"', true), ["change.opened", "tool.used", "change.opened"]);
  } finally {
    await server.close();
  }
});

test("#89: with the box not ticked, a filter that names tool.used is answered with tool calls", async () => {
  const server = await startServer({ home: home(), port: 0, root: folder() });
  try {
    assert.deepEqual(await asked(server.url, 'event.type == "tool.used"', false), ["tool.used"]);
    assert.deepEqual(await asked(server.url, "type=tool.used", false), ["tool.used"]);
  } finally {
    await server.close();
  }
});

test("#89: the box is named, the button is Clear, and the hint names no Reset and no default", () => {
  assert.equal(texts.stream.showTools, "Show tool calls");
  assert.equal(texts.stream.clear, "Clear");
  assert.equal("reset" in texts.stream, false);
  assert.doesNotMatch(texts.stream.filterHint, /Reset|starts with/);
});
