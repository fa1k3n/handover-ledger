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
        // #45: who assigned is the actor of the event.
        { id: 900, event: "assigned", actor: { login: "alice", type: "User" }, assignee: { login: "agent-bot", type: "User" }, created_at: "2026-01-01T00:01:00Z" },
        { id: 901, event: "labeled", created_at: "2026-01-01T00:02:00Z" },
        { id: 902, event: "assigned", actor: { login: "agent-bot", type: "User" }, assignee: { login: "helper[bot]", type: "Bot" }, created_at: "2026-01-01T00:03:00Z" },
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
      { id: "900", assignee: { login: "agent-bot", bot: false }, by: { login: "alice", bot: false }, at: "2026-01-01T00:01:00Z" },
      { id: "902", assignee: { login: "helper[bot]", bot: true }, by: { login: "agent-bot", bot: false }, at: "2026-01-01T00:03:00Z" },
    ],
    closedAt: "2026-01-01T01:00:00Z",
    closedBy: { login: "alice", bot: false },
    updatedAt: "2026-01-01T01:00:00Z",
  });
});

test("a change: its branch, its head with the time of the commit, the tasks it closes, its reviews, and its pushes", async () => {
  const sha = "a".repeat(40);
  const first = "c".repeat(40);
  const { host } = github({
    // #44: the repository's activity list of the change's branch: who pushed each head, and when. The newest first, as GitHub gives it.
    [`${R}/activity?`]: {
      body: [
        { id: 7003, before: sha, after: "0".repeat(40), ref: "refs/heads/task-5-x", timestamp: "2026-01-01T00:31:00Z", activity_type: "branch_deletion", actor: { login: "carol", type: "User" } },
        { id: 7002, before: first, after: sha, ref: "refs/heads/task-5-x", timestamp: "2026-01-01T00:05:03Z", activity_type: "push", actor: { login: "agent-bot", type: "User" } },
        { id: 7001, before: "0".repeat(40), after: first, ref: "refs/heads/task-5-x", timestamp: "2025-12-31T23:59:00Z", activity_type: "branch_creation", actor: { login: "agent-bot", type: "User" } },
      ],
    },
    // #25: and the files; before `pulls/7`, which the fake matches as a prefix.
    [`${R}/pulls/7/files`]: { body: [{ filename: ".howl/howl.yml" }, { filename: "src/a.ts" }] },
    // #45: the events of the issue, for the reopenings and the dismissals: none here.
    [`${R}/issues/7/events`]: { body: [] },
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
        head: { ref: "task-5-x", sha, repo: { id: 1234567, full_name: "team/product" } },
        base: { ref: "main", repo: { id: 1234567, full_name: "team/product" } },
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
    pushes: [
      { id: "7001", sha: first, at: "2025-12-31T23:59:00Z", by: { login: "agent-bot", bot: false } },
      { id: "7002", sha, before: first, at: "2026-01-01T00:05:03Z", by: { login: "agent-bot", bot: false } },
    ],
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
    [`${R}/issues/9/events`]: { body: [] },
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

test("#48: the lasting id of the repository is its numeric id, as text, asked once for as long as the host lives", async () => {
  const { host, asked } = github({ [R]: { body: { id: 1234567, full_name: "team/product" } } });
  assert.equal(await host.repositoryId(), "1234567");
  assert.equal(await host.repositoryId(), "1234567");
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.url, R);
});

test("#48: an answer with no id for the repository is an error, not an id made from the name", async () => {
  const { host } = github({ [R]: { body: { full_name: "team/product" } } });
  await assert.rejects(host.repositoryId(), /id/);
});

test("#48: an account that no longer exists is no one: no user, or the ghost the host puts in its place", async () => {
  const { host } = github({
    [`${R}/issues/5/events`]: { body: [{ id: 900, event: "assigned", assignee: null, created_at: "2026-01-01T00:01:00Z" }] },
    [`${R}/issues/5`]: {
      body: {
        number: 5,
        user: null,
        created_at: "2026-01-01T00:00:00Z",
        closed_at: "2026-01-01T01:00:00Z",
        closed_by: { login: "ghost", id: 10137, type: "User" },
        updated_at: "2026-01-01T01:00:00Z",
      },
    },
  });
  const task = await host.task(5);
  assert.deepEqual(task.openedBy, { removed: true });
  assert.deepEqual(task.closedBy, { removed: true });
  assert.deepEqual(task.assignments, [{ id: "900", assignee: { removed: true }, at: "2026-01-01T00:01:00Z" }], "given to an account that is gone: it was still given");
});

test("#48: a user who is called ghost and is not the host's ghost is an account like another", async () => {
  const { host } = github({
    [`${R}/issues/5/events`]: { body: [] },
    [`${R}/issues/5`]: { body: { number: 5, user: { login: "ghost", id: 42, type: "User" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" } },
  });
  assert.deepEqual((await host.task(5)).openedBy, { login: "ghost", bot: false });
});

test("#48: a review with no user, and a comment by the host's ghost, are of an account that is gone; a comment with no user is left out, as before", async () => {
  const sha = "a".repeat(40);
  const { host } = github({
    [`${R}/pulls/7/files`]: { body: [] },
    [`${R}/issues/7/events`]: { body: [] },
    [`${R}/pulls/7/reviews`]: {
      body: [
        { id: 1, user: null, state: "APPROVED", submitted_at: "2026-01-01T00:10:00Z", commit_id: sha },
        { id: 2, user: { login: "ghost", id: 10137, type: "User" }, state: "COMMENTED", submitted_at: "2026-01-01T00:11:00Z", commit_id: sha },
      ],
    },
    [`${R}/issues/7/comments`]: {
      body: [
        { id: 31, user: { login: "ghost", id: 10137, type: "User" }, created_at: "2026-01-01T00:12:00Z", body: "[review] ok" },
        { id: 32, user: null, created_at: "2026-01-01T00:13:00Z", body: "[review] ok" },
      ],
    },
    [`${R}/pulls/7`]: {
      body: { number: 7, user: null, created_at: "2026-01-01T00:00:00Z", head: { ref: "x", sha }, updated_at: "2026-01-01T00:30:00Z" },
    },
    [`${R}/commits/${sha}`]: { body: { sha, commit: { committer: { date: "2026-01-01T00:05:00Z" } } } },
  });
  const change = await host.change(7);
  assert.deepEqual(change.openedBy, { removed: true });
  assert.deepEqual(change.reviews.map((r) => r.by), [{ removed: true }, { removed: true }]);
  assert.deepEqual(change.reviews.map((r) => r.state), ["approved", "commented"]);
  assert.deepEqual(change.comments!.map((c) => [c.id, c.by]), [["31", { removed: true }]]);
});

test("#48: an old name that GitHub answers with the same id is the same repository: it was renamed", async () => {
  const { host, asked } = github({ "/repos/team/old": { body: { id: 1234567 } }, [R]: { body: { id: 1234567 } } });
  assert.equal(await host.isSameRepository("team/old"), true);
  assert.deepEqual(asked.map((a) => a.url).sort(), ["/repos/team/old", R].sort());
});

test("#48: an old name that GitHub answers with another id is another repository", async () => {
  const { host } = github({ "/repos/team/old": { body: { id: 7654321 } }, [R]: { body: { id: 1234567 } } });
  assert.equal(await host.isSameRepository("team/old"), false);
});

test("#48: an old name that is no repository at GitHub is another repository; any other failure is no answer", async () => {
  const none = github({ "/repos/team/old": { status: 404, body: { message: "Not Found" } }, [R]: { body: { id: 1234567 } } });
  assert.equal(await none.host.isSameRepository("team/old"), false);
  const down = github({ "/repos/team/old": { status: 502 }, [R]: { body: { id: 1234567 } } });
  await assert.rejects(down.host.isSameRepository("team/old"), /502/);
  const denied = github({ "/repos/team/old": { status: 401 }, [R]: { body: { id: 1234567 } } });
  await assert.rejects(denied.host.isSameRepository("team/old"), /401/);
  // A name that cannot be a repository at GitHub is asked for nowhere.
  const odd = github({});
  assert.equal(await odd.host.isSameRepository("local"), false);
  assert.deepEqual(odd.asked, []);
});

test("#45: a task: who took it from whom, who opened it again, and who gave it, from the events of its issue", async () => {
  const { host } = github({
    [`${R}/issues/5/events`]: {
      body: [
        { id: 900, event: "assigned", actor: { login: "alice", type: "User" }, assignee: { login: "agent-bot", type: "User" }, created_at: "2026-01-01T00:01:00Z" },
        { id: 901, event: "unassigned", actor: { login: "alice", type: "User" }, assignee: { login: "agent-bot", type: "User" }, created_at: "2026-01-01T00:02:00Z" },
        // The host says nothing of who gave this one: there is no actor to tell. A giver whose account is gone is `null`.
        { id: 902, event: "assigned", assignee: { login: "helper[bot]", type: "Bot" }, created_at: "2026-01-01T00:03:00Z" },
        { id: 903, event: "assigned", actor: null, assignee: { login: "agent-bot", type: "User" }, created_at: "2026-01-01T00:04:00Z" },
        { id: 904, event: "assigned", actor: { login: "alice", type: "User" }, assignee: null, created_at: "2026-01-01T00:05:00Z" },
        { id: 905, event: "unassigned", actor: { login: "alice", type: "User" }, assignee: null, created_at: "2026-01-01T00:06:00Z" },
        { id: 906, event: "closed", actor: { login: "alice", type: "User" }, created_at: "2026-01-01T00:07:00Z" },
        { id: 907, event: "reopened", actor: { login: "bob", type: "User" }, created_at: "2026-01-01T00:08:00Z" },
      ],
    },
    [`${R}/issues/5`]: { body: { number: 5, user: { login: "alice", type: "User" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:08:00Z" } },
  });
  const task = await host.task(5);
  assert.deepEqual(
    task.assignments.map((a) => [a.id, a.assignee, a.by]),
    [
      ["900", { login: "agent-bot", bot: false }, { login: "alice", bot: false }],
      ["902", { login: "helper[bot]", bot: true }, undefined],
      ["903", { login: "agent-bot", bot: false }, { removed: true }],
      ["904", { removed: true }, { login: "alice", bot: false }],
    ],
  );
  assert.equal("by" in task.assignments[1]!, false, "no actor in the answer: the host does not say");
  assert.deepEqual(task.unassignments, [
    { id: "901", assignee: { login: "agent-bot", bot: false }, by: { login: "alice", bot: false }, at: "2026-01-01T00:02:00Z" },
    { id: "905", assignee: { removed: true }, by: { login: "alice", bot: false }, at: "2026-01-01T00:06:00Z" },
  ]);
  assert.deepEqual(task.reopenings, [{ id: "907", by: { login: "bob", bot: false }, at: "2026-01-01T00:08:00Z" }]);
});

test("#45: a change: when it was opened again, and which reviews were dismissed and by whom; nothing of what is in the dismissal is read", async () => {
  const sha = "a".repeat(40);
  const { host, asked } = github({
    [`${R}/pulls/7/files`]: { body: [] },
    [`${R}/issues/7/events`]: {
      body: [
        { id: 1, event: "labeled", created_at: "2026-01-01T00:01:00Z" },
        { id: 2, event: "closed", actor: { login: "carol", type: "User" }, created_at: "2026-01-01T00:20:00Z" },
        { id: 3, event: "reopened", actor: { login: "carol", type: "User" }, created_at: "2026-01-01T00:25:00Z" },
        { id: 4, event: "review_dismissed", actor: { login: "carol", type: "User" }, created_at: "2026-01-01T00:26:00Z", dismissed_review: { review_id: 77, state: "changes_requested", dismissal_message: "secret words" } },
        { id: 5, event: "review_dismissed", actor: null, created_at: "2026-01-01T00:27:00Z" },
      ],
    },
    [`${R}/pulls/7/reviews`]: { body: [] },
    [`${R}/issues/7/comments`]: { body: [] },
    [`${R}/pulls/7`]: { body: { number: 7, user: { login: "agent-bot", type: "User" }, created_at: "2026-01-01T00:00:00Z", head: { ref: "x", sha }, updated_at: "2026-01-01T00:28:00Z" } },
    [`${R}/commits/${sha}`]: { body: { sha, commit: { committer: { date: "2026-01-01T00:05:00Z" } } } },
  });
  const change = await host.change(7);
  assert.deepEqual(change.reopenings, [{ id: "3", by: { login: "carol", bot: false }, at: "2026-01-01T00:25:00Z" }]);
  // The fields of a dismissal that name the review and its outcome are not checked against the host yet: they are not read.
  assert.deepEqual(change.dismissals, [
    { id: "4", by: { login: "carol", bot: false }, at: "2026-01-01T00:26:00Z" },
    { id: "5", by: { removed: true }, at: "2026-01-01T00:27:00Z" },
  ]);
  assert.ok(!JSON.stringify(change).includes("secret words"), "the text of a dismissal is never kept");
  assert.ok(asked.some((a) => a.url.startsWith(`${R}/issues/7/events`)), "from the events it already knows how to ask for");
});

/** #44: a change of the repository itself on branch `task-5-x`, with the answer of the activity list given. */
function withActivity(activity: Reply | Reply[], pull: Record<string, unknown> = {}) {
  const sha = "a".repeat(40);
  const repo = { id: 1234567, full_name: "team/product" };
  return github({
    [`${R}/activity?`]: activity,
    [`${R}/pulls/7/files`]: { body: [] },
    [`${R}/issues/7/events`]: { body: [] },
    [`${R}/pulls/7/reviews`]: { body: [] },
    [`${R}/issues/7/comments`]: { body: [] },
    [`${R}/pulls/7`]: {
      body: { number: 7, user: { login: "agent-bot", type: "User" }, created_at: "2026-01-01T00:00:00Z", head: { ref: "task-5-x", sha, repo }, base: { ref: "main", repo }, updated_at: "2026-01-01T00:30:00Z", ...pull },
    },
    [`${R}/commits/${sha}`]: { body: { sha, commit: { committer: { date: "2026-01-01T00:05:00Z" } } } },
  });
}

const H = { a: "a".repeat(40), b: "b".repeat(40), c: "c".repeat(40), zero: "0".repeat(40) };
const entry = (id: number, type: string, before: string, after: string, timestamp: string, actor: unknown = { login: "agent-bot", type: "User" }) => ({
  id,
  activity_type: type,
  before,
  after,
  ref: "refs/heads/task-5-x",
  timestamp,
  actor,
});

test("#44: the pushes are asked of the activity list of the change's branch, every page, in the order they were made", async () => {
  const { host, asked } = withActivity([
    {
      body: [entry(3, "push", H.b, H.a, "2026-01-01T00:20:00Z"), entry(2, "push", H.c, H.b, "2026-01-01T00:10:00Z")],
      headers: { link: `<https://api.github.com${R}/activity?ref=refs%2Fheads%2Ftask-5-x&per_page=100&after=xyz>; rel="next"` },
    },
    { body: [entry(1, "branch_creation", H.zero, H.c, "2026-01-01T00:00:00Z")] },
  ]);
  const change = await host.change(7);
  assert.deepEqual(change.pushes!.map((p) => [p.id, p.sha, p.at]), [
    ["1", H.c, "2026-01-01T00:00:00Z"],
    ["2", H.b, "2026-01-01T00:10:00Z"],
    ["3", H.a, "2026-01-01T00:20:00Z"],
  ]);
  const activity = asked.filter((a) => a.url.startsWith(`${R}/activity?`));
  assert.equal(activity.length, 2);
  assert.match(activity[0]!.url, /ref=refs%2Fheads%2Ftask-5-x/);
  assert.match(activity[0]!.url, /per_page=100/);
});

test("#44: a force push is a push that was forced; the deletion of the branch and a merge are no heads", async () => {
  // Not seen in a real answer: built from the type the host's documents name, in the form of the entries that were seen.
  const { host } = withActivity({
    body: [
      entry(5, "branch_deletion", H.a, H.zero, "2026-01-01T00:40:00Z"),
      entry(4, "pr_merge", H.b, H.a, "2026-01-01T00:35:00Z"),
      entry(3, "force_push", H.b, H.a, "2026-01-01T00:20:00Z", { login: "alice", type: "User" }),
      entry(2, "push", H.a, H.b, "2026-01-01T00:10:00Z"),
      entry(1, "branch_creation", H.zero, H.a, "2025-12-31T23:50:00Z"),
    ],
  });
  const change = await host.change(7);
  assert.deepEqual(change.pushes, [
    { id: "1", sha: H.a, at: "2025-12-31T23:50:00Z", by: { login: "agent-bot", bot: false } },
    { id: "2", sha: H.b, before: H.a, at: "2026-01-01T00:10:00Z", by: { login: "agent-bot", bot: false } },
    { id: "3", sha: H.a, before: H.b, at: "2026-01-01T00:20:00Z", by: { login: "alice", bot: false }, forced: true },
  ]);
});

test("#44: a pusher whose account is gone is no one; an entry that names no actor names no pusher", async () => {
  const { host } = withActivity({
    body: [entry(2, "push", H.a, H.b, "2026-01-01T00:10:00Z", null), { ...entry(1, "push", H.c, H.a, "2026-01-01T00:05:00Z"), actor: undefined }],
  });
  const change = await host.change(7);
  assert.deepEqual(change.pushes!.map((p) => [p.id, p.by]), [
    ["1", undefined],
    ["2", { removed: true }],
  ]);
  assert.equal("by" in change.pushes![0]!, false);
});

test("#44: a change from a fork has no pushes, and its activity is not asked for", async () => {
  const { host, asked } = withActivity({ body: [entry(1, "push", H.c, H.a, "2026-01-01T00:05:00Z")] }, { head: { ref: "task-5-x", sha: H.a, repo: { id: 999, full_name: "someone/product" } } });
  const change = await host.change(7);
  assert.equal(change.pushes, undefined);
  assert.ok(!asked.some((a) => a.url.startsWith(`${R}/activity`)));
  // A fork that was deleted: the host gives no repository for the head.
  const gone = withActivity({ body: [] }, { head: { ref: "task-5-x", sha: H.a, repo: null } });
  assert.equal((await gone.host.change(7)).pushes, undefined);
});

test("#44: a list with no pushes of the branch, or a host with no activity list, gives no pushes; another failure is thrown", async () => {
  assert.equal((await withActivity({ body: [] }).host.change(7)).pushes, undefined);
  assert.equal((await withActivity({ status: 404, body: { message: "Not Found" } }).host.change(7)).pushes, undefined);
  await assert.rejects(withActivity({ status: 502 }).host.change(7), /502/);
});
