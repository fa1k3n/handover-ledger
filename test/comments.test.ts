// A review is a review: comments on a pull request are not counted as reviews. The tests of issue #28.
// @code_class tests
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { GitHub } from "../src/observe/github.ts";
import { handovers, keyFigures } from "../src/read/overview.ts";
import { parseAsked, render, show } from "../src/read/show.ts";
import { folder, howl, lines, PROJECT, workspace } from "./helpers.ts";
import { at, LocalHost, SHA } from "./local-host.ts";

const R = "/repos/team/product";

/** A GitHub adapter over a fixed table of answers: change 9 with one formal review and three comments. */
function github(pattern?: RegExp) {
  const sha = "b".repeat(40);
  const table: Record<string, unknown> = {
    [`${R}/pulls/9/reviews`]: [{ id: 7, user: { login: "dave", type: "User" }, state: "APPROVED", submitted_at: "2026-01-01T01:40:00Z", commit_id: sha }],
    [`${R}/pulls/9/files`]: [],
    // #45: the events of the issue tell when a change was opened again and which reviews were dismissed: none here.
    [`${R}/issues/9/events`]: [],
    [`${R}/issues/9/comments`]: [
      { id: 501, user: { login: "carol", type: "User" }, created_at: "2026-01-01T01:10:00Z", body: "[review] round 1\nmore words" },
      { id: 502, user: { login: "helper[bot]", type: "Bot" }, created_at: "2026-01-01T01:20:00Z", body: "thanks, fixed" },
      { id: 503, user: { login: "carol", type: "User" }, created_at: "2026-01-01T01:30:00Z", body: "thanks\n[review] not on the first line" },
    ],
    [`${R}/pulls/9`]: { number: 9, user: { login: "carol", type: "User" }, created_at: "2026-01-01T01:00:00Z", head: { ref: "task-9-x", sha }, body: "", updated_at: "2026-01-01T01:40:00Z" },
    [`${R}/commits/${sha}`]: { sha, commit: { committer: { date: "2026-01-01T01:05:00Z" } } },
  };
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const key = Object.keys(table).find((k) => (url.pathname + url.search).startsWith(k));
    return key ? new Response(JSON.stringify(table[key])) : new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return new GitHub({ repository: "team/product", token: "t", fetch, warn: () => {}, ...(pattern ? { reviewCommentPattern: pattern } : {}) });
}

test("#28: with a pattern, a comment whose first line matches is a review comment, another is not; no text is kept", async () => {
  const change = await github(/^\[review\]/).change(9);
  assert.deepEqual(change.reviews, [{ id: "7", by: { login: "dave", bot: false }, state: "approved", at: "2026-01-01T01:40:00Z", sha: "b".repeat(40) }]);
  assert.deepEqual(change.comments, [
    { id: "501", by: { login: "carol", bot: false }, at: "2026-01-01T01:10:00Z", review: true },
    { id: "502", by: { login: "helper[bot]", bot: true }, at: "2026-01-01T01:20:00Z", review: false },
    { id: "503", by: { login: "carol", bot: false }, at: "2026-01-01T01:30:00Z", review: false },
  ]);
  const text = JSON.stringify(change);
  assert.ok(!text.includes("round 1") && !text.includes("fixed") && !text.includes("thanks"), "no comment text is kept");
});

test("#28: with no pattern, no comment is a review", async () => {
  const change = await github().change(9);
  assert.equal(change.reviews.length, 1, "only the formal review");
  assert.ok(change.comments!.every((c) => c.review === false));
});

