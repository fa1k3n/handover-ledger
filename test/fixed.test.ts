// The fixed form of an event: the JSON Canonicalization Scheme, RFC 8785.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { eventHash, fixedForm } from "../src/ledger/fixed.ts";
import { LedgerError } from "../src/ledger/ledger.ts";
import { event, sha256 } from "./helpers.ts";

const text = (value: unknown) => fixedForm(value).toString("utf8");

test("the fixed form is the same whatever order the keys were given in, also in nested objects", () => {
  const a = event({ data: { b: 1, a: { y: [1, { q: 1, p: 2 }], x: true } } });
  const b = {
    data: { a: { x: true, y: [1, { p: 2, q: 1 }] }, b: 1 },
    ...Object.fromEntries(Object.entries(a).reverse().filter(([k]) => k !== "data")),
  };
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(fixedForm(a), fixedForm(b));
  assert.equal(eventHash(a), eventHash(b as unknown as typeof a));
});

test("keys are sorted at every depth, with no white space", () => {
  assert.equal(text({ b: [{ d: 1, c: 2 }], a: { f: null, e: "x" } }), '{"a":{"e":"x","f":null},"b":[{"c":2,"d":1}]}');
});

test("keys that look like numbers are sorted as text", () => {
  // A JavaScript object puts such keys first and in numeric order; JCS does not.
  assert.equal(text({ "2": 0, "10": 0, a: 0, "1": 0 }), '{"1":0,"10":0,"2":0,"a":0}');
});

// The examples of RFC 8785 are kept in files of their own, byte for byte as
// the RFC gives them, with their escapes.
const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

test("keys are sorted by UTF-16 code units: the sorting example of RFC 8785, 3.2.3", () => {
  const written = text(JSON.parse(fixture("rfc8785-sorting.json")));
  // The values in the order the keys were written. An emoji (D83D DE00) comes
  // before FB33, which it would not if keys were sorted by code point.
  const order = [...written.matchAll(/:"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, [
    "Carriage Return",
    "One",
    "Control",
    "Latin Small Letter O With Diaeresis",
    "Euro Sign",
    "Emoji: Grinning Face",
    "Hebrew Letter Dalet With Dagesh",
  ]);
});

test("numbers, strings and literals: the example of RFC 8785, 3.2.3", () => {
  assert.equal(text(JSON.parse(fixture("rfc8785-values.json"))), fixture("rfc8785-values.fixed"));
});

test("minus zero is written as 0", () => {
  assert.equal(text({ n: -0 }), '{"n":0}');
});

test("the fixed form is UTF-8", () => {
  assert.deepEqual([...fixedForm("ö")], [0x22, 0xc3, 0xb6, 0x22]);
});

test("a value that has no fixed form is refused", () => {
  assert.throws(() => fixedForm({ s: "\ud800" }), LedgerError, "a lone surrogate");
  assert.throws(() => fixedForm({ ["\udc00"]: 1 }), LedgerError, "a lone surrogate in a key");
  assert.throws(() => fixedForm({ n: Number.NaN }), LedgerError);
  assert.throws(() => fixedForm({ n: Number.POSITIVE_INFINITY }), LedgerError);
  assert.throws(() => fixedForm({ n: 1n }), LedgerError);
  assert.throws(() => fixedForm([undefined]), LedgerError);
});

test("a member without a value is left out, as JSON leaves it out", () => {
  assert.equal(text({ a: 1, b: undefined }), '{"a":1}');
});

test("the hash of an event is the SHA-256 of its fixed form", () => {
  const e = event();
  assert.equal(eventHash(e), sha256(text(e)));
});
