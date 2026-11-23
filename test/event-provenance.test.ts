// #191: the event dialog shows provenance in numbered parts. The parts the
// page works out are functions: the related events, and the texts of the parts.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { originOf, partIdentity, partKept, partTime } from "../src/dashboard/format.ts";
import { texts } from "../src/dashboard/texts.ts";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { relatedEvents } from "../src/read/line.ts";
import type { Read } from "../src/read/reader.ts";
import type { Item } from "../src/serve/server.ts";
import { event } from "./helpers.ts";

/** Ledger lines from 2 on, in the order given. */
function reads(events: Partial<LedgerEvent>[]): Read[] {
  return events.map((over, i) => {
    const e = event(over);
    return { from: "ledger", n: i + 2, hash: `h${i + 2}`, prev: `h${i + 1}`, event: e, raw: JSON.stringify({ event: e }) };
  });
}

const ns = (rs: { n: number }[]) => rs.map((r) => r.n);

test("#191: the related events are those of the same task or change, before and after, in the order of the lines", () => {
  const all = reads([
    { task: "7" }, // 2
    { task: "8" }, // 3
    { task: undefined, change: "30", repo: "team/a" }, // 4
    { task: "7", change: "30", repo: "team/a" }, // 5: the line
    { task: undefined, change: "30", repo: "team/b" }, // 6: another repository's change 30
    { task: "7" }, // 7
    { task: undefined, change: "30", repo: "team/a" }, // 8
  ]);
  const r = relatedEvents(all, 5);
  assert.deepEqual(ns(r.before), [2, 4]);
  assert.deepEqual(ns(r.after), [7, 8]);
  assert.equal(r.beforeMore, 0);
  assert.equal(r.afterMore, 0);
  assert.equal(r.before[0]!.type, all[0]!.event.type);
  assert.equal(r.before[0]!.time, all[0]!.event.time);
});

test("#191: a change without a repository matches only a change without one", () => {
  const all = reads([{ task: undefined, change: "30" }, { task: undefined, change: "30", repo: "team/a" }, { task: undefined, change: "30" }]);
  assert.deepEqual(ns(relatedEvents(all, 2).after), [4]);
});

