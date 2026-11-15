// #110: a click on a row of the event log opens the event in a dialog,
// decoded and as stored side by side. The page's parts are functions.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodedFields, dialogHeading, itemKey, lineToCopy, narrowOf, neighbours } from "../src/dashboard/format.ts";
import type { Item } from "../src/serve/server.ts";
import { event } from "./helpers.ts";

let n = 0;
/** A row of the event log: a line of a ledger, or a line of the activity file with `tool`. */
function item(over: Partial<Item> & { type?: string; repo?: string; tool?: boolean } = {}): Item {
  n++;
  const e = event({ id: `e-${n}`, type: (over.type ?? "change.opened") as never, ...(over.repo !== undefined ? { repo: over.repo } : {}) });
  const raw = JSON.stringify(over.tool ? e : { prev: "p", hash: `h-${n}`, event: e });
  const base = over.tool ? { from: "activity" as const, event: e, raw } : { from: "ledger" as const, n, hash: `h-${n}`, prev: "p", event: e, raw };
  const { type: _type, repo: _repo, tool: _tool, ...rest } = over;
  return { ...base, ...rest } as Item;
}

test("#110: Project and Repository can narrow the list, and no other field", () => {
  const it = item({ project: "body", repo: "team/body" });
  const narrows = decodedFields(it).map((f) => [f.k, narrowOf(f, it)]);
  assert.deepEqual(
    narrows.filter(([, by]) => by !== null),
    [
      ["Project", { field: "project", value: "body" }],
      ["Repository", { field: "repo", value: "team/body" }],
    ],
  );
  assert.ok(narrows.length > 5, "the other fields are there and give none");
  const bare = item();
  assert.deepEqual(
    decodedFields(bare).filter((f) => narrowOf(f, bare) !== null),
    [],
    "an event with no project and no repository narrows by nothing",
  );
});

test("#110: the neighbours of an event are the newer and the older one of the list, and none at its ends", () => {
  const list = [item({ project: "a" }), item({ project: "a" }), item({ project: "b" })]; // newest first, as the page holds it
  const [first, middle, last] = list.map(itemKey) as [string, string, string];
  assert.deepEqual(neighbours(list, middle), { newer: first, older: last });
  assert.deepEqual(neighbours(list, first), { newer: null, older: middle });
  assert.deepEqual(neighbours(list, last), { newer: middle, older: null });
  assert.deepEqual(neighbours(list, "gone"), { newer: null, older: null }, "an event that left the list has none");
  assert.deepEqual(neighbours([], middle), { newer: null, older: null });
});

test("#110: the line that is copied is the stored line, byte for byte, not its indented form", () => {
  const it = item();
  assert.equal(lineToCopy(it), it.raw);
  assert.notEqual(lineToCopy(it), JSON.stringify(JSON.parse(it.raw), null, 2));
  assert.ok(!lineToCopy(it).includes("\n"), "one line, as in the file");
  const odd = { ...it, raw: '{"event":{"data":{"text":"a\\u00e5  b"}},"hash":"x"}' };
  assert.equal(lineToCopy(odd), odd.raw, "an escape and two spaces are kept as they are");
});

test("#110: the dialog's heading names the line and its project, or says it is a tool call", () => {
  assert.equal(dialogHeading({ ...item({ project: "example" }), n: 1796 }), "Line 1796 · example");
  assert.equal(dialogHeading({ ...item(), n: 12 }), "Line 12");
  assert.equal(dialogHeading(item({ tool: true, type: "tool.used", project: "example" })), "Tool call · example");
  assert.equal(dialogHeading(item({ tool: true, type: "tool.used" })), "Tool call");
});
