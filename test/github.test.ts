// The GitHub adapter, with a fetch of its own: no network.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHub, closingTasks, originRepository } from "../src/observe/github.ts";

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

/** A fetch that answers from a table of paths, and records what it was asked. */
function fake(table: Record<string, Reply | Reply[]>) {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    asked.push({ url: url.pathname + url.search, headers });
    const key = Object.keys(table).find((k) => (url.pathname + url.search).startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    const entry = table[key]!;
    const reply = Array.isArray(entry) ? (entry.shift() ?? { status: 500 }) : entry;
    return new Response(reply.status === 304 ? null : JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: reply.headers,
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, asked };
}

const R = "/repos/team/product";

function github(table: Record<string, Reply | Reply[]>, sleep = async (_ms: number) => {}) {
  const f = fake(table);
  const host = new GitHub({ repository: "team/product", token: "t0ken", fetch: f.fetch, sleep, warn: () => {} });
  return { host, asked: f.asked };
}

test("listUpdated tells tasks from changes, passes since, and follows the pages", async () => {
  const { host, asked } = github({
    [`${R}/issues?`]: [
      {
        body: [
          { number: 1, updated_at: "2026-01-01T00:00:00Z" },
          { number: 2, updated_at: "2026-01-01T00:01:00Z", pull_request: {} },
        ],
        headers: { link: `<https://api.github.com${R}/issues?page=2&since=x>; rel="next"` },
      },
      { body: [{ number: 3, updated_at: "2026-01-01T00:02:00Z" }] },
    ],
  });
  const refs = await host.listUpdated("2025-12-31T00:00:00Z");
  assert.deepEqual(refs, [
    { kind: "task", number: 1, updatedAt: "2026-01-01T00:00:00Z" },
    { kind: "change", number: 2, updatedAt: "2026-01-01T00:01:00Z" },
    { kind: "task", number: 3, updatedAt: "2026-01-01T00:02:00Z" },
  ]);
  assert.match(asked[0]!.url, /since=2025-12-31T00%3A00%3A00Z/);
  assert.match(asked[0]!.url, /state=all/);
  assert.equal(asked[0]!.headers.authorization, "Bearer t0ken");
  assert.equal(asked.length, 2);
});

test("a task: who opened it, every assignment with its own id, who closed it", async () => {
  const { host } = github({
    [`${R}/issues/5/events`]: {
      body: [
        { id: 900, event: "assigned", assignee: { login: "agent-bot", type: "User" }, created_at: "2026-01-01T00:01:00Z" },
        { id: 901, event: "labeled", created_at: "2026-01-01T00:02:00Z" },
        { id: 902, event: "assigned", assignee: { login: "helper[bot]", type: "Bot" }, created_at: "2026-01-01T00:03:00Z" },
      ],
    },
    [`${R}/issues/5`]: {
      body: {
        number: 5,
        user: { login: "alice", type: "User" },
        created_at: "2026-01-01T00:00:00Z",
        closed_at: "2026-01-01T01:00:00Z",
        closed_by: { login: "alice", type: "User" },
        updated_at: "2026-01-01T01:00:00Z",
      },
    },
  });
  assert.deepEqual(await host.task(5), {
    number: 5,
    openedAt: "2026-01-01T00:00:00Z",
    openedBy: { login: "alice", bot: false },
    assignments: [
      { id: "900", assignee: { login: "agent-bot", bot: false }, at: "2026-01-01T00:01:00Z" },
      { id: "902", assignee: { login: "helper[bot]", bot: true }, at: "2026-01-01T00:03:00Z" },
    ],
    closedAt: "2026-01-01T01:00:00Z",
    closedBy: { login: "alice", bot: false },
    updatedAt: "2026-01-01T01:00:00Z",
  });
});

test("a change: its branch, its head with the time of the commit, the tasks it closes, and its reviews", async () => {
  const sha = "a".repeat(40);
  const { host } = github({
    // #25: and the files; before `pulls/7`, which the fake matches as a prefix.
    [`${R}/pulls/7/files`]: { body: [{ filename: ".howl/howl.yml" }, { filename: "src/a.ts" }] },
    [`${R}/pulls/7/reviews`]: {
      body: [
        { id: 1, user: { login: "bob", type: "User" }, state: "CHANGES_REQUESTED", submitted_at: "2026-01-01T00:10:00Z", commit_id: sha },
        { id: 2, user: { login: "bob", type: "User" }, state: "DISMISSED", submitted_at: "2026-01-01T00:11:00Z", commit_id: sha },
        { id: 3, user: { login: "bob", type: "User" }, state: "PENDING", commit_id: sha },
        { id: 4, user: { login: "review[bot]", type: "Bot" }, state: "COMMENTED", submitted_at: "2026-01-01T00:12:00Z", commit_id: sha },
        { id: 5, user: { login: "bob", type: "User" }, state: "APPROVED", submitted_at: "2026-01-01T00:20:00Z", commit_id: sha },
      ],
    },
    [`${R}/pulls/7`]: {
      body: {
        number: 7,
        user: { login: "agent-bot", type: "User" },
        created_at: "2026-01-01T00:00:00Z",
        head: { ref: "task-5-x", sha },
        body: "Does the thing.\n\nCloses #5, fixes #6 and resolves team/product#8. Not #9.",
        merged_at: "2026-01-01T00:30:00Z",
        merged_by: { login: "carol", type: "User" },
        closed_at: "2026-01-01T00:30:00Z",
        updated_at: "2026-01-01T00:30:00Z",
      },
    },
    // #20: the adapter also reads the comments; this change has none. Before `issues/7`, which the fake matches as a prefix.
    [`${R}/issues/7/comments`]: { body: [] },
    [`${R}/issues/7`]: { body: { closed_by: { login: "carol", type: "User" } } },
    [`${R}/commits/${sha}`]: { body: { sha, commit: { committer: { date: "2026-01-01T00:05:00Z" } } } },
  });
  assert.deepEqual(await host.change(7), {
    number: 7,
    branch: "task-5-x",
    openedAt: "2026-01-01T00:00:00Z",
    openedBy: { login: "agent-bot", bot: false },
    head: { sha, at: "2026-01-01T00:05:00Z" },
    tasks: [5, 6, 8],
    files: [".howl/howl.yml", "src/a.ts"],
    reviews: [
      { id: "1", by: { login: "bob", bot: false }, state: "changes_requested", at: "2026-01-01T00:10:00Z", sha },
      { id: "4", by: { login: "review[bot]", bot: true }, state: "commented", at: "2026-01-01T00:12:00Z", sha },
      { id: "5", by: { login: "bob", bot: false }, state: "approved", at: "2026-01-01T00:20:00Z", sha },
    ],
    comments: [],
    mergedAt: "2026-01-01T00:30:00Z",
    mergedBy: { login: "carol", bot: false },
    closedAt: "2026-01-01T00:30:00Z",
    closedBy: { login: "carol", bot: false },
    updatedAt: "2026-01-01T00:30:00Z",
  });
});

test("the tasks a change closes are read from the closing words of its description only", () => {
  assert.deepEqual(closingTasks("Fixes #1. Close #2; closed #3 resolved #4 RESOLVES #5", "team/product"), [1, 2, 3, 4, 5]);
  assert.deepEqual(closingTasks("See #1, relates to #2, other/repo#3 closes", "team/product"), []);
  assert.deepEqual(closingTasks("closes other/repo#3", "team/product"), []);
  assert.deepEqual(closingTasks(null, "team/product"), []);
});

test("the checks of a commit: check runs and statuses together", async () => {
  const sha = "b".repeat(40);
  const run = (status: string, conclusion: string | null, completed_at: string | null) => ({ status, conclusion, completed_at });
  const cases: [Reply, Reply, string, string | undefined][] = [
    [{ body: { check_runs: [run("completed", "success", "2026-01-01T00:02:00Z"), run("completed", "skipped", "2026-01-01T00:03:00Z")] } },
      { body: { state: "success", statuses: [{ state: "success", updated_at: "2026-01-01T00:04:00Z" }] } }, "passed", "2026-01-01T00:04:00Z"],
    [{ body: { check_runs: [run("completed", "failure", "2026-01-01T00:02:00Z")] } }, { body: { state: "pending", statuses: [] } }, "failed", "2026-01-01T00:02:00Z"],
    [{ body: { check_runs: [run("in_progress", null, null), run("completed", "success", "2026-01-01T00:02:00Z")] } }, { body: { statuses: [] } }, "pending", undefined],
    [{ body: { check_runs: [] } }, { body: { statuses: [{ state: "pending", updated_at: "x" }] } }, "pending", undefined],
    [{ body: { check_runs: [] } }, { body: { statuses: [] } }, "none", undefined],
  ];
  for (const [runs, status, state, at] of cases) {
    const { host } = github({ [`${R}/commits/${sha}/check-runs`]: runs, [`${R}/commits/${sha}/status`]: status });
    assert.deepEqual(await host.checks(sha), at ? { sha, state, at } : { sha, state });
  }
});

test("a call asked again sends its ETag, and a 304 gives the answer from before", async () => {
  const { host, asked } = github({
    [`${R}/issues?`]: [
      { body: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], headers: { etag: '"v1"' } },
      { status: 304 },
    ],
  });
  const first = await host.listUpdated(null);
  const second = await host.listUpdated(null);
  assert.deepEqual(second, first);
  assert.equal(asked[0]!.headers["if-none-match"], undefined);
  assert.equal(asked[1]!.headers["if-none-match"], '"v1"');
});

