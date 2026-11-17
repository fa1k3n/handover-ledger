// #52: when the overview page shows the tile "No agent matched" and its list, through the seam showsUnattributed.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { showsUnattributed } from "../src/dashboard/format.ts";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { keyFigures } from "../src/read/overview.ts";
import { PROJECT } from "./helpers.ts";
import { T0 } from "./story.ts";

const DAY = 24 * 3600_000;
let n = 0;
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();

function observed(type: LedgerEvent["type"], minute: number, actor: string, extra: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    v: 0,
    id: `d-${++n}`,
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

function session(minute: number, agent: string): LedgerEvent {
  return {
    v: 0,
    id: `d-${++n}`,
    time: at(minute),
    type: "session.started",
    source: { adapter: "claude-code-hook", kind: "claimed" },
    project: PROJECT,
    actor: { kind: "agent", id: agent },
    session: `session-${agent}`,
    branch: "task-9-elsewhere",
  };
}

test("#52 R52.1: on a ledger of people only, the page shows neither the tile nor its list", () => {
  const figures = keyFigures(
    [
      observed("change.opened", 0, "person-0a0a0a0a"),
      observed("review.commented", 5, "person-0b0b0b0b"),
      observed("review.approved", 10, "person-0b0b0b0b"),
      observed("change.merged", 12, "person-0a0a0a0a"),
    ],
    T0 + DAY,
  );
  assert.equal(showsUnattributed(figures), false);
});

test("#52 R52.2: with one session of an agent in the period and an unmatched review, the page shows the tile and the list", () => {
  const figures = keyFigures([session(0, "agent-a"), observed("review.commented", 5, "person-0b0b0b0b", { change: "8" })], T0 + DAY);
  assert.equal(figures.unattributed?.count, 1);
  assert.equal(showsUnattributed(figures), true);
});

test("#52 R52.3: a session of an agent older than the period does not bring the tile and the list back", () => {
  const figures = keyFigures([session(0, "agent-a"), observed("review.commented", 40 * 24 * 60 + 5, "person-0b0b0b0b", { change: "8" })], T0 + 41 * DAY);
  assert.equal(showsUnattributed(figures), false);
});
