// The overview: handovers derived from the ledger, and the key figures. The tests of issue #13.
// @code_class tests
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
      [
        `${MERGER} → merged`,
        `agent-1 → ${REVIEWER}`,
        `${REVIEWER} → agent-1`,
        // #120: the story gives two tasks to the agent, in the form from before #45: the giver is not recorded.
        "not recorded → agent-1",
        "not recorded → agent-1",
      ],
    );
    assert.ok(body.handovers.every((h) => /^[0-9a-f]{64}$/.test(h.hash)));
  } finally {
    await server.close();
  }
});

test("#26: a review through a person's account with no matched agent is counted once, with its change", () => {
  const events = [observed("change.opened", 0, "agent-a"), observed("review.commented", 5, "person-0b0b0b0b"), observed("review.commented", 6, "person-0b0b0b0b", { change: "8" })];
  const figures = keyFigures(events, T0 + DAY);
  assert.equal(figures.unattributed.count, 2);
  assert.deepEqual(figures.unattributed.changes, ["7", "8"]);
});

test("#25: the overview lists the changes to .howl/ of the period", () => {
  const cfg = (change: string, minute: number, paths: string[]): LedgerEvent => ({ ...observed("change.opened", minute, "agent-a", { change }), id: `cfg-${change}-${minute}`, type: "config.changed", data: { paths } });
  const figures = keyFigures([cfg("7", 1, [".howl/howl.yml"]), cfg("9", 2, [".howl/rules.yml"])], T0 + DAY);
  assert.deepEqual(
    figures.configChanges.map((c) => [c.change, c.paths]),
    [["9", [".howl/rules.yml"]], ["7", [".howl/howl.yml"]]],
  );
  assert.equal(keyFigures([cfg("7", 1, [".howl/howl.yml"])], T0 + 40 * DAY).configChanges.length, 0);
});

/** #48: an observed event of an account that no longer exists: no actor, and it says so. */
function gone(type: LedgerEvent["type"], minute: number): LedgerEvent {
  const e = observed(type, minute, "agent-x");
  delete e.actor;
  return { ...e, data: { account_removed: true } };
}

test("#48: a review by a removed account is a handover to someone, with no pseudonym", () => {
  const rows = handovers(items([observed("change.opened", 0, "agent-a"), gone("review.approved", 5)]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.from, "agent-a");
  assert.equal(rows[0]!.to, "someone");
  assert.equal(rows[0]!.step, "Implementation → review");
});

test("#48: a review that asks for changes, by a removed account, is a handover from someone back to the author", () => {
  const rows = handovers(items([observed("change.opened", 0, "agent-a"), gone("review.changes_requested", 5)]));
  assert.deepEqual(rows.map((r) => `${r.from} → ${r.to}`), ["someone → agent-a"]);
});

test("#48: two reviews by two removed accounts are two rows, not one reviewer with a count", () => {
  const rows = handovers(items([observed("change.opened", 0, "agent-a"), gone("review.approved", 5), gone("review.approved", 6)]));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.n === undefined));
});

test("#48: a review with no actor and no word that the account is gone is still no handover", () => {
  const e = observed("review.approved", 5, "agent-x");
  delete e.actor;
  assert.deepEqual(handovers(items([observed("change.opened", 0, "agent-a"), e])), []);
});
