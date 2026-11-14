// #51: a claim never counts as what the code host showed, in the handovers, the figures, the rounds or the end.
// @code_class tests
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { claimText } from "../src/dashboard/format.ts";
import { texts } from "../src/dashboard/texts.ts";
import { openLedger } from "../src/ledger/ledger.ts";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { observed } from "../src/read/observed.ts";
import { handovers, keyFigures } from "../src/read/overview.ts";
import { show } from "../src/read/show.ts";
import { startServer } from "../src/serve/server.ts";
import { folder, howl, PROJECT, workspace } from "./helpers.ts";

const T0 = Date.UTC(2026, 0, 1, 8, 0, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const NOW = T0 + 3600_000;
const SHA = { a: "a".repeat(40), b: "b".repeat(40) };

let n = 0;
function event(kind: "observed" | "claimed", type: LedgerEvent["type"], minute: number, actor: string, extra: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    v: 0,
    id: `e-${++n}`,
    time: at(minute),
    type,
    source: kind === "observed" ? { adapter: "github", kind } : { adapter: "emit", kind },
    project: PROJECT,
    actor: { kind: "agent", id: actor },
    change: "30",
    ...extra,
  };
}

const opening = () => event("observed", "change.opened", 0, "agent-a", { task: "12", branch: "task-12-x", sha: SHA.a });
/** An observed opening, then an approval and a merge of the kind given. */
const story = (kind: "observed" | "claimed") => [
  opening(),
  event(kind, "review.approved", 5, "agent-b", { task: "12" }),
  event(kind, "change.merged", 6, "agent-b", { task: "12" }),
];
const items = (events: LedgerEvent[]) => events.map((e, i) => ({ event: e, hash: `h${i}` }));

function ledgerOf(events: LedgerEvent[]): string {
  const path = join(folder(), "ledger.jsonl");
  const writer = openLedger(path, { project: PROJECT });
  for (const e of events) writer.append(e);
  writer.close();
  return path;
}

test("observed() is true for what an adapter read, and false for what a session or a script sent", () => {
  assert.equal(observed(event("observed", "change.merged", 0, "agent-a")), true);
  assert.equal(observed(event("claimed", "change.merged", 0, "agent-a")), false);
});

test("a claimed approval and merge give no handover, and the change is open in the figures", () => {
  const events = story("claimed");
  assert.deepEqual(handovers(items(events)), []);
  const figures = keyFigures(events, NOW);
  assert.equal(figures.open, 1);
  assert.equal(figures.merged, 0);
  assert.equal(figures.reviewRoundsMean, null);
  assert.equal(figures.leadTimeMedianMs, null);
});

test("a claimed approval and merge give no round and no end in howl show, and are listed as claimed", () => {
  const events = story("claimed");
  const shown = show(events, { kind: "change", id: "30" }, null)!;
  assert.deepEqual(shown.reviews, []);
  assert.deepEqual(shown.end, { state: "open" });
  assert.equal(shown.summary.reviewRounds, 0);
  assert.equal(shown.summary.open, true);
  assert.deepEqual(shown.claimed, [
    { time: at(5), type: "review.approved", change: "30", actor: { kind: "agent", id: "agent-b" } },
    { time: at(6), type: "change.merged", change: "30", actor: { kind: "agent", id: "agent-b" } },
  ]);
  // Single events are still shown, with their mark.
  assert.deepEqual(
    shown.events.map((e) => [e.type, e.source.kind]),
    [
      ["change.opened", "observed"],
      ["review.approved", "claimed"],
      ["change.merged", "claimed"],
    ],
  );
});

test("howl show prints the claims under a heading of their own, and the change as open", () => {
  const run = howl(["show", "change:30", "--ledger", ledgerOf(story("claimed")), "--utc"]);
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.split("\n");
  assert.equal(lines[0], "Task 12: open");
  assert.equal(lines[lines.indexOf("Reviews") + 1], "  none");
  assert.equal(lines[lines.indexOf("End") + 1], "  open");
  const heading = lines.indexOf("Claimed, not seen at the code host");
  assert.ok(heading > 0, run.stdout);
  assert.match(lines[heading + 1]!, /claimed {2}review\.approved on change 30 by agent-b$/);
  assert.match(lines[heading + 2]!, /claimed {2}change\.merged on change 30 by agent-b$/);
  assert.ok(lines.includes("  review rounds: 0"));
});

