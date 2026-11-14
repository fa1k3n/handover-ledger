// #81: the team right now is on the overview; the event log has its tab to itself.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { hashFor, menuShown, needsInputHref, parseHash } from "../src/dashboard/format.ts";

test("#81: the project menu shows on the overview and the change view as before, and never on the event log", () => {
  const several = { single: false };
  const oneLedger = { single: true };
  assert.equal(menuShown("overview", several), true);
  assert.equal(menuShown("change", several), true);
  assert.equal(menuShown("stream", several), false, "the event log is every project: the menu steers nothing there");
  assert.equal(menuShown("overview", oneLedger), false, "one ledger: no menu, as before");
  assert.equal(menuShown("stream", oneLedger), false);
  assert.equal(menuShown("overview", null), false, "not before the projects are known");
});

test("#81: needs input leads to the overview, where the team is", () => {
  assert.equal(needsInputHref("example"), hashFor("overview", "example"));
  assert.equal(parseHash(needsInputHref("example")).view, "overview");
  assert.equal(needsInputHref(null), "#overview");
});

test("#81: the addresses hold: #stream is the event log, #overview the overview, and anything else the overview", () => {
  assert.equal(parseHash("#stream").view, "stream");
  assert.equal(parseHash("#stream?project=a").project, "a");
  assert.equal(parseHash("#overview").view, "overview");
  assert.equal(parseHash("#team").view, "overview");
  assert.equal(parseHash("").view, "overview");
});
