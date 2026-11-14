// The pure parts of the dashboard page: the tests of issue #12.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodedFields, filterPairs, localTime, tabTitle, utcTime, whenShort } from "../src/dashboard/format.ts";

test("#12: the filter text is split into field=value pairs; empty gives none", () => {
  assert.deepEqual(filterPairs("  actor=agent-1   type=review.* "), ["actor=agent-1", "type=review.*"]);
  assert.deepEqual(filterPairs(""), []);
});

test("#12: times are shown in the time zone given, and in UTC on the decoded event", () => {
  const t = "2026-11-13T09:40:18.890Z";
  assert.equal(localTime(t, "Europe/Stockholm"), "10:40:18");
  assert.equal(localTime(t, "UTC"), "09:40:18");
  assert.equal(utcTime(t), "2026-11-13 09:40:18 UTC");
});

test("#12: a ledger line is decoded with its number, hashes, actor and what it concerns", () => {
  const fields = decodedFields(
    {
      n: 7,
      from: "ledger",
      hash: "a".repeat(64),
      prev: "b".repeat(64),
      raw: "{}",
      event: {
        v: 0,
        id: "x",
        time: "2026-11-13T09:40:18Z",
        type: "agent.waiting",
        source: { adapter: "claude-code-hook", kind: "claimed" },
        project: "p",
        actor: { kind: "agent", id: "agent-1" },
        task: "12",
        branch: "task-12-x",
      },
    },
    "UTC",
  );
  const get = (k: string) => fields.find((f) => f.k === k)?.v;
  assert.equal(get("Line"), "7");
  assert.equal(get("Line hash"), "a".repeat(64));
  assert.equal(get("Previous hash"), "b".repeat(64));
  assert.equal(get("Actor"), "agent-1 (agent)");
  assert.equal(get("Task"), "12");
  assert.equal(get("Time"), "09:40:18 local · 2026-11-13 09:40:18 UTC");
  assert.equal(get("Change"), undefined, "a field the event does not have is left out");
});

test("#12: a tool call is decoded as activity, with no line or hash", () => {
  const fields = decodedFields(
    {
      from: "activity",
      raw: "{}",
      event: {
        v: 0,
        id: "y",
        time: "2026-11-13T09:40:18Z",
        type: "tool.used",
        source: { adapter: "claude-code-hook", kind: "claimed" },
        project: "p",
        actor: { kind: "agent", id: "agent-1" },
        data: { tool: "Bash", target: "make", outcome: "succeeded" },
      },
    },
    "UTC",
  );
  assert.equal(fields.find((f) => f.k === "Line"), undefined);
  assert.equal(fields.find((f) => f.k === "File")?.v, "activity.jsonl");
  assert.equal(fields.find((f) => f.k === "Tool")?.v, "Bash make succeeded");
});

test("#13: a time from another day shows its date; one from today only the time", () => {
  const now = Date.parse("2026-11-13T15:00:00Z");
  assert.equal(whenShort("2026-11-13T09:40:18Z", now, "UTC"), "09:40:18");
  assert.equal(whenShort("2026-11-12T21:14:00Z", now, "UTC"), "12 Nov 21:14");
  // Midnight is where the viewer is: 23:30 UTC on the 12th is the 13th in Stockholm.
  assert.equal(whenShort("2026-11-12T23:30:00Z", now, "Europe/Stockholm"), "00:30:00");
});

test("#16: the tab title starts with how many agents need input", () => {
  assert.equal(tabTitle(0), "Handover Ledger");
  assert.equal(tabTitle(1), "(1) Handover Ledger");
  assert.equal(tabTitle(2), "(2) Handover Ledger");
});

test("#15: the view and the project are kept in the address", async () => {
  const { hashFor, parseHash } = await import("../src/dashboard/format.ts");
  assert.deepEqual(parseHash("#stream?project=demo"), { view: "stream", project: "demo" });
  assert.deepEqual(parseHash(""), { view: "overview", project: null });
  assert.deepEqual(parseHash("#overview"), { view: "overview", project: null });
  assert.equal(hashFor("stream", "a b"), "#stream?project=a+b");
  assert.deepEqual(parseHash(hashFor("stream", "a b")), { view: "stream", project: "a b" });
});

test("#17: the decoded event shows the role and the role prompt", () => {
  const fields = decodedFields(
    {
      n: 3,
      from: "ledger",
      hash: "a".repeat(64),
      prev: "b".repeat(64),
      raw: "{}",
      event: {
        v: 0,
        id: "r",
        time: "2026-11-13T09:40:18Z",
        type: "session.started",
        source: { adapter: "claude-code-hook", kind: "claimed" },
        project: "p",
        actor: { kind: "agent", id: "agent-1" },
        role: "review",
        prompt: { file: "roles/review.md", sha256: "c".repeat(64) },
      },
    },
    "UTC",
  );
  assert.equal(fields.find((f) => f.k === "Role")?.v, "review");
  assert.equal(fields.find((f) => f.k === "Role prompt")?.v, `roles/review.md · ${"c".repeat(12)}`);
});

test("#22: the change view keeps what it shows in the address", async () => {
  const { hashFor, parseHash } = await import("../src/dashboard/format.ts");
  assert.equal(hashFor("change", "example", "change:30"), "#change?project=example&what=change%3A30");
  assert.deepEqual(parseHash("#change?project=example&what=change%3A30"), { view: "change", project: "example", what: "change:30" });
  assert.deepEqual(parseHash("#change"), { view: "change", project: null });
});

test("#23: the decoded event says whether it is signed, by which key and for what", () => {
  const base = {
    n: 4,
    from: "ledger" as const,
    hash: "a".repeat(64),
    prev: "b".repeat(64),
    raw: "{}",
    event: {
      v: 0 as const,
      id: "s",
      time: "2026-11-13T09:40:18Z",
      type: "session.started" as const,
      source: { adapter: "claude-code-hook", kind: "claimed" as const },
      project: "p",
      actor: { kind: "agent" as const, id: "agent-1" },
    },
  };
  const sig = (s: object) => decodedFields({ ...base, signed: s } as never, "UTC").find((f) => f.k === "Signature")?.v;
  assert.equal(sig({ key: "c".repeat(64), actor: "agent-1", change: "30", until: "2026-11-13T17:00:00Z", ok: true }), `valid · key ${"c".repeat(12)} · agent-1 · change 30 · until 2026-11-13 17:00:00 UTC`);
  assert.equal(sig({ key: "c".repeat(64), actor: "agent-1", until: "2026-11-13T17:00:00Z", ok: false, reason: "signed after the key was revoked" }), "does not hold: signed after the key was revoked");
  assert.equal(decodedFields(base as never, "UTC").find((f) => f.k === "Signature")?.v, "unsigned");
});