test("when the limit is reached it waits until the limit is lifted, then asks again", async () => {
  const slept: number[] = [];
  const reset = Math.floor(Date.now() / 1000) + 30;
  const { host } = github(
    {
      [`${R}/issues?`]: [
        { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } },
        { status: 429, headers: { "retry-after": "2" } },
        { body: [] },
      ],
    },
    async (ms) => {
      slept.push(ms);
    },
  );
  assert.deepEqual(await host.listUpdated(null), []);
  assert.equal(slept.length, 2);
  assert.ok(slept[0]! > 25_000 && slept[0]! <= 32_000, String(slept[0]));
  assert.equal(slept[1], 2000);
});

test("any other failure is thrown with its status", async () => {
  const { host } = github({ [`${R}/issues/9`]: { status: 500 } });
  await assert.rejects(host.task(9), /500/);
});

test("the repository is read from the remote origin when it is at GitHub", () => {
  assert.deepEqual(originRepository("git@github.com:team/product.git"), { host: "github", repository: "team/product" });
  assert.deepEqual(originRepository("https://github.com/team/product"), { host: "github", repository: "team/product" });
  assert.deepEqual(originRepository("ssh://git@github.com/team/product.git"), { host: "github", repository: "team/product" });
  assert.equal(originRepository("git@gitlab.example:team/product.git"), null);
  assert.equal(originRepository(null), null);
});

