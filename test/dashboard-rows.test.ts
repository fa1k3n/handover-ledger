// The event list: rows of one height, the detail opened in place, and the signature mark (#210).
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { builtInFilters, cutDetail, DETAIL_CUT, filtersFor, nameTaken, signatureMark } from "../src/dashboard/format.ts";
import { texts } from "../src/dashboard/texts.ts";
import type { Item } from "../src/serve/server.ts";

const signedItem = (signed?: { ok: boolean; reason?: string }, withSig = true): Item =>
  ({
    n: 1,
    from: "ledger",
    hash: "a",
    prev: "b",
    raw: "{}",
    event: { v: 0, id: "x", time: "2026-11-23T09:00:00Z", type: "review.approved", source: { adapter: "howl", kind: "claimed" }, ...(withSig ? { sig: { key: "k", alg: "ed25519", value: "v" } } : {}) },
    ...(signed ? { signed: { key: "k", actor: "a", until: "2027-01-01T00:00:00Z", ...signed } } : {}),
  }) as unknown as Item;

test("#210: a detail that fits is shown whole and is not said to be cut", () => {
  assert.deepEqual(cutDetail("short"), { text: "short", cut: false });
  assert.deepEqual(cutDetail(""), { text: "", cut: false });
  const exact = "x".repeat(DETAIL_CUT);
  assert.deepEqual(cutDetail(exact), { text: exact, cut: false });
});

test("#210: a detail that is too long is cut with an ellipsis and is said to be cut", () => {
  const long = "y".repeat(DETAIL_CUT + 1);
  const r = cutDetail(long);
  assert.equal(r.cut, true);
  assert.ok(r.text.endsWith("…"));
  assert.ok(r.text.length <= DETAIL_CUT + 1);
  assert.ok(long.startsWith(r.text.slice(0, -1)));
});

test("#210: a cut never splits a character written with two code units", () => {
  const r = cutDetail("😀".repeat(DETAIL_CUT + 5));
  assert.equal(r.cut, true);
  assert.doesNotMatch(r.text, /[\ud800-\udbff](?![\udc00-\udfff])/);
});

test("#210: the mark of a signature that holds under a pin is solid and says pinned issuer", () => {
  const m = signatureMark(signedItem({ ok: true }), true);
  assert.equal(m.kind, "pinned");
  assert.equal(m.glyph, "●");
  assert.equal(m.text, texts.stream.signature.pinned);
  assert.equal(m.text, "signed, pinned issuer");
});

test("#210: the mark of a signature that holds with no pin is hollow and says issuer not pinned", () => {
  const m = signatureMark(signedItem({ ok: true }), false);
  assert.equal(m.kind, "open");
  assert.equal(m.glyph, "○");
  assert.equal(m.text, "signed, issuer not pinned");
});

test("#210: the mark of a signature that does not hold is the fault mark, pin or none", () => {
  for (const pinned of [true, false]) {
    const m = signatureMark(signedItem({ ok: false, reason: "bad" }), pinned);
    assert.equal(m.kind, "fault");
    assert.equal(m.glyph, "!");
    assert.equal(m.text, "signature does not hold");
  }
});

test("#210: an unsigned event has no mark", () => {
  for (const pinned of [true, false, null]) assert.deepEqual(signatureMark(signedItem(undefined, false), pinned), { kind: "none", glyph: "", text: "" });
});

test("#210: a claim that carries a signature and has no verdict is a fault, never shown as unsigned", () => {
  for (const pinned of [true, false, null]) {
    const m = signatureMark(signedItem(undefined, true), pinned);
    assert.equal(m.kind, "fault");
    assert.equal(m.glyph, "!");
    assert.equal(m.text, "signature does not hold: its key has no valid issue");
  }
});

test("#210: a key's issue or revocation with no verdict has no mark", () => {
  for (const type of ["key.issued", "key.revoked"]) {
    const it = signedItem(undefined, true);
    (it.event as { type: string }).type = type;
    assert.equal(signatureMark(it, true).kind, "none");
  }
});

test("#210: before the ledger's state is read a holding signature says the issuer is not read yet", () => {
  const m = signatureMark(signedItem({ ok: true }), null);
  assert.equal(m.kind, "unread");
  assert.equal(m.glyph, "○");
  assert.equal(m.text, "signed, issuer not read yet");
});

test("#210: the filter Signed, not pinned is there only where the server serves no pin", () => {
  assert.equal(builtInFilters().length, 4);
  assert.equal(filtersFor(false).length, 5);
  assert.equal(filtersFor(false)[4]?.name, "Signed, not pinned");
  assert.equal(filtersFor(false)[4]?.expression, "has(event.sig)");
  assert.equal(filtersFor(true).length, 4);
  assert.equal(filtersFor(null).length, 4);
  assert.equal(nameTaken("Signed, not pinned", []), true);
});

test("#210: the words for the list are in texts", () => {
  assert.equal(texts.stream.showDetail("30"), "Show the whole detail of line 30");
  assert.equal(texts.stream.hideDetail("30"), "Hide the whole detail of line 30");
  assert.equal(texts.stream.cols.signature, "Signature");
});
