// The event list says who established each event: the badge, the status mark and the saved filters (#189).
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { builtInFilters, establishedBy, readSavedFilters, statusMark, writeSavedFilters } from "../src/dashboard/format.ts";
import type { Item } from "../src/serve/server.ts";

const item = (type: string, data?: Record<string, unknown>): Item =>
  ({ n: 1, from: "ledger", hash: "a", prev: "b", raw: "{}", event: { v: 0, id: "x", time: "2026-11-23T09:00:00Z", type, source: { adapter: "howl", kind: "observed" }, ...(data ? { data } : {}) } }) as unknown as Item;

test("#189: an observed event is a solid SOURCE badge", () => {
  assert.deepEqual(establishedBy("observed"), { code: "SOURCE", mark: "▣", claimed: false });
});

test("#189: a claimed event is an outlined CLAIM badge, and its row is in italics", () => {
  assert.deepEqual(establishedBy("claimed"), { code: "CLAIM", mark: "▢", claimed: true });
});

test("#189: a kind the page does not know is unknown, never observed", () => {
  for (const kind of ["derived", "", "Observed", "x"]) {
    const b = establishedBy(kind);
    assert.equal(b.code, "UNKNOWN");
    assert.equal(b.claimed, false);
    assert.notEqual(b.mark, establishedBy("observed").mark);
  }
});

test("#189: the mark of a status: a wait for a person, failed checks, merged, and none", () => {
  assert.equal(statusMark(item("checks.failed")), "!");
  assert.equal(statusMark(item("change.merged")), "✓");
  assert.equal(statusMark(item("agent.waiting", { waits_for: "person" })), "◷");
  assert.equal(statusMark(item("agent.waiting")), "◷");
  assert.equal(statusMark(item("agent.waiting", { waits_for: "instructions" })), "");
  assert.equal(statusMark(item("review.requested")), "");
});

test("#189: the built-in filters are four, in order, with the expressions of the issue", () => {
  assert.deepEqual(builtInFilters().map((f) => f.expression), ["", 'event.type == "agent.waiting"', 'event.source.kind == "claimed"', 'event.type == "checks.failed"']);
  assert.equal(builtInFilters().length, 4);
});

test("#189: saved filters are read back from a stored value", () => {
  const raw = JSON.stringify([{ name: "Mine", expression: 'event.actor.id == "a"' }]);
  assert.deepEqual(readSavedFilters(raw), [{ name: "Mine", expression: 'event.actor.id == "a"' }]);
  assert.deepEqual(readSavedFilters(writeSavedFilters([{ name: "A", expression: "x" }])), [{ name: "A", expression: "x" }]);
});

test("#189: a broken stored value is ignored, and so is none", () => {
  assert.deepEqual(readSavedFilters(null), []);
  assert.deepEqual(readSavedFilters("not json"), []);
  assert.deepEqual(readSavedFilters('{"name":"x"}'), []);
  assert.deepEqual(readSavedFilters('[{"name":1,"expression":"x"},{"name":"ok","expression":"y"},null,"s"]'), [{ name: "ok", expression: "y" }]);
});
