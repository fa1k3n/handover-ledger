// The overview: handovers derived from the ledger, and the key figures. The tests of issue #13.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { handovers, keyFigures } from "../src/read/overview.ts";
import { startServer } from "../src/serve/server.ts";
import { folder, PROJECT } from "./helpers.ts";
import { ledgerEvents, MERGER, REVIEWER, T0, writeStory } from "./story.ts";

const DAY = 24 * 3600_000;
const items = (events: LedgerEvent[]) => events.map((event, i) => ({ event, hash: `h${i}` }));

let n = 0;
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
function observed(type: LedgerEvent["type"], minute: number, actor: string, extra: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    v: 0,
    id: `o-${++n}`,
    time: at(minute),
    type,
    source: { adapter: "github", kind: "observed" },
    project: PROJECT,
    actor: { kind: actor.startsWith("person-") ? "person" : "agent", id: actor },
    change: "7",
    task: "3",
    ...extra,
  };
}

test("#13: opened by A, reviewed by B: one handover A → B", () => {
  const rows = handovers(items([observed("change.opened", 0, "agent-a"), observed("review.commented", 5, "agent-b")]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.from, "agent-a");
  assert.equal(rows[0]!.to, "agent-b");
  assert.equal(rows[0]!.change, "7");
  assert.equal(rows[0]!.task, "3");
  assert.equal(rows[0]!.hash, "h1");
});

test("#13: a review asking for changes is a handover back, B → A; the merge ends the chain", () => {
  const rows = handovers(
    items([
      observed("change.opened", 0, "agent-a"),
      observed("review.changes_requested", 5, "agent-b"),
      observed("change.updated", 8, "agent-a"),
      observed("review.approved", 10, "agent-b"),
      observed("change.merged", 12, "person-0b0b0b0b"),
    ]),
  );
  // Newest first.
  assert.deepEqual(
    rows.map((r) => `${r.from} → ${r.to}`),
    ["person-0b0b0b0b → merged", "agent-a → agent-b", "agent-b → agent-a"],
  );
});

test("#13: a review by the author is no handover", () => {
  assert.deepEqual(handovers(items([observed("change.opened", 0, "agent-a"), observed("review.commented", 5, "agent-a")])), []);
});

test("#13: lead time, rounds and open changes on the story", () => {
  const figures = keyFigures(ledgerEvents(), T0 + DAY);
  // Change 31 is still open; change 30 was merged.
  assert.equal(figures.open, 1);
  // Task 12: first change opened at minute 10, merged at 60.
  assert.equal(figures.leadTimeMedianMs, 50 * 60_000);
  // Change 30 had two reviews: changes requested, then approved.
  assert.equal(figures.reviewRoundsMean, 2);
  assert.equal(figures.merged, 1);
});

test("#13: a closed change does not count as open; a merge older than 30 days is not counted", () => {
  const events = [
    observed("change.opened", 0, "agent-a", { change: "1" }),
    observed("change.closed", 1, "agent-a", { change: "1" }),
    observed("change.opened", 2, "agent-a", { change: "2", task: "9" }),
    observed("change.merged", 3, "agent-a", { change: "2", task: "9" }),
  ];
  const now = T0 + 40 * DAY;
  const figures = keyFigures(events, now);
  assert.equal(figures.open, 0);
  assert.equal(figures.merged, 0);
  assert.equal(figures.leadTimeMedianMs, null);
  assert.equal(figures.reviewRoundsMean, null);
});

test("#13: /api/overview gives the key figures and the latest handovers of the story", async () => {
  const dir = folder();
  const server = await startServer({ ledger: writeStory(), port: 0, root: dir });
  try {
    const body = (await (await fetch(`${server.url}/api/overview`)).json()) as {
      figures: { open: number };
      handovers: { from: string; to: string; hash: string }[];
    };
    assert.equal(body.figures.open, 1);
    assert.deepEqual(
      body.handovers.map((h) => `${h.from} → ${h.to}`),
      [`${MERGER} → merged`, `agent-1 → ${REVIEWER}`, `${REVIEWER} → agent-1`],
    );
    assert.ok(body.handovers.every((h) => /^[0-9a-f]{64}$/.test(h.hash)));
  } finally {
    await server.close();
  }
});