test("#191: the related events are the nearest ten on each side, with how many more there are", () => {
  const all = reads(Array.from({ length: 31 }, () => ({ task: "7" }))); // lines 2 to 32
  const r = relatedEvents(all, 17);
  assert.deepEqual(ns(r.before), [7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(ns(r.after), [18, 19, 20, 21, 22, 23, 24, 25, 26, 27]);
  assert.equal(r.beforeMore, 5);
  assert.equal(r.afterMore, 5);
});

test("#191: an event that names no task and no change has no related events", () => {
  const all = reads([{ task: undefined }, { task: undefined }]);
  const r = relatedEvents(all, 2);
  assert.deepEqual(r, { before: [], after: [], beforeMore: 0, afterMore: 0 });
});

let count = 0;
function item(over: Partial<LedgerEvent> = {}, from: "ledger" | "activity" = "ledger"): Item {
  count++;
  const e = event({ id: `p-${count}`, ...over });
  return from === "ledger" ? { from, n: count + 1, hash: "h", prev: "p", event: e, raw: JSON.stringify({ event: e }) } : { from, event: e, raw: JSON.stringify(e) };
}

const KINDS = {
  hook: item({ type: "session.started", source: { adapter: "claude-code-hook", kind: "claimed" } }),
  http: item({ type: "tool.used", source: { adapter: "claude-code-http", kind: "claimed" }, data: { tool: "Edit", target: "src/a.ts", outcome: "ok" } }, "activity"),
  host: item({ type: "change.opened", source: { adapter: "github", kind: "observed" }, data: { title_words: 3 } }),
  claim: item({ type: "agent.waiting", source: { adapter: "emit", kind: "claimed" } }),
  howl: item({ type: "ledger.created", source: { adapter: "howl", kind: "observed" } }),
  unknown: item({ source: { adapter: "checker", kind: "derived" as never } }),
};

test("#191: the origin of an event: a hook, a code host, another claim, howl itself, or not known", () => {
  assert.equal(originOf(KINDS.hook.event), "hook");
  assert.equal(originOf(KINDS.http.event), "hook");
  assert.equal(originOf(KINDS.host.event), "host");
  assert.equal(originOf(KINDS.claim.event), "claim");
  assert.equal(originOf(KINDS.howl.event), "howl");
  assert.equal(originOf(KINDS.unknown.event), "unknown", "a kind the page does not know is never taken for observed");
});

test("#191: part 2 gives the time the event states and by whom, and says the received time is not recorded yet", () => {
  const seen = new Set<string>();
  for (const [name, it] of Object.entries(KINDS)) {
    const t = partTime(it, "UTC");
    assert.ok(t.stated.includes("2026-01-02 03:04:05 UTC"), `${name}: the stated time`);
    assert.equal(t.received, texts.provenance.time.notRecorded, `${name}: the received time`);
    assert.equal(t.received, "not recorded yet");
    seen.add(t.by);
  }
  assert.equal(partTime(KINDS.hook).by, texts.provenance.time.by.hook);
  assert.equal(partTime(KINDS.host).by, texts.provenance.time.by.host);
  assert.equal(partTime(KINDS.claim).by, texts.provenance.time.by.claim);
  assert.equal(partTime(KINDS.howl).by, texts.provenance.time.by.howl);
  assert.equal(partTime(KINDS.unknown).by, texts.provenance.time.by.unknown);
  assert.equal(partTime(KINDS.http).by, texts.provenance.time.by.http, "a hook received over HTTP: howl up's clock");
  assert.equal(seen.size, 6, "each origin says whose clock it is");
});

test("#191: part 5 says what was dropped or not kept for each kind, and shows the data as kept", () => {
  assert.match(partKept(KINDS.hook).note, /input and answer were dropped on the machine/);
  assert.match(partKept(KINDS.http).note, /input and answer were dropped on the machine/);
  assert.match(partKept(KINDS.host).note, /not kept/);
  assert.equal(partKept(KINDS.claim).note, texts.provenance.kept.claim);
  assert.equal(partKept(KINDS.howl).note, texts.provenance.kept.howl);
  assert.equal(partKept(KINDS.unknown).note, texts.provenance.kept.unknown);
  assert.deepEqual(JSON.parse(partKept(KINDS.http).data!), { tool: "Edit", target: "src/a.ts", outcome: "ok" });
  assert.deepEqual(JSON.parse(partKept(KINDS.host).data!), { title_words: 3 });
  assert.equal(partKept(KINDS.claim).data, null, "no data: none is shown");
});

test("#191: part 3 says not signed, valid for the key in the ledger, or why not; never that the issuer is known", () => {
  const claim = KINDS.claim;
  assert.equal(partIdentity(claim, null).signature, "not signed");
  const key = "a".repeat(64);
  const valid = partIdentity(claim, { key, ok: true });
  assert.match(valid.signature, /^valid for key aaaaaaaaaaaa/);
  assert.match(valid.signature, /in this ledger/);
  assert.doesNotMatch(valid.signature, /trusted|known issuer|pinned/i);
  assert.equal(valid.limit, texts.provenance.identity.limit, "a signed event carries the limit of what a signature shows");
  assert.match(valid.limit!, /stays a claim/);
  assert.match(valid.limit!, /sent with that key, unchanged since/);
  assert.match(valid.limit!, /does not show that the issuer/);
  const wrong = partIdentity(claim, { key, ok: false, reason: "the signature does not hold: the event was changed after it was signed" });
  assert.match(wrong.signature, /^not valid: the signature does not hold/);
  assert.equal(partIdentity(claim, null).limit, null, "an unsigned event has no limit to say");
  assert.equal(partIdentity(KINDS.http, undefined).signature, texts.provenance.identity.tool, "a tool call is not checked here");
  assert.match(partIdentity(KINDS.hook, null).actor, /agent|person|no actor/);
});

test("#191 (review): part 3 says a key's issue or revocation is valid for the issuer key the line names, never issued on an earlier line", () => {
  const key = "b".repeat(64);
  for (const type of ["key.issued", "key.revoked"] as const) {
    const it = item({ type, source: { adapter: "howl-key", kind: "claimed" }, data: { key: "c".repeat(64), issuer: key } });
    const id = partIdentity(it, { key, ok: true });
    assert.match(id.signature, /issuer key this line names \(bbbbbbbbbbbb\)/, type);
    assert.match(id.signature, /taken as the ledger's issuer from its first key line/, type);
    assert.doesNotMatch(id.signature, /earlier line/, type);
  }
});
