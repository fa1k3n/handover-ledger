// #138: JSON that howl did not write is refused when it is nested more than 128 deep: the same in both versions.
// @code_class tests
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_DEPTH, parseJson } from "../src/ledger/json.ts";
import { fixedForm } from "../src/ledger/fixed.ts";
import { openLedger } from "../src/ledger/ledger.ts";
import { event, howl, lines, PROJECT, workspace, folder } from "./helpers.ts";

/** `n` arrays inside each other. */
const arrays = (n: number) => "[".repeat(n) + "]".repeat(n);

/** A ledger whose last line, taken whole, is nested `depth` deep: the line, its event, its data, and then `data.a` inside. */
function ledgerNested(depth: number): string {
  const path = join(folder(), "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  // The line is 1, its event 2, its data 3: what is left goes into `a`.
  let value: unknown = {};
  for (let i = 0; i < depth - 3; i++) value = { a: value };
  writer.append(event({ type: "change.opened", data: depth > 3 ? (value as Record<string, unknown>) : {} }));
  writer.close();
  return path;
}

const depthOf = (text: string): number => {
  let depth = 0;
  let max = 0;
  for (const c of text) {
    if (c === "{" || c === "[") max = Math.max(max, ++depth);
    else if (c === "}" || c === "]") depth--;
  }
  return max;
};

test("#138: the depth limit is 128, and a text at the limit is read", () => {
  assert.equal(MAX_DEPTH, 128);
  assert.deepEqual(parseJson("[1, {\"a\": [\"[\"]}]"), [1, { a: ["["] }]);
  assert.doesNotThrow(() => parseJson(arrays(128)));
  assert.throws(() => parseJson(arrays(129)), { message: "not JSON: nested more than 128 deep" });
});

test("#138: brackets inside a string, and escaped quotes, do not count", () => {
  const text = JSON.stringify({ a: "[".repeat(500), b: '\\"[[[[', c: ["]".repeat(500)] });
  assert.deepEqual(parseJson(text), JSON.parse(text));
});

test("#138: a text that is not JSON is still said so, with no depth in it", () => {
  assert.throws(() => parseJson("{not json"), { message: "not JSON" });
});

test("#138: a ledger line nested 128 deep passes howl verify; one nested 129 deep fails it, naming the line", () => {
  const ok = ledgerNested(128);
  assert.equal(depthOf(readFileSync(ok, "utf8").split("\n")[1]!), 128);
  const passed = howl(["verify", "--ledger", ok]);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);

  const deep = ledgerNested(129);
  assert.equal(depthOf(readFileSync(deep, "utf8").split("\n")[1]!), 129);
  const failed = howl(["verify", "--ledger", deep]);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.deepEqual(failed.stdout.match(/^line \d+/gm), ["line 2"], failed.stdout);
  assert.match(failed.stdout, /not JSON: nested more than 128 deep/);
});

test("#138: an inbox file nested more than 128 deep is rejected with that reason, and one at 128 is taken", () => {
  const ws = workspace();
  mkdirSync(ws.inbox, { recursive: true });
  const nest = (depth: number, id: string) => {
    let data: unknown = {};
    for (let i = 0; i < depth - 2; i++) data = { a: data };
    return fixedForm(event({ id, type: "session.started", data: data as Record<string, unknown> }));
  };
  writeFileSync(join(ws.inbox, "0001.json"), nest(128, "at-limit"));
  writeFileSync(join(ws.inbox, "0002.json"), nest(129, "too-deep"));
  const result = howl(["ingest"], { cwd: ws.root, env: ws.env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(lines(ws.ledger).slice(1).map((l) => l.event.id), ["at-limit"]);
  assert.match(readFileSync(join(ws.inbox, "rejected", "0002.json.reason"), "utf8"), /not JSON: nested more than 128 deep/);
});