test("the same with observed events gives the handovers, the round and the merge, as before", () => {
  const events = story("observed");
  assert.deepEqual(
    handovers(items(events)).map((h) => [h.from, h.to, h.step]),
    [
      ["agent-b", "merged", "Review → merge"],
      ["agent-a", "agent-b", "Implementation → review"],
    ],
  );
  const figures = keyFigures(events, NOW);
  assert.equal(figures.open, 0);
  assert.equal(figures.merged, 1);
  assert.equal(figures.reviewRoundsMean, 1);
  assert.equal(figures.leadTimeMedianMs, 6 * 60_000);
  const shown = show(events, { kind: "change", id: "30" }, null)!;
  assert.equal(shown.reviews.length, 1);
  assert.equal(shown.reviews[0]!.followedBy, "change.merged");
  assert.deepEqual(shown.end, { state: "merged", time: at(6), actor: { kind: "agent", id: "agent-b" } });
  assert.equal(shown.summary.reviewRounds, 1);
  assert.deepEqual(shown.claimed, []);
  const text = howl(["show", "change:30", "--ledger", ledgerOf(events), "--utc"]).stdout;
  assert.ok(!text.includes("Claimed, not seen"), "no heading when there is no claim");
});

test("a claimed opening, head, comment and closing are not the change's", () => {
  const events = [
    opening(),
    event("claimed", "change.updated", 3, "agent-b", { sha: SHA.b }),
    event("claimed", "change.commented", 4, "agent-b"),
    event("claimed", "change.closed", 5, "agent-b"),
    event("claimed", "change.opened", 7, "agent-b", { change: "31", task: "12" }),
  ];
  const shown = show(events, { kind: "task", id: "12" }, null)!;
  const [thirty, other] = shown.changes;
  assert.deepEqual(thirty!.opened, { time: at(0), actor: { kind: "agent", id: "agent-a" } });
  assert.deepEqual(thirty!.heads, [{ sha: SHA.a, time: at(0) }]);
  assert.equal(thirty!.comments, 0);
  assert.equal(other!.opened, undefined);
  assert.deepEqual(other!.heads, []);
  assert.deepEqual(shown.end, { state: "open" });
  assert.deepEqual(
    shown.claimed.map((c) => c.type),
    ["change.updated", "change.commented", "change.closed", "change.opened"],
  );
  // The claimed opening of change 31 opens nothing in the figures, and the claimed closing closes nothing.
  assert.equal(keyFigures(events, NOW).open, 1);
  assert.deepEqual(handovers(items(events)), []);
});

test("a claimed review does not start a round or end one, beside observed reviews", () => {
  const events = [
    opening(),
    event("observed", "review.commented", 2, "agent-b"),
    event("claimed", "review.changes_requested", 3, "agent-c"),
    event("claimed", "change.updated", 4, "agent-a", { sha: SHA.b }),
    event("observed", "review.approved", 5, "agent-b"),
  ];
  const shown = show(events, { kind: "change", id: "30" }, null)!;
  assert.equal(shown.reviews.length, 1, "the claimed head starts no second round");
  assert.deepEqual(
    shown.reviews[0]!.reviews.map((r) => r.outcome),
    ["commented", "approved"],
  );
  assert.equal(shown.reviews[0]!.followedBy, null);
  assert.equal(handovers(items(events)).length, 2);
});

test("a script's howl emit review.approved and change.merged, taken in, merge nothing", () => {
  const ws = workspace();
  const writer = openLedger(ws.ledger, { project: PROJECT });
  writer.append(opening());
  writer.close();
  for (const type of ["review.approved", "change.merged"]) {
    assert.equal(howl(["emit", type, "--change", "30"], { cwd: ws.root, env: ws.env }).status, 0);
  }
  assert.equal(howl(["ingest"], { cwd: ws.root, env: ws.env }).status, 0);
  const run = howl(["show", "change:30", "--ledger", ws.ledger, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const shown = JSON.parse(run.stdout);
  assert.deepEqual(shown.end, { state: "open" });
  assert.deepEqual(shown.reviews, []);
  assert.deepEqual(
    shown.claimed.map((c: { type: string }) => c.type).sort(),
    ["change.merged", "review.approved"],
  );
});

test("the dashboard gets the claims from /api/show, and has a heading and a line for them", async () => {
  const server = await startServer({ ledger: ledgerOf(story("claimed")), port: 0, root: folder() });
  try {
    const body = await (await fetch(`${server.url}/api/show?what=change:30`)).json();
    assert.equal(body.claimed.length, 2);
    assert.equal(body.end.state, "open");
    assert.equal(claimText(body.claimed[0]), "review.approved · change 30 · agent-b");
    const overview = await (await fetch(`${server.url}/api/overview`)).json();
    assert.deepEqual(overview.handovers, []);
    assert.equal(overview.figures.open, 1);
  } finally {
    await server.close();
  }
  assert.equal(texts.change.claimed, "Claimed, not seen at the code host");
});