test("#20, #28: a change's comments are read apart from its reviews, with their own ids and no text; with no pattern none is a review", async () => {
  const sha = "b".repeat(40);
  const { host } = github({
    [`${R}/pulls/9/reviews`]: { body: [] },
    [`${R}/pulls/9/files`]: { body: [] },
    [`${R}/issues/9/comments`]: {
      body: [
        { id: 501, user: { login: "carol", type: "User" }, created_at: "2026-01-01T01:10:00Z", body: "[review] round 1" },
        { id: 502, user: { login: "helper[bot]", type: "Bot" }, created_at: "2026-01-01T01:20:00Z", body: "thanks, fixed" },
      ],
    },
    [`${R}/pulls/9`]: {
      body: {
        number: 9,
        user: { login: "carol", type: "User" },
        created_at: "2026-01-01T01:00:00Z",
        head: { ref: "task-9-x", sha },
        body: "",
        updated_at: "2026-01-01T01:20:00Z",
      },
    },
    [`${R}/commits/${sha}`]: { body: { sha, commit: { committer: { date: "2026-01-01T01:05:00Z" } } } },
  });
  const change = await host.change(9);
  assert.deepEqual(change.reviews, []);
  assert.deepEqual(change.comments, [
    { id: "501", by: { login: "carol", bot: false }, at: "2026-01-01T01:10:00Z", review: false },
    { id: "502", by: { login: "helper[bot]", bot: true }, at: "2026-01-01T01:20:00Z", review: false },
  ]);
  assert.ok(!JSON.stringify(change).includes("round 1"), "no comment text is kept");
});
