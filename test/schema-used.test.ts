// #49: the schema holds only what something writes.
// @code_class tests
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { leave } from "../src/inbox/inbox.ts";
import { LedgerError } from "../src/ledger/errors.ts";
import { openLedger, type LedgerEvent } from "../src/ledger/ledger.ts";
import { eventFaults } from "../src/ledger/schema.ts";
import { event, folder, howl, inboxFiles, lines, PROJECT, workspace } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const schema = JSON.parse(readFileSync(join(ROOT, "schema", "event.v0.schema.json"), "utf8")) as {
  properties: Record<string, unknown> & { type: { enum: string[] } };
};

/** The types and the fields that left the schema with #49: no step wrote them. */
const REMOVED_TYPES = ["tests.written", "finding.fixed", "finding.dismissed", "finding.left_open", "level.changed", "rule.broken", "escalation.raised"];
const REMOVED_FIELDS: Record<string, unknown> = {
  requirements: ["REQ-1"],
  clauses: ["REQ-1.a"],
  tests: ["test-1"],
  level: 1,
  class: "evidence",
  rules: "0123abc",
  team: "team-a",
};

test("the removed types and fields are not in the schema", () => {
  for (const type of REMOVED_TYPES) assert.ok(!schema.properties.type.enum.includes(type), type);
  for (const field of Object.keys(REMOVED_FIELDS)) assert.ok(!(field in schema.properties), field);
});

test("an event of each removed type is refused by the writer, and nothing is written", () => {
  const path = join(folder(), "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  try {
    for (const type of REMOVED_TYPES) {
      assert.throws(() => writer.append(event({ type: type as LedgerEvent["type"] })), LedgerError, type);
    }
  } finally {
    writer.close();
  }
  assert.equal(lines(path).length, 1);
});

test("an event of each removed type is refused by howl emit, with 1 and the reason", () => {
  const ws = workspace();
  for (const type of REMOVED_TYPES) {
    const run = howl(["emit", type], { cwd: ws.root, env: ws.env });
    assert.equal(run.status, 1, type);
    assert.match(run.stderr, /not a valid event/);
  }
  assert.deepEqual(inboxFiles(ws.inbox), []);
});

test("an event of each removed type left in the inbox is moved to rejected/ with the reason by howl ingest", () => {
  const ws = workspace();
  for (const type of REMOVED_TYPES) leave(ws.inbox, event({ type: type as LedgerEvent["type"], source: { adapter: "test", kind: "claimed" } }));
  const run = howl(["ingest"], { cwd: ws.root, env: ws.env });
  assert.equal(run.status, 0, run.stderr);
  const rejected = join(ws.inbox, "rejected");
  const names = readdirSync(rejected);
  assert.equal(names.filter((n) => n.endsWith(".json")).length, REMOVED_TYPES.length);
  for (const reason of names.filter((n) => n.endsWith(".reason"))) {
    assert.match(readFileSync(join(rejected, reason), "utf8"), /not a valid event/);
  }
  assert.deepEqual(inboxFiles(ws.inbox), []);
  assert.equal(lines(ws.ledger).length, 1, "only the first line");
});

test("an event with a removed field is refused", () => {
  const path = join(folder(), "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  try {
    for (const [field, value] of Object.entries(REMOVED_FIELDS)) {
      const made = { ...event(), [field]: value };
      assert.ok(eventFaults(made).length > 0, field);
      assert.throws(() => writer.append(made as LedgerEvent), LedgerError, field);
    }
    // The same event without the field is taken.
    writer.append(event());
  } finally {
    writer.close();
  }
  assert.equal(lines(path).length, 2);
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".gen.ts") ? [path] : [];
  });
}

test("every type of the schema is written somewhere under src: a type ahead of its step fails here", () => {
  const src = join(ROOT, "src");
  // What only reads names types too: it does not count as writing them.
  const readers = ["read/", "dashboard/", "serve/", "export/"];
  const texts = sources(src)
    .filter((path) => !readers.some((r) => relative(src, path).split("\\").join("/").startsWith(r)))
    .map((path) => readFileSync(path, "utf8"));
  assert.ok(texts.length > 10 && existsSync(join(src, "observe", "observe.ts")));
  const unwritten = schema.properties.type.enum.filter((type) => {
    return !texts.some((text) => text.includes(`"${type}"`)) && !isBuilt(type, texts);
  });
  assert.deepEqual(unwritten, []);
});

/**
 * Whether a type is built from its two parts: the first as `review.${state}` or `checks.${state}`,
 * and the second named as a state of its own (`"approved"`, `"failed"`) by what writes.
 */
function isBuilt(type: string, texts: string[]): boolean {
  const [first, second] = [type.slice(0, type.indexOf(".") + 1), type.slice(type.indexOf(".") + 1)];
  return texts.some((text) => text.includes(`\`${first}\${`)) && texts.some((text) => text.includes(`"${second}"`));
}

test("the test of the types catches a type nothing writes, also one whose first part is built", () => {
  const texts = ['this.event(`review.${r.state}`)', 'state: "approved" | "commented"', 'type: "task.opened"'];
  assert.ok(isBuilt("review.approved", texts));
  assert.ok(!isBuilt("review.withdrawn", texts), "the first part is built, the second is no state");
  assert.ok(!isBuilt("made.up", texts));
  assert.ok(!isBuilt("task.opened", texts), "named whole, not built");
});