/** A repository observed through a local host with one change: a formal review and two comments with text. */
function observed(extra: string) {
  const dir = folder();
  const ws = workspace({ yml: `project: ${PROJECT}\nhost: local\nlocal: ${dir}\nrepository: team/product\n${extra}` });
  const person = (login: string) => ({ login });
  new LocalHost(dir).change({
    number: 28,
    branch: "task-6-x",
    openedAt: at(0),
    openedBy: person("alice"),
    head: { sha: SHA.a, at: at(0) },
    tasks: [6],
    reviews: [{ id: "r1", by: person("dave"), state: "approved", at: at(40), sha: SHA.a }],
    comments: [
      { id: "1", by: person("carol"), at: at(10), body: "[review] please rename" },
      { id: "2", by: person("alice"), at: at(20), body: "done" },
    ],
    updatedAt: at(40),
  } as never);
  const r = howl(["observe", "--once"], { cwd: ws.root, env: ws.env });
  assert.equal(r.status, 0, r.stderr);
  return { ws, events: lines(ws.ledger).map((l) => l.event as unknown as LedgerEvent) };
}

test("#28: howl observe records a matching comment as review.commented, another as change.commented, and keeps no text", () => {
  const { ws, events } = observed("review_comment_pattern: '^\\[review\\]'");
  const of = (type: string) => events.filter((e) => e.type === type);
  assert.equal(of("review.approved").length, 1);
  assert.deepEqual(of("review.commented").map((e) => e.time), [at(10)]);
  assert.deepEqual(of("change.commented").map((e) => e.time), [at(20)]);
  assert.ok(of("change.commented").every((e) => e.change === "28" && e.task === "6"));
  const ledger = readFileSync(ws.ledger, "utf8");
  assert.ok(!ledger.includes("rename") && !ledger.includes("done\""), "no comment text in the ledger");
});

test("#28: with no pattern in howl.yml, every comment is change.commented", () => {
  const { events } = observed("");
  assert.equal(events.filter((e) => e.type === "review.commented").length, 0);
  assert.equal(events.filter((e) => e.type === "change.commented").length, 2);
});

test("#28: an invalid review_comment_pattern stops howl observe with a message, not silently", () => {
  const dir = folder();
  const ws = workspace({ yml: `project: ${PROJECT}\nhost: local\nlocal: ${dir}\nrepository: team/product\nreview_comment_pattern: '(unclosed'\n` });
  new LocalHost(dir);
  const r = howl(["observe", "--once"], { cwd: ws.root, env: ws.env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /review_comment_pattern/);
});

// One change: opened by an agent, three comments, one review that asks for changes, an approval, the merge.
let n = 0;
const ev = (type: LedgerEvent["type"], minute: number, actor: string, kind: "agent" | "person" = "person"): LedgerEvent => ({
  v: 0,
  id: `c-${++n}`,
  time: at(minute),
  type,
  source: { adapter: "local", kind: "observed" },
  project: PROJECT,
  actor: { kind, id: actor },
  change: "40",
  task: "8",
  branch: "task-8-x",
  sha: SHA.a,
  data: { seen: at(minute) },
});
const story = (): LedgerEvent[] => [
  ev("change.opened", 0, "agent-1", "agent"),
  ev("change.commented", 5, "person-aaaa"),
  ev("review.changes_requested", 10, "person-bbbb"),
  ev("change.commented", 12, "agent-1", "agent"),
  ev("change.commented", 14, "person-aaaa"),
  ev("review.approved", 20, "person-bbbb"),
  ev("change.merged", 30, "person-bbbb"),
];

test("#28: howl show counts rounds from reviews only and lists the comments apart, a count per change", () => {
  const shown = show(story(), parseAsked("change:40"), null)!;
  assert.deepEqual(
    shown.reviews.flatMap((r) => r.reviews.map((x) => x.outcome)),
    ["changes_requested", "approved"],
  );
  assert.equal(shown.changes[0]!.comments, 3);
  assert.equal(shown.summary.reviewRounds, shown.reviews.length);
  assert.match(render(shown, { utc: true }), /comments: 3/);
});

test("#28: the handovers and the overview's figures use reviews only", () => {
  const events = story();
  const steps = handovers(events.map((event) => ({ event }))).map((h) => h.step);
  assert.deepEqual(steps, ["Review → merge", "Implementation → review", "Review → fix"]);
  const figures = keyFigures(events, Date.parse(at(60)));
  assert.equal(figures.reviewRoundsMean, 1, "one round, not five");
});
